import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type {
  AgentAdapter,
  AgentInfo,
  AgentResumeInput,
  AgentSessionHandle,
  AgentStartInput,
  EventSeverity,
  EventSink,
  EventType,
  IsolationStatus,
} from '@acc/core';
import { DEFAULT_TEST_DOMAINS, DEGRADED_TEST_ISOLATION, type CommandSandbox } from './command-sandbox.js';
import { filteredEnvNames, testRunnerEnv, type EnvSource } from './env-policy.js';
import { BoundedOutput, killProcessTree, useProcessGroup } from './process-tree.js';
import { defaultAdapterLog, safeEmit, type AdapterLog } from './shared.js';

/**
 * 本地測試執行 adapter（TestAdapter → local processes）。
 *
 * 在任務工作目錄執行操作員配置的測試命令，按退出碼給出確定性的通過/失敗結果（confirmed）。
 * 一個 run 內是一個邏輯會話：send() 即重新執行同一命令；重啟後 resume() 重新執行（測試視為冪等）。
 * 命令由操作員在建立任務時提供，本地單使用者場景下透過 shell 執行。
 *
 * 環境變數（P0-8 / H-15）：測試命令實際執行的內容（package.json 的 test 腳本、測試配置）在 agent 可寫的工作區裡，
 * 所以只給它基礎變數（系統路徑、臨時目錄、使用者目錄、語言編碼、代理等），任何 API key、令牌、機密和 ACC 自己的配置都不傳。
 * 專案測試需要的其他變數（例如 DATABASE_URL）可以由操作員用 ACC_TEST_ENV_ALLOW 放行（envAllow，憑據類名字仍然不放行）；
 * 測試失敗時，結果裡列出被過濾掉的變數名（只列名字），方便判斷失敗是不是因為少了某個變數（P0 第三批審查）。
 * agent 改過測試配置時，編排器在測試步驟之前先請操作員確認（見 Orchestrator 的 testConfigGuard）。
 */
export interface LocalTestRunnerOptions {
  defaultCwd?: string;
  /** 單次執行超時，預設 10 分鐘。 */
  timeoutMs?: number;
  /** 保留的輸出尾部長度。 */
  maxOutput?: number;
  /** 日誌出口；預設寫 stderr。 */
  log?: AdapterLog;
  /** 注入的程序啟動函式（測試用假子程序）；預設 node:child_process 的 spawn。 */
  spawn?: (command: string, options: SpawnOptions) => ChildProcess;
  /** 構造測試程序環境變數的來源；預設 process.env。實際傳給測試程序的是按白名單過濾後的副本。 */
  env?: EnvSource;
  /**
   * 額外放行給測試程序的變數名（服務端從 ACC_TEST_ENV_ALLOW 讀取，P0 第三批審查）。
   * 名字看起來像憑據（*_API_KEY、*_TOKEN、*_PASSWORD……）的仍然不放行。
   */
  envAllow?: readonly string[];
  /** 執行隔離（P2-8）：有沙箱時測試只能寫工作目錄、只能連允許的域名；沒有時降級為環境變數白名單 + 超時。 */
  sandbox?: CommandSandbox;
  /** 測試程序允許訪問的域名（P2-8）；預設 DEFAULT_TEST_DOMAINS。 */
  allowedDomains?: readonly string[];
}

/** 結果裡最多列出多少個被過濾掉的變數名。 */
const MAX_FILTERED_NAMES = 30;

/** 程序退出後等待輸出收尾的時間：超過就不再等管道關閉（孫程序可能還佔著管道）。 */
const EXIT_GRACE_MS = 2_000;

/** 超時結束程序樹之後最多再等多久（毫秒）：還沒退出就直接結束這一次執行。 */
const KILL_GRACE_MS = 5_000;

interface TestSession {
  localId: string;
  command: string;
  cwd?: string;
  ids: { projectId: string; taskId: string; runId: string };
  emit: EventSink;
  child?: ChildProcess;
  runs: number;
  cancelled: boolean;
}

