/**
 * 審批策略（P2-7，參考 Roo / Cline / Kilo 的自動批准與連續計數器、Codex 的執行策略）。
 *
 * 全部是確定性的純函式：
 * - analyzeApprovalRisk：按工具與命令判斷風險等級（low / medium / high）。high 永遠交給人；
 * - 規則（PolicyRule）：操作員從某個審批「以後都允許」生成，按工具 + 命令前綴 / 路徑前綴匹配；
 *   命令裡帶管道、串聯、重定向、命令替換時只有完全相同才匹配（避免 `npm test && rm -rf /` 借前綴放行）；
 * - 自主度（AutonomyMode）：ask = 每次都問；rules = 按規則自動放行（預設）；unattended = 另外自動放行所有非高風險的操作；
 * - 連續自動放行計數：由策略自動放行的次數達到上限後改為交給人，人處理一次就清零。
 */

export type AutonomyMode = 'ask' | 'rules' | 'unattended';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PolicyRule {
  id: string;
  /** 工具名（Bash、Edit、shell、apply_patch…）。 */
  toolName: string;
  /** 只對這個 agent 生效；預設對所有 agent 生效。 */
  agentId?: string;
  /** 命令前綴（命令類工具）。預設不限。 */
  commandPrefix?: string;
  /** 檔案路徑前綴（寫檔案類工具，統一成 / 分隔、小寫比較）。預設不限。 */
  pathPrefix?: string;
  createdAt: number;
  /** 給人看的說明。 */
  note?: string;
}

/** 策略配置的來源（服務端把它存在資料目錄裡）。 */
export interface ApprovalPolicySource {
  mode(): AutonomyMode;
  rules(): readonly PolicyRule[];
}

/** 預設的連續自動放行上限：達到後交給人確認一次。 */
export const DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS = 25;

/** 唯讀、不會產生副作用的工具（Claude 內建）。 */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'WebSearch']);
/** 寫檔案的工具。 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
/** 執行命令的工具。 */
const SHELL_TOOLS = new Set(['Bash', 'shell', 'PowerShell']);

