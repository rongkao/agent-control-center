import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanToml, type TomlValue } from './toml-lite.js';

/**
 * 子程序環境變數白名單（P0-8 / H-15、M-13、M-35）。
 *
 * 以前測試執行器、Claude 執行時、Codex app-server 都直接繼承控制面程序的全部環境變數（process.env）：
 * 各家的 API key、其他服務的令牌、ACC 自己的配置都會交給子程序，agent 改了測試腳本就能把它們外發出去。
 * 現在一律按白名單構造一份新的環境：
 * - 測試執行器：只有基礎變數（系統路徑、臨時目錄、使用者目錄、語言編碼、代理、Node / 常見工具鏈的位置等），
 *   外加操作員用 ACC_TEST_ENV_ALLOW 顯式放行的名字（仍然不放行憑據類名字，P0 第三批審查）；
 * - Claude 執行時：基礎變數 + Claude 認證 / 配置需要的變數（ANTHROPIC_*、CLAUDE_*；顯式使用 Bedrock / Vertex 時再加對應的雲憑據）；
 * - Codex app-server：基礎變數 + Codex 認證 / 配置需要的變數（OPENAI_*、CODEX_*，以及它的 config.toml 裡
 *   env_key / env_vars / bearer_token_env_var / env_http_headers 點名的變數）。
 * 兩家互不交叉；ACC_*（訪問令牌檔案、資料目錄等）和 npm 注入的 npm_* 一律不傳。
 *
 * 注意：
 * - 不用 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 代替白名單（它會把權限模式強制改回 default，見分析報告第 8 節）；
 * - Codex 自己執行的命令另外由 shell_environment_policy（inherit=core，保留預設的 *KEY* / *SECRET* / *TOKEN* 排除）過濾，見 CODEX_THREAD_CONFIG；
 * - Claude 自己執行的 Bash 命令繼承 Claude CLI 的環境：使用者用環境變數裡的 API key 認證時，這個 key 仍然在命令裡可見
 *   （訂閱登入用的是憑據檔案，環境裡沒有 key）。這是目前無法在不破壞認證的前提下消除的限制，見 docs/RUNTIME_ADAPTER_MAPPING.md。
 */

export type EnvSource = Record<string, string | undefined>;
export type ChildEnv = Record<string, string>;

/** 基礎白名單（精確名字，比較時不區分大小寫：Windows 的環境變數名本來就不區分大小寫）。 */
const BASE_NAMES: ReadonlySet<string> = new Set(
  [
    // Windows 系統變數（系統自己設定的位置與機器資訊，不含機密）
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'ALLUSERSPROFILE',
    'PUBLIC',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'COMMONPROGRAMW6432',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_ARCHITEW6432',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'NUMBER_OF_PROCESSORS',
    'COMPUTERNAME',
    'USERNAME',
    'USERDOMAIN',
    'USERDOMAIN_ROAMINGPROFILE',
    'PSMODULEPATH',
    // POSIX 基礎變數
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TERM',
    'COLORTERM',
    'TZ',
    'LANG',
    'LANGUAGE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    // Node 與版本管理器
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'NODE_ENV',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_NO_WARNINGS',
    'NVM_HOME',
    'NVM_SYMLINK',
    'NVM_DIR',
    'VOLTA_HOME',
    'PNPM_HOME',
    'FNM_DIR',
    'FNM_MULTISHELL_PATH',
    'BUN_INSTALL',
    'COREPACK_HOME',
    // 常見工具鏈的位置（測試命令可能用到）
    'JAVA_HOME',
    'GOPATH',
    'GOROOT',
    'GOCACHE',
    'GOMODCACHE',
    'GOPROXY',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'DOTNET_ROOT',
    'VIRTUAL_ENV',
    'CONDA_PREFIX',
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONIOENCODING',
    'PYTHONUTF8',
    // 網路代理與證書（很多網路環境離不開代理）
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    // 終端與 CI 標記
    'FORCE_COLOR',
    'NO_COLOR',
    'CI',
  ].map((name) => name.toUpperCase()),
);

/** 基礎白名單（前綴）：語言區域設定。 */
const BASE_PREFIXES = ['LC_'];

/** 一律不傳的前綴：ACC 自己的配置（訪問令牌檔案、資料目錄……）和 npm 執行腳本時注入的變數。 */
const DENIED_PREFIXES = ['ACC_', 'NPM_'];

/** 名字裡出現就算敏感的片段（子串匹配）。TOKEN 後面緊跟 S 的（MAX_THINKING_TOKENS 這類計數配置）不算。 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [/TOKEN(?!S)/, /SECRET/, /PASSWORD/, /PASSWD/, /CREDENTIAL/, /APIKEY/, /API_KEY/];
/** 作為完整片段（按 _ - . 分隔）出現才算敏感的詞：避免把 KEYBOARD、PATH 之類誤判為敏感。 */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set(['KEY', 'KEYS', 'PASS', 'AUTH', 'PRIVATE', 'COOKIE', 'COOKIES', 'PAT', 'SESSIONID']);

