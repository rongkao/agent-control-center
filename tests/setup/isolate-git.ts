import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 測試不受開發者自己的 git 配置影響（P1-11 / L-30）：全域性配置裡的簽名、hooks、預設分支名等會讓用到 git 的測試在不同機器上表現不同。
 * 這裡給測試程序指定一個空的全域性配置（只設定提交需要的身份），並忽略系統級配置。
 */
const dir = mkdtempSync(join(tmpdir(), 'acc-gitconfig-'));
const config = join(dir, 'gitconfig');
writeFileSync(config, '[user]\n\tname = ACC Tests\n\temail = tests@local.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
