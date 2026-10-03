import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir as osHomedir } from 'node:os';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IDLE_SESSION_MS, DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS, DEFAULT_STEP_INACTIVITY_MS, EventBus, Orchestrator, createRedactor } from '@acc/core';
import { FilePolicyStore } from './policy-store.js';
import { parseOtlpHeaders, startOtlpExporter } from './otlp-export.js';
import type { AgentAdapter, ControlPlaneStore, RecoveryReport, TestConfigGuard } from '@acc/core';
import { ACP_PRESETS, AcpAdapter, ClaudeAgentSdkAdapter, CodexAppServerAdapter, GitCheckpointer, SrtCommandSandbox, commandAvailable, type AcpAdapterOptions, findOrphanWorktrees, LocalTestRunnerAdapter, createLocalTestConfigGuard, claudeReadiness, codexReadiness, createMockAdapters, parseEnvNameList } from '@acc/adapters';
import { InMemoryControlPlaneStore, LEGACY_BACKUP_DIR_NAME, SqliteControlPlaneStore, acquireInstanceLock, migrateLegacyDatabase, relocateLegacyArtifacts } from '@acc/storage';
import type { InstanceLock, InstanceLockError, InstanceLockOptions } from '@acc/storage';
import { installAccessControl, redactToken } from './access-control.js';
import { AccessTokenError, TOKEN_FILE_NAME, createTokenFileGuard, loadOrCreateAccessToken } from './access-token.js';
import type { TokenFileGuard } from './access-token.js';
import { controlDataInside, isPathInside, resolveControlPlanePaths } from './data-paths.js';
import type { ControlPlanePaths } from './data-paths.js';
import { createEventLogger } from './event-log.js';
import { installUnhandledRejectionGuard } from './process-guards.js';
import { registerRoutes } from './routes.js';

export { resolveControlPlanePaths, isPathInside } from './data-paths.js';
export type { ControlPlanePaths } from './data-paths.js';
export { createTokenFileGuard, checkWindowsDacl, currentWindowsUserSid, readWindowsDacl, sddlAliasesForSid } from './access-token.js';
export type { TokenFileGuard, TokenFileGuardOptions, CheckWindowsDaclOptions } from './access-token.js';
export { openBrowser, shouldOpenBrowser } from './open-browser.js';
export { createEventLogger } from './event-log.js';

/**
 * 服務端啟動模組：命令列入口（index.ts）、測試（app.inject）和以後的桌面外殼都透過 startServer 啟動和關閉服務。
 *
 * 啟動順序（P0-1 / P0-3 / P0-10）：
 * 0. 監聽非迴環地址（ACC_HOST）卻沒有顯式令牌（ACC_TOKEN_FILE / accessToken）時拒絕啟動；
 * 1. 計算資料位置；資料庫、日誌或令牌檔案落在預設工作區內時拒絕啟動（ACC_ALLOW_DATA_IN_WORKSPACE=1 降級為告警）；
 *    反過來預設工作區落在資料目錄之內時照常啟動但告警，不帶工作目錄的任務會被拒絕（請填寫具體的專案目錄）；
 * 2. 獲取單實例租約——在寫入任何控制面資料之前。已有實例在執行時拒絕啟動；
 * 3. （持有租約後）舊位置資料庫的一次性遷移；舊版本留在工作區裡的備份和事件日誌移到 <資料目錄>/legacy-backups；
 *    然後讀取或生成訪問令牌（檔案只允許當前使用者讀取，啟動自檢）；
 * 4. 開啟儲存、註冊 adapter、訪問控制鉤子和路由；
 * 5. 先監聽埠；埠被佔用則直接失敗，不做任何恢復；
 * 6. 再執行 recover：此時已確認上一任的租約失效（作業系統鎖已釋放），會話歸屬才會轉移到本實例。
 *    工作目錄不合規（例如升級前建立、包含資料目錄）的任務不續跑，fail closed 為帶原因的 BLOCKED。
 *    恢復完成之前，會改變狀態的 API 請求會等待恢復結束。
 *
 * 關閉（close()，以及租約丟失後的自行關閉）：先停掉全部 agent 執行時（不寫任何狀態，重啟後照常續接），
 * 再關埠和資料庫，最後釋放租約——同一程序裡重啟時，一個 provider 會話始終只有一個執行時。
 */

