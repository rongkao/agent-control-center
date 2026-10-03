import { projectEvent } from 'D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/projection.ts';
import { createBudgetSnapshot } from 'D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/budget.ts';
const task: any = { id: 't', projectId: 'p', title: 'x', prompt: 'x', status: 'RUNNING', workflow: 'manual', runId: 'r', createdAt: 1, updatedAt: 1 };
const run: any = { schemaVersion: 4, runId: 'r', projectId: 'p', taskId: 't', status: 'RUNNING', workflow: 'manual', currentStep: 's', currentAgentId: 'claude', agentSessions: {}, pendingApprovals: [], pendingInputs: [], budget: createBudgetSnapshot(), completedSideEffects: [], progressSinceLastTurn: false, lastSequence: 0, createdAt: 1, updatedAt: 1 };
let seq = 0;
const ev = (type: string, data: any, agentId = 'claude') => ({ id: 'e' + (++seq), projectId: 'p', taskId: 't', runId: 'r', agentId, type, severity: 'info', confidence: 'confirmed', timestamp: 1000 + seq, sequence: seq, data });
projectEvent(task, run, ev('approval.required', { approvalId: 'a1', summary: 'rm -rf' }) as any);
console.log('after approval.required', run.status);
projectEvent(task, run, ev('safety.blocked', { code: 'CODEX_CYBER_POLICY' }, 'codex') as any);
console.log('after safety.blocked', run.status);
const r = projectEvent(task, run, ev('approval.resolved', { approvalId: 'a1', decision: 'approve' }) as any);
console.log('after approve', run.status, r.statusChanged);
// handoff decline
projectEvent(task, run, ev('approval.required', { approvalId: 'h1', kind: 'handoff' }) as any);
projectEvent(task, run, ev('budget.exceeded', { limit: 'maxTurns' }) as any);
console.log('after budget.exceeded', run.status);
projectEvent(task, run, ev('approval.resolved', { approvalId: 'h1', decision: 'decline' }) as any);
console.log('after handoff decline', run.status);