/** 高風險命令：刪除、強推、重置、下載即執行、改權限、釋出、關機等。 */
const HIGH_RISK_COMMAND = [
  /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\b(?:del|erase|rd|rmdir)\s+\/[sq]/i,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:ba|z)?sh\b/,
  /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(?:iex|Invoke-Expression)\b/i,
  /\bInvoke-Expression\b|\biex\s/i,
  /\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:/i,
  /\bchmod\s+-R\s+777\b|\bchown\s+-R\b/,
  /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b/,
  /\b(?:shutdown|reboot|Stop-Computer|Restart-Computer)\b/i,
  /\bsudo\b|\brunas\b/i,
  /\breg\s+(?:add|delete)\b|\bSet-ItemProperty\b[^\n]*HKLM/i,
];
/** 訪問網路的命令：中風險。 */
const NETWORK_COMMAND = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ssh|scp|nc|ncat|ftp)\b/i;
/** 命令裡帶這些就不能只按前綴匹配：管道、串聯、重定向、命令替換、換行。 */
const COMPOUND_COMMAND = /[|;&`<>\n\r]|\$\(/;

/** 審批裡的命令（Claude 的 Bash、Codex 的 shell）。 */
export function approvalCommand(payload: Record<string, unknown>): string | undefined {
  const input = (payload.fullInput ?? payload.toolInput) as Record<string, unknown> | undefined;
  return typeof input?.command === 'string' ? input.command : undefined;
}

/** 審批裡要寫的檔案路徑（Claude 的 file_path / notebook_path，Codex apply_patch 的 files）。 */
export function approvalPaths(payload: Record<string, unknown>): string[] {
  const input = (payload.fullInput ?? payload.toolInput) as Record<string, unknown> | undefined;
  if (!input) return [];
  const out: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path']) if (typeof input[key] === 'string') out.push(input[key] as string);
  if (Array.isArray(input.files)) {
    for (const f of input.files as unknown[]) {
      if (typeof f === 'string') out.push(f);
      else if (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string') out.push((f as { path: string }).path);
    }
  }
  return out;
}

const normPath = (p: string) => p.split('\\').join('/').toLowerCase();
const normCommand = (c: string) => c.trim().replace(/\s+/g, ' ');

/** 確定性的風險分析（P2-7）。 */
export function analyzeApprovalRisk(payload: Record<string, unknown>): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  // adapter 已經標成高風險（例如命令涉及受保護路徑）、交接、提問、額外權限：一律交給人
  if (payload.risk === 'high') reasons.push('adapter 標為高風險');
  if (payload.kind === 'handoff' || payload.kind === 'question') reasons.push('交接或提問需要你決定');
  const toolName = String(payload.toolName ?? '');
  if (toolName === 'permissions') reasons.push('申請額外權限');
  const command = approvalCommand(payload);
  if (command !== undefined) {
    for (const pattern of HIGH_RISK_COMMAND) {
      if (pattern.test(command)) {
        reasons.push(`高風險命令（${pattern.source.slice(0, 40)}）`);
        break;
      }
    }
  }
  if (reasons.length) return { level: 'high', reasons };
  if (READ_ONLY_TOOLS.has(toolName)) return { level: 'low', reasons: ['唯讀工具'] };
  if (command !== undefined) {
    if (NETWORK_COMMAND.test(command)) return { level: 'medium', reasons: ['會連網'] };
    return { level: 'medium', reasons: ['執行命令'] };
  }
  if (WRITE_TOOLS.has(toolName)) return { level: 'medium', reasons: ['修改檔案'] };
  return { level: 'medium', reasons: ['其他工具'] };
}

/** 規則是否匹配這個審批。 */
export function ruleMatches(rule: PolicyRule, payload: Record<string, unknown>, agentId: string): boolean {
  if (rule.agentId && rule.agentId !== agentId) return false;
  if (String(payload.toolName ?? '') !== rule.toolName) return false;
  if (rule.commandPrefix !== undefined) {
    const command = approvalCommand(payload);
    if (command === undefined) return false;
    const normalized = normCommand(command);
    const prefix = normCommand(rule.commandPrefix);
    if (normalized !== prefix) {
      // 複合命令只允許完全相同；普通命令按“前綴 + 空格”匹配（npm test 匹配 npm test -- --watch，不匹配 npm testx）
      if (COMPOUND_COMMAND.test(command) || !normalized.startsWith(`${prefix} `)) return false;
    }
  }
  if (rule.pathPrefix !== undefined) {
    const paths = approvalPaths(payload);
    const prefix = normPath(rule.pathPrefix);
    if (paths.length === 0 || !paths.every((p) => normPath(p).startsWith(prefix))) return false;
  }
  return true;
}

/** 從一個審批生成規則（「以後都允許」）：命令類按整條命令（不含引數時就是它本身），寫檔案類按所在目錄。 */
export function ruleFromApproval(payload: Record<string, unknown>, agentId: string): Omit<PolicyRule, 'id' | 'createdAt'> | undefined {
  const toolName = String(payload.toolName ?? '');
  if (!toolName || analyzeApprovalRisk(payload).level === 'high') return undefined;
  const command = approvalCommand(payload);
  if (command !== undefined) {
    const normalized = normCommand(command);
    return { toolName, agentId, commandPrefix: normalized, note: `${toolName}: ${normalized.slice(0, 120)}` };
  }
  const paths = approvalPaths(payload);
  if (paths.length > 0) {
    // 所有路徑共同的目錄
    const dirs = paths.map((p) => normPath(p).replace(/\/[^/]*$/, '/'));
    let prefix = dirs[0]!;
    for (const d of dirs.slice(1)) while (!d.startsWith(prefix)) prefix = prefix.replace(/[^/]*\/$/, '');
    return { toolName, agentId, pathPrefix: prefix, note: `${toolName}: ${prefix}` };
  }
  return { toolName, agentId, note: toolName };
}

export interface PolicyDecision {
  allow: boolean;
  ruleId?: string;
  risk: RiskLevel;
  /** 給人看的說明（為什麼放行 / 為什麼沒有放行）。 */
  reason: string;
}

/**
 * 策略判斷（P2-7）：ask 模式、高風險、達到連續上限時都交給人；
 * 否則匹配到規則就放行；unattended 模式下沒有規則也放行非高風險的操作。
 */
export function evaluateApprovalPolicy(
  payload: Record<string, unknown>,
  agentId: string,
  source: ApprovalPolicySource,
  consecutive: number,
  maxConsecutive = DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS,
): PolicyDecision {
  const { level, reasons } = analyzeApprovalRisk(payload);
  const mode = source.mode();
  if (mode === 'ask') return { allow: false, risk: level, reason: '自主度設為「每次都問」' };
  if (level === 'high') return { allow: false, risk: level, reason: `高風險，需要你確認：${reasons.join('、')}` };
  if (consecutive >= maxConsecutive) return { allow: false, risk: level, reason: `已經連續自動放行 ${consecutive} 次，請確認一次再繼續` };
  const rule = source.rules().find((r) => ruleMatches(r, payload, agentId));
  if (rule) return { allow: true, ruleId: rule.id, risk: level, reason: `符合規則：${rule.note ?? rule.toolName}` };
  if (mode === 'unattended') return { allow: true, risk: level, reason: `無人值守模式：${reasons.join('、')}` };
  return { allow: false, risk: level, reason: '沒有符合的規則' };
}