/** 啟動失敗（帶錯誤碼與面向使用者的中文說明）。 */
export class StartupError extends Error {
  override readonly name = 'StartupError';

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface AdapterFactoryContext {
  workspace: string;
  runtimeMode: string;
  log: (message: string, error?: unknown) => void;
}

export interface StartServerOptions {
  /** 環境變數（預設 process.env）。測試傳入獨立物件，避免讀到真實環境。 */
  env?: Record<string, string | undefined>;
  /** 覆蓋 ACC_PORT（測試傳 0 取隨機埠）。 */
  port?: number;
  /** 覆蓋 ACC_HOST。 */
  host?: string;
  /** 平台與使用者主目錄（決定預設資料目錄；測試可注入）。 */
  platform?: NodeJS.Platform;
  homedir?: string;
  /** 程序當前目錄（INIT_CWD 預設時的回退），預設 process.cwd()。 */
  cwd?: string;
  /** 自定義 adapter（測試注入替身）；預設按 ACC_RUNTIME_MODE 建立。 */
  adapters?: (context: AdapterFactoryContext) => AgentAdapter[];
  /** 單實例鎖引數（重試、心跳、測試接縫）。 */
  instanceLock?: Partial<Omit<InstanceLockOptions, 'lockPath' | 'instanceId' | 'onLost'>>;
  /** 安靜模式：不在控制台列印啟動橫幅和事件日誌（事件仍寫入 events.log）。 */
  quiet?: boolean;
  /** Fastify 日誌級別（預設按 ACC_LOG_LEVEL / ACC_LOG_REQUESTS）。 */
  logLevel?: string;
  /** 啟動過程中的提示（遷移、告警、接管等），預設寫到 stdout。 */
  notice?: (message: string) => void;
  /** 是否安裝全域性 unhandledRejection 兜底（預設 true；關閉服務時解除安裝）。 */
  installProcessGuards?: boolean;
  /** 是否提供前端靜態檔案（預設 web/dist 存在時提供）。 */
  serveWeb?: boolean;
  /** 前端靜態檔案所在的目錄（桌面版打包後的位置）；預設是原始碼旁邊的 apps/web/dist。 */
  webRoot?: string;
  /**
   * 致命錯誤（例如單實例租約丟失）：先呼叫本回呼通知宿主，隨後服務自行關閉（closed 在關閉完成後 resolve）。
   * 命令列入口用它退出程序；桌面外殼可以用它提示使用者。
   */
  onFatal?: (error: Error) => void;
  /**
   * 收到 POST /api/shutdown（P1-5）：由宿主負責關閉並退出（命令列入口優雅關閉後退出程序，桌面外殼可以退出整個應用）。
   * 沒有提供時，服務只關閉自己（app.close），程序是否退出由呼叫方決定。
   */
  onShutdownRequest?: () => void;
  /**
   * 顯式指定訪問令牌（程式呼叫，例如桌面外殼自己生成令牌）：不寫令牌檔案。
   * 預設讀取 ACC_TOKEN_FILE 指向的檔案，再預設為 <資料目錄>/access-token（沒有就生成）。
   * 令牌不會寫進 process.env。
   */
  accessToken?: string;
  /**
   * 開發模式（npm run dev）：額外放行 Vite 開發伺服器埠（ACC_WEB_PORT，預設 5174）的 Origin，
   * 訪問連結指向 Vite。預設按 ACC_DEV 環境變數。
   */
  dev?: boolean;
  /** WebSocket 限制：單條訊息最大位元組數（預設 64 KiB）、同時線上連線數（預設 32）。 */
  websocket?: { maxPayload?: number; maxConnections?: number };
  /** 令牌檔案權限保護（測試注入替身；預設按平台：Windows 用 icacls，其他平台 chmod 600）。 */
  tokenFileGuard?: TokenFileGuard;
  /**
   * 測試配置守衛（P0-8 / H-15）：agent 改過測試配置時，測試步驟之前先請操作員確認。
   * 預設讀取任務工作目錄裡的本地檔案（createLocalTestConfigGuard）；測試可以注入替身。
   */
  testConfigGuard?: TestConfigGuard;
}

export interface RunningServer {
  app: FastifyInstance;
  /** 服務地址，例如 http://127.0.0.1:8788 （不帶令牌，可以寫進日誌和鎖檔案）。 */
  url: string;
  /**
   * 帶令牌的訪問連結（例如 http://127.0.0.1:8788/?token=…；開發模式指向 Vite 埠）。
   * 瀏覽器開啟它即完成登入；桌面外殼直接載入它。等同於登入密碼，不要寫進日誌檔案。
   */
  accessUrl: string;
  /** 訪問令牌（程式呼叫可用 Authorization: Bearer）。 */
  accessToken: string;
  /** 令牌檔案（顯式傳入 accessToken 時沒有）。 */
  tokenPath?: string;
  /** 是否以開發模式啟動。 */
  dev: boolean;
  port: number;
  host: string;
  instanceId: string;
  runtimeMode: string;
  storeMode: string;
  workspace: string;
  paths: ControlPlanePaths;
  /** 單實例租約（ACC_STORE=memory 時沒有）。 */
  lock?: InstanceLock;
  recovery: RecoveryReport;
  /** 啟動時的告警（例如顯式允許把資料放在工作區內）。 */
  warnings: string[];
  orchestrator: Orchestrator;
  store: ControlPlaneStore;
  /** 服務關閉完成時 resolve（包括租約丟失導致的自行關閉）。 */
  closed: Promise<void>;
  /** 優雅關閉：停止定時器和全部 agent 執行時，關閉埠和資料庫，釋放單實例租約。可重複呼叫。 */
  close(): Promise<void>;
}

const isTruthy = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

/** Vite 開發伺服器的預設埠（與 apps/web/vite.config.ts 一致，二者都讀取 ACC_WEB_PORT）。 */
export const DEFAULT_WEB_DEV_PORT = 5174;
const DEFAULT_WS_MAX_PAYLOAD = 64 * 1024;
const DEFAULT_WS_MAX_CONNECTIONS = 32;
/** 單個 WebSocket 連線積壓的待傳送資料超過該值時斷開（瀏覽器標籤頁卡死等），避免服務端記憶體無限增長。 */
const WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** 監聽地址是否只在本機可達（127.0.0.0/8、::1、localhost）。 */
export function isLoopbackBindHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return value === 'localhost' || value === '::1' || /^127(\.\d{1,3}){3}$/.test(value) || /^::ffff:127(\.\d{1,3}){3}$/.test(value);
}

/**
 * 監聽非迴環地址（區域網或 0.0.0.0）時必須顯式配置令牌（ACC_TOKEN_FILE，或程式呼叫時傳 accessToken）：
 * 否則拒絕啟動。返回問題說明；undefined 表示可以啟動。
 */
export function insecureBindHostProblem(host: string, hasExplicitToken: boolean): string | undefined {
  if (isLoopbackBindHost(host) || hasExplicitToken) return undefined;
  return [
    `ACC_HOST=${host} 會讓區域網裡的其他裝置也能訪問控制台（可以檢視全部對話、批准命令、讓 AI 在這台電腦上執行操作）。`,
    '只在本機使用時，請不要設定 ACC_HOST（預設 127.0.0.1）。',
    '確實需要從其他裝置訪問時，請先用 ACC_TOKEN_FILE 指定一個只有你能讀取的令牌檔案（至少 32 個字元），服務會要求所有訪問都帶這個令牌；',
    '並用 ACC_ALLOWED_HOSTS 列出允許的訪問地址（逗號分隔）。',
  ].join('\n');
}

/** URL 裡的主機部分：通配地址換成 127.0.0.1，IPv6 加方括號。 */
function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StartupError('ACC_INVALID_CONFIG', `${name}=${value} 不是有效的埠號（1～65535）。`);
  return port;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new StartupError('ACC_INVALID_CONFIG', `${name}=${value} 不是有效的正整數。`);
  return number;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string, hint = ''): number {
  if (value === undefined || value.trim() === '') return fallback;
  const number = Number(value.trim());
  if (!Number.isInteger(number) || number < 0) throw new StartupError('ACC_INVALID_CONFIG', `${name}=${value} 不是有效的非負整數${hint}。`);
  return number;
}

/** 會話 Cookie 名：由令牌派生（同一台機器上不同資料目錄的實例互不覆蓋；重啟、換埠後仍然有效）。 */
function sessionCookieName(token: string): string {
  return `acc_session_${createHmac('sha256', token).update('acc-cookie-name').digest('hex').slice(0, 12)}`;
}

/** Windows 上只接受帶磁碟機代號的絕對路徑（不接受 UNC / 裝置路徑，避免訪問網路共享時洩露憑據）。 */
function isAcceptableAbsolutePath(target: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(target);
  return path.posix.isAbsolute(target);
}

/**
 * 任務工作目錄的校驗（L-12 / H-16）。新建任務（包括不帶 cwd、使用預設工作區的任務）、啟動 agent、續接會話和重啟恢復都用它：
 * - 必須是已存在的絕對目錄；
 * - 不能落在控制面資料目錄（資料庫、日誌、令牌所在目錄）之內——任何情況下都拒絕；
 * - 不能反過來包含控制面資料。ACC_ALLOW_DATA_IN_WORKSPACE=1 只放寬這一條裡“資料本來就在預設工作區裡”的部分
 *   （使用者顯式接受了這個風險）；包含預設工作區以外的控制面資料時仍然拒絕；
 * - 設定了 ACC_ALLOWED_ROOTS（按系統路徑分隔符分隔）時，必須位於其中之一。預設不限制，免得擋住使用者正常選擇別的專案。
 */
