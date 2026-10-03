/**
 * 金鑰脫敏與掃描（P2-9，參考 secretlint / gitleaks 的規則）。
 *
 * - 脫敏：adapter 發出的每個事件在唯一入口（EventBus.createSink）經過這裡，事件資料裡的字串先按“已知環境變數的值”
 *   精確替換，再按一組精選正則替換，替換後才落盤、廣播和寫日誌。只替換匹配到的片段，其餘內容（路徑、ID 等）不變。
 * - 掃描：合入主倉庫之前掃描 diff 新增的行，發現疑似金鑰時預設不合入。
 */

export interface SecretRule {
  id: string;
  /** 給人看的名字。 */
  name: string;
  pattern: RegExp;
}

/** 精選規則：前綴明確、誤報少。都必須帶 g 標誌。 */
export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'anthropic', name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai', name: 'OpenAI API key', pattern: /sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'github', name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { id: 'aws', name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack', name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google', name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe', name: 'Stripe secret key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g },
  { id: 'private-key', name: 'Private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
];

/** 名字像金鑰的環境變數（值會被精確替換）。 */
const SECRET_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export interface RedactorOptions {
  /** 環境變數（通常是 process.env）：名字像金鑰、值足夠長的會被精確替換。 */
  env?: Record<string, string | undefined>;
  /** 額外需要替換的值（例如訪問令牌）。 */
  values?: string[];
}

export type Redactor = <T>(value: T) => T;

/**
 * 值是否適合做精確替換：太短、像路徑、像 URL、純數字或 true/false 的不替換，避免把正常內容（例如檔案路徑）遮掉。
 */
function redactableValue(value: string): boolean {
  if (value.length < 12) return false;
  if (/[\\/\s]/.test(value) && !/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  if (/^\d+$/.test(value) || /^(true|false)$/i.test(value)) return false;
  return true;
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const exact = new Map<string, string>();
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value && SECRET_ENV_NAME.test(name) && redactableValue(value)) exact.set(value, `[已遮蔽:${name}]`);
  }
  for (const value of options.values ?? []) {
    if (value && value.length >= 8) exact.set(value, '[已遮蔽]');
  }
  // 長的先替換（一個值包含另一個值時不會只替換一半）
  const exactList = [...exact.entries()].sort((a, b) => b[0].length - a[0].length);

  const redactString = (text: string): string => {
    let out = text;
    for (const [value, label] of exactList) {
      if (out.includes(value)) out = out.split(value).join(label);
    }
    for (const rule of SECRET_RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(out)) {
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, `[已遮蔽:${rule.name}]`);
      }
    }
    return out;
  };

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (depth > 12 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const r = walk(item, depth + 1);
        if (r !== item) changed = true;
        return r;
      });
      return changed ? next : value;
    }
    // 只處理普通物件（Date、Buffer 等原樣保留）
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const r = walk(item, depth + 1);
      if (r !== item) changed = true;
      next[key] = r;
    }
    return changed ? next : value;
  };

  // 沒有變化時返回原物件（不復制）
  return <T>(value: T): T => walk(value, 0) as T;
}

export interface SecretFinding {
  rule: string;
  name: string;
  path?: string;
  line?: number;
  /** 遮蔽後的片段（只保留前 6 個字元）。 */
  preview: string;
}

/** 在一段文字里找疑似金鑰。 */
export function scanTextForSecrets(text: string): Array<Omit<SecretFinding, 'path' | 'line'>> {
  const found: Array<Omit<SecretFinding, 'path' | 'line'>> = [];
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      found.push({ rule: rule.id, name: rule.name, preview: `${match[0].slice(0, 6)}…` });
    }
  }
  return found;
}

/**
 * 掃描 unified diff 裡新增的行（P2-9，合入前）：只看以 + 開頭的行，報告檔案和新檔案裡的行號。
 */
export function scanDiffForSecrets(patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let path: string | undefined;
  let line = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      for (const f of scanTextForSecrets(raw.slice(1))) findings.push({ ...f, path, line });
      line += 1;
    } else if (!raw.startsWith('-')) {
      line += 1;
    }
  }
  return findings;
}
