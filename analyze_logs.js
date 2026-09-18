const log = require('fs').readFileSync('logs/proxy.log', 'utf8').trim().split('\n');
const entries = log.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const bodies = entries.filter(e => e.event === 'request_body' && e.label === 'anthropic_original');
bodies.forEach(e => {
  const p = e.preview || '';
  const hasSafety = p.includes('safety') || p.includes('classifier') || p.includes('auto mode');
  const hasToolUse = p.includes('tool_use');
  const hasMcp = p.includes('mcp__');
  const modelMatch = p.match(/model....([^,]+)/);
  console.log(e.requestId + ' | safety=' + hasSafety + ' | tool_use=' + hasToolUse + ' | mcp=' + hasMcp + ' | model=' + (modelMatch ? modelMatch[1] : '?'));
});