export class LocalTestRunnerAdapter implements AgentAdapter {
  readonly info: AgentInfo = { id: 'test', name: 'Test Runner', kind: 'test', ready: true, capabilities: ['test', 'build', 'lint'] };
  private sessions = new Map<string, TestSession>();
  private readonly log: AdapterLog;
  /** 已停止（服務關閉）：不再啟動或續跑測試。 */
  private disposed = false;

  constructor(private readonly options: LocalTestRunnerOptions = {}) {
    this.log = options.log ?? defaultAdapterLog;
  }

  /**
   * 停止全部測試（服務關閉、單實例租約丟失時呼叫）。可重複呼叫。
   * 結束正在執行的測試命令程序樹，不發任何事件；重啟後由編排器按快照續跑（測試視為冪等）。
   */
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      session.cancelled = true;
      // 服務馬上要退出：同步結束，保證不留下孤兒程序
      killProcessTree(session.child, { sync: true });
    }
  }

  /** 釋放一個會話（任務結束或空閒時由編排器呼叫，P1-5）：結束可能殘留的程序，忘掉這個會話，不發事件。 */
  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    killProcessTree(session.child);
    this.sessions.delete(sessionId);
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    if (this.disposed) throw new Error('Test runner has been shut down');
    const command = typeof input.context?.testCommand === 'string' ? input.context.testCommand.trim() : '';
    if (!command) throw new Error('No test command configured for this task');
    const session: TestSession = {
      localId: `test-${randomUUID()}`,
      command,
      cwd: input.cwd ?? this.options.defaultCwd,
      ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId },
      emit,
      runs: 0,
      cancelled: false,
    };
    this.sessions.set(session.localId, session);
    await this.emitFor(session, 'agent.started', { providerSessionId: session.localId, adapterType: 'test', command, cwd: session.cwd, action: 'Test runner ready' });
    void this.runSafely(session);
    return { sessionId: session.localId, providerSessionId: session.localId };
  }

  async send(sessionId: string, _message: string, _emit: EventSink): Promise<void> {
    const session = this.mustSession(sessionId);
    if (session.cancelled || this.disposed) throw new Error(`Test session ${sessionId} is cancelled`);
    if (session.child) throw new Error(`Test run already in progress for ${sessionId}`);
    void this.runSafely(session);
  }

  async cancel(sessionId: string, _emit: EventSink): Promise<void> {
    const session = this.mustSession(sessionId);
    const again = session.cancelled;
    session.cancelled = true;
    killProcessTree(session.child);
    // 冪等（P0 第二批審查）：編排器在派發許可失效時可能再取消一次，終態只報告一次
    if (again) return;
    // 取消就是這一次執行的終態：之後程序退出也不會再報告結果（run() 裡檢查 cancelled）
    await this.emitFor(session, 'agent.status', { status: 'cancelled', turnId: runId(session), action: 'Test run cancelled' }, 'warning');
  }

  async resume(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void> {
    if (this.disposed) throw new Error('Test runner has been shut down');
    const command = typeof input.metadata?.testCommand === 'string' ? input.metadata.testCommand : '';
    if (!command) throw new Error('Cannot resume test session without test command');
    const session: TestSession = {
      localId: sessionId,
      command,
      cwd: (typeof input.metadata?.cwd === 'string' ? input.metadata.cwd : undefined) ?? this.options.defaultCwd,
      ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId },
      emit,
      // 同一程序裡續接時接著原來的執行次數：每次執行的回合 ID（turnId）保持唯一
      runs: this.sessions.get(sessionId)?.runs ?? 0,
      cancelled: false,
    };
    this.sessions.set(sessionId, session);
    await this.emitFor(session, 'agent.started', { providerSessionId: sessionId, adapterType: 'test', command, resumed: true, action: 'Test runner resumed' });
    void this.runSafely(session);
  }

  /**
   * 後台執行一次測試（fire-and-forget）。任何異常（例如事件沒能落盤）都在這裡接住：
   * 記錄日誌，並盡力 fail closed——告訴編排器這次測試沒有結果，而不是讓工作流一直等下去；
   * 絕不產生未處理的 Promise 拒絕。
   */
  private async runSafely(session: TestSession): Promise<void> {
    try {
      await this.run(session);
    } catch (error) {
      session.child = undefined;
      this.log(`test session ${session.localId}: run failed`, error);
      if (session.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.safeEmitFor(session, 'runtime.error', { code: 'TEST_RUNNER_FAILED', category: 'runtime', retryable: false, turnId: runId(session), message, action: 'Test runner failed' }, 'error');
      await this.safeEmitFor(session, 'agent.status', { status: 'failed', turnId: runId(session), action: 'Test runner failed' }, 'error');
    }
  }

  private async run(session: TestSession): Promise<void> {
    session.runs += 1;
    const toolCallId = runId(session);
    const maxOutput = this.options.maxOutput ?? 20_000;
    const started = Date.now();
    await this.emitFor(session, 'agent.status', { status: 'testing', action: `Running ${session.command}` });
    await this.emitFor(session, 'tool.started', { toolCallId, toolName: 'test', toolInput: { command: session.command, cwd: session.cwd }, action: `Running ${session.command}` });

    // 按原始位元組收集、結束時統一解碼（L-32）；上限按位元組算，中文輸出也能保留足夠的尾部
    const collected = new BoundedOutput(maxOutput * 4);
    let output = '';
    let timedOut = false;
    let isolation: 'sandbox' | 'degraded' = 'degraded';
    // 白名單環境（H-15）：測試腳本可能被 agent 改過，不能讓它讀到任何憑據；操作員放行的名字（envAllow）一併傳入
    const source = this.options.env ?? process.env;
    const env = testRunnerEnv(source, process.platform, { extraNames: this.options.envAllow });
    // 執行隔離（P2-8）：任務級執行策略——只能寫這個任務的工作目錄（和臨時目錄）、只能連允許的域名
    const prepared = this.options.sandbox
      ? await this.options.sandbox
          .prepare(session.command, session.cwd ?? process.cwd(), { writableRoots: [session.cwd ?? process.cwd(), tmpdir()], allowedDomains: [...(this.options.allowedDomains ?? DEFAULT_TEST_DOMAINS)] })
          .catch(() => undefined)
      : undefined;
    isolation = prepared ? 'sandbox' : 'degraded';
    const exitCode = await new Promise<number | null>((settle) => {
      // 程序可能只報 error、不再報 close（例如啟動失敗）：結果只認第一次，保證這一次執行一定結束（終態合約）
      let settled = false;
      const resolve = (code: number | null) => {
        if (settled) return;
        settled = true;
        settle(code);
      };
      // 啟動前再查一次：取消可能發生在上面幾個 await 期間（L-8 的啟動競態）
      if (session.cancelled || this.disposed) {
        resolve(null);
        return;
      }
      let child: ChildProcess;
      try {
        const spawnOptions: SpawnOptions = {
          shell: true,
          cwd: session.cwd,
          env: prepared?.run.env ? { ...env, ...prepared.run.env } : env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // POSIX：獨立程序組，超時或取消時連孫程序一起結束
          detached: useProcessGroup,
        };
        const run = prepared?.run;
        child =
          run && 'argv' in run
            ? spawnProcess(run.argv[0]!, run.argv.slice(1), { ...spawnOptions, shell: false })
            : (this.options.spawn ?? spawnProcess)(run && 'command' in run ? run.command : session.command, spawnOptions);
      } catch (error) {
        output = `Failed to start: ${(error as Error).message}`;
        resolve(null);
        return;
      }
      session.child = child;
      const append = (data: Buffer) => collected.push(data);
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        // 兜底：結束程序樹之後 KILL_GRACE_MS 內還沒有退出（例如機器繁忙、taskkill 沒能及時生效），直接結束這一次執行、按超時失敗處理，
        // 並再直接結束一次子程序——不能讓這一步一直掛著
        const force = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 程序可能已經退出
          }
          clearTimeout(exitTimer);
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve(null);
        }, KILL_GRACE_MS);
        force.unref?.();
      }, this.options.timeoutMs ?? 10 * 60_000);
      child.on('error', (error) => {
        collected.push(`\n${error.message}`);
        // 程序根本沒有啟動起來（例如找不到 shell）：不一定還會有 close 事件，這裡直接結束這一次執行（按測試失敗處理）
        if (child.pid === undefined) {
          clearTimeout(timer);
          resolve(null);
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(exitTimer);
        resolve(code);
      });
      // 以 exit 為主訊號（L-8）：孫程序繼承了管道時 close 要等它們全部退出，可能永遠等不到。
      // 程序退出後給輸出 2 秒收尾，之後不管管道是否關閉都結束這一次執行。
      child.on('exit', (code) => {
        exitTimer = setTimeout(() => {
          clearTimeout(timer);
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve(code);
        }, EXIT_GRACE_MS);
      });
    });
    session.child = undefined;
    await prepared?.release().catch(() => undefined);
    // 啟動失敗時 output 已有說明；否則取收集到的輸出
    output = `${collected.text()}${output}`.slice(-maxOutput);
    if (session.cancelled) return;

    const passed = exitCode === 0 && !timedOut;
    const durationMs = Date.now() - started;
    // 測試失敗時說明哪些變數沒有傳給測試（只列名字）：失敗可能正是因為少了它們，操作員可以用 ACC_TEST_ENV_ALLOW 放行
    const filtered = passed ? [] : filteredEnvNames(source, env).slice(0, MAX_FILTERED_NAMES);
    const note = filtered.length > 0 ? `\n\n[Agent Control Center] 為了安全，這些環境變數沒有傳給測試：${filtered.join('、')}。如果測試需要其中某些變數，可以在啟動 ACC 前設定 ACC_TEST_ENV_ALLOW=名稱1,名稱2（登入憑據類的名稱仍然不會傳入）。` : '';
    const outputTail = `${output.slice(-4000)}${note}`;
    await this.emitFor(
      session,
      passed ? 'tool.completed' : 'tool.failed',
      {
        toolCallId,
        toolName: 'test',
        exitCode,
        timedOut,
        executed: exitCode !== null,
        // 這次測試的隔離級別（P2-8）
        isolation,
        output: `${output.slice(-3000)}${note}`,
        ...(filtered.length > 0 ? { filteredEnvNames: filtered } : {}),
        action: passed ? 'Tests passed' : 'Tests failed',
      },
      passed ? 'info' : 'warning',
    );
    await this.emitFor(session, 'agent.status', {
      status: 'completed',
      turnId: toolCallId,
      testPassed: passed,
      exitCode,
      timedOut,
      durationMs,
      isolation,
      outputTail,
      progress: true,
      action: passed ? 'Tests passed' : `Tests failed (exit ${exitCode ?? 'n/a'}${timedOut ? ', timeout' : ''})`,
    });
  }

  /** 執行隔離狀態（P2-8）。 */
  async isolation(): Promise<IsolationStatus> {
    if (this.options.sandbox) return this.options.sandbox.status();
    return { level: 'degraded', ready: false, detail: `沒有設定沙箱，測試以「${DEGRADED_TEST_ISOLATION}」執行。` };
  }

  private async emitFor(session: TestSession, type: EventType, data: Record<string, unknown>, severity: EventSeverity = 'info'): Promise<void> {
    await session.emit({ ...session.ids, agentId: this.info.id, sessionId: session.localId, type, severity, confidence: 'confirmed', data });
  }

  private safeEmitFor(session: TestSession, type: EventType, data: Record<string, unknown>, severity: EventSeverity = 'info'): Promise<boolean> {
    return safeEmit(session.emit, { ...session.ids, agentId: this.info.id, sessionId: session.localId, type, severity, confidence: 'confirmed', data }, this.log);
  }

  private mustSession(sessionId: string): TestSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown test session ${sessionId}`);
    return session;
  }
}

/** 這一次測試執行的 ID（同時作為工具呼叫 ID 與回合 ID）。 */
function runId(session: TestSession): string {
  // 帶上本程序的隨機標記（P1-2 / M-9）：重啟後續接同一個會話時執行次數從頭計數，沒有它的話新的一次執行會和重啟前的同名，
  // 被當成“已經完成過”的副作用
  return `${session.localId}:run-${session.runs}-${PROCESS_NONCE}`;
}

/** 本程序的隨機標記（每次啟動不同）。 */
const PROCESS_NONCE = randomUUID().slice(0, 8);
