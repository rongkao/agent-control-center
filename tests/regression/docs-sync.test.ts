import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderTransitionTable } from '@acc/core';

/**
 * P1-13 / L-24：文件與程式碼同步。docs/STATE_MACHINE.md 裡的狀態遷移表由程式碼生成，這裡保證兩者一致——
 * 改了狀態機卻忘了更新文件時，這個測試會失敗並給出應該貼進去的新表。
 */
describe('文件同步', () => {
  it('STATE_MACHINE.md 的遷移表與 state-machine.ts 一致', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../docs/STATE_MACHINE.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const match = /<!-- transitions:start -->\n([\s\S]*?)\n<!-- transitions:end -->/.exec(doc);
    expect(match, 'docs/STATE_MACHINE.md 缺少 transitions 標記').toBeTruthy();
    expect(match![1]).toBe(renderTransitionTable());
  });
});
