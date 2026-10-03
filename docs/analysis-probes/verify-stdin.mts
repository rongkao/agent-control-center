import { CodexRpcClient, spawnCodexTransport } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/adapters/src/codex-rpc.ts';
process.on('exit', (c) => console.log('process exit code', c));
// 模拟 codex 已关闭 stdin 但外层 shell 仍存活
const transport = spawnCodexTransport({ command: 'node -e "process.stdin.destroy(); setTimeout(()=>{}, 1500)"' });
const client = new CodexRpcClient(transport);
client.onClose((r) => console.log('client closed:', r));
setTimeout(() => {
  try { client.respond(7, { decision: 'accept' }); console.log('respond returned without throw'); } catch (e) { console.log('sync throw', (e as Error).message); }
  client.request('turn/start', { x: 'y'.repeat(100000) }, 2000).then(() => console.log('resolved'), (e) => console.log('request rejected:', e.message));
}, 700);
setTimeout(() => console.log('survived'), 2500);
