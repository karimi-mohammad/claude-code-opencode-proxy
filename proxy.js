const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = Number(process.env.PROXY_PORT || 22213);
const TARGET_HOST = 'opencode.ai';
const TARGET_PATH = '/zen/v1/chat/completions';
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');

const OPENAI_ENDPOINT = '/v1/chat/completions';
const ANTHROPIC_ENDPOINT = '/v1/messages';
const COUNT_TOKENS_ENDPOINT = '/v1/messages/count_tokens';
const MODELS_ENDPOINT = '/v1/models';
const HEALTH_ENDPOINT = '/health';

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function generateBase62(length) {
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += BASE62_CHARS[bytes[i] % 62];
    }
    return result;
}

function generateCanonicalSessionId() {
    const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(12, '0');
    const random = generateBase62(14);
    return `ses_${timestamp}${random}`;
}

function generateRequestId() {
    const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(12, '0');
    const random = generateBase62(14);
    return `msg_${timestamp}${random}`;
}

function generateAnthropicId() {
    return `msg_${generateBase62(24)}`;
}

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function redactHeaders(headers = {}) {
    const redacted = {};

    for (const [key, value] of Object.entries(headers)) {
        if (/authorization|cookie|api-key|token/i.test(key)) {
            redacted[key] = '[REDACTED]';
        } else {
            redacted[key] = value;
        }
    }

    return redacted;
}

function previewBody(buffer, maxLength = 4000) {
    if (!buffer || !buffer.length) {
        return '';
    }

    const text = buffer.toString('utf8');
    return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
}

function logEvent(level, event, details = {}) {
    ensureLogDir();

    const entry = {
        timestamp: new Date().toISOString(),
        level,
        event,
        ...details
    };

    const line = JSON.stringify(entry);
    console.log(line);
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
}

function logRequestStart(requestId, clientReq, pathname) {
    logEvent('info', 'request_received', {
        requestId,
        method: clientReq.method,
        url: clientReq.url,
        pathname,
        hasApiKey: Boolean(clientReq.headers['x-api-key']),
        hasAuthorization: Boolean(clientReq.headers.authorization),
        headers: redactHeaders(clientReq.headers)
    });
}

function logRequestBody(requestId, label, bodyBuffer) {
    logEvent('info', 'request_body', {
        requestId,
        label,
        byteLength: bodyBuffer.length,
        preview: previewBody(bodyBuffer)
    });
}

function logRequestError(requestId, label, error) {
    logEvent('error', label, {
        requestId,
        message: error?.message || String(error),
        stack: error?.stack
    });
}

function logUpstreamResponse(requestId, statusCode, headers) {
    logEvent('info', 'upstream_response', {
        requestId,
        statusCode,
        headers: redactHeaders(headers)
    });
}

function getUpstreamAuthHeaders(clientReq) {
    const upstreamHeaders = {};
    const apiKey = clientReq.headers['x-api-key'];
    const authorization = clientReq.headers.authorization;

    if (apiKey) {
        upstreamHeaders['x-api-key'] = apiKey;
    }

    if (authorization) {
        upstreamHeaders.authorization = authorization;
    }

    return upstreamHeaders;
}

function buildHeaders(contentLength, requestId = null, upstreamAuthHeaders = {}) {
    return {
        'Host': TARGET_HOST,
        'connection': 'close',
        'content-type': 'application/json',
        'user-agent': 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
        'x-opencode-client': 'desktop',
        'x-opencode-project': 'global',
        'x-opencode-request': requestId || generateRequestId(),
        'x-opencode-session': generateCanonicalSessionId(),
        'accept': '*/*',
        'accept-language': '*',
        'sec-fetch-mode': 'cors',
        'accept-encoding': 'br, gzip, deflate',
        'Content-Length': contentLength,
        ...upstreamAuthHeaders
    };
}