/** 變數名看起來是否像憑據（API key、令牌、機密、密碼……）。只看名字，不看值。 */
export function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(upper))) return true;
  return upper.split(/[_\-.]+/).some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

/** 一份環境配置：允許哪些名字（精確 / 前綴），以及哪些憑據類名字是認證真正需要、必須放行的。 */
interface EnvProfile {
  names: ReadonlySet<string>;
  prefixes: readonly string[];
  /** 看起來像憑據、但認證需要的變數（精確名字，大寫）。 */
  secrets: ReadonlySet<string>;
  /** 看起來像憑據、但認證需要的變數（前綴，大寫），例如使用 Bedrock 時的 AWS_*。 */
  secretPrefixes: readonly string[];
}

function buildEnv(source: EnvSource, profile: EnvProfile): ChildEnv {
  const env: ChildEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    // 認證需要的憑據：只放行點名的那幾個
    if (profile.secrets.has(upper) || profile.secretPrefixes.some((prefix) => upper.startsWith(prefix))) {
      env[name] = value;
      continue;
    }
    const allowed = profile.names.has(upper) || profile.prefixes.some((prefix) => upper.startsWith(prefix));
    if (!allowed || isSensitiveEnvName(name)) continue;
    env[name] = value;
  }
  return env;
}

const isTruthy = (value: string | undefined): boolean => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

/** 大小寫不敏感地讀取源環境裡的變數。 */
function readInsensitive(source: EnvSource, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(source)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

const BASE_PROFILE: EnvProfile = { names: BASE_NAMES, prefixes: BASE_PREFIXES, secrets: new Set(), secretPrefixes: [] };

export interface TestRunnerEnvOptions {
  /**
   * 操作員額外放行的變數名（ACC_TEST_ENV_ALLOW，P0 第三批審查）：例如整合測試要用的 DATABASE_URL、Playwright 的 PLAYWRIGHT_BROWSERS_PATH。
   * 名字看起來像憑據（*_API_KEY、*_TOKEN、*_PASSWORD……）的仍然不放行；ACC_*、npm_* 也不放行。
   */
  extraNames?: readonly string[];
}

/**
 * 測試執行器的環境：只有基礎變數（加上 options.extraNames 裡不像憑據的名字）。任何 *_API_KEY / *_TOKEN / *_SECRET、ACC_*、npm_* 都不傳。
 * platform 引數只用於文件說明與測試（名字比較在所有平台上都不區分大小寫）。
 */
export function testRunnerEnv(source: EnvSource = process.env, _platform: NodeJS.Platform = process.platform, options: TestRunnerEnvOptions = {}): ChildEnv {
  const extra = (options.extraNames ?? []).map((name) => name.toUpperCase());
  if (extra.length === 0) return buildEnv(source, BASE_PROFILE);
  return buildEnv(source, { ...BASE_PROFILE, names: new Set([...BASE_NAMES, ...extra]) });
}

/**
 * 源環境裡有、但沒有傳給子程序的變數名（只列名字，不含任何值）：不包括憑據類名字、ACC_*、npm_*——
 * 這些本來就不會放行，列出來也幫不上忙。測試失敗時據此提示操作員哪些變數可以用 ACC_TEST_ENV_ALLOW 放行。
 */
export function filteredEnvNames(source: EnvSource, passed: ChildEnv): string[] {
  const kept = new Set(Object.keys(passed).map((name) => name.toUpperCase()));
  const names = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (kept.has(upper) || DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || isSensitiveEnvName(name)) continue;
    names.add(name);
  }
  return [...names].sort();
}

