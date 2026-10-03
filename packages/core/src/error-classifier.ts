import type { NormalizedError } from './types.js';

/**
 * 錯誤分類器（P2.4）。
 *
 * 優先順序：結構化原生訊號 → 確定性執行時結果 → 文字推斷（兜底）。
 * - 帶 code/category 的結構化錯誤：confidence = confirmed；
 * - 只有異常文字時按規則推斷：confidence = inferred，UI 不得把它展示為已證實的 provider 決策。
 */

const CATEGORIES: ReadonlySet<NormalizedError['category']> = new Set(['policy', 'approval', 'permission', 'runtime', 'tool', 'usage', 'unknown']);

interface TextRule {
  pattern: RegExp;
  code: string;
  category: NormalizedError['category'];
  retryable: boolean;
}

/** 文字推斷規則：順序即優先順序。 */
const TEXT_RULES: TextRule[] = [
  { pattern: /\b(content policy|safety|refus(ed|al)|policy violation)\b/i, code: 'INFERRED_POLICY_BLOCK', category: 'policy', retryable: false },
  { pattern: /\b(rate.?limit|429|too many requests)\b/i, code: 'INFERRED_RATE_LIMIT', category: 'usage', retryable: true },
  { pattern: /\b(quota|usage limit|billing|insufficient credit)\b/i, code: 'INFERRED_QUOTA', category: 'usage', retryable: false },
  { pattern: /\b(unauthori[sz]ed|401|403|forbidden|not logged in|authentication)\b/i, code: 'INFERRED_AUTH', category: 'permission', retryable: false },
  { pattern: /\b(EACCES|EPERM|permission denied)\b/i, code: 'INFERRED_PERMISSION', category: 'permission', retryable: false },
  { pattern: /\b(ENOENT|not found|command not found|is not recognized)\b/i, code: 'INFERRED_NOT_FOUND', category: 'runtime', retryable: false },
  { pattern: /\b(timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|overloaded|503|502|temporar(y|ily))\b/i, code: 'INFERRED_TRANSIENT', category: 'runtime', retryable: true },
];

export interface StructuredErrorInput {
  code?: unknown;
  category?: unknown;
  retryable?: unknown;
  message?: unknown;
}

/** 結構化錯誤（adapter 已歸一化的 runtime.error 資料等）。 */
export function classifyStructured(input: StructuredErrorInput): NormalizedError | undefined {
  if (typeof input.code !== 'string' || !input.code) return undefined;
  const category = typeof input.category === 'string' && CATEGORIES.has(input.category as NormalizedError['category']) ? (input.category as NormalizedError['category']) : 'unknown';
  return {
    code: input.code,
    message: typeof input.message === 'string' ? input.message : input.code,
    category,
    retryable: input.retryable === true,
    confidence: 'confirmed',
  };
}

/** 只有異常/文字時的兜底推斷。 */
export function inferFromText(message: string): NormalizedError {
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(message)) {
      return { code: rule.code, message, category: rule.category, retryable: rule.retryable, confidence: 'inferred' };
    }
  }
  return { code: 'UNKNOWN_ERROR', message, category: 'unknown', retryable: false, confidence: 'inferred' };
}

/** 統一入口：先看結構化欄位，再退回文字推斷。 */
export function classifyError(error: unknown): NormalizedError {
  if (error && typeof error === 'object') {
    const structured = classifyStructured(error as StructuredErrorInput);
    if (structured) return structured;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return inferFromText(message);
  }
  return inferFromText(String(error));
}