function anthropicToOpenAI(body) {
    const messages = [];

    if (body.system) {
        const systemContent = typeof body.system === 'string'
            ? body.system
            : body.system.map(b => b.text).join('\n');
        messages.push({ role: 'system', content: systemContent });
    }

    for (const msg of body.messages || []) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            const hasToolResult = msg.content.some(b => b.type === 'tool_result');
            if (hasToolResult) {
                for (const block of msg.content) {
                    if (block.type === 'tool_result') {
                        messages.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                        });
                    } else if (block.type === 'text' && block.text) {
                        messages.push({ role: 'user', content: block.text });
                    }
                }
            } else {
                const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
                if (textParts) {
                    messages.push({ role: 'user', content: textParts });
                }
            }
        } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
            const textBlocks = msg.content.filter(b => b.type === 'text');
            if (toolUseBlocks.length) {
                messages.push({
                    role: 'assistant',
                    content: textBlocks.map(b => b.text).join('\n') || null,
                    tool_calls: toolUseBlocks.map(b => ({
                        id: b.id,
                        type: 'function',
                        function: {
                            name: b.name,
                            arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input)
                        }
                    }))
                });
            } else {
                const text = textBlocks.map(b => b.text).join('\n');
                messages.push({ role: 'assistant', content: text });
            }
        } else if (msg.role === 'assistant') {
            messages.push({ role: 'assistant', content: msg.content || '' });
        } else if (msg.role === 'user') {
            messages.push({ role: 'user', content: msg.content || '' });
        }
    }

    const tools = Array.isArray(body.tools)
        ? body.tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema || { type: 'object', properties: {} }
            }
        }))
        : undefined;

    const openaiBody = {
        model: 'mimo-v2.5-free',
        messages,
        max_tokens: body.max_tokens || 4096,
        stream: true
    };

    if (tools) {
        openaiBody.tools = tools;
    }

    if (body.tool_choice) {
        openaiBody.tool_choice = body.tool_choice;
    }

    return openaiBody;
}

function createAnthropicStreamStart(requestId, model) {
    return [
        `event: message_start`,
        `data: ${JSON.stringify({
            type: 'message_start',
            message: {
                id: requestId,
                type: 'message',
                role: 'assistant',
                content: [],
                model,
                stop_reason: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        })}`,
        '',
        ''
    ].join('\n');
}

function createAnthropicContentStart(requestId, index = 0) {
    return [
        `event: content_block_start`,
        `data: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' }
        })}`,
        '',
        ''
    ].join('\n');
}

function createAnthropicContentDelta(text, index = 0) {
    return [
        `event: content_block_delta`,
        `data: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text }
        })}`,
        '',
        ''
    ].join('\n');
}

function createAnthropicContentStop(index = 0) {
    return [
        `event: content_block_stop`,
        `data: ${JSON.stringify({
            type: 'content_block_stop',
            index
        })}`,
        '',
        ''
    ].join('\n');
}

function createAnthropicMessageStop(stopReason = 'end_turn') {
    return [
        `event: message_delta`,
        `data: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 0 }
        })}`,
        '',
        ''
    ].join('\n') + [
        `event: message_stop`,
        `data: ${JSON.stringify({
            type: 'message_stop'
        })}`,
        '',
        ''
    ].join('\n');
}

function createAnthropicToolUseStart(toolUseId, name, index) {
    return [
        `event: content_block_start`,
        `data: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: toolUseId, name, input: {} }
        })}`,
        '',
        ''
    ].join('\n');
}

function createAnthropicToolUseDelta(partialJson, index) {
    return [
        `event: content_block_delta`,
        `data: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: partialJson }
        })}`,
        '',
        ''
    ].join('\n');
}

function mapFinishReason(finishReason) {
    if (finishReason === 'tool_calls') return 'tool_use';
    if (finishReason === 'length') return 'max_tokens';
    return 'end_turn';
}