/** 解析一串變數名（逗號、分號或空白分隔，例如 ACC_TEST_ENV_ALLOW 的值）：只保留合法的名字，去重，保持順序。 */
export function parseEnvNameList(text: string | undefined): string[] {
  const names: string[] = [];
  for (const item of (text ?? '').split(/[,;\s]+/)) {
    const name = item.trim();
    if (name && ENV_NAME.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Claude CLI 自身的配置變數（沒有 ANTHROPIC_ / CLAUDE_ 前綴的那部分）。 */
const CLAUDE_CONFIG_NAMES = ['MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT', 'MAX_MCP_OUTPUT_TOKENS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'BASH_MAX_OUTPUT_LENGTH', 'MAX_THINKING_TOKENS'];
/** Claude 認證需要的憑據變數。 */
const CLAUDE_SECRETS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'];
/**
 * 標識“上一層” Claude Code 會話的變數（例如在 Claude Code 裡啟動了 ACC）：它們不是配置也不是認證，
 * 傳下去會讓 ACC 啟動的獨立 CLI 以為自己是那個會話的子會話，一律不傳。
 */
const CLAUDE_PARENT_SESSION_NAMES: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PROJECT_DIR',
]);

/**
 * Claude 執行時（Claude Code CLI 程序）的環境：基礎變數 + ANTHROPIC_* / CLAUDE_* 的配置 + Claude 認證需要的憑據。
 * 顯式使用 Bedrock（CLAUDE_CODE_USE_BEDROCK）時再放行 AWS_*，使用 Vertex（CLAUDE_CODE_USE_VERTEX）時再放行 Google 雲的變數。
 * OpenAI / Codex 的變數、其他服務的憑據、ACC_* 一律不傳。
 */
export function claudeRuntimeEnv(source: EnvSource = process.env, _platform: NodeJS.Platform = process.platform): ChildEnv {
  const bedrock = isTruthy(readInsensitive(source, 'CLAUDE_CODE_USE_BEDROCK'));
  const vertex = isTruthy(readInsensitive(source, 'CLAUDE_CODE_USE_VERTEX'));
  const filtered = Object.fromEntries(Object.entries(source).filter(([name]) => !CLAUDE_PARENT_SESSION_NAMES.has(name.toUpperCase())));
  return buildEnv(filtered, {
    names: new Set([...BASE_NAMES, ...CLAUDE_CONFIG_NAMES, ...(vertex ? ['CLOUD_ML_REGION'] : [])]),
    // 開啟了 Claude 自己的遙測（CLAUDE_CODE_ENABLE_TELEMETRY）時，OTEL_* 匯出配置一併傳入（P2-2）
    prefixes: [...BASE_PREFIXES, 'ANTHROPIC_', 'CLAUDE_', 'DISABLE_', ...(isTruthy(readInsensitive(source, 'CLAUDE_CODE_ENABLE_TELEMETRY')) ? ['OTEL_'] : []), ...(bedrock ? ['AWS_'] : []), ...(vertex ? ['VERTEX_REGION_', 'GOOGLE_CLOUD_', 'GCLOUD_'] : [])],
    secrets: new Set([...CLAUDE_SECRETS, ...(vertex ? ['GOOGLE_APPLICATION_CREDENTIALS'] : [])]),
    secretPrefixes: bedrock ? ['AWS_'] : [],
  });
}

export interface AcpEnvOptions {
  /** 這個 agent 配置需要的變數（精確名字）。 */
  names?: readonly string[];
  /** 這個 agent 配置需要的變數（前綴），例如 GEMINI_、OPENCODE_。 */
  prefixes?: readonly string[];
  /** 認證需要、看起來像憑據的變數（例如 GEMINI_API_KEY）：只放行點名的這些。 */
  secrets?: readonly string[];
}

/**
 * ACP agent 程序的環境（P2-1）：基礎變數 + 這個 agent 預設點名的配置與憑據。其他服務的憑據、ACC_* 一律不傳。
 */
export function acpRuntimeEnv(source: EnvSource = process.env, options: AcpEnvOptions = {}): ChildEnv {
  return buildEnv(source, {
    names: new Set([...BASE_NAMES, ...(options.names ?? []).map((n) => n.toUpperCase())]),
    prefixes: [...BASE_PREFIXES, ...(options.prefixes ?? []).map((p) => p.toUpperCase())],
    secrets: new Set((options.secrets ?? []).map((n) => n.toUpperCase())),
    secretPrefixes: [],
  });
}

/** Codex 認證需要的憑據變數。 */
const CODEX_SECRETS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY'];

export interface CodexEnvOptions {
  /** Codex 配置檔案裡點名的變數（env_key、env_vars、bearer_token_env_var、env_http_headers 的值），見 codexConfigEnvNames。 */
  extraNames?: readonly string[];
}

/**
 * Codex app-server 程序的環境：基礎變數 + OPENAI_* / CODEX_* 的配置 + Codex 認證需要的憑據，
 * 以及 Codex 配置檔案裡點名的變數（否則自定義模型提供方無法認證）。Anthropic / Claude 的變數、其他服務的憑據、ACC_* 一律不傳。
 * Codex 執行的命令還會再經過 shell_environment_policy 過濾（只繼承核心變數，排除 *KEY* / *SECRET* / *TOKEN*）。
 */
export function codexRuntimeEnv(source: EnvSource = process.env, _platform: NodeJS.Platform = process.platform, options: CodexEnvOptions = {}): ChildEnv {
  return buildEnv(source, {
    names: BASE_NAMES,
    prefixes: [...BASE_PREFIXES, 'OPENAI_', 'CODEX_'],
    secrets: new Set([...CODEX_SECRETS, ...(options.extraNames ?? []).map((name) => name.toUpperCase())]),
    secretPrefixes: [],
  });
}

/** 合法的環境變數名。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 值就是一個環境變數名的配置鍵：模型提供方的 env_key、MCP 伺服器的 bearer_token_env_var。 */
const CODEX_ENV_NAME_KEYS: ReadonlySet<string> = new Set(['env_key', 'bearer_token_env_var']);

const isTable = (value: TomlValue | undefined): value is { [key: string]: TomlValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 在一條賦值（以及它內聯的表 / 陣列）裡收集點名的變數名。 */
function collectCodexEnvNames(path: readonly string[], value: TomlValue, add: (name: string) => void): void {
  const key = path.at(-1);
  if (key !== undefined && CODEX_ENV_NAME_KEYS.has(key) && typeof value === 'string') add(value);
  if (key === 'env_vars' && Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') add(item);
      // 另一種寫法：env_vars = [{ name = "X", ... }]
      else if (isTable(item) && typeof item.name === 'string') add(item.name);
    }
  }
  // env_http_headers = { "請求頭" = "變數名" }：值是變數名
  if (key === 'env_http_headers' && isTable(value)) {
    for (const header of Object.values(value)) if (typeof header === 'string') add(header);
  }
  if (isTable(value)) {
    for (const [child, nested] of Object.entries(value)) collectCodexEnvNames([...path, child], nested, add);
  } else if (Array.isArray(value)) {
    for (const item of value) if (isTable(item)) collectCodexEnvNames([...path, '[]'], item, add);
  }
}

/** 逐行的兜底識別（TOML 解析失敗時用）：單行的 env_key / bearer_token_env_var / env_vars。 */
function codexConfigEnvNamesByLine(toml: string, add: (name: string) => void): void {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const key = /^(?:env_key|bearer_token_env_var)\s*=\s*(["'])([^"']*)\1/.exec(line);
    if (key) {
      add(key[2]!);
      continue;
    }
    const vars = /^env_vars\s*=\s*\[(.*)\]/.exec(line);
    if (vars) for (const item of vars[1]!.matchAll(/(["'])([^"']*)\1/g)) add(item[2]!);
  }
}

/**
 * 從 Codex 的 config.toml 文字里取出點名要用的環境變數名（只取名字，不讀取任何值，P0 第三批審查）：
 * - 模型提供方的 `env_key`（自定義提供方的 API key）、`env_http_headers` 的值（請求頭取值的變數）；
 * - MCP 伺服器的 `bearer_token_env_var`、`env_vars`（多行陣列、`{ name = ... }` 寫法都認）；
 * - 不論寫在 `[model_providers.x]` 表裡、內聯表（`model_providers.x = { ... }`）裡，還是 `[profiles.*]` 下面。
 * 按 TOML 語法解析（容錯：同一個表裡重複的鍵各自計入）；語法錯誤時透過 log 提示（不含任何值），再退回逐行識別，不靜默丟棄。
 * 不合法的名字忽略。
 */
export function codexConfigEnvNames(toml: string, log?: (message: string) => void): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    if (ENV_NAME.test(name) && !names.includes(name)) names.push(name);
  };
  try {
    scanToml(toml, (path, value) => collectCodexEnvNames(path, value, add));
  } catch (error) {
    log?.(`Codex 的 config.toml 無法完整解析（${error instanceof Error ? error.message : String(error)}），已改用逐行識別其中的 env_key / env_vars / bearer_token_env_var；請檢查這個檔案的寫法。`);
    codexConfigEnvNamesByLine(toml, add);
  }
  return names;
}

/**
 * 讀取 Codex 配置檔案（CODEX_HOME/config.toml，預設 ~/.codex/config.toml）裡點名的變數名；沒有檔案時返回空列表。
 * 讀取失敗或語法錯誤時透過 log 提示（只說明檔案和原因，不含任何值）。
 */
export function readCodexConfigEnvNames(source: EnvSource = process.env, log?: (message: string) => void): string[] {
  const home = readInsensitive(source, 'CODEX_HOME')?.trim() || join(homedir(), '.codex');
  const file = join(home, 'config.toml');
  let text: string;
  try {
    if (!existsSync(file)) return [];
    text = readFileSync(file, 'utf8');
  } catch (error) {
    log?.(`讀不到 Codex 的設定檔 ${file}（${(error as NodeJS.ErrnoException).code ?? 'error'}），自訂模型提供方或 MCP 伺服器需要的環境變數可能不會傳給 Codex。`);
    return [];
  }
  return codexConfigEnvNames(text, log ? (message) => log(`${file}：${message}`) : undefined);
}
