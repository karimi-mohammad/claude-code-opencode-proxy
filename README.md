# claude-code-opencode-proxy

Local HTTP proxy that accepts Claude Code-style Anthropic requests and forwards them to `opencode.ai` after rewriting the payload and headers.

## What it does

- Exposes `POST /v1/messages`
- Exposes `POST /v1/chat/completions`
- Exposes `GET /v1/models`
- Exposes `GET /health`
- Logs incoming requests to `logs/proxy.log` at runtime
- Overrides every incoming model to `mimo-v2.5-free`
- Forwards caller auth headers upstream so the target service can see the API key from the client

## Requirements

- Node.js 18+
- A running upstream proxy on `127.0.0.1:22213` that can reach `opencode.ai`

## Run

```bash
npm start
```

Optional environment variables:

- `PORT` sets the local HTTP port, default `3001`
- `PROXY_PORT` sets the upstream tunnel port, default `22213`

Example:

```bash
PORT=3001 PROXY_PORT=22213 npm start
```

On Windows PowerShell:

```powershell
$env:PORT = 3001
$env:PROXY_PORT = 22213
npm start
```

## Endpoints

- `GET /health` returns a simple health response
- `GET /v1/models` returns the advertised model list
- `POST /v1/messages` accepts Anthropic-compatible payloads
- `POST /v1/chat/completions` accepts OpenAI-style payloads

## Logging

Runtime logs are written to `logs/proxy.log`. The file is ignored by git so request data and upstream responses are not committed.

## Notes

- The proxy is designed for local use.
- Do not commit API keys, tokens, or generated logs.
