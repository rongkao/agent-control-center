import { describe, expect, it } from 'vitest';
import { projectEvent, summarizeTask } from '@acc/core';
import type { PendingApproval } from '@acc/core';
import { makeEvent, makeRun, makeTask } from '../helpers.js';

/**
 * P0-5（M-5）：審批只能恢復“因審批而暫停”的狀態；run 進入終態時作廢全部待審批。
 *
 * 復現（docs/analysis-probes/refute-approval.ts，probe 場景 10）：審批等待中被安全攔截（BLOCKED），
 * 之後批准最後一條審批，投影無條件把 BLOCKED 改回 RUNNING，fail-closed 的阻塞被繞過。
 * 第一批返修已經讓 BLOCKED 在審批後保持；本組在此基礎上：
 * - 記錄阻塞原因 blockedBy（來源 + 程式碼 + 觸發事件），離開 BLOCKED 時清除；
 * - 只有 WAITING_APPROVAL（因審批而暫停）才能由審批恢復為 RUNNING：評審閘門（WAITING_INPUT）不會被一次批准繞過；
 * - run 進入終態的同一次投影裡，全部待審批標為作廢（voided），待輸入與暫停遊標一併清空；
 * - 終態之後才到的 approval.required 不再登記為待審批，直接按拒絕記錄。
 */

const pending = (id: string, payload: Record<string, unknown> = {}): PendingApproval => ({ id, agentId: 'claude', summary: id, payload, createdAt: 1, status: 'pending' });

describe('M-5：審批只恢復“因審批而暫停”的狀態（probe 場景 10）', () => {
  it('等待審批時被安全攔截：批准後仍為 BLOCKED，blockedBy 指向安全攔截', () => {
    const task = makeTask({ status: 'RUNNING' });
    const run = makeRun({ status: 'RUNNING', workflow: 'manual' });
    projectEvent(task, run, makeEvent(1, { type: 'approval.required', agentId: 'claude', data: { approvalId: 'a1', summary: 'rm -rf' } }));
    expect(run.status).toBe('WAITING_APPROVAL');
    projectEvent(task, run, makeEvent(2, { id: 'safety-evt', type: 'safety.blocked', agentId: 'codex', data: { code: 'CODEX_CYBER_POLICY' } }));
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'safety', code: 'CODEX_CYBER_POLICY', eventId: 'safety-evt', agentId: 'codex' });

    const result = projectEvent(task, run, makeEvent(3, { type: 'approval.resolved', agentId: 'claude', data: { approvalId: 'a1', decision: 'approve' } }));
    expect(run.status).toBe('BLOCKED');
    expect(result.statusChanged).toBe(false);
    expect(run.pendingApprovals).toEqual([]);
    // 阻塞原因不因審批而改變
    expect(run.blockedBy).toMatchObject({ source: 'safety', code: 'CODEX_CYBER_POLICY' });
  });

  it('交接審批期間預算超限：拒絕交接後仍為 BLOCKED，blockedBy 指向預算', () => {
    const task = makeTask({ status: 'RUNNING' });
    const run = makeRun({ status: 'RUNNING', workflow: 'manual' });
    projectEvent(task, run, makeEvent(1, { type: 'approval.required', agentId: 'claude', data: { approvalId: 'h1', kind: 'handoff' } }));
    projectEvent(task, run, makeEvent(2, { type: 'budget.exceeded', data: { limit: 'maxTurns', step: 'budget:maxTurns' } }));
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxTurns' });
    projectEvent(task, run, makeEvent(3, { type: 'approval.resolved', agentId: 'claude', data: { approvalId: 'h1', decision: 'decline' } }));
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxTurns' });
  });

  it('評審閘門（WAITING_INPUT）期間批准一條審批：仍停在閘門，待輸入與暫停遊標都保留', () => {
    const task = makeTask({ status: 'WAITING_INPUT' });
    const run = makeRun({
      status: 'WAITING_INPUT',
      currentStep: 'workflow:review-gate',
      pendingInputs: [{ id: 'review-gate', prompt: 'Tests passed', createdAt: 1 }],
      resumeCursor: { step: 'workflow:test', reason: 'input' },
    });
    projectEvent(task, run, makeEvent(1, { type: 'approval.required', agentId: 'codex', data: { approvalId: 'a1', summary: 'cat file' } }));
    // WAITING_INPUT 不能轉到 WAITING_APPROVAL：仍是閘門，只多了一條待審批
    expect(run.status).toBe('WAITING_INPUT');
    projectEvent(task, run, makeEvent(2, { type: 'approval.resolved', agentId: 'codex', data: { approvalId: 'a1', decision: 'approve' } }));
    expect(run.status).toBe('WAITING_INPUT');
    expect(task.status).toBe('WAITING_INPUT');
    expect(run.pendingInputs.map((x) => x.id)).toEqual(['review-gate']);
    expect(run.resumeCursor).toEqual({ step: 'workflow:test', reason: 'input' });
    expect(run.pendingApprovals).toEqual([]);
  });

  it('WAITING_APPROVAL 時批准最後一條審批：照常恢復 RUNNING', () => {
    const task = makeTask({ status: 'WAITING_APPROVAL' });
    const run = makeRun({ status: 'WAITING_APPROVAL', pendingApprovals: [pending('a1')], resumeCursor: { step: 'workflow:implement', reason: 'approval', approvalId: 'a1' } });
    projectEvent(task, run, makeEvent(1, { type: 'approval.resolved', agentId: 'claude', data: { approvalId: 'a1', decision: 'approve' } }));
    expect(run.status).toBe('RUNNING');
    expect(run.currentStep).toBe('workflow:implement');
    expect(run.blockedBy).toBeUndefined();
  });

  it('拒絕審批進入 BLOCKED：blockedBy 記錄是哪一條審批；之後經閘門離開 BLOCKED 時清除', () => {
    const task = makeTask({ status: 'WAITING_APPROVAL' });
    const run = makeRun({ status: 'WAITING_APPROVAL', pendingApprovals: [pending('a1')], resumeCursor: { step: 'workflow:implement', reason: 'approval', approvalId: 'a1' } });
    projectEvent(task, run, makeEvent(1, { id: 'decline-evt', type: 'approval.resolved', agentId: 'claude', data: { approvalId: 'a1', decision: 'decline' } }));
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'approval', code: 'APPROVAL_DECLINED', approvalId: 'a1', eventId: 'decline-evt' });
    expect(summarizeTask(task, run).blockedBy).toMatchObject({ source: 'approval', code: 'APPROVAL_DECLINED' });

    projectEvent(task, run, makeEvent(2, { type: 'run.status', data: { status: 'RUNNING', step: 'workflow:gate-retry' } }));
    expect(run.status).toBe('RUNNING');
    expect(run.blockedBy).toBeUndefined();
    expect(summarizeTask(task, run).blockedBy).toBeUndefined();
  });

  it('編排器 fail closed（run.status BLOCKED + blocked:<code>）與工作流阻塞都記錄程式碼', () => {
    const task = makeTask();
    const run = makeRun();
    projectEvent(task, run, makeEvent(1, { type: 'run.status', data: { status: 'BLOCKED', step: 'blocked:SESSION_OWNERSHIP_CONFLICT', action: 'conflict' } }));
    expect(run.blockedBy).toMatchObject({ source: 'runtime', code: 'SESSION_OWNERSHIP_CONFLICT' });

    const task2 = makeTask();
    const run2 = makeRun();
    projectEvent(task2, run2, makeEvent(1, { type: 'run.status', data: { status: 'BLOCKED', step: 'workflow:TESTS_FAILED', code: 'TESTS_FAILED' } }));
    expect(run2.blockedBy).toMatchObject({ source: 'workflow', code: 'TESTS_FAILED' });
  });
});

