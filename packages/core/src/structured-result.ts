import type { ReviewVerdict } from './types.js';

/**
 * 結構化的完成結果（P2-5）：評審這一步要求 agent 按 JSON Schema 交回結論與問題列表
 * （Codex 用 turn/start 的 outputSchema 約束最後一條回覆）。拿到結構化結果時工作流按它判斷（confidence = confirmed），
 * 拿不到（模型不支援、回覆不是合法 JSON）時退回文字裡的 VERDICT 行（confidence = inferred）。
 */

export interface ReviewIssue {
  severity: 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
  text: string;
}

export interface StructuredReview {
  kind: 'review';
  verdict: Exclude<ReviewVerdict, 'UNKNOWN'>;
  summary: string;
  issues: ReviewIssue[];
}

/** 評審結果的 JSON Schema（嚴格模式：所有欄位必填，可選的用 null）。 */
export const REVIEW_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['ACCEPT', 'SUGGEST_CHANGES', 'BLOCKED'], description: 'ACCEPT if the change is good to merge, SUGGEST_CHANGES if fixes are needed, BLOCKED if it cannot be reviewed' },
    summary: { type: 'string', description: 'Short overall assessment' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'text'],
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          text: { type: 'string' },
        },
      },
    },
  },
};

/** 解析結構化評審結果；不是合法的結果時返回 undefined。 */
export function parseStructuredReview(text: string): StructuredReview | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.verdict !== 'ACCEPT' && r.verdict !== 'SUGGEST_CHANGES' && r.verdict !== 'BLOCKED') return undefined;
  const issues = Array.isArray(r.issues)
    ? (r.issues as Array<Record<string, unknown>>).map((i) => ({
        severity: i.severity === 'high' || i.severity === 'low' ? i.severity : 'medium',
        ...(typeof i.file === 'string' && i.file ? { file: i.file } : {}),
        ...(typeof i.line === 'number' ? { line: i.line } : {}),
        text: String(i.text ?? ''),
      })) as ReviewIssue[]
    : [];
  return { kind: 'review', verdict: r.verdict, summary: String(r.summary ?? ''), issues };
}

/** 給人看的評審結果（第一行是 VERDICT，文字解析也能認出來）。 */
export function renderStructuredReview(review: StructuredReview): string {
  const lines = [`VERDICT: ${review.verdict}`, '', review.summary.trim()];
  if (review.issues.length) {
    lines.push('', 'Issues:');
    for (const i of review.issues) lines.push(`- [${i.severity}]${i.file ? ` ${i.file}${i.line ? `:${i.line}` : ''}` : ''} — ${i.text}`);
  }
  return lines.join('\n').trim();
}
