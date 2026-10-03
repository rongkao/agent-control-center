import { describe, expect, it } from 'vitest';
import { handoffRequestNotice, sessionScopeOffered } from '../../apps/web/src/approval-ui.js';
import { pendingApprovalBanner } from '../../apps/web/src/blocked-ui.js';

/**
 * P0-9 / H-13 的介面部分：從文字推斷的交接請求（Codex 的 HANDOFF@ 標記）一律交給操作員確認，
 * 介面要說明原因——“這是從文字推斷的請求，需要你確認”；auto 策略下還要說明為什麼沒有自動執行。
 */

const AGENTS = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
];

describe('交接請求的說明', () => {
  it('推斷出的請求：說明需要確認；auto 策略下說明為什麼沒有自動執行', () => {
    expect(handoffRequestNotice({ kind: 'handoff', inferred: true })).toBe('這是從文字推斷的請求，需要你確認。');
    expect(handoffRequestNotice({ kind: 'handoff', inferred: true, policy: 'auto' })).toBe('這是從文字推斷的請求，需要你確認（自動交接只會自動執行 AI 透過正式工具提出的請求）。');
  });

  it('結構化的請求、普通審批、舊記錄：沒有這條說明', () => {
    expect(handoffRequestNotice({ kind: 'handoff', inferred: false })).toBeUndefined();
    expect(handoffRequestNotice({ kind: 'handoff' })).toBeUndefined();
    expect(handoffRequestNotice({ toolName: 'Bash', inferred: true })).toBeUndefined();
    expect(handoffRequestNotice(undefined)).toBeUndefined();
  });

  it('待審批橫幅同樣說明是從文字推斷的請求', () => {
    const text = pendingApprovalBanner([{ agentId: 'codex', payload: { kind: 'handoff', fromAgentId: 'codex', toAgentId: 'claude', inferred: true } }], AGENTS)!;
    expect(text).toContain('Codex 請求把工作交給 Claude');
    expect(text).toContain('這是從文字推斷的請求，需要你確認');
  });

  it('交接請求沒有「本會話都允許」：由編排器策略產生的放行不會擴大成會話級', () => {
    expect(sessionScopeOffered({ kind: 'handoff', inferred: true })).toBe(false);
  });
});
