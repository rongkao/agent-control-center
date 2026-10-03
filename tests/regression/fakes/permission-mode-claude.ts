import type { ClaudeQueryFn } from '@acc/adapters';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { FakeClaudeRuntime, type FakeClaudeDisk, type FakeScript } from '../../fakes/fake-claude-runtime.js';

/**
 * 支援 query.setPermissionMode() 的假 Claude 執行時（P0-4 審查：唯讀步驟線上切換 plan 模式）。
 *
 * 包裝 tests/fakes 裡的 FakeClaudeRuntime，不改變原替身的預設行為：
 * - 每個查詢的控制代碼多一個 setPermissionMode(mode)，呼叫被記錄在 modeChanges 裡（按查詢下標）；
 * - 呼叫後同步更新該查詢記錄裡的 options.permissionMode，腳本可以據此看到“當前”模式；
 * - 每一輪開始時的模式記錄在 turnModes 裡（按查詢下標，順序與 prompts 一致）。
 */
export class PermissionModeClaudeRuntime {
  readonly inner: FakeClaudeRuntime;
  /** 查詢下標 → 依次切換到的模式。 */
  readonly modeChanges: PermissionMode[][] = [];
  /** 查詢下標 → 每一輪開始時的權限模式。 */
  readonly turnModes: Array<Array<string | undefined>> = [];

  constructor(disk: FakeClaudeDisk, script: FakeScript) {
    this.inner = new FakeClaudeRuntime(disk, async (ctx) => {
      const index = this.inner.queries.findIndex((q) => q.options === ctx.options);
      (this.turnModes[index] ??= []).push(ctx.options.permissionMode);
      await script(ctx);
    });
  }

  get queries() {
    return this.inner.queries;
  }

  readonly queryFn: ClaudeQueryFn = (params) => {
    const handle = this.inner.queryFn(params);
    const index = this.inner.queries.length - 1;
    const record = this.inner.queries[index]!;
    this.modeChanges[index] = [];
    return Object.assign(handle, {
      setPermissionMode: async (mode: PermissionMode) => {
        this.modeChanges[index]!.push(mode);
        record.options.permissionMode = mode;
      },
    });
  };
}