function injectTools(body) {
    try {
        const parsed = JSON.parse(body.toString());

        const requiredTools = [
            { type: 'function', function: { name: 'bash', description: 'Execute bash command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
            { type: 'function', function: { name: 'glob', description: 'Find files by pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
            { type: 'function', function: { name: 'grep', description: 'Search file contents', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
            { type: 'function', function: { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } }
        ];

        if (!parsed.tools) {
            parsed.tools = requiredTools;
        } else {
            const existingNames = new Set(parsed.tools.map(t => t.function?.name));
            for (const tool of requiredTools) {
                if (!existingNames.has(tool.function.name)) {
                    parsed.tools.push(tool);
                }
            }
        }

        parsed.model = 'mimo-v2.5-free';
        parsed.stream = true;

        return Buffer.from(JSON.stringify(parsed));
    } catch {
        return body;
    }
}

function collectBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

function getRequestPath(reqUrl) {
    return new URL(reqUrl, 'http://127.0.0.1').pathname;
}

function writeJson(clientRes, statusCode, payload, extraHeaders = {}) {
    clientRes.writeHead(statusCode, {
        'Content-Type': 'application/json',
        ...extraHeaders
    });
    clientRes.end(JSON.stringify(payload));
}

function writeMethodNotAllowed(clientRes, allowedMethods) {
    clientRes.writeHead(405, {
        'Content-Type': 'application/json',
        'Allow': allowedMethods.join(', ')
    });
    clientRes.end(JSON.stringify({
        error: 'Method Not Allowed',
        allowed: allowedMethods
    }));
}

function pipeOpenAIStream(requestId, proxySocket, clientRes) {
    let buffer = '';
    let activeBlockType = null;
    let sawToolCall = false;
    let stopReason = 'end_turn';
    let blockIndex = 0;
    let finished = false;

    function startTextBlock() {
        if (activeBlockType === 'text') return;
        if (activeBlockType) {
            clientRes.write(createAnthropicContentStop(blockIndex));
            blockIndex++;
        }
        clientRes.write(createAnthropicContentStart(requestId, blockIndex));
        activeBlockType = 'text';
    }

    function startToolUseBlock(toolUseId, name) {
        if (activeBlockType === 'tool_use') return;
        if (activeBlockType) {
            clientRes.write(createAnthropicContentStop(blockIndex));
            blockIndex++;
        }
        clientRes.write(createAnthropicToolUseStart(toolUseId, name, blockIndex));
        activeBlockType = 'tool_use';
    }

    function finishStream() {
        if (finished) return;
        finished = true;
        if (!activeBlockType) {
            clientRes.write(createAnthropicContentStart(requestId, blockIndex));
        }
        clientRes.write(createAnthropicContentStop(blockIndex));
        clientRes.write(createAnthropicMessageStop(stopReason));
        clientRes.end();
    }

    proxySocket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    finishStream();
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const choice = parsed.choices?.[0] || {};
                    const delta = choice.delta || {};

                    if (choice.finish_reason) {
                        stopReason = mapFinishReason(choice.finish_reason);
                    }

                    const content = delta.content;
                    if (content) {
                        startTextBlock();
                        clientRes.write(createAnthropicContentDelta(content, blockIndex));
                    }

                    const toolCalls = delta.tool_calls || [];
                    for (const toolCall of toolCalls) {
                        const toolUseId = toolCall.id || `toolu_${generateBase62(24)}`;
                        const toolName = toolCall.function?.name || 'tool';
                        const partialArgs = toolCall.function?.arguments;

                        sawToolCall = true;
                        stopReason = 'tool_use';
                        startToolUseBlock(toolUseId, toolName);

                        if (partialArgs) {
                            clientRes.write(createAnthropicToolUseDelta(partialArgs, blockIndex));
                        }
                    }
                } catch { }
            }
        }
    });

    proxySocket.on('end', () => {
        if (sawToolCall && stopReason === 'end_turn') {
            stopReason = 'tool_use';
        }
        finishStream();
    });
}

function pipeOpenAIStreamToOpenAI(proxySocket, clientRes) {
    proxySocket.pipe(clientRes);
}

function estimateTokenCount(value) {
    if (value == null) return 0;
    if (typeof value === 'string') return Math.max(1, Math.ceil(value.length / 4));
    if (Array.isArray(value)) return value.reduce((total, item) => total + estimateTokenCount(item), 0);
    if (typeof value === 'object') return Object.values(value).reduce((total, item) => total + estimateTokenCount(item), 0);
    return Math.max(1, Math.ceil(String(value).length / 4));
}

function countAnthropicTokens(body) {
    let total = 0;
    if (body.system) total += estimateTokenCount(body.system);
    if (body.messages) total += estimateTokenCount(body.messages);
    if (body.tools) total += estimateTokenCount(body.tools);
    if (body.context) total += estimateTokenCount(body.context);
    return Math.max(1, total);
}

async function handleCountTokensRequest(clientReq, clientRes) {
    const requestId = generateRequestId();
    const bodyBuffer = await collectBody(clientReq);

    let body;
    try {
        body = JSON.parse(bodyBuffer.toString() || '{}');
    } catch {
        clientRes.writeHead(400);
        clientRes.end('Invalid JSON');
        return;
    }

    const inputTokens = countAnthropicTokens(body);
    writeJson(clientRes, 200, { input_tokens: inputTokens });
}

async function forwardToTarget(modifiedBody, clientRes, requestId, upstreamAuthHeaders, isAnthropic = false, anthropicRequestId = null, anthropicModel = null) {
    const headers = buildHeaders(modifiedBody.length, requestId, upstreamAuthHeaders);

    logEvent('info', 'forward_to_target', {
        requestId,
        isAnthropic,
        anthropicRequestId,
        anthropicModel,
        hasApiKey: Boolean(upstreamAuthHeaders['x-api-key']),
        hasAuthorization: Boolean(upstreamAuthHeaders.authorization),
        targetHost: TARGET_HOST,
        targetPath: TARGET_PATH,
        headers: redactHeaders(headers),
        bodyPreview: previewBody(modifiedBody)
    });

    const proxySocket = net.connect(PROXY_PORT, PROXY_HOST, () => {
        const connectRequest = [
            `CONNECT ${TARGET_HOST}:443 HTTP/1.1`,
            `Host: ${TARGET_HOST}:443`,
            '',
            ''
        ].join('\r\n');

        proxySocket.write(connectRequest);
    });

    let proxyResponse = '';
    proxySocket.once('data', (data) => {
        proxyResponse += data.toString();
        if (proxyResponse.includes('\r\n\r\n')) {
            const https = require('https');
            const options = {
                host: TARGET_HOST,
                port: 443,
                path: TARGET_PATH,
                method: 'POST',
                headers: headers,
                socket: proxySocket,
                agent: false
            };

            const targetReq = https.request(options, (targetRes) => {
                logUpstreamResponse(requestId, targetRes.statusCode, targetRes.headers);

                const responseHeaders = {
                    'Content-Type': targetRes.headers['content-type'] || 'application/json',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                };

                if (targetRes.headers['content-type']?.includes('text/event-stream')) {
                    responseHeaders['X-Accel-Buffering'] = 'no';
                }

                clientRes.writeHead(targetRes.statusCode, responseHeaders);

                if (targetRes.statusCode >= 400) {
                    const errorChunks = [];

                    targetRes.on('data', (chunk) => {
                        errorChunks.push(chunk);
                    });

                    targetRes.on('end', () => {
                        const errorBody = Buffer.concat(errorChunks);
                        logEvent('error', 'upstream_error_body', {
                            requestId,
                            statusCode: targetRes.statusCode,
                            preview: previewBody(errorBody, 12000)
                        });

                        if (!clientRes.writableEnded) {
                            clientRes.end(errorBody);
                        }
                    });

                    return;
                }

                if (isAnthropic && targetRes.headers['content-type']?.includes('text/event-stream')) {
                    clientRes.write(createAnthropicStreamStart(anthropicRequestId, anthropicModel));
                    pipeOpenAIStream(requestId, targetRes, clientRes);
                } else {
                    targetRes.pipe(clientRes);
                }
            });

            targetReq.on('error', (err) => {
                logRequestError(requestId, 'target_request_error', err);
                if (!clientRes.headersSent) {
                    clientRes.writeHead(502);
                }
                clientRes.end('Bad Gateway');
            });

            targetReq.write(modifiedBody);
            targetReq.end();
        }
    });

    proxySocket.on('error', (err) => {
        logRequestError(requestId, 'proxy_socket_error', err);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502);
        }
        clientRes.end('Bad Gateway');
    });
}

