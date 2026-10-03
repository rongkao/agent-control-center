import { createHash } from 'node:crypto';
import type { TestConfigChange, TestConfigFingerprint, TestConfigReview } from './types.js';

/**
 * 測試配置的比較與差異（P0-8 / H-15）：純函式，不做 IO。讀取檔案的部分在 @acc/adapters 的 test-config-probe.ts。
 *
 * testCommand 由操作員提供，但它實際執行的內容（package.json 的 scripts、測試框架配置、testCommand 直接引用的腳本）
 * 在 agent 可寫的工作區裡。編排器在任務建立時記下這些配置的指紋（基線），每次進入測試步驟之前重新讀取、比較：
 * 一致就照常自動執行；不一致就停在 WAITING_INPUT，把逐檔案的差異交給操作員確認。
 */

/** 測試配置確認閘門的輸入 ID（pendingInputs 裡的 id）。 */
export const TEST_CONFIG_INPUT_ID = 'test-config-review';

/** 單個檔案的差異最多顯示多少行。 */
const MAX_DIFF_LINES = 300;
/** 超過這麼多“行 × 行”就不做逐行比對，直接列出刪除和新增（避免大檔案拖慢編排器）。 */
const MAX_DIFF_CELLS = 1_000_000;
/** 差異裡每處改動前後保留的上下文行數。 */
const DIFF_CONTEXT = 3;

/** 測試配置的摘要：檔案路徑與內容雜湊（按路徑排序）的 sha256。確認時用它核對操作員看到的就是現在的配置。 */
export function testConfigDigest(fingerprint: TestConfigFingerprint): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(fingerprint.files).sort()) hash.update(`${path}\u0000${fingerprint.files[path]!.hash}\n`);
  return hash.digest('hex');
}

/** 兩份指紋是否相同。 */
export function sameTestConfig(a: TestConfigFingerprint | undefined, b: TestConfigFingerprint | undefined): boolean {
  if (!a || !b) return false;
  return testConfigDigest(a) === testConfigDigest(b);
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type DiffOp = { tag: ' ' | '-' | '+'; line: string };

/** 逐行比對（最長公共子序列）。 */
function diffOps(before: string[], after: string[]): DiffOp[] {
  // 先去掉相同的開頭和結尾，縮小比對範圍
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const a = before.slice(start, endA);
  const b = after.slice(start, endB);
  const middle: DiffOp[] = [];
  if (a.length * b.length > MAX_DIFF_CELLS) {
    for (const line of a) middle.push({ tag: '-', line });
    for (const line of b) middle.push({ tag: '+', line });
  } else {
    // lcs[i][j]：a[i..] 與 b[j..] 的最長公共子序列長度
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push({ tag: ' ', line: a[i]! });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        middle.push({ tag: '-', line: a[i]! });
        i += 1;
      } else {
        middle.push({ tag: '+', line: b[j]! });
        j += 1;
      }
    }
    while (i < a.length) middle.push({ tag: '-', line: a[i++]! });
    while (j < b.length) middle.push({ tag: '+', line: b[j++]! });
  }
  return [...before.slice(0, start).map((line) => ({ tag: ' ' as const, line })), ...middle, ...before.slice(endA).map((line) => ({ tag: ' ' as const, line }))];
}

/**
 * 統一格式的差異（只保留改動附近的上下文，不同的改動之間用 ⋯ 分隔）：以 - 開頭的行被刪除，以 + 開頭的行是新增。
 * 超過 MAX_DIFF_LINES 行時截斷。
 */
export function unifiedDiff(before: string, after: string): string {
  const ops = diffOps(splitLines(before), splitLines(after));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.tag === ' ') return;
    for (let k = Math.max(0, index - DIFF_CONTEXT); k <= Math.min(ops.length - 1, index + DIFF_CONTEXT); k += 1) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push('⋯');
    skipped = false;
    out.push(`${op.tag}${op.line}`);
  });
  if (out.length > MAX_DIFF_LINES) return [...out.slice(0, MAX_DIFF_LINES), `…（差異過長，只顯示前 ${MAX_DIFF_LINES} 行）`].join('\n');
  return out.join('\n');
}

/**
 * 基線與當前測試配置的逐檔案差異（按路徑排序）。沒有基線時，當前的每個檔案都按“新增”列出（介面會說明無法確認是否被改過）。
 */