function createTaskCwdValidator(input: {
  paths: ControlPlanePaths;
  platform: NodeJS.Platform;
  allowedRoots: string[];
  tokenPath?: string;
  usesSqlite: boolean;
  allowDataInWorkspace: boolean;
  /** 預設工作區（ACC_ALLOW_DATA_IN_WORKSPACE 只放寬落在它裡面的資料）。 */
  workspace: string;
}): (cwd: string) => string | undefined {
  const { paths, platform, allowedRoots } = input;
  return (cwd) => {
    if (!isAcceptableAbsolutePath(cwd, platform)) {
      return `工作目錄必須是完整的絕對路徑${platform === 'win32' ? '（例如 D:\\projects\\my-app）' : '（例如 /home/me/my-app）'}，收到的是「${cwd}」。`;
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(cwd).isDirectory();
    } catch {
      return `工作目錄「${cwd}」不存在，請確認路徑是否正確。`;
    }
    if (!isDirectory) return `「${cwd}」不是資料夾，請填寫專案所在的資料夾。`;
    if (allowedRoots.length > 0 && !allowedRoots.some((root) => isPathInside(cwd, root, platform))) {
      return `工作目錄「${cwd}」不在允許的範圍內（ACC_ALLOWED_ROOTS：${allowedRoots.join('、')}）。`;
    }
    const dataDirs = [paths.dataDir, paths.logDir];
    const inData = dataDirs.find((dir) => isPathInside(cwd, dir, platform));
    if (inData) {
      return `工作目錄「${cwd}」位於 Agent Control Center 自己的資料目錄（${inData}）裡。Agent 在這裡工作就能讀取或竄改任務記錄、審批和預算，請改選具體的專案資料夾。`;
    }
    const containedAll = [...controlDataInside(paths, cwd, { includeDb: input.usesSqlite }), ...(input.tokenPath && isPathInside(input.tokenPath, cwd, platform) ? [input.tokenPath] : [])];
    const contained = input.allowDataInWorkspace ? containedAll.filter((item) => !isPathInside(item, input.workspace, platform)) : containedAll;
    if (contained.length > 0) {
      return `工作目錄 ${cwd} 包含 Agent Control Center 自己的資料（${contained.join('、')}）。Agent 在這裡工作就能讀取或竄改任務記錄、審批和預算，請改選具體的專案資料夾。`;
    }
    return undefined;
  };
}