async function handleOpenAIRequest(clientReq, clientRes) {
    const requestId = generateRequestId();
    const pathname = getRequestPath(clientReq.url || '/');
    logRequestStart(requestId, clientReq, pathname);
    const upstreamAuthHeaders = getUpstreamAuthHeaders(clientReq);

    const originalBody = await collectBody(clientReq);
    logRequestBody(requestId, 'openai_original', originalBody);

    const modifiedBody = injectTools(originalBody);
    logRequestBody(requestId, 'openai_modified', modifiedBody);

    await forwardToTarget(modifiedBody, clientRes, requestId, upstreamAuthHeaders, false);
}

async function handleAnthropicRequest(clientReq, clientRes) {
    const requestId = generateRequestId();
    const pathname = getRequestPath(clientReq.url || '/');
    logRequestStart(requestId, clientReq, pathname);
    const upstreamAuthHeaders = getUpstreamAuthHeaders(clientReq);

    const originalBody = await collectBody(clientReq);
    logRequestBody(requestId, 'anthropic_original', originalBody);

    let anthropicBody;
    try {
        anthropicBody = JSON.parse(originalBody.toString());
    } catch {
        logEvent('warn', 'invalid_json', {
            requestId,
            pathname,
            preview: previewBody(originalBody)
        });
        clientRes.writeHead(400);
        clientRes.end('Invalid JSON');
        return;
    }

    const openaiBody = anthropicToOpenAI(anthropicBody);
    const modifiedBody = injectTools(Buffer.from(JSON.stringify(openaiBody)));
    logRequestBody(requestId, 'anthropic_transformed', modifiedBody);

    const anthropicStreamId = generateAnthropicId();

    await forwardToTarget(modifiedBody, clientRes, requestId, upstreamAuthHeaders, true, anthropicStreamId, anthropicBody.model);
}

