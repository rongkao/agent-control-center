import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkWindowsDacl, createTokenFileGuard, currentWindowsUserSid, readWindowsDacl, sddlAliasesForSid } from '@acc/server';

/**
 * P0-1 審查（high）：以內建 Administrator（RID 500）賬戶執行時，令牌檔案 ACL 自檢因為 SDDL 別名 LA 誤報。
 *
 * 現象（修復前）：restrict() 只授權給當前使用者 S-1-5-21-<機器>-500，但 icacls /save 讀回的 SDDL 把 RID 500 寫成別名 LA：
 * D:PAI(A;;FA;;;LA)。checkWindowsDacl 只認 SY/LS/NS 三個別名，於是把 LA 當成“別的賬戶”，每次啟動都以
 * ACC_TOKEN_FILE_INSECURE 拒絕；ACC_TOKEN_FILE 走同一套檢查，也沒有任何繞過辦法（雲主機和不少裝機版預設就是 Administrator）。
 *
 * 期望：與賬戶域相關的別名（LA = 本機 Administrator，LG = 本機 Guest）按“Windows 實際怎麼寫當前使用者”解析；
 * 當前使用者不是 RID 500 時，出現 LA 仍然判為問題。
 */

const USER_1001 = 'S-1-5-21-3595940597-263295407-201143530-1001';
const ADMIN_500 = 'S-1-5-21-3595940597-263295407-201143530-500';

describe('checkWindowsDacl：賬戶域別名（純函式）', () => {
  it('當前使用者就是本機 Administrator（SDDL 寫成 LA）：只授權給它時不算問題', () => {
    expect(checkWindowsDacl('D:PAI(A;;FA;;;LA)', ADMIN_500, { userAliases: ['LA'] })).toBeUndefined();
  });

  it('當前使用者不是 RID 500：出現 LA 仍然判為“還授權給了別的賬戶”', () => {
    expect(checkWindowsDacl(`D:PAI(A;;FA;;;${USER_1001})(A;;FA;;;LA)`, USER_1001)).toContain('LA');
    expect(checkWindowsDacl(`D:PAI(A;;FA;;;${USER_1001})(A;;FA;;;LA)`, USER_1001, { userAliases: [] })).toContain('LA');
  });

  it('其他規則不變：繼承、沒有授權給自己、多餘的賬戶', () => {
    expect(checkWindowsDacl('D:AI(A;;FA;;;LA)', ADMIN_500, { userAliases: ['LA'] })).toContain('繼承');
    expect(checkWindowsDacl('D:PAI(A;;FA;;;SY)', ADMIN_500, { userAliases: ['LA'] })).toContain('SY');
    expect(checkWindowsDacl('D:PAI(A;;FA;;;LA)(A;;FR;;;WD)', ADMIN_500, { userAliases: ['LA'] })).toContain('WD');
  });
});

describe.runIf(process.platform === 'win32')('Windows：真實 ACL（icacls）', () => {
  const icaclsExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const dirs: Array<{ dir: string; file: string }> = [];
  afterEach(() => {
    while (dirs.length) {
      const { dir, file } = dirs.pop()!;
      // 檔案可能只授權給了別的賬戶：先以所有者身份恢復繼承的權限，再刪除
      spawnSync(icaclsExe, [file, '/reset'], { windowsHide: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'acc-acl-alias-'));
    const file = join(dir, 'access-token');
    dirs.push({ dir, file });
    writeFileSync(file, '');
    return file;
  }

  /** 與當前使用者同一個賬戶域裡的 RID 500 賬戶（本機賬戶時就是本機的內建 Administrator）。 */
  const rid500 = () => currentWindowsUserSid().replace(/-\d+$/, '-500');

  it('檔案只授權給 RID 500 賬戶：按 Windows 實際寫法（通常是 LA）識別為“只有該使用者”', () => {
    const file = tempFile();
    const sid = rid500();
    const icacls = spawnSync(icaclsExe, [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
    expect(icacls.status).toBe(0);
    const sddl = readWindowsDacl(file);
    // 本機賬戶域時 Windows 把它寫成別名 LA（域賬戶時寫完整 SID）；兩種情況都必須通過
    const aliases = sddlAliasesForSid(sid);
    if (sddl.includes(';;;LA)')) expect(aliases).toContain('LA');
    expect(checkWindowsDacl(sddl, sid, { userAliases: aliases })).toBeUndefined();
  });

  it('令牌檔案保護：以 RID 500 賬戶身份收緊權限後，自檢通過（修復前每次都報“還授權給了 LA”）', () => {
    const file = tempFile();
    const guard = createTokenFileGuard('win32', { userSid: rid500() });
    guard.restrict(file);
    expect(guard.check(file)).toBeUndefined();
  });

  it('反向：當前使用者不是 RID 500 時，檔案額外授權給了本機 Administrator 仍被判為問題', () => {
    const me = currentWindowsUserSid();
    if (me.endsWith('-500')) return; // 本身就以 Administrator 執行時這個場景不存在
    const file = tempFile();
    const guard = createTokenFileGuard('win32');
    guard.restrict(file);
    expect(guard.check(file)).toBeUndefined();
    const icacls = spawnSync(icaclsExe, [file, '/grant', `*${rid500()}:(R)`], { windowsHide: true });
    expect(icacls.status).toBe(0);
    expect(guard.check(file)).toMatch(/除當前使用者外/);
  });
});