/** 資料落在工作區內時的說明。 */
function misplacedDataMessage(paths: ControlPlanePaths, workspace: string, inside: string[]): string {
  const label = (item: string) => (item === paths.dbPath ? '資料庫' : item === paths.logDir ? '日誌目錄' : '訪問令牌檔案');
  return [
    `控制面資料不能放在 agent 的預設工作區（${workspace}）裡：`,
    ...inside.map((item) => `  - ${label(item)}：${item}`),
    'agent 可以讀寫工作區裡的檔案；資料放在這裡，等於讓 agent 能讀到全部歷史，還能改掉審批、預算和已完成操作的記錄。',
    '解決辦法（任選其一）：',
    '  1. 不設定 ACC_DB_PATH / ACC_LOG_DIR / ACC_DATA_DIR / ACC_TOKEN_FILE，使用預設的使用者資料目錄；',
    '  2. 把它們指向工作區以外的目錄，或者把 ACC_WORKSPACE 指向具體的專案目錄；',
    '  3. 確實需要放在工作區內時，設定 ACC_ALLOW_DATA_IN_WORKSPACE=1（只告警、不攔截，風險自負）。',
  ].join('\n');
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const notice = options.notice ?? ((message: string) => process.stdout.write(`${message}\n`));
  const storeMode = env.ACC_STORE ?? 'sqlite';
  const runtimeMode = env.ACC_RUNTIME_MODE ?? 'mock';
  const allowDataInWorkspace = isTruthy(env.ACC_ALLOW_DATA_IN_WORKSPACE);
  const paths = resolveControlPlanePaths({ env, platform, homedir: options.homedir ?? osHomedir(), cwd });
  const workspace = paths.workspace;
  const usesSqlite = storeMode !== 'memory';
  const warnings: string[] = [];
  const dev = options.dev ?? isTruthy(env.ACC_DEV);
  const host = options.host ?? env.ACC_HOST ?? '127.0.0.1';
  const webDevPort = parsePort(env.ACC_WEB_PORT, DEFAULT_WEB_DEV_PORT, 'ACC_WEB_PORT');
  const wsMaxPayload = options.websocket?.maxPayload ?? parsePositiveInt(env.ACC_WS_MAX_PAYLOAD, DEFAULT_WS_MAX_PAYLOAD, 'ACC_WS_MAX_PAYLOAD');
  const wsMaxConnections = options.websocket?.maxConnections ?? parsePositiveInt(env.ACC_WS_MAX_CONNECTIONS, DEFAULT_WS_MAX_CONNECTIONS, 'ACC_WS_MAX_CONNECTIONS');
  // 步驟不活動看門狗的預設閾值（P0-6）：毫秒，0 表示關閉；每個任務建立時寫進 RunSettings，也可以在建立任務時單獨指定
  const stepInactivityMs = parseNonNegativeInt(env.ACC_STEP_INACTIVITY_MS, DEFAULT_STEP_INACTIVITY_MS, 'ACC_STEP_INACTIVITY_MS', '（單位是毫秒，例如 900000 表示 15 分鐘；0 表示關閉）');
  const tokenFileFromEnv = env.ACC_TOKEN_FILE?.trim() ? path.resolve(cwd, env.ACC_TOKEN_FILE.trim()) : undefined;
  const allowedRoots = (env.ACC_ALLOWED_ROOTS ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(cwd, item));

  // 0. 監聽非迴環地址卻沒有顯式令牌：拒絕啟動（在任何寫入之前）
  const bindProblem = insecureBindHostProblem(host, options.accessToken !== undefined || tokenFileFromEnv !== undefined);
  if (bindProblem) throw new StartupError('ACC_INSECURE_HOST', bindProblem);

  // 令牌檔案：顯式傳入令牌時不落盤；否則 ACC_TOKEN_FILE，再否則 <資料目錄>/access-token
  const tokenPath = options.accessToken !== undefined ? undefined : (tokenFileFromEnv ?? path.join(paths.dataDir, TOKEN_FILE_NAME));

  // 1. 資料位置檢查：在任何寫入之前（包括建目錄）。令牌檔案在工作區裡等於把控制台的登入密碼交給 agent
  const inside = [...controlDataInside(paths, workspace, { includeDb: usesSqlite }), ...(tokenPath && isPathInside(tokenPath, workspace) ? [tokenPath] : [])];
  if (inside.length > 0) {
    const message = misplacedDataMessage(paths, workspace, inside);
    if (!allowDataInWorkspace) throw new StartupError('ACC_DATA_IN_WORKSPACE', message);
    const warning = `警告：已透過 ACC_ALLOW_DATA_IN_WORKSPACE 允許控制面資料放在工作區內。\n${message}`;
    warnings.push(warning);
    notice(warning);
  }

  const app = Fastify({
    // 請求日誌是 info 級別：預設 warn 即不列印；ACC_LOG_REQUESTS=1 或 ACC_LOG_LEVEL=info 可恢復
    logger: {
      level: options.logLevel ?? env.ACC_LOG_LEVEL ?? (env.ACC_LOG_REQUESTS === '1' ? 'info' : 'warn'),
      // 請求日誌裡去掉 URL 中的訪問令牌（首次訪問的連結帶 ?token=）
      serializers: {
        req: (request: { method?: string; url?: string; hostname?: string; ip?: string }) => ({
          method: request.method,
          url: redactToken(request.url),
          hostname: request.hostname,
          remoteAddress: request.ip,
        }),
      },
    },
  });
  // 最後一道防線：未處理的 Promise 拒絕只記錄，不讓整個服務（和所有任務）一起退出
  const removeGuard =
    options.installProcessGuards === false ? () => undefined : installUnhandledRejectionGuard((message, error) => app.log.error({ err: error }, message));
  /** 核心元件（事件匯流排、編排器、adapter）共用的錯誤日誌出口。 */
  const logError = (message: string, error?: unknown) => app.log.error({ err: error }, message);

  let lock: InstanceLock | undefined;
  let store: ControlPlaneStore | undefined;
  let codexAdapter: CodexAppServerAdapter | undefined;
  /** 編排器建立之後才有；關閉時用它停止全部 agent 執行時。 */
  let orchestratorRef: Orchestrator | undefined;
  const timers: NodeJS.Timeout[] = [];
  let recovery: RecoveryReport | undefined;
  let recoveryGateSettled = false;
  let resolveRecoveryGate!: () => void;
  let rejectRecoveryGate!: (error: unknown) => void;
  const recoveryGate = new Promise<void>((resolve, reject) => {
    resolveRecoveryGate = () => {
      recoveryGateSettled = true;
      resolve();
    };
    rejectRecoveryGate = (error) => {
      recoveryGateSettled = true;
      reject(error);
    };
  });
  recoveryGate.catch(() => undefined);

  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      for (const timer of timers) clearInterval(timer);
      if (!recoveryGateSettled) rejectRecoveryGate(new Error('server closed'));
      try {
        // 先停掉全部 agent 執行時（不寫任何狀態，重啟後照常續接），再關埠和資料庫
        await orchestratorRef?.shutdown();
        await app.close(); // onClose：關閉資料庫
      } finally {
        // 資料庫關閉之後才釋放租約：此後別的實例才可能接手
        lock?.release();
        removeGuard();
        resolveClosed();
      }
    })());

  /**
   * 租約丟失：先讓全部 agent 執行時立即停下（同步中止，不再執行任何工具——之後也不會再有記錄或審批），
   * 再關資料庫停止寫入，通知宿主，然後關閉服務。桌面外殼只提示、不退出程序時也是安全的。
   */
  const onLeaseLost = (error: InstanceLockError) => {
    app.log.error({ err: error }, 'instance lease lost');
    notice(`嚴重：${error.message}`);
    try {
      orchestratorRef?.shutdown().catch(() => undefined);
    } catch {
      // 忽略
    }
    try {
      void store?.close?.();
    } catch {
      // 忽略
    }
    try {
      options.onFatal?.(error);
    } finally {
      void close();
    }
  };

  try {
    // 2. 單實例租約：在寫入任何控制面資料之前
    if (usesSqlite) {
      mkdirSync(dirname(paths.lockPath), { recursive: true });
      try {
        lock = await acquireInstanceLock({ ...options.instanceLock, lockPath: paths.lockPath, onLost: onLeaseLost });
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'ACC_LOCK_FAILED';
        throw new StartupError(code, (error as Error).message, { cause: error });
      }
      if (lock.previous) {
        const prev = lock.previous;
        const alive = prev.processAlive === false ? '，該程序已不存在' : '';
        notice(
          `檢測到上一個實例沒有正常退出（程序 ${prev.pid}${alive}，最後心跳 ${new Date(prev.heartbeatAt).toLocaleString('zh-CN', { hour12: false })}），已接管它留下的單實例鎖。`,
        );
      }

      // 3. 舊位置資料庫的一次性遷移（持有租約後進行，避免兩個實例同時遷移）
      migrateIfNeeded(paths, usesSqlite, workspace, notice, warnings);
    }

    // 3.5 訪問令牌（P0-1）：持久化在使用者資料目錄，只允許當前使用者讀取（每次啟動自檢）；絕不放進 process.env。
    // 檔案權限取決於真實的作業系統，所以這裡用 process.platform 而不是可注入的 platform。
    let tokenResult: ReturnType<typeof loadOrCreateAccessToken>;
    try {
      tokenResult = loadOrCreateAccessToken({
        explicitToken: options.accessToken,
        tokenPath: tokenPath ?? path.join(paths.dataDir, TOKEN_FILE_NAME),
        explicitFile: tokenFileFromEnv !== undefined,
        guard: options.tokenFileGuard ?? createTokenFileGuard(process.platform),
      });
    } catch (error) {
      if (error instanceof AccessTokenError) throw new StartupError(error.code, error.message, { cause: error });
      throw error;
    }
    if (tokenResult.repaired) notice(`注意：訪問令牌檔案 ${tokenResult.path} 的權限曾被放寬，已恢復為只有當前使用者可以讀取。`);
    const accessToken = tokenResult.token;

    // 4. 開啟儲存
    try {
      store = usesSqlite ? new SqliteControlPlaneStore({ path: paths.dbPath }) : new InMemoryControlPlaneStore();
    } catch (error) {
      throw new StartupError('ACC_STORE_OPEN_FAILED', `無法開啟資料庫 ${paths.dbPath}：${(error as Error).message}`, { cause: error });
    }
    const openedStore = store;
    if (store instanceof SqliteControlPlaneStore && store.migrationBackup) {
      notice(`資料庫已升級到新版本；升級前的備份在 ${store.migrationBackup}（確認一切正常後可以刪除）。`);
    }
    app.addHook('onClose', async () => {
      // 直接呼叫 app.close() 時同樣先停執行時（shutdown 可重複呼叫）
      await orchestratorRef?.shutdown();
      codexAdapter?.dispose();
      await openedStore.close?.();
    });

    // WebSocket：限制單條訊息大小（瀏覽器不需要向服務端傳送任何大訊息）
    await app.register(websocket, { options: { maxPayload: wsMaxPayload } });
    // 訪問控制（P0-1）：必須在 websocket 外掛之後註冊（它的鉤子先標記升級請求），並且在其他鉤子和路由之前
    const allowedHosts = (env.ACC_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((item) => (item.includes(':') && !item.startsWith('[') ? `[${item}]` : item));
    const wildcardHost = host === '0.0.0.0' || host === '::' || host === '[::]';
    installAccessControl(app, {
      token: accessToken,
      cookieName: sessionCookieName(accessToken),
      // 監聽地址本身總是允許的（包括 127.0.0.2 這樣的迴環地址，否則訪問連結會被 Host 白名單拒絕）；通配地址的訪問連結用 127.0.0.1
      extraHostnames: [...(wildcardHost ? [] : [urlHost(host).toLowerCase()]), ...allowedHosts],
      devOriginPorts: dev ? [webDevPort] : [],
    });
    // 脫敏（P2-9）：adapter 事件裡出現的金鑰（金鑰類環境變數的值、訪問令牌、常見金鑰格式）落盤和廣播之前遮掉；ACC_REDACT=0 關閉
    const redact = env.ACC_REDACT === '0' ? undefined : createRedactor({ env, values: [accessToken] });
    const eventBus = new EventBus({ log: logError, redact });
    // 任務工作目錄的校驗：目錄校驗針對真實檔案系統，所以用 process.platform
    const validateTaskCwd = createTaskCwdValidator({ paths, platform: process.platform, allowedRoots, tokenPath: tokenResult.path, usesSqlite, allowDataInWorkspace, workspace });
    // 預設工作區本身不合規（例如落在資料目錄之內）：照常啟動，但不帶工作目錄的任務會被拒絕
    const workspaceProblem = validateTaskCwd(workspace);
    if (workspaceProblem) {
      const warning = `注意：預設工作區 ${workspace} 不能直接給 agent 使用：${workspaceProblem}\n新建任務時請在「更多選項 → 工作目錄」填寫具體的專案資料夾。`;
      warnings.push(warning);
      notice(warning);
    }
    // 審批策略（P2-7）：自主度與規則儲存在資料目錄的 policy.json
    const autonomy = env.ACC_AUTONOMY === 'ask' || env.ACC_AUTONOMY === 'unattended' ? env.ACC_AUTONOMY : 'rules';
    const policyStore = new FilePolicyStore(path.join(paths.dataDir, 'policy.json'), { mode: autonomy }, (message) => app.log.warn(message));
    const maxConsecutiveAutoApprovals = parseNonNegativeInt(env.ACC_MAX_AUTO_APPROVALS, DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS, 'ACC_MAX_AUTO_APPROVALS', '（連續自動放行幾次後要你確認一次，例如 25）');
    // mock 執行時不會寫檔案，允許共享工作區；真實執行時同一工作區只允許一個寫任務（需要並行請用 worktree）
    const orchestrator = new Orchestrator(openedStore, eventBus, {
      // 會話歸屬使用租約裡的實例 ID：接管時的 SESSION_OWNER_TRANSFERRED 能對上上一任的租約
      instanceId: lock?.instanceId ?? randomUUID(),
      // 恢復（會話歸屬轉移）只在仍持有租約時進行
      instanceLease: lock,
      defaultCwd: workspace,
      workspacePolicy: runtimeMode === 'real' ? 'exclusive' : 'shared',
      // 寫進新任務的快照（P1-14）：出了問題時能看出任務是哪個版本建立的
      appVersion: APP_VERSION,
      log: logError,
      // 任何任務的工作目錄（包括升級前建立的任務）在啟動 / 續接 agent 前都要透過同一套校驗
      workspaceGuard: validateTaskCwd,
      inactivityTimeoutMs: stepInactivityMs,
      // 空閒會話回收（P1-5 / M-6）：答完話閒置超過閾值的 Claude 會話釋放 CLI 程序，下次發訊息自動續接
      // 新任務預設的美元花費上限（估算，P1-7）：不設就不限
      defaultMaxCostUsd: parseMaxCostUsd(env.ACC_MAX_COST_USD),
      // 審批策略（P2-7）：資料目錄裡的 policy.json；ACC_AUTONOMY 是沒有配置檔案時的預設自主度
      approvalPolicy: policyStore,
      maxConsecutiveAutoApprovals,
      // 提問過期（P2-6）：ACC_QUESTION_TIMEOUT_MIN 分鐘沒人回答就跳過，AI 自己判斷；0 = 一直等
      questionTimeoutMs: parseNonNegativeInt(env.ACC_QUESTION_TIMEOUT_MIN, 0, 'ACC_QUESTION_TIMEOUT_MIN', '（分鐘，0 表示一直等）') * 60_000,
      // 交接有向邊白名單（P2-5）：例如 ACC_HANDOFF_EDGES=claude>codex,codex>claude；不設就不限
      handoffEdges: (env.ACC_HANDOFF_EDGES ?? '').split(/[,;\s]+/).filter((edge) => edge.includes('>')),
      // 工作區檢查點（P2-3）：每一輪做完後拍快照，可以檢視改動、撤銷一輪；ACC_CHECKPOINTS=0 關閉
      checkpointer: env.ACC_CHECKPOINTS === '0' ? undefined : new GitCheckpointer(),
      // 全域性每日估算花費上限（P1-7）：所有任務加起來；不設就不限
      dailyMaxCostUsd: parseMaxCostUsd(env.ACC_DAILY_MAX_COST_USD, 'ACC_DAILY_MAX_COST_USD'),
      idleSessionMs: parseNonNegativeInt(env.ACC_IDLE_SESSION_MS, DEFAULT_IDLE_SESSION_MS, 'ACC_IDLE_SESSION_MS', '（單位是毫秒，例如 600000 表示 10 分鐘；0 表示關閉）'),
      // agent 改過測試配置（package.json 的 scripts、測試框架配置、testCommand 引用的腳本）時，測試步驟之前先請操作員確認（H-15）
      testConfigGuard: options.testConfigGuard ?? createLocalTestConfigGuard(),
    });
    orchestratorRef = orchestrator;

    if (options.adapters) {
      for (const adapter of options.adapters({ workspace, runtimeMode, log: logError })) orchestrator.registerAdapter(adapter);
    } else {
      // ACC_RUNTIME_MODE=real：claude 走 Claude Agent SDK、codex 走 Codex App Server（複用本機登入），test 走本地命令
      codexAdapter =
        runtimeMode === 'real'
          ? new CodexAppServerAdapter({ defaultCwd: workspace, model: env.ACC_CODEX_MODEL || undefined, onStderr: (text) => app.log.debug({ codex: text }), log: logError })
          : undefined;
      for (const adapter of createMockAdapters({ log: logError })) {
        if (runtimeMode === 'real' && adapter.info.id === 'claude') {
          const claude = new ClaudeAgentSdkAdapter({
            defaultCwd: workspace,
            model: env.ACC_CLAUDE_MODEL || undefined,
            log: logError,
            // 指定 Claude Code 執行檔（桌面版打包後由外殼填入 app.asar.unpacked 裡的 claude.exe；一般情況由 SDK 自己找）
            ...(env.ACC_CLAUDE_EXECUTABLE ? { extraOptions: { pathToClaudeCodeExecutable: env.ACC_CLAUDE_EXECUTABLE } } : {}),
          });
          // 登入狀態（P1-16）：沒有登入時介面上標成“未就緒”並說明怎麼登入
          applyReadiness(claude.info, claudeReadiness(env), notice);
          orchestrator.registerAdapter(claude);
        } else if (codexAdapter && adapter.info.id === 'codex') {
          applyReadiness(codexAdapter.info, codexReadiness(env), notice);
          orchestrator.registerAdapter(codexAdapter);
        } else if (runtimeMode === 'real' && adapter.info.id === 'test') {
          // ACC_TEST_ENV_ALLOW：操作員額外放行給測試程序的變數名（例如 DATABASE_URL；憑據類名字仍然不放行，P0 第三批審查）
          orchestrator.registerAdapter(
            new LocalTestRunnerAdapter({
              defaultCwd: workspace,
              log: logError,
              envAllow: parseEnvNameList(env.ACC_TEST_ENV_ALLOW),
              // 執行隔離（P2-8）：有 sandbox-runtime 時測試只能寫工作目錄、只能連允許的域名；ACC_TEST_SANDBOX=0 關閉
              sandbox: env.ACC_TEST_SANDBOX === '0' ? undefined : new SrtCommandSandbox(),
              ...(env.ACC_TEST_ALLOWED_DOMAINS ? { allowedDomains: env.ACC_TEST_ALLOWED_DOMAINS.split(/[,;\s]+/).filter(Boolean) } : {}),
            }),
          );
        } else {
          orchestrator.registerAdapter(adapter);
        }
      }
      // ACP agent（P2-1）：ACC_ACP_AGENTS=gemini,opencode 用內建預設；ACC_ACP_AGENTS_JSON 可以加自訂的
      // （[{"id":"x","name":"X","command":"npx","args":["-y","pkg@1.2.3"],"env":{"secrets":["X_API_KEY"]}}]，npx 必須固定版本號）
      if (runtimeMode === 'real') {
        for (const spec of acpAgentSpecs(env, notice)) {
          const adapter = new AcpAdapter({ ...spec, defaultCwd: workspace, log: logError });
          if (adapter.info.ready && !commandAvailable(spec.command)) {
            applyReadiness(adapter.info, { ready: false, reason: `找不到指令 ${spec.command}，請先安裝（並確認在 PATH 裡）。` }, notice);
          } else if (!adapter.info.ready) {
            notice(`${adapter.info.name} 未就緒：${adapter.info.notReadyReason ?? ''}`);
          }
          orchestrator.registerAdapter(adapter);
        }
      }
    }

    const sockets = new Set<{ send(data: string): void; readyState: number; close(code?: number, reason?: string): void; bufferedAmount?: number }>();
    // 可讀事件日誌：控制台 + <日誌目錄>/events.log
    eventBus.subscribe(createEventLogger(paths.logDir, { echo: !options.quiet }));
    const broadcast = (event: unknown) => {
      const payload = JSON.stringify(event);
      for (const socket of sockets) {
        if (socket.readyState !== 1) continue;
        // 背壓：瀏覽器長時間不讀取（例如標籤頁卡死）時斷開它；重連後前端會從 REST 拉取權威狀態
        if ((socket.bufferedAmount ?? 0) > WS_MAX_BUFFERED_BYTES) {
          socket.close(1013, 'client too slow');
          continue;
        }
        socket.send(payload);
      }
    };
    eventBus.subscribe(broadcast);
    // 逐字流式片段：只推送給瀏覽器即時顯示，不持久化
    eventBus.subscribeEphemeral(broadcast);

    // 恢復完成之前，改變狀態的 API 請求先等待（事件序號在恢復時才從資料庫接上，提前寫會衝突）
    app.addHook('onRequest', async (request, reply) => {
      if (recoveryGateSettled && recovery) return;
      if (request.method === 'GET' || request.method === 'HEAD' || !request.url.startsWith('/api/')) return;
      try {
        await recoveryGate;
      } catch {
        return reply.code(503).send({ error: '服務正在啟動或已經停止，請稍後再試。' });
      }
    });

    registerRoutes(app, {
      store: openedStore,
      orchestrator,
      runtimeMode,
      storeMode,
      workspace,
      sockets,
      recovery: () => recovery,
      validateTaskCwd,
      maxWsConnections: wsMaxConnections,
      policy: policyStore,
      maxConsecutiveAutoApprovals,
    });

    // 優雅關閉（P1-5）：介面上的「關閉服務」或以後的桌面外殼呼叫；需要登入（訪問控制鉤子覆蓋 /api/*）
    app.post('/api/shutdown', async (_request, reply) => {
      reply.send({ ok: true });
      setImmediate(() => {
        if (options.onShutdownRequest) options.onShutdownRequest();
        else app.close().catch((error) => app.log.error(error, 'shutdown failed'));
      });
      return reply;
    });

    // 生產模式：若前端已構建（npm start 會先構建），同一埠直接提供控制台介面
    const webDist = options.webRoot ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
    if (options.serveWeb !== false && existsSync(webDist)) {
      // wildcard 模式按請求動態查詢檔案：重新構建前端後無需重啟服務端
      await app.register(fastifyStatic, { root: webDist });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/ws')) {
          return reply.sendFile('index.html');
        }
        return reply.code(404).send({ error: 'Not found' });
      });
    }

    // 5. 先監聽：埠被佔用時直接失敗，此時還沒有恢復任何任務、也沒有寫任何事件
    const port = options.port ?? Number(env.ACC_PORT ?? 8788);
    try {
      await app.listen({ port, host });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new StartupError(
          'ACC_PORT_IN_USE',
          `埠 ${port}（${host}）已被其他程式佔用，服務沒有啟動，也沒有恢復任何任務。請關閉佔用該埠的程式，或用 ACC_PORT 換一個埠。`,
          { cause: error },
        );
      }
      throw error;
    }
    const address = app.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    // 不帶令牌的地址：寫進單實例鎖和日誌
    const url = `http://${urlHost(host)}:${actualPort}`;
    lock?.setOwnerInfo({ url });
    // 帶令牌的訪問連結：開發模式下頁面由 Vite 提供（前端會用連結裡的令牌換登入 Cookie）
    const accessUrl = `${dev ? `http://localhost:${webDevPort}` : url}/?token=${encodeURIComponent(accessToken)}`;

    // 6. 再恢復：租約已由本實例持有（上一任的作業系統鎖已釋放），會話歸屬可以安全轉移
    try {
      recovery = await orchestrator.recover();
    } catch (error) {
      throw new StartupError('ACC_RECOVERY_FAILED', `啟動恢復失敗：${(error as Error).message}`, { cause: error });
    }
    resolveRecoveryGate();
    const recovered = recovery.resumed.length + recovery.waiting.length + recovery.blocked.length + recovery.failedClosed.length;
    if (recovered > 0) {
      notice(`恢復：續接 ${recovery.resumed.length}，等待中 ${recovery.waiting.length}，已阻塞 ${recovery.blocked.length}，快照不可讀 ${recovery.failedClosed.length}`);
    }

    // 週期性檢查時長等執行時預算，以及步驟不活動看門狗（P0-6）
    const budgetTimer = setInterval(() => {
      orchestrator.checkBudgets().catch((error) => app.log.error(error, 'budget check failed'));
      orchestrator.checkInactivity().catch((error) => app.log.error(error, 'step inactivity check failed'));
      orchestrator.releaseIdleSessions().catch((error) => app.log.error(error, 'idle session release failed'));
      orchestrator.expireQuestions().catch((error) => app.log.error(error, 'question expiry failed'));
    }, Number(env.ACC_BUDGET_CHECK_MS ?? 5000));
    budgetTimer.unref();
    timers.push(budgetTimer);

    // 上游版本檢查（P1-14）：真實模式下核對本機 Codex CLI 的版本是否在測試過的範圍內；不在範圍內只提示，不阻止啟動
    if (runtimeMode === 'real' && !options.adapters) {
      void checkCodexVersion(env.ACC_CODEX_BIN || 'codex').then((warning) => {
        if (warning) notice(warning);
      });
    }

    // OTLP 匯出（P2-2）：設定了 ACC_OTLP_ENDPOINT 時，任務結束後把追蹤發過去（預設只含後設資料）
    if (env.ACC_OTLP_ENDPOINT) {
      const stopExporter = startOtlpExporter({
        endpoint: env.ACC_OTLP_ENDPOINT,
        headers: parseOtlpHeaders(env.ACC_OTLP_HEADERS),
        includeContent: env.ACC_OTLP_CONTENT === '1',
        store: openedStore,
        bus: eventBus,
        log: (message, error) => app.log.warn({ err: error }, message),
      });
      app.addHook('onClose', async () => stopExporter());
    }

    // 孤兒 worktree（P2-4）：工作目錄的 .acc-worktrees 下、沒有任何任務引用的目錄（例如任務被刪除、程序在建立途中退出）。只提示，不自動刪除
    void (async () => {
      const referenced = new Set<string>();
      for (const task of await openedStore.listTasks()) {
        const run = await openedStore.getRun(task.runId).catch(() => undefined);
        if (run?.workspace?.kind === 'worktree' && !run.workspace.cleanedAt) referenced.add(run.workspace.cwd);
      }
      const orphans = findOrphanWorktrees(workspace, referenced);
      if (orphans.length) notice(`工作目錄裡有 ${orphans.length} 個沒有任務使用的 worktree（${orphans.slice(0, 3).join('、')}${orphans.length > 3 ? ' 等' : ''}）。確認不需要後可以用 git worktree remove 刪除。`);
    })().catch((error: unknown) => app.log.warn({ err: error }, 'orphan worktree scan failed'));

    // 資料保留（P1-12）：定期把 WAL 寫回主庫並截斷；設定了 ACC_RETENTION_DAYS 時刪除結束超過這麼多天的任務（預設 0 = 永久保留）
    const retentionDays = parseNonNegativeInt(env.ACC_RETENTION_DAYS, 0, 'ACC_RETENTION_DAYS', '（單位是天，例如 90；0 表示永久保留）');
    const maintain = async () => {
      if (openedStore instanceof SqliteControlPlaneStore) {
        try {
          openedStore.checkpoint();
        } catch (error) {
          app.log.warn(error, 'wal checkpoint failed');
        }
      }
      if (retentionDays > 0 && openedStore.deleteTask) {
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        for (const task of await openedStore.listTasks()) {
          if (task.updatedAt >= cutoff || !['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status)) continue;
          await openedStore.deleteTask(task.id);
        }
      }
    };
    void maintain().catch((error) => app.log.error(error, 'maintenance failed'));
    const maintenanceTimer = setInterval(() => void maintain().catch((error) => app.log.error(error, 'maintenance failed')), 60 * 60 * 1000);
    maintenanceTimer.unref();
    timers.push(maintenanceTimer);

    // 事件迴圈卡頓監測：任何同步阻塞超過 1 秒都記錄告警，便於定位
    let lagCheck = Date.now();
    const lagTimer = setInterval(() => {
      const now = Date.now();
      const lag = now - lagCheck - 500;
      if (lag > 1000) app.log.warn({ eventLoopLagMs: lag }, 'event loop blocked');
      lagCheck = now;
    }, 500);
    lagTimer.unref();
    timers.push(lagTimer);

    if (!options.quiet) {
      notice(
        `\nAgent Control Center 已啟動：${url}  （執行模式 ${runtimeMode}，工作區 ${workspace}）\n` +
          `訪問連結（已包含登入令牌，等同於密碼，請不要分享給別人）：\n  ${accessUrl}\n` +
          (dev ? `開發模式：等前端開發伺服器（埠 ${webDevPort}）啟動後開啟上面的連結。\n` : '') +
          `資料目錄：${usesSqlite ? dirname(paths.dbPath) : '（記憶體儲存，不落盤）'}\n` +
          `事件日誌：${paths.logDir}${platform === 'win32' ? '\\' : '/'}events.log\n`,
      );
    }

    return {
      app,
      url,
      accessUrl,
      accessToken,
      tokenPath: tokenResult.path,
      dev,
      port: actualPort,
      host,
      instanceId: orchestrator.instanceId,
      runtimeMode,
      storeMode,
      workspace,
      paths,
      lock,
      recovery,
      warnings,
      orchestrator,
      store: openedStore,
      closed,
      close,
    };
  } catch (error) {
    // 啟動失敗：關閉已開啟的埠和資料庫，再釋放租約（失敗的啟動不能佔著鎖）
    await close().catch(() => undefined);
    throw error;
  }
}

