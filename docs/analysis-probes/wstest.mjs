import WebSocket from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/node_modules/ws/wrapper.mjs';
const ws = new WebSocket('ws://127.0.0.1:18799/ws/events', { headers: { Origin: 'https://evil.example.com' } });
const got = [];
ws.on('open', async () => {
  console.log('OPEN accepted with foreign Origin');
  const r = await fetch('http://127.0.0.1:18799/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'SECRET-PROMPT-xyz', workflow: 'manual', agentId: 'claude' }) });
  console.log('create status', r.status);
  setTimeout(() => { console.log('events received:', got.length, 'containsPrompt:', got.some(m => m.includes('SECRET-PROMPT-xyz'))); console.log(got.slice(0,3).map(s=>s.slice(0,200)).join('\n')); ws.close(); process.exit(0); }, 2500);
});
ws.on('message', (m) => got.push(String(m)));
ws.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
ws.on('unexpected-response', (req, res) => { console.log('REJECTED', res.statusCode); process.exit(0); });
