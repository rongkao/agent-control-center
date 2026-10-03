import type { TestConfigReview } from './types';

/**
 * 測試配置確認卡片的純函式規則（P0-8 / H-15），與 React 元件分開，便於單獨測試。
 *
 * AI 改過測試配置（package.json 的 scripts、測試框架配置、測試命令引用的腳本）時，測試不會自動執行，
 * 介面顯示逐檔案的差異，由操作員一鍵決定：確認並執行測試 / 讓 AI 改回去 / 不跑測試直接接受結果（/ 停止）。
 */

export const TEST_CONFIG_KIND_LABEL: Record<string, string> = { added: '新增', removed: '刪除', modified: '修改' };

/** 卡片標題。 */
export function testConfigTitle(review: Pick<TestConfigReview, 'reason'>): string {
  if (review.reason === 'no-baseline') return '無法確認測試設定有沒有被改過，執行測試前需要你確認';
  if (review.reason === 'unreadable') return '讀取測試設定失敗，執行測試前需要你確認';
  return 'AI 改動了測試設定，執行測試前需要你確認';
}

/** 卡片上的說明：為什麼要確認。 */
export function testConfigExplanation(testCommand: string | undefined): string {
  const command = testCommand ? `「${testCommand}」` : '測試命令';
  return `${command}實際執行什麼，由下面這些檔案決定。AI 改動它們之後，執行測試就可能執行任何命令（例如把程式碼或金鑰傳到外面）。請確認這些改動是你要的，再執行測試。`;
}

/** 「讓 AI 改回去」時發給實現 agent 的說明（帶說明重試的 note）。 */
export function testConfigRevertNote(review: Pick<TestConfigReview, 'changes'>): string {
  const files = review.changes.map((change) => change.path).join('、');
  return `你修改了測試設定（${files}）。除非任務明確要求，請把這些測試設定改回原樣，不要為了讓測試通過而修改測試腳本或測試設定；完成後簡要說明你改了什麼。`;
}

export type TestConfigAction = 'confirm' | 'revert' | 'accept';

/**
 * 卡片上提供哪些一鍵操作：確認並執行測試總是可以；「讓 AI 改回去」「不跑測試，直接接受結果」是人工閘門的決定，
 * 只有任務在等你決定（WAITING_INPUT / BLOCKED）時才提供。停止在流程控制條上。
 */
export function testConfigActions(status: string): TestConfigAction[] {
  return status === 'WAITING_INPUT' || status === 'BLOCKED' ? ['confirm', 'revert', 'accept'] : ['confirm'];
}

/** 差異的一行對應的樣式。 */
export function diffLineClass(line: string): 'add' | 'del' | 'gap' | 'ctx' {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line === '⋯' || line.startsWith('…')) return 'gap';
  return 'ctx';
}
