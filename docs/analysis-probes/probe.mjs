import { createRequire } from 'node:module';
const require = createRequire('D:/codes/ai/AgentBox/agent-control-center-claude/apps/server/package.json');
const Fastify = require('fastify');
const app = Fastify();
let hits = 0;
app.post('/api/tasks/:taskId/cancel', async () => { hits++; return { ok: true }; });
const tests = [
  ['no body, no CT', {}],
  ['no body, Origin evil', { headers: { origin: 'https://evil.example' } }],
  ['text/plain form body', { headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, payload: 'a=b' }],
  ['urlencoded form body', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, payload: 'a=b' }],
  ['urlencoded empty', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, payload: '' }],
  ['multipart', { headers: { 'content-type': 'multipart/form-data; boundary=x', origin: 'https://evil.example' }, payload: '--x--' }],
];
for (const [name, opts] of tests) {
  const res = await app.inject({ method: 'POST', url: '/api/tasks/abc/cancel', ...opts });
  console.log(name, res.statusCode, res.headers['access-control-allow-origin'] ?? '-', res.body);
}
console.log('hits', hits);
