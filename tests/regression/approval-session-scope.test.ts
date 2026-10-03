import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter, AgentInfo, AgentSessionHandle, AgentStartInput, ApprovalDecision, EventSink } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { approvalRisk, sessionScopeOffered } from '../../apps/web/src/approval-ui.js';

/**
 * P0-8 / M-15：「本會話都允許」只在執行時允許時提供，並且只能是會話級。
 *
 * - 審批請求帶 allowSessionScope=false（Claude 的 suppressAlwaysAllowRule、沒有可用的會話級規則，或者命令涉及受保護路徑）時，
 *   介面不提供「本會話都允許」；
 * - 即使有人繞過介面直接用 API 發 scope=session，編排器也只按“這一次”批准（記錄裡寫明降級），adapter 收到的是 once。
 */

const base = { severity: 'warning' as const, confidence: 'confirmed' as const };

/** start 之後立刻發出一個審批請求，記錄收到的批准決定。 */
class ApprovalAgent implements AgentAdapter {
  readonly info: AgentInfo = { id: 'claude', name: 'Claude', kind: 'claude', ready: true, capabilities: ['implement', 'analysis'] };
  readonly decisions: ApprovalDecision[] = [];

  constructor(private readonly payload: Record<string, unknown>) {}

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    const ids = { projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: this.info.id, sessionId: 'claude-1' };
    await emit({ ...ids, ...base, severity: 'info', type: 'agent.started', data: {} });
    await emit({ ...ids, ...base, type: 'approval.required', data: { approvalId: 'appr-1', providerCallId: 'toolu-1', toolName: 'Bash', toolInput: { command: 'npm test' }, summary: 'Run npm test', ...this.payload } });
    return { sessionId: 'claude-1', providerSessionId: 'native-1' };
  }

  async send(): Promise<void> {}

  async cancel(): Promise<void> {}

  async approve(_sessionId: string, decision: ApprovalDecision): Promise<void> {
    this.decisions.push(decision);
  }
}

async function run(payload: Record<string, unknown>, scope: 'once' | 'session') {
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus());
  const agent = new ApprovalAgent(payload);
  orchestrator.registerAdapter(agent);
  const task = await orchestrator.createTask({ title: 't', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
  await orchestrator.idle();
  await orchestrator.resolveApproval(task.id, 'appr-1', 'approve', scope);
  await orchestrator.idle();
  const resolved = (await store.listEvents(task.runId)).find((event) => event.type === 'approval.resolved');
  return { agent, resolved };
}

describe('M-15：會話級批准只在允許時生效', () => {
  it('執行時不允許會話級（allowSessionScope=false）：scope=session 被降級為只批准這一次，並記錄下來', async () => {
    const { agent, resolved } = await run({ allowSessionScope: false }, 'session');
    expect(agent.decisions.map((d) => d.scope)).toEqual(['once']);
    expect(resolved?.data.scope).toBe('once');
    expect(resolved?.data.scopeDowngraded).toBe(true);
  });

  it('允許時照常按會話級轉給 adapter（由 adapter 負責只給會話級規則）', async () => {
    const { agent, resolved } = await run({ allowSessionScope: true }, 'session');
    expect(agent.decisions.map((d) => d.scope)).toEqual(['session']);
    expect(resolved?.data.scope).toBe('session');
  });
});

describe('介面：什麼時候提供「本會話都允許」、什麼時候標成高風險', () => {
  it('allowSessionScope=false、交接請求：不提供；沒有這個欄位（舊記錄）時沿用原來的行為', () => {
    expect(sessionScopeOffered({ allowSessionScope: false })).toBe(false);
    expect(sessionScopeOffered({ kind: 'handoff', allowSessionScope: true })).toBe(false);
    expect(sessionScopeOffered({ allowSessionScope: true })).toBe(true);
    expect(sessionScopeOffered({})).toBe(true);
    expect(sessionScopeOffered(undefined)).toBe(true);
  });

  it('risk=high 時給出中文的高風險提示', () => {
    expect(approvalRisk({ risk: 'high', riskReason: '命令涉及受保護的路徑：.git/hooks' })).toEqual({ level: 'high', text: '命令涉及受保護的路徑：.git/hooks' });
    expect(approvalRisk({ risk: 'high' })?.level).toBe('high');
    expect(approvalRisk({})).toBeUndefined();
  });
});
