import type { TaskStatus } from './types.js';

const allowed: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  // CREATED/QUEUED -> BLOCKED：重啟恢復無法證明執行時狀態時 fail closed，進入人工閘門
  CREATED: new Set(['QUEUED', 'CANCELLED', 'BLOCKED']),
  QUEUED: new Set(['RUNNING', 'CANCELLED', 'FAILED', 'BLOCKED']),
  RUNNING: new Set(['WAITING_INPUT', 'WAITING_APPROVAL', 'BLOCKED', 'FAILED', 'CANCELLED', 'COMPLETED']),
  WAITING_INPUT: new Set(['RUNNING', 'CANCELLED', 'FAILED', 'BLOCKED']),
  WAITING_APPROVAL: new Set(['RUNNING', 'BLOCKED', 'CANCELLED', 'FAILED']),
  BLOCKED: new Set(['RUNNING', 'CANCELLED', 'FAILED']),
  FAILED: new Set(),
  CANCELLED: new Set(),
  COMPLETED: new Set(),
};

/** 允許的狀態遷移（唯讀檢視，P1-13：文件裡的遷移表由它生成，測試保證兩者一致）。 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.fromEntries(
  Object.entries(allowed).map(([from, to]) => [from, [...to]]),
) as unknown as Record<TaskStatus, readonly TaskStatus[]>;

/** 生成 docs/STATE_MACHINE.md 裡的遷移表（Markdown）。 */
export function renderTransitionTable(): string {
  const rows = Object.entries(TASK_TRANSITIONS).map(([from, to]) => `| \`${from}\` | ${to.length ? to.map((x) => `\`${x}\``).join(', ') : '—（終態）'} |`);
  return ['| 從 | 可以遷移到 |', '|---|---|', ...rows].join('\n');
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || allowed[from].has(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}

/**
 * 操作員「接受結果」可以直接完成的狀態（P0-7 / H-7）：執行中、評審閘門（WAITING_INPUT）、已阻塞。
 * 接受直接進入 COMPLETED，不再先回到 RUNNING——那樣會在閘門自己的遷移上觸發預算檢查，任務可能永遠完成不了。
 * 只有帶 acceptedBy=operator 的 run.completed 走這條路；工作流自己的完成仍然必須從 RUNNING 遷移。
 */
export function canAcceptResult(from: TaskStatus): boolean {
  return from === 'RUNNING' || from === 'WAITING_INPUT' || from === 'BLOCKED';
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'FAILED' || status === 'CANCELLED' || status === 'COMPLETED';
}
