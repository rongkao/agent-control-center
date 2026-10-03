import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeReadiness, codexReadiness } from '@acc/adapters';

/**
 * P1-16：登入狀態檢查——沒有登入時 agent 標成未就緒，並用中文說明怎麼登入；只看檔案或變數是否存在。
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-home-'));
  dirs.push(dir);
  return dir;
}

describe('登入狀態檢查', () => {
  it('Claude：沒有憑據檔案也沒有變數時未就緒（非 macOS），有憑據檔案或 API key 時就緒', () => {
    const h = home();
    if (process.platform !== 'darwin') {
      const r = claudeReadiness({}, h);
      expect(r.ready).toBe(false);
      expect(r.reason).toContain('claude');
    }
    expect(claudeReadiness({ ANTHROPIC_API_KEY: 'x' }, h).ready).toBe(true);
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', '.credentials.json'), '{}');
    expect(claudeReadiness({}, h).ready).toBe(true);
  });

  it('Codex：沒有 auth.json 也沒有變數時未就緒，提示 codex login', () => {
    const h = home();
    const r = codexReadiness({}, h);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('codex login');
    mkdirSync(join(h, '.codex'), { recursive: true });
    writeFileSync(join(h, '.codex', 'auth.json'), '{}');
    expect(codexReadiness({}, h).ready).toBe(true);
    expect(codexReadiness({ OPENAI_API_KEY: 'x' }, home()).ready).toBe(true);
  });
});
