/**
 * 事件處理耗時基準（P2-10 / L-5）：連續 N 次工具呼叫（每次 tool.started + tool.completed），
 * 報告開頭和最後 500 個事件的平均耗時與快照大小。用法：npx tsx scripts/bench-events.ts [N]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { ControlledAgent } from '../tests/regression/fakes/controlled-agent.js';

const N = Number(process.argv[2] ?? 6000);
const dir = mkdtempSync(join(tmpdir(), 'acc-bench-'));
const store = new SqliteControlPlaneStore({ path: join(dir, 'bench.db') });
const bus = new EventBus({ log: () => undefined });
const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: () => undefined });
const agent = new ControlledAgent({ id: 'claude', kind: 'claude' });
orchestrator.registerAdapter(agent);
const task = await orchestrator.createTask({ title: 'bench', prompt: 'p', agentId: 'claude', workflow: 'manual', maxTurns: 1_000_000 } as never);
await orchestrator.idle();
const times: number[] = [];
for (let i = 0; i < N; i += 1) {
  const t0 = performance.now();
  await agent.emit('tool.started', { providerCallId: `call-${i}`, toolName: 'Read', input: { file_path: `src/file-${i}.ts` } });
  await agent.emit('tool.completed', { providerCallId: `call-${i}`, toolName: 'Read', output: 'x'.repeat(200) });
  times.push((performance.now() - t0) / 2);
}
await orchestrator.idle();
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const run = await store.getRun(task.runId);
console.log(`N=${N} 前 500 次：${avg(times.slice(0, 500)).toFixed(2)} ms/事件；最後 500 次：${avg(times.slice(-500)).toFixed(2)} ms/事件；快照 ${(JSON.stringify(run).length / 1024).toFixed(0)} KB`);
if (process.env.BENCH_FIELDS) {
  const sizes = Object.entries(run as unknown as Record<string, unknown>).map(([k, v]) => [k, JSON.stringify(v ?? null).length] as const).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(sizes.map(([k, n]) => `${k}=${(n / 1024).toFixed(0)}KB`).join(' '));
}
await orchestrator.shutdown();
store.close?.();
rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
