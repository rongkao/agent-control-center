import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EnvSource } from './env-policy.js';
import type { AdapterLog } from './shared.js';

/**
 * Claude 設定的唯讀轉交（P0 第三批審查，P0-8 / M-13 的副作用修正）。
 *
 * ACC 以 settingSources: [] 啟動 Claude（不載入任何 settings 檔案：allow 規則、hooks、外部 MCP 都不生效，審批只走編排器），
 * 但這樣也把使用者級 settings.json 裡的認證、模型和拒絕規則一起丟了：閘道器 / 中轉（env 裡的 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN）、
 * Bedrock、apiKeyHelper 的使用者認證失敗，model / effortLevel 被忽略，permissions.deny / ask 失效（這是放寬，不是收緊）。
 *
 * 這裡唯讀地取出需要的部分，由 adapter 顯式交給 SDK：
 * - 使用者級 settings.json（CLAUDE_CONFIG_DIR 優先，預設 ~/.claude）：env（adapter 再按同一套白名單過濾後併入 env 選項）、
 *   認證相關的 helper（apiKeyHelper 等）、登入方式、model、effortLevel，以及 permissions.deny / ask；
 * - 專案級 .claude/settings.json 與 .claude/settings.local.json（agent 可寫）：只取 permissions.deny / ask——
 *   限制性規則來自 agent 可寫的檔案也無妨；env、apiKeyHelper、model 這類會改變認證去向的設定一律不採用；
 * - 任何位置的 allow 規則、hooks、MCP、defaultMode、additionalDirectories 都不採用（隔離不變）。
 * 讀不到檔案時跳過；檔案不是合法的 JSON 時記日誌（只說明是哪個檔案，不含內容，免得把憑據寫進日誌）。
 */

/** 從使用者級設定裡原樣轉交的鍵（認證 helper、登入方式、模型）。 */
const USER_SETTING_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'model', 'effortLevel'] as const;

export interface ClaudeSettingsPassthrough {
  /** 使用者級 settings.json 裡的 env（還沒有經過白名單過濾）。 */
  env: Record<string, string>;
  /** 交給 SDK 的 flag settings（沒有任何需要轉交的設定時為 undefined）。 */
  settings?: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function readInsensitive(source: EnvSource, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(source)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

/** 讀取一個 settings 檔案；不存在時返回 undefined，不是合法 JSON 物件時記日誌並返回 undefined。 */
function readSettingsFile(file: string, log: AdapterLog): JsonObject | undefined {
  let text: string;
  try {
    if (!existsSync(file)) return undefined;
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    log(`讀不到 Claude 設定檔 ${file}（${(error as NodeJS.ErrnoException).code ?? 'error'}），已略過`);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed)) return parsed;
  } catch {
    // 不記錄解析器的錯誤資訊：它可能帶著檔案裡的一段原文（例如憑據）
  }
  log(`Claude 設定檔 ${file} 不是有效的 JSON，已略過（其中的認證、模型與拒絕規則不會生效）`);
  return undefined;
}

/** permissions 裡某一類規則（只保留字串）。 */
function rules(settings: JsonObject | undefined, kind: 'deny' | 'ask'): string[] {
  const permissions = settings?.permissions;
  if (!isObject(permissions) || !Array.isArray(permissions[kind])) return [];
  return (permissions[kind] as unknown[]).filter((rule): rule is string => typeof rule === 'string' && rule.trim() !== '');
}

/** 使用者級 settings 所在的目錄：CLAUDE_CONFIG_DIR，預設 ~/.claude。 */
export function claudeConfigDir(source: EnvSource = process.env, home: string = homedir()): string {
  return readInsensitive(source, 'CLAUDE_CONFIG_DIR')?.trim() || join(home, '.claude');
}

/**
 * 讀出要顯式交給 SDK 的 Claude 設定（見檔案開頭的說明）。
 * source：構造執行時環境的來源（決定 CLAUDE_CONFIG_DIR）；cwd：會話的工作目錄（專案級拒絕規則）。
 */
export function readClaudeSettingsPassthrough(input: { source?: EnvSource; cwd?: string; log: AdapterLog; home?: string }): ClaudeSettingsPassthrough {
  const source = input.source ?? process.env;
  const user = readSettingsFile(join(claudeConfigDir(source, input.home), 'settings.json'), input.log);
  const project = input.cwd ? [readSettingsFile(join(input.cwd, '.claude', 'settings.json'), input.log), readSettingsFile(join(input.cwd, '.claude', 'settings.local.json'), input.log)] : [];

  const env: Record<string, string> = {};
  if (isObject(user?.env)) {
    for (const [name, value] of Object.entries(user.env)) if (typeof value === 'string') env[name] = value;
  }

  const settings: JsonObject = {};
  for (const key of USER_SETTING_KEYS) {
    const value = user?.[key];
    if (typeof value === 'string' || (key === 'forceLoginOrgUUID' && Array.isArray(value))) settings[key] = value;
  }
  const unique = (items: string[]) => [...new Set(items)];
  const deny = unique([user, ...project].flatMap((item) => rules(item, 'deny')));
  const ask = unique([user, ...project].flatMap((item) => rules(item, 'ask')));
  if (deny.length || ask.length) settings.permissions = { ...(deny.length ? { deny } : {}), ...(ask.length ? { ask } : {}) };

  return { env, ...(Object.keys(settings).length > 0 ? { settings } : {}) };
}
