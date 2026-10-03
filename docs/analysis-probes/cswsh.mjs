import { createRequire } from 'node:module';
const require = createRequire('D:/codes/ai/AgentBox/agent-control-center-claude/package.json');
const WebSocket = require('ws');
const base = 'http://127.0.0.1:18917';
const ws = new WebSocket('ws://127.0.0.1:18917/ws/events', { headers: { Origin: 'https://evil.example' } });
const got = [];
ws.on('unexpected-response', (_req, res) => { console.log('REJECTED status', res.statusCode); process.exit(0); });
ws.on('error', (e) => { console.log('ERR', e.message); process.exit(0); });
ws.on('message', (d) => got.push(JSON.parse(d.toString())));
ws.on('open', async () => {
  console.log('OPEN accepted with foreign Origin');
  const r = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'SECRET-PROMPT-XYZ do something', workflow: 'manual', agentId: 'claude' }) });
  console.log('create task status', r.status);
  await new Promise((r) => setTimeout(r, 3000));
  console.log('received events:', got.length);
  console.log('types:', [...new Set(got.map((e) => e.type))].join(','));
  console.log('contains secret prompt:', JSON.stringify(got).includes('SECRET-PROMPT-XYZ'));
  ws.close(); process.exit(0);
});
