// 子程序夾具（由 tests/regression/single-instance.test.ts 用 `node --import tsx` 啟動）：
// 用真實的 startServer 啟動一個實例（替身 adapter，不聯網），建立一個執行到一半的任務（tool-A 已完成、run 仍在 RUNNING），
// 列印 READY 後保持存活，等待父程序驗證“第二個實例被拒絕”，再由父程序強殺它，模擬強殺/斷電後殘留的鎖。
import { startServer } from '@acc/server';
import { FakeWorld, ScriptedAdapter } from '../../fakes/scripted-adapter.ts';

const [dataDir, workspace, home] = process.argv.slice(2);
const world = new FakeWorld();
const server = await startServer({
  env: { ACC_DATA_DIR: dataDir, ACC_WORKSPACE: workspace, INIT_CWD: workspace, ACC_RUNTIME_MODE: 'mock' },
  homedir: home,
  cwd: workspace,
  port: 0,
  host: '127.0.0.1',
  quiet: true,
  logLevel: 'silent',
  installProcessGuards: false,
  serveWeb: false,
  adapters: () => [new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }])],
  instanceLock: { retries: 0, heartbeatMs: 0 },
});
// P0-1 之後 API 需要登入：用啟動令牌（Bearer）
const response = await server.app.inject({
  method: 'POST',
  url: '/api/tasks',
  headers: { authorization: `Bearer ${server.accessToken}` },
  payload: { prompt: 'do work', agentId: 'claude' },
});
const task = response.json();
await server.orchestrator.idle();
process.stdout.write(`READY ${JSON.stringify({ instanceId: server.instanceId, taskId: task.id, runId: task.runId, pid: process.pid })}\n`);
// 保持存活：控制代碼與鎖一直被本程序佔用，直到被父程序強殺
setInterval(() => undefined, 1 << 30);