/**
 * 舊版本留下的控制面資料（P0-10 / H-16）：
 * - 舊位置（INIT_CWD/agent-control.db）有庫、新位置沒有：一次性遷移，舊庫備份放到 <資料目錄>/legacy-backups；
 * - 上一版遷移留在舊位置的 .bak-* 備份、舊版本預設的 logs/events.log：一併移到 <資料目錄>/legacy-backups；
 * - 舊庫不遷移（新位置已有庫，或顯式指定了 ACC_DB_PATH）而它又在預設工作區裡：告警——agent 能讀到它的全部歷史。
 */
function migrateIfNeeded(paths: ControlPlanePaths, usesSqlite: boolean, workspace: string, notice: (message: string) => void, warnings: string[]): void {
  const backupDir = path.join(paths.dataDir, LEGACY_BACKUP_DIR_NAME);
  const legacyDir = dirname(paths.legacyDbPath);
  const warn = (message: string) => {
    warnings.push(message);
    notice(message);
  };
  const leftInWorkspace = (file: string, reason: string) =>
    warn(`警告：${file} 包含 Agent Control Center 的歷史記錄（提示詞、輸出、審批），它仍在 agent 的預設工作區 ${workspace} 裡，agent 能讀到它（${reason}）。確認不需要後請刪除它，或移到工作區以外。`);

  if (usesSqlite) migrateLegacyDb(paths, backupDir, notice, (file, reason) => (isPathInside(file, workspace) ? leftInWorkspace(file, reason) : undefined));

  // 舊資料目錄就是現在的資料目錄（例如顯式允許把資料放在工作區裡）：那些檔案就是正在使用的資料，不移動
  if (isPathInside(legacyDir, paths.dataDir)) return;
  const relocated = relocateLegacyArtifacts({ legacyDir, backupDir, skipEventLog: isPathInside(path.join(legacyDir, 'logs'), paths.logDir) });
  if (relocated.moved.length > 0) {
    notice(`已把舊版本留下的 ${relocated.moved.length} 個歷史檔案（資料庫備份、事件日誌）從 ${legacyDir} 移到 ${backupDir}。`);
  }
  for (const failure of relocated.failed) {
    if (isPathInside(failure.path, workspace)) leftInWorkspace(failure.path, `沒能移到 ${backupDir}：${failure.error}`);
  }
}

