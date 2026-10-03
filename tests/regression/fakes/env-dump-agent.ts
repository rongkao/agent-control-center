import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentInfo, AgentSessionHandle, AgentStartInput, EventSink } from '@acc/core';

/** adapter 透過 EventSink 發出的事件（還沒有 id / sequence）。 */
export type EmittedEvent = Parameters<EventSink>[0];

/**
 * “列印環境變數”的假執行時：start() 像真實 adapter 一樣啟動一個子程序（不顯式傳 env，即繼承服務程序的環境變數），
 * 子程序把自己看到的環境變數寫進檔案。用來斷言訪問令牌不會傳給 agent 子程序。
 */
export class EnvDumpAgent implements AgentAdapter {
  readonly info: AgentInfo;
  /** 子程序寫完檔案並退出後 resolve（顯式等待，不用 sleep）。 */
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;

  constructor(
    private readonly fixture: string,
    private readonly outputFile: string,
    info: Partial<AgentInfo> = {},
  ) {
    this.info = { id: 'claude', name: 'EnvDump', kind: 'claude', ready: true, capabilities: ['implement', 'analysis'], ...info };
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    const sessionId = `env-dump-${randomUUID()}`;
    const base = { projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: this.info.id, sessionId, confidence: 'confirmed' as const };
    await emit({ ...base, type: 'agent.started', severity: 'info', data: { action: 'Dumping environment' } });
    // 與真實 adapter 相同：不傳 env，子程序繼承 process.env
    const child = spawn(process.execPath, [this.fixture, this.outputFile], { stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => this.rejectDone(error));
    child.once('exit', (code) => {
      if (code === 0) this.resolveDone();
      else this.rejectDone(new Error(`env dump child exited with ${code}`));
    });
    return { sessionId };
  }

  async send(_sessionId: string, _message: string, _emit: EventSink): Promise<void> {}

  async cancel(_sessionId: string, _emit: EventSink): Promise<void> {}
}

/**
 * 包裝一個真實 adapter，旁聽它發出的事件，便於測試顯式等待某個事件（例如測試執行器跑完），而不是 sleep。
 * 只轉發，不改變被包裝 adapter 的任何行為。
 */
export class ObservedAdapter implements AgentAdapter {
  readonly info: AgentInfo;
  private readonly seen: EmittedEvent[] = [];
  private readonly waiters: Array<{ match: (event: EmittedEvent) => boolean; resolve: (event: EmittedEvent) => void }> = [];

  approve?: AgentAdapter['approve'];
  resume?: AgentAdapter['resume'];

  constructor(private readonly inner: AgentAdapter) {
    this.info = inner.info;
    // 可選方法：被包裝的 adapter 有才提供（編排器按是否存在決定能否續跑/審批）
    if (inner.approve) this.approve = (sessionId, decision, emit) => inner.approve!(sessionId, decision, this.wrap(emit));
    if (inner.resume) this.resume = (sessionId, input, emit) => inner.resume!(sessionId, input, this.wrap(emit));
  }

  /** 等待第一個滿足條件的事件（包括已經發生過的）。 */
  waitFor(match: (event: EmittedEvent) => boolean): Promise<EmittedEvent> {
    const hit = this.seen.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  private wrap(emit: EventSink): EventSink {
    return async (event) => {
      const result = await emit(event);
      this.seen.push(event);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(event)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
      return result;
    };
  }

  start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    return this.inner.start(input, this.wrap(emit));
  }

  send(sessionId: string, message: string, emit: EventSink): Promise<void> {
    return this.inner.send(sessionId, message, this.wrap(emit));
  }

  cancel(sessionId: string, emit: EventSink): Promise<void> {
    return this.inner.cancel(sessionId, this.wrap(emit));
  }
}
