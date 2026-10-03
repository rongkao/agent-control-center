// 復現：Claude 返回 error_* result 後工作流是否掛起
const root = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/';
const { Orchestrator, EventBus } = await import(root + 'packages/core/src/index.ts');
const { InMemoryControlPlaneStore } = await import(root + 'packages/storage/src/index.ts');
const { ClaudeAgentSdkAdapter } = await import(root + 'packages/adapters/src/index.ts');

const subtype = process.argv[2] ?? 'error_during_execution';
const isErrorSuccess = subtype === 'success_is_error';

class Channel {
  items = []; waiters = []; closed = false;
  push(x) { if (this.closed) return; const w = this.waiters.shift(); if (w) w({ value: x, done: false }); else this.items.push(x); }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() { return { next: () => { if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false }); if (this.closed) return Promise.resolve({ value: undefined, done: true }); return new Promise((r) => this.waiters.push(r)); } }; }
}

const queryFn = ({ prompt, options }) => {
  const out = new Channel();
  options?.abortController?.signal.addEventListener('abort', () => out.close(), { once: true });
  (async () => {
    out.push({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'fake', cwd: '.', permissionMode: 'default' });
    for await (const _user of prompt) {
      // 流式輸入模式：回合以錯誤 result 結束，程序繼續等待下一條輸入（不關閉流）
      if (isErrorSuccess) {
        out.push({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] } });
        out.push({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401', num_turns: 1, stop_reason: null, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 0 } });
      } else {
        out.push({ type: 'result', subtype, is_error: true, errors: ['boom'], num_turns: 1, stop_reason: null, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
      }
    }
    out.close();
  })();
  return { [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](), interrupt: async () => out.close() };
};

let now = Date.now();
const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orch = new Orchestrator(store, bus, { now: () => now });
orch.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn }));
const task = await orch.createTask({ title: 't', prompt: 'fix it', agentId: 'claude', testCommand: 'echo hi' }).catch(async (e) => {
  console.log('createTask with testCommand failed:', e.message);
  return orch.createTask({ title: 't', prompt: 'fix it', agentId: 'claude' });
});
await new Promise((r) => setTimeout(r, 500));

const dump = async (label) => {
  const loaded = await store.loadRun(task.runId);
  const run = loaded.snapshot;
  const t = await store.getTask(task.id);
  console.log(`[${label}] run.status=${run.status} task.status=${t.status} step=${run.workflowState?.step} awaiting=${run.workflowState?.awaitingAgentId} claude=${run.agentSessions.claude?.status} stall=${run.budget.stallCount}/${run.budget.maxStallCount} turns=${run.budget.turnsUsed} lastError=${JSON.stringify(run.workflowState?.lastError)}`);
};
const events = await store.listEvents?.(task.runId).catch(() => undefined);
await dump('after error result');
if (Array.isArray(events)) console.log('events:', events.map((e) => `${e.type}${e.data?.status ? ':' + e.data.status : ''}`).join(', '));

now += 29 * 60 * 1000;
await orch.checkBudgets();
await dump('+29min checkBudgets');
now += 2 * 60 * 1000;
await orch.checkBudgets();
await dump('+31min checkBudgets');
process.exit(0);