function migrateLegacyDb(paths: ControlPlanePaths, backupDir: string, notice: (message: string) => void, leftBehind: (file: string, reason: string) => void): void {
  const legacy = paths.legacyDbPath;
  if (!existsSync(legacy) || isPathInside(legacy, paths.dbPath)) return;
  const targetExists = existsSync(paths.dbPath);
  if (paths.dbPathExplicit) {
    if (!targetExists) {
      notice(`注意：ACC_DB_PATH 指定的資料庫 ${paths.dbPath} 還不存在，將新建；舊位置 ${legacy} 還有一個資料庫（顯式指定路徑時不會自動遷移）。`);
    }
    leftBehind(legacy, '顯式指定了 ACC_DB_PATH，不會自動遷移它');
    return;
  }
  if (targetExists) {
    notice(`注意：舊位置 ${legacy} 還有一個資料庫，已不再使用；當前使用 ${paths.dbPath}。確認不需要後可以刪除舊檔案。`);
    leftBehind(legacy, `當前使用的是 ${paths.dbPath}，它已不再使用`);
    return;
  }
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  let result;
  try {
    result = migrateLegacyDatabase({ from: legacy, to: paths.dbPath, backupDir });
  } catch (error) {
    throw new StartupError('ACC_MIGRATION_FAILED', (error as Error).message, { cause: error });
  }
  notice(
    `已將資料庫從舊位置 ${legacy} 遷移到 ${paths.dbPath}（${result.tasks} 個任務，${result.events} 條事件）。\n` +
      `舊檔案已備份到 ${result.backupPath}${result.backupNotMoved ? '' : `（在資料目錄 ${backupDir} 裡，agent 讀不到）`}，確認資料無誤後可以刪除。`,
  );
  if (result.backupNotMoved) leftBehind(result.backupPath, `沒能移到 ${backupDir}：${result.backupNotMoved}`);
}