describe('H-5：run 進入終態時作廢全部待審批', () => {
  it('取消時同一次投影裡把兩條待審批都標為 voided，待輸入和暫停遊標一併清空', () => {
    const task = makeTask({ status: 'WAITING_APPROVAL' });
    const run = makeRun({
      status: 'WAITING_APPROVAL',
      pendingApprovals: [pending('a1'), { ...pending('a2'), agentId: 'codex' }],
      pendingInputs: [{ id: 'review-gate', prompt: 'x', createdAt: 1 }],
      resumeCursor: { step: 'agent:claude', reason: 'approval', approvalId: 'a1' },
    });
    const result = projectEvent(task, run, makeEvent(5, { type: 'run.status', data: { status: 'CANCELLED', step: 'cancelled' } }));
    expect(run.status).toBe('CANCELLED');
    expect(run.pendingApprovals).toEqual([]);
    expect(run.pendingInputs).toEqual([]);
    expect(run.resumeCursor).toBeUndefined();
    expect(result.approvals.map((x) => [x.id, x.agentId, x.status])).toEqual([
      ['a1', 'claude', 'voided'],
      ['a2', 'codex', 'voided'],
    ]);
    expect(result.approvals[0]?.decision).toMatchObject({ resolvedBy: 'orchestrator', reason: 'run-terminal', runStatus: 'CANCELLED' });
    expect(result.approvals[0]?.resolvedAt).toBe(1005);
  });

  it('run.completed 同樣作廢遺留的待審批', () => {
    const task = makeTask({ status: 'RUNNING' });
    const run = makeRun({ status: 'RUNNING', pendingApprovals: [pending('a1')] });
    const result = projectEvent(task, run, makeEvent(5, { type: 'run.completed', data: { reason: 'Accepted by operator' } }));
    expect(run.status).toBe('COMPLETED');
    expect(run.pendingApprovals).toEqual([]);
    expect(result.approvals).toEqual([expect.objectContaining({ id: 'a1', status: 'voided' })]);
  });

  it('終態之後才到的 approval.required：不登記為待審批，直接按拒絕記錄', () => {
    const task = makeTask({ status: 'CANCELLED' });
    const run = makeRun({ status: 'CANCELLED' });
    const result = projectEvent(task, run, makeEvent(9, { type: 'approval.required', agentId: 'claude', data: { approvalId: 'late', summary: 'rm -rf', providerCallId: 'toolu_late' } }));
    expect(run.status).toBe('CANCELLED');
    expect(run.pendingApprovals).toEqual([]);
    expect(run.resumeCursor).toBeUndefined();
    expect(result.approvals).toEqual([
      expect.objectContaining({ id: 'late', status: 'declined', providerCallId: 'toolu_late', decision: expect.objectContaining({ decision: 'decline', resolvedBy: 'orchestrator', reason: 'run-terminal' }) }),
    ]);
  });
});