export function diffTestConfig(before: TestConfigFingerprint | undefined, after: TestConfigFingerprint): TestConfigChange[] {
  const previous = before?.files ?? {};
  const current = after.files;
  const changes: TestConfigChange[] = [];
  for (const path of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
    const a = previous[path];
    const b = current[path];
    if (a && b && a.hash === b.hash) continue;
    if (!a && b) {
      changes.push({ path, kind: 'added', diff: b.text !== undefined ? unifiedDiff('', b.text) : '', ...(b.note ? { note: b.note } : {}) });
    } else if (a && !b) {
      changes.push({ path, kind: 'removed', diff: a.text !== undefined ? unifiedDiff(a.text, '') : '', ...(a.note ? { note: a.note } : {}) });
    } else if (a && b) {
      const diffable = a.text !== undefined && b.text !== undefined;
      const note = diffable ? b.note : (b.note ?? a.note ?? '內容已變更（不顯示內容）');
      changes.push({ path, kind: 'modified', diff: diffable ? unifiedDiff(a.text!, b.text!) : '', ...(note ? { note } : {}) });
    }
  }
  return changes;
}

/**
 * 同一目錄的新任務沿用上一次確認過的測試配置作為基線（P0 第三批審查）：
 * - 測試命令相同：整份沿用；
 * - 測試命令不同：只沿用共用的部分（package.json、測試框架配置等，沒有標 scope = command 的檔案），
 *   只因為新命令才檢查的檔案（Makefile、引用的腳本）以現在的內容為準——那次確認沒有看過它們。
 * 共用部分裡現在多出來的檔案不會被當成基線：測試之前按“新增”請操作員確認。
 */
export function rebaseTrustedTestConfig(
  trusted: TestConfigFingerprint,
  trustedCommand: string,
  current: TestConfigFingerprint | undefined,
  command: string,
): TestConfigFingerprint {
  if (trustedCommand.trim() === command.trim()) return trusted;
  const files: TestConfigFingerprint['files'] = {};
  for (const [path, file] of Object.entries(trusted.files)) if (file.scope !== 'command') files[path] = file;
  for (const [path, file] of Object.entries(current?.files ?? {})) if (file.scope === 'command') files[path] = file;
  return { files };
}

/** 讀取失敗時代替真實配置的條目名。 */
export const TEST_CONFIG_UNREADABLE_PATH = '（無法讀取測試設定）';

/**
 * 讀取測試配置失敗時使用的指紋（fail closed）：它和任何基線都不一樣，所以測試步驟會停下來請操作員確認；
 * 同樣的錯誤得到同樣的摘要，操作員確認之後可以繼續。
 */
export function unreadableTestConfig(message: string): TestConfigFingerprint {
  return { files: { [TEST_CONFIG_UNREADABLE_PATH]: { hash: createHash('sha256').update(`unreadable:${message}`).digest('hex'), text: message, note: '讀取測試設定失敗' } } };
}

/** 等待確認時給操作員看的一句話（中文，跟隨介面的繁體文案）。 */
export function testConfigPrompt(review: Pick<TestConfigReview, 'reason' | 'changes' | 'preexisting'>): string {
  if (review.reason === 'no-baseline') {
    return '無法確認測試設定有沒有被 AI 改過（任務建立於舊版本，或當時讀取失敗）。請先檢視目前的測試設定，確認後再執行測試。';
  }
  if (review.reason === 'unreadable') {
    return '讀取測試設定失敗，無法確認 AI 有沒有改過測試腳本或測試設定。請確認後再執行測試。';
  }
  const files = review.changes.map((change) => change.path);
  const list = files.length > 4 ? `${files.slice(0, 4).join('、')} 等 ${files.length} 個檔案` : files.join('、');
  if (review.preexisting) {
    // 改動在這個任務開始之前就有了：可能是之前的任務裡 AI 改的（當時沒有確認），也可能是你自己改的
    return `測試設定和這個目錄上一次確認過的不一樣（${list}）：可能是之前的任務裡 AI 改的（當時沒有確認），也可能是你自己改的。執行測試前需要你確認這些改動。`;
  }
  return `AI 修改了測試設定（${list}），執行測試前需要你確認這些改動。`;
}