/** ACC_MAX_COST_USD：新任務預設的美元花費上限（估算）；空表示不限，非法值拒絕啟動並說明原因。 */
function parseMaxCostUsd(raw: string | undefined, name = 'ACC_MAX_COST_USD'): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.01 || value > 100_000) {
    throw Object.assign(new Error(`${name} 的值「${raw}」無效：請填 0.01～100000 之間的數字（單位是美元，例如 5 或 2.5），或者留空表示不限。`), { code: 'ACC_INVALID_ENV' });
  }
  return value;
}

/** 應用版本號（根目錄 package.json 的 version；桌面版打包後由 ACC_APP_VERSION 傳入）；讀不到時為 undefined。 */
const APP_VERSION: string | undefined = (() => {
  if (process.env.ACC_APP_VERSION) return process.env.ACC_APP_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
})();

/** 測試過的 Codex CLI 版本（主.次）；協議型別按這個版本的 app-server 核對過。 */
export const TESTED_CODEX_VERSIONS = ['0.156'];

/**
 * 查詢本機 Codex CLI 的版本（P1-14）。不在測試過的範圍內時返回中文提示；查不到（沒裝、超時）時不提示——
 * 沒裝 Codex 的使用者照樣可以只用 Claude。
 */
export async function checkCodexVersion(bin: string): Promise<string | undefined> {
  const output = await new Promise<string>((resolve) => {
    let text = '';
    try {
      const child = spawn(`${bin.includes(' ') && !bin.startsWith('"') ? `"${bin}"` : bin} --version`, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => {
        child.kill();
        resolve(text);
      }, 10_000);
      timer.unref();
      child.stdout?.on('data', (d) => (text += String(d)));
      child.on('error', () => resolve(''));
      child.on('close', () => {
        clearTimeout(timer);
        resolve(text);
      });
    } catch {
      resolve('');
    }
  });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return undefined;
  const minor = `${match[1]}.${match[2]}`;
  if (TESTED_CODEX_VERSIONS.includes(minor)) return undefined;
  return `注意：本機的 Codex CLI 版本是 ${match[0]}，Agent Control Center 是按 ${TESTED_CODEX_VERSIONS.map((v) => `${v}.x`).join('、')} 測試的。大多數情況下仍然能用；如果 Codex 出現奇怪的錯誤，可以先換回測試過的版本。`;
}

