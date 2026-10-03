import type { IsolationStatus } from '@acc/core';

/**
 * 測試命令的執行隔離（P2-8）。
 *
 * 任務級執行策略（ExecutionPolicy）：可寫目錄（任務的工作目錄 / worktree）與允許訪問的域名。
 * 有沙箱（Anthropic sandbox-runtime，srt）時，測試程序只能寫這些目錄、只能連這些域名；
 * 沒有沙箱（沒有安裝、平台不支援、Windows 上還沒做一次性的 windows-install）時明確降級為「環境變數白名單 + 超時」，
 * 並透過 isolation() 告訴介面現在是哪一級、怎麼開啟。
 */

export interface ExecutionPolicy {
  /** 允許寫入的目錄（絕對路徑）。 */
  writableRoots: string[];
  /** 允許訪問的域名（支援 *.example.com）。 */
  allowedDomains: string[];
}

/** 準備好的沙箱命令：shell 命令字串，或者 argv（不經過 shell）。 */
export type SandboxedCommand = { command: string; env?: NodeJS.ProcessEnv } | { argv: string[]; env?: NodeJS.ProcessEnv };

export interface CommandSandbox {
  /** 隔離狀態（給介面）。 */
  status(): Promise<IsolationStatus>;
  /**
   * 在沙箱裡執行這條命令：返回包裝後的命令與釋放函式（執行結束後呼叫）；沙箱不可用時返回 undefined（呼叫方降級執行）。
   */
  prepare(command: string, cwd: string, policy: ExecutionPolicy): Promise<{ run: SandboxedCommand; release(): Promise<void> } | undefined>;
}

/** 預設允許的域名：常見的包管理源與程式碼託管（安裝依賴、下載測試夾具）。 */
export const DEFAULT_TEST_DOMAINS = [
  'registry.npmjs.org',
  '*.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'github.com',
  '*.githubusercontent.com',
];

/** 降級時的狀態說明。 */
export const DEGRADED_TEST_ISOLATION = '環境變數白名單 + 逾時（測試程式可以連任何網站、寫工作目錄以外的檔案）';

interface SrtModule {
  /** Windows：隨包附帶的 srt-win.exe。 */
  VENDORED_SRT_WIN_EXE?: string;
  /** Windows：srt-sandbox 帳號是否已經建立（windows-install 做過沒有）。 */
  getWindowsSandboxUserStatus?: (opts?: { srtWin?: { exe: string; prependArgs: readonly string[] } }) => { provisioned: boolean };
  SandboxManager: {
    initialize(config: Record<string, unknown>): Promise<void>;
    isSupportedPlatform(): boolean;
    checkDependencies(): { errors?: string[]; warnings?: string[] } | undefined;
    wrapWithSandbox(command: string): Promise<string>;
    wrapWithSandboxArgv(command: string, binShell?: unknown, customConfig?: unknown, abortSignal?: AbortSignal, cwd?: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    reset(): Promise<void>;
  };
}

/**
 * 基於 sandbox-runtime 的沙箱。sandbox-runtime 是可選依賴：沒有安裝時 status() 報告降級。
 * 它的 SandboxManager 是程序級單例，而且原生 Windows 上檔案規則只能在 initialize 時按會話設定——
 * 所以每次執行都用這個任務的目錄重新 initialize，執行結束 reset；同一時間只跑一個沙箱命令（序列）。
 */
export class SrtCommandSandbox implements CommandSandbox {
  private modulePromise?: Promise<SrtModule | undefined>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastFailure?: string;

  constructor(
    private readonly options: {
      /** 測試用：注入模組。 */
      load?: () => Promise<SrtModule | undefined>;
      platform?: NodeJS.Platform;
    } = {},
  ) {}

  private load(): Promise<SrtModule | undefined> {
    this.modulePromise ??= (this.options.load ?? defaultLoad)().catch(() => undefined);
    return this.modulePromise;
  }

