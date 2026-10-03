import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ApprovalPolicySource, AutonomyMode, PolicyRule } from '@acc/core';

/**
 * 審批策略的持久化（P2-7）：資料目錄裡的 policy.json（{ mode, rules }），寫入時先寫臨時檔案再改名。
 * 檔案壞了不阻止啟動：按預設（rules 模式、沒有規則 = 全部交給人）處理，並在日誌裡說明。
 */
export class FilePolicyStore implements ApprovalPolicySource {
  private state: { mode: AutonomyMode; rules: PolicyRule[] };

  constructor(
    private readonly file: string,
    defaults: { mode?: AutonomyMode } = {},
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.state = { mode: defaults.mode ?? 'rules', rules: [] };
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { mode?: unknown; rules?: unknown };
      const mode = raw.mode === 'ask' || raw.mode === 'rules' || raw.mode === 'unattended' ? raw.mode : this.state.mode;
      const rules = Array.isArray(raw.rules) ? (raw.rules as PolicyRule[]).filter((r) => r && typeof r.id === 'string' && typeof r.toolName === 'string') : [];
      this.state = { mode, rules };
    } catch (error) {
      this.log(`policy.json 讀不出來，改用預設（所有審批都交給你）：${(error as Error).message}`);
    }
  }

  mode(): AutonomyMode {
    return this.state.mode;
  }

  rules(): readonly PolicyRule[] {
    return this.state.rules;
  }

  setMode(mode: AutonomyMode): void {
    this.state = { ...this.state, mode };
    this.save();
  }

  /** 加一條規則；已經有一樣的（工具、agent、命令前綴、路徑前綴都相同）時返回原來那條。 */
  addRule(rule: Omit<PolicyRule, 'id' | 'createdAt'>, now = Date.now()): PolicyRule {
    const same = this.state.rules.find(
      (r) => r.toolName === rule.toolName && r.agentId === rule.agentId && r.commandPrefix === rule.commandPrefix && r.pathPrefix === rule.pathPrefix,
    );
    if (same) return same;
    const created: PolicyRule = { ...rule, id: randomUUID().slice(0, 8), createdAt: now };
    this.state = { ...this.state, rules: [...this.state.rules, created] };
    this.save();
    return created;
  }

  removeRule(id: string): boolean {
    const before = this.state.rules.length;
    this.state = { ...this.state, rules: this.state.rules.filter((r) => r.id !== id) };
    if (this.state.rules.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}