const server = http.createServer(async (clientReq, clientRes) => {
    const pathname = getRequestPath(clientReq.url || '/');
    const requestId = generateRequestId();

    logRequestStart(requestId, clientReq, pathname);

    if (clientReq.method === 'GET' && pathname === HEALTH_ENDPOINT) {
        logEvent('info', 'health_check', { requestId, pathname });
        return writeJson(clientRes, 200, {
            status: 'ok',
            service: 'api-proxy'
        });
    }

    if (clientReq.method === 'GET' && pathname === MODELS_ENDPOINT) {
        return writeJson(clientRes, 200, {
            object: 'list',
            data: [
                { id: 'mimo-v2.5-free', object: 'model', owned_by: 'opencode' },
                { id: 'claude-3-5-sonnet', object: 'model', owned_by: 'anthropic' },
                { id: 'claude-3-5-haiku', object: 'model', owned_by: 'anthropic' }
            ]
        });
    }

    if (clientReq.method === 'POST' && pathname === COUNT_TOKENS_ENDPOINT) {
        return handleCountTokensRequest(clientReq, clientRes);
    }

    if (pathname === OPENAI_ENDPOINT || pathname === ANTHROPIC_ENDPOINT) {
        if (clientReq.method !== 'POST') {
            logEvent('warn', 'method_not_allowed', {
                requestId,
                pathname,
                method: clientReq.method
            });
            return writeMethodNotAllowed(clientRes, ['POST']);
        }
    }

    if (clientReq.method === 'POST' && pathname === OPENAI_ENDPOINT) {
        return handleOpenAIRequest(clientReq, clientRes);
    }

    if (clientReq.method === 'POST' && pathname === ANTHROPIC_ENDPOINT) {
        return handleAnthropicRequest(clientReq, clientRes);
    }

    logEvent('warn', 'not_found', {
        requestId,
        pathname,
        method: clientReq.method,
        url: clientReq.url
    });
    clientRes.writeHead(404);
    clientRes.end('Not Found');
});

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
    console.log(`API Proxy running on http://localhost:${PORT}`);
    console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`Target: ${TARGET_HOST}`);
    console.log(`OpenAI Endpoint: POST ${OPENAI_ENDPOINT}`);
    console.log(`Anthropic Endpoint: POST ${ANTHROPIC_ENDPOINT}`);
    console.log(`Models: GET ${MODELS_ENDPOINT}`);
    console.log(`Health: GET ${HEALTH_ENDPOINT}`);
});