/** 把登入檢查的結果寫進 agent 資訊（P1-16）；未就緒時同時在啟動日誌裡提示一次。 */
/** ACP agent 的配置（P2-1）：內建預設 + 自訂；ID 與已有 agent 重複、格式不對的會被忽略並提示。 */
function acpAgentSpecs(env: NodeJS.ProcessEnv, notice: (text: string) => void): AcpAdapterOptions[] {
  const specs: AcpAdapterOptions[] = [];
  for (const name of (env.ACC_ACP_AGENTS ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const preset = ACP_PRESETS[name.toLowerCase()];
    if (!preset) {
      notice(`ACC_ACP_AGENTS 裡的「${name}」不是內建的 ACP agent（可以用：${Object.keys(ACP_PRESETS).join('、')}；其他的請用 ACC_ACP_AGENTS_JSON）。`);
      continue;
    }
    specs.push({ id: name.toLowerCase(), ...preset });
  }
  if (env.ACC_ACP_AGENTS_JSON) {
    try {
      const list = JSON.parse(env.ACC_ACP_AGENTS_JSON) as Array<Record<string, unknown>>;
      for (const item of Array.isArray(list) ? list : []) {
        if (typeof item.id !== 'string' || typeof item.command !== 'string' || !/^[a-z0-9_-]+$/i.test(item.id)) {
          notice('ACC_ACP_AGENTS_JSON 裡有一項缺少 id / command（id 只能用英數字、- 和 _），已忽略。');
          continue;
        }
        specs.push({
          id: item.id,
          name: typeof item.name === 'string' ? item.name : item.id,
          command: item.command,
          args: Array.isArray(item.args) ? item.args.map(String) : [],
          env: (item.env as AcpAdapterOptions['env']) ?? {},
        });
      }
    } catch (error) {
      notice(`ACC_ACP_AGENTS_JSON 不是有效的 JSON：${(error as Error).message}`);
    }
  }
  const reserved = new Set(['claude', 'codex', 'test']);
  return specs.filter((spec, i) => !reserved.has(spec.id) && specs.findIndex((s) => s.id === spec.id) === i);
}

function applyReadiness(info: { ready: boolean; notReadyReason?: string; name: string }, readiness: { ready: boolean; reason?: string }, notice: (text: string) => void): void {
  info.ready = readiness.ready;
  if (readiness.ready) {
    delete info.notReadyReason;
    return;
  }
  info.notReadyReason = readiness.reason;
  notice(`${info.name} 未就緒：${readiness.reason ?? ''}`);
}
