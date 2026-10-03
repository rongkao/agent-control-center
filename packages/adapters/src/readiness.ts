import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 登入狀態檢查（P1-16）：啟動時看 Claude / Codex 有沒有可用的登入方式，沒有就在介面上標成“未就緒”並說明怎麼登入。
 * 只檢查憑據檔案或環境變數是否存在，不讀取、不列印它們的內容。檢查不出來（例如用了別的登入方式）時按“就緒”處理，
 * 不擋住使用者——真正呼叫時如果認證失敗，任務會停下並說明原因（P0-6）。
 */

export interface Readiness {
  ready: boolean;
  /** 未就緒時給使用者看的中文原因與解決辦法。 */
  reason?: string;
}

type Env = Record<string, string | undefined>;

const hasValue = (env: Env, name: string) => typeof env[name] === 'string' && env[name]!.trim() !== '';

/** Claude：訂閱登入的憑據檔案、API key / token 環境變數、雲廠商（Bedrock / Vertex）或 settings 裡的 apiKeyHelper 任一存在即可。 */
export function claudeReadiness(env: Env = process.env, home = homedir()): Readiness {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  if (existsSync(join(configDir, '.credentials.json'))) return { ready: true };
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    if (hasValue(env, name)) return { ready: true };
  }
  try {
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { apiKeyHelper?: unknown; env?: Record<string, unknown> };
    if (settings.apiKeyHelper || settings.env?.ANTHROPIC_API_KEY || settings.env?.ANTHROPIC_AUTH_TOKEN) return { ready: true };
  } catch {
    // 沒有 settings.json
  }
  // macOS 上訂閱登入的憑據在鑰匙串裡，檔案檢查不出來：不判為未就緒
  if (process.platform === 'darwin') return { ready: true };
  return { ready: false, reason: '沒有找到 Claude 的登入資訊。請在終端機執行一次 `claude` 並完成登入（或設定 ANTHROPIC_API_KEY），然後重新啟動 Agent Control Center。' };
}

/** Codex：~/.codex/auth.json（或 CODEX_HOME 下的）、OPENAI_API_KEY / CODEX_API_KEY 任一存在即可。 */
export function codexReadiness(env: Env = process.env, home = homedir()): Readiness {
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex');
  if (existsSync(join(codexHome, 'auth.json'))) return { ready: true };
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY']) {
    if (hasValue(env, name)) return { ready: true };
  }
  return { ready: false, reason: '沒有找到 Codex 的登入資訊。請在終端機執行 `codex login` 完成登入，然後重新啟動 Agent Control Center。' };
}