  async status(): Promise<IsolationStatus> {
    const platform = this.options.platform ?? process.platform;
    const mod = await this.load();
    const setup = platform === 'win32' ? '以系統管理員身分執行一次：npx @anthropic-ai/sandbox-runtime windows-install（會建立 srt-sandbox 帳號與防火牆規則）' : undefined;
    if (!mod) {
      return { level: 'degraded', ready: false, detail: `沒有安裝沙箱元件（@anthropic-ai/sandbox-runtime），測試以「${DEGRADED_TEST_ISOLATION}」執行。`, setupHint: 'npm install @anthropic-ai/sandbox-runtime' };
    }
    if (!mod.SandboxManager.isSupportedPlatform()) return { level: 'degraded', ready: false, detail: `這個平台不支援沙箱，測試以「${DEGRADED_TEST_ISOLATION}」執行。` };
    if (platform === 'win32') {
      // Windows：沙箱在專用的 srt-sandbox 帳號下執行，需要先以管理員身份做一次 windows-install
      const exe = mod.VENDORED_SRT_WIN_EXE;
      const user = exe && mod.getWindowsSandboxUserStatus ? safe(() => mod.getWindowsSandboxUserStatus!({ srtWin: { exe, prependArgs: [] } })) : undefined;
      if (!user?.provisioned) return { level: 'degraded', ready: false, detail: `Windows 沙箱還沒有安裝，測試以「${DEGRADED_TEST_ISOLATION}」執行。`, setupHint: setup };
      if (this.lastFailure) return { level: 'degraded', ready: false, detail: `沙箱上次啟動失敗：${this.lastFailure}。測試以「${DEGRADED_TEST_ISOLATION}」執行。`, setupHint: setup };
      return { level: 'sandbox', ready: true, detail: '測試在 Windows 沙箱（srt-sandbox 帳號）裡執行：只能寫任務的工作目錄，只能連允許的網域。注意：裝在你個人設定檔裡的工具（例如 nvm 的 Node）沙箱帳號讀不到。' };
    }
    const deps = safe(() => mod.SandboxManager.checkDependencies());
    if (deps?.errors?.length) {
      return { level: 'degraded', ready: false, detail: `沙箱缺少依賴：${deps.errors.join('；')}。測試以「${DEGRADED_TEST_ISOLATION}」執行。`, setupHint: setup };
    }
    if (this.lastFailure) return { level: 'degraded', ready: false, detail: `沙箱上次啟動失敗：${this.lastFailure}。測試以「${DEGRADED_TEST_ISOLATION}」執行。`, setupHint: setup };
    return { level: 'sandbox', ready: true, detail: '測試在沙箱裡執行：只能寫任務的工作目錄，只能連允許的網域。' };
  }

  async prepare(command: string, cwd: string, policy: ExecutionPolicy): Promise<{ run: SandboxedCommand; release(): Promise<void> } | undefined> {
    const mod = await this.load();
    if (!mod || !mod.SandboxManager.isSupportedPlatform()) return undefined;
    // Windows 上還沒有做 windows-install：不嘗試（直接降級）
    if ((this.options.platform ?? process.platform) === 'win32' && !(await this.status()).ready) return undefined;
    // 序列：拿到“鎖”之後才 initialize；release 時 reset 並放開
    let unlock!: () => void;
    const turn = new Promise<void>((resolve) => (unlock = resolve));
    const previous = this.queue;
    this.queue = previous.then(() => turn);
    await previous;
    try {
      const platform = this.options.platform ?? process.platform;
      await mod.SandboxManager.initialize({
        network: { allowedDomains: policy.allowedDomains, deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: policy.writableRoots, denyWrite: [] },
        ...(platform === 'win32' && mod.VENDORED_SRT_WIN_EXE ? { windows: { srtWin: { path: mod.VENDORED_SRT_WIN_EXE } } } : {}),
      });
      const run: SandboxedCommand =
        platform === 'win32' ? await mod.SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, undefined, cwd) : { command: await mod.SandboxManager.wrapWithSandbox(command) };
      this.lastFailure = undefined;
      return {
        run,
        release: async () => {
          await mod.SandboxManager.reset().catch(() => undefined);
          unlock();
        },
      };
    } catch (error) {
      this.lastFailure = (error as Error).message.split('\n')[0]!.slice(0, 300);
      await mod.SandboxManager.reset().catch(() => undefined);
      unlock();
      return undefined;
    }
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function defaultLoad(): Promise<SrtModule | undefined> {
  // 可選依賴：用變數做模組名，沒有安裝時不影響編譯和啟動
  const name = '@anthropic-ai/sandbox-runtime';
  return (await import(name)) as SrtModule;
}
