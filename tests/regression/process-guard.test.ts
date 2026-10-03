import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P0-2（H-2）：服務端註冊全域性 unhandledRejection 處理器——只記錄日誌，不退出程序。
 * 用真實子程序驗證（vitest 自己會攔截測試程序裡的未處理拒絕，無法在程序內證明“程序存活”）。
 */

const fixture = fileURLToPath(new URL('./fixtures/unhandled-rejection-child.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function runChild(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', fixture, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
}

describe('全域性 unhandledRejection 兜底', () => {
  it('故意製造一個未處理的 Promise 拒絕：程序存活，日誌裡有這條錯誤', () => {
    const result = runChild();
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('LOGGED');
    expect(result.stdout).toContain('p0-2 deliberate rejection');
    expect(result.stdout).toContain('ALIVE');
    expect(result.status).toBe(0);
  });

  it('對照：不安裝兜底時，同樣的拒絕會讓程序以非零碼退出', () => {
    const result = runChild('--no-guard');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('p0-2 deliberate rejection');
  });
});
