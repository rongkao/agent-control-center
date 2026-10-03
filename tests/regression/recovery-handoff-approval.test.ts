import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter, CreateTaskInput } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * P0 第二批審查（P0-5 / H-5，probe3 B 同類）：重啟恢復不能漏掉“有待處理的交接審批、但仍在工作”的 agent。
 *
 * 復現（修復前）：Claude 在一輪中途呼叫 request_handoff，工具立即返回，Claude 繼續把這一輪做完；ask 策略下生成 kind=handoff 的審批，
 * approval.agentId 就是 Claude，run 進入 WAITING_APPROVAL。這時服務重啟：recover 用“有待審批的 agent”把 Claude 排除在續跑之外，
 * 預設它已經因為審批暫停。可是交接審批並不會暫停請求者，批准交接也只投遞交接、不續跑 Claude：
 * report={resumed:[], waiting:[run]}，Claude 沒有被續接（calls=[]），會話停在 waiting，工作流一直等它的完成訊號。
 *
 * 期望：交接審批不算“因審批暫停”——這樣的 agent 照常續跑（續不上就 fail closed 並指明是它）。
 */

const quiet = () => undefined;

function boot(adapters: AgentAdapter[], store: InMemoryControlPlaneStore, instanceId: string) {
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet, instanceId });
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return orchestrator;
}

const claudeAgent = (options: { resumable?: boolean } = {}) => new ControlledAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] }, options);
const codexAgent = () => new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] }, [], { kind: 'reply', text: 'reviewed' });
const testAgent = () => new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });

const HANDOFF = { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'Please review the diff', content: 'diff summary' };

/** 程序 1：Claude 在一輪中途請求交接（ask 策略 → 審批），這一輪還沒做完；然後程序直接結束。 */
async function requestHandoffThenRestart(input: CreateTaskInput, claudeAfterRestart: ControlledAgent) {
  const store = new InMemoryControlPlaneStore();
  const claude1 = claudeAgent();
  const first = boot([claude1, codexAgent(), testAgent()], store, 'instance-1');
  const task = await first.createTask(input);
  await first.idle();
  await claude1.emit('handoff.requested', HANDOFF);
  await first.idle();
  const before = (await store.getRun(task.runId))!;
  expect(before.status).toBe('WAITING_APPROVAL');
  expect(before.pendingApprovals).toEqual([expect.objectContaining({ agentId: 'claude', payload: expect.objectContaining({ kind: 'handoff' }) })]);
  expect(before.agentSessions.claude?.status).toBe('coding');

  const codex2 = codexAgent();
  const tester2 = testAgent();
  const second = boot([claudeAfterRestart, codex2, tester2], store, 'instance-2');
  const report = await second.recover();
  await second.idle();
  return { store, task, report, second, codex2, tester2, approvalId: before.pendingApprovals[0]!.id };
}

describe('交接審批待處理時重啟：請求者仍在工作，照常續跑', () => {
  it('對話任務：Claude 被續跑；之後批准交接，Codex 收到轉交內容', async () => {
    const claude2 = claudeAgent();
    const { store, task, report, second, codex2, approvalId } = await requestHandoffThenRestart({ title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual' }, claude2);

    expect(report.waiting).toEqual([task.runId]);
    expect(claude2.calls).toEqual([expect.objectContaining({ via: 'resume', reason: 'recovery' })]);
    expect(second.liveAgentIds(task.runId)).toEqual(['claude']);
    expect((await store.getRun(task.runId))?.agentSessions.claude?.status).toBe('coding');

    await second.resolveApproval(task.id, approvalId, 'approve');
    await second.idle();
    expect(codex2.calls).toHaveLength(1);
    expect(codex2.calls[0]?.prompt).toContain('diff summary');
    expect((await store.getRun(task.runId))?.status).toBe('RUNNING');
  });

  it('工作流任務：Claude 被續跑，它的完成訊號在審批期間快取，批准交接後流程繼續到測試並完成', async () => {
    const claude2 = claudeAgent();
    const { store, task, report, second, tester2, approvalId } = await requestHandoffThenRestart({ title: 'fix', prompt: 'Fix the login bug', agentId: 'claude', testCommand: 'npm test' }, claude2);

    expect(report.waiting).toEqual([task.runId]);
    expect(claude2.calls).toEqual([expect.objectContaining({ via: 'resume', reason: 'recovery', mode: 'implement' })]);

    // 續上的 Claude 把這一輪做完：等待審批期間的完成訊號被快取
    await claude2.complete('implemented');
    await second.idle();
    expect((await store.getRun(task.runId))?.status).toBe('WAITING_APPROVAL');

    await second.resolveApproval(task.id, approvalId, 'approve');
    await second.idle();
    expect(tester2.calls).toHaveLength(1);
    expect((await store.getRun(task.runId))?.status).toBe('COMPLETED');
  });

  it('請求者的執行時不能續接：fail closed 為 BLOCKED，並指明是 Claude（不再被靜默丟下）', async () => {
    const claude2 = claudeAgent({ resumable: false });
    const { store, task, report } = await requestHandoffThenRestart({ title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual' }, claude2);

    expect(report.blocked).toEqual([task.runId]);
    const run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    const incident = (await store.listEvents(task.runId)).find((e) => e.type === 'runtime.error' && e.data.code === 'RUNTIME_DISCONNECTED');
    expect(incident?.agentId).toBe('claude');
  });
});
