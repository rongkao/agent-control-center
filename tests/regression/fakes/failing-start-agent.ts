import type { AgentAdapter, AgentInfo, AgentSessionHandle, AgentStartInput, EventSink } from '@acc/core';

/**
 * 啟動就失敗的假 agent：模擬首次啟動時 CLI 沒裝好（spawn ENOENT）或初始化超時。
 * 在發出 agent.started 之前拋錯，所以快照裡不會留下任何會話。
 */
export class FailingStartAgent implements AgentAdapter {
  readonly info: AgentInfo;
  readonly starts: AgentStartInput[] = [];

  constructor(
    info: Partial<AgentInfo> & { id: string },
    private readonly message = `spawn ${info.id} ENOENT`,
  ) {
    this.info = { name: info.id, kind: 'other', ready: true, capabilities: ['implement'], ...info };
  }

  async start(input: AgentStartInput, _emit: EventSink): Promise<AgentSessionHandle> {
    this.starts.push(input);
    throw new Error(this.message);
  }

  async send(): Promise<void> {
    throw new Error('FailingStartAgent never has a session');
  }

  async cancel(): Promise<void> {
    // 沒有會話可取消
  }
}
