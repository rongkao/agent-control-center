import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTestRunnerAdapter, codexConfigEnvNames, codexRuntimeEnv, parseEnvNameList, readCodexConfigEnvNames, testRunnerEnv } from '@acc/adapters';
import { emitRecorder } from './fakes/event-waiter.js';
import { fakeSpawner } from './fakes/fake-test-child.js';

/**
 * P0 第三批審查（P0-8 環境變數白名單的兩個缺口）：
 *
 * 1. Codex 白名單隻認 config.toml 裡的 env_key 和單行 env_vars：bearer_token_env_var、env_http_headers、多行陣列和內聯表寫法都漏掉，
 *    對應的認證變數被剝掉，閘道器 / MCP 伺服器認證失敗，使用者只能改環境變數名或改原始碼。
 *    期望：按 TOML 語法解析（容錯），在 model_providers、mcp_servers、profiles 等處收集 env_key、env_vars、bearer_token_env_var、
 *    env_http_headers 的值；解析失敗時記日誌並退回逐行識別，不靜默丟棄。
 * 2. 測試執行器的白名單沒有任何放行口：DATABASE_URL、PLAYWRIGHT_BROWSERS_PATH、CHROME_BIN 之類不含憑據字樣的變數被靜默剝掉，
 *    打包成 exe 後使用者無法自行補上。期望：ACC_TEST_ENV_ALLOW（逗號 / 分號分隔）放行這些名字，但憑據類名字仍然不放行；
 *    測試失敗時在結果裡列出被過濾掉的變數名（只列名字），方便判斷。
 */

const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CODEX_TOML = [
  'model = "gpt-5" # 行尾註釋',
  'model_provider = "gateway"',
  '',
  '[model_providers.gateway]',
  'name = "Company gateway"',
  'base_url = "https://gw.example/v1#not-a-comment"',
  'env_http_headers = { "api-key" = "GW_HEADER_SECRET", "x-team" = "GW_TEAM_ID" }',
  '',
  '# 內聯表寫法的提供方',
  'model_providers.inline = { name = "Inline", env_key = "INLINE_PROVIDER_KEY" }',
  '',
  '[mcp_servers.github]',
  'command = "gh-mcp"',
  'bearer_token_env_var = "GH_MCP_PAT"',
  '',
  '[mcp_servers.db]',
  'command = "db-mcp"',
  'env_vars = [',
  '  "DB_MCP_PASSWORD", # 資料庫密碼',
  "  'DB_MCP_USER',",
  ']',
  '',
  '[profiles.work.model_providers.azure]',
  'env_key = "AZURE_WORK_KEY"',
  '',
  '[[skills.config]]',
  'path = """',
  'env_key = "NOT_A_REAL_ASSIGNMENT"',
  '"""',
].join('\n');

describe('Codex config.toml：按 TOML 語法收集認證需要的變數名', () => {
  it('bearer_token_env_var、env_http_headers、多行陣列、內聯表、profiles 裡的都能找到', () => {
    const names = codexConfigEnvNames(CODEX_TOML);
    for (const name of ['GW_HEADER_SECRET', 'GW_TEAM_ID', 'INLINE_PROVIDER_KEY', 'GH_MCP_PAT', 'DB_MCP_PASSWORD', 'DB_MCP_USER', 'AZURE_WORK_KEY']) {
      expect(names, name).toContain(name);
    }
    // 多行字串裡的文字不是賦值
    expect(names).not.toContain('NOT_A_REAL_ASSIGNMENT');
  });

  it('這些變數隨後放行給 app-server；其他憑據照樣不傳', () => {
    const source = { PATH: 'C:/bin', GH_MCP_PAT: 'ghp_fake', GW_HEADER_SECRET: 'gw-fake', DB_MCP_PASSWORD: 'db-fake', INLINE_PROVIDER_KEY: 'inline-fake', ANTHROPIC_API_KEY: 'sk-ant-fake' };
    const env = codexRuntimeEnv(source, 'win32', { extraNames: codexConfigEnvNames(CODEX_TOML) });
    expect(Object.keys(env).sort()).toEqual(['DB_MCP_PASSWORD', 'GH_MCP_PAT', 'GW_HEADER_SECRET', 'INLINE_PROVIDER_KEY', 'PATH']);
  });

  it('config.toml 語法有錯：記日誌提示（不含變數的值），並退回逐行識別，不靜默丟掉', () => {
    const home = tempDir('acc-codex-home-');
    writeFileSync(join(home, 'config.toml'), '[mcp_servers.github\nbearer_token_env_var = "GH_MCP_PAT"\n[model_providers.x]\nenv_key = "X_KEY"\n');
    const logs: string[] = [];
    const names = readCodexConfigEnvNames({ CODEX_HOME: home }, (message) => logs.push(message));
    expect(names).toEqual(expect.arrayContaining(['GH_MCP_PAT', 'X_KEY']));
    expect(logs.some((line) => line.includes('config.toml'))).toBe(true);
  });
});

describe('測試執行器：ACC_TEST_ENV_ALLOW 放行口', () => {
  it('名單裡不含憑據字樣的變數放行；憑據類名字即使列出來也不放行', () => {
    const source = { PATH: 'C:/bin', DATABASE_URL: 'postgres://localhost/test', PLAYWRIGHT_BROWSERS_PATH: 'C:/pw', CHROME_BIN: 'C:/chrome.exe', MY_API_KEY: 'secret', ANDROID_HOME: 'C:/android' };
    const names = parseEnvNameList('DATABASE_URL, PLAYWRIGHT_BROWSERS_PATH;CHROME_BIN  MY_API_KEY bad-name!');
    expect(names).toEqual(['DATABASE_URL', 'PLAYWRIGHT_BROWSERS_PATH', 'CHROME_BIN', 'MY_API_KEY']);
    const env = testRunnerEnv(source, 'win32', { extraNames: names });
    expect(Object.keys(env).sort()).toEqual(['CHROME_BIN', 'DATABASE_URL', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH']);
    // 沒有放行時和原來一樣只有基礎變數
    expect(Object.keys(testRunnerEnv(source, 'win32')).sort()).toEqual(['PATH']);
  });

  it('LocalTestRunnerAdapter：按放行名單構造測試程序的環境；測試失敗時結果裡列出被過濾掉的變數名（只列名字）', async () => {
    const spawner = fakeSpawner();
    let seen: SpawnOptions | undefined;
    const runner = new LocalTestRunnerAdapter({
      defaultCwd: tempDir('acc-test-allow-'),
      env: { PATH: 'C:/bin', DATABASE_URL: 'postgres://localhost/test', CHROME_BIN: 'C:/chrome.exe', OPENAI_API_KEY: 'sk-fake', ACC_DATA_DIR: 'C:/acc' },
      envAllow: ['DATABASE_URL'],
      spawn: (command, options) => {
        seen = options;
        return spawner.spawn(command);
      },
    });
    const recorder = emitRecorder();
    await runner.start({ ...ids, prompt: 'test', mode: 'test', context: { testCommand: 'npm test' } }, recorder.emit);
    const child = await spawner.next(1);
    child.finish(1, 'Error: CHROME_BIN is not set');
    const failed = await recorder.waitFor((event) => event.type === 'tool.failed');
    expect(seen?.env?.DATABASE_URL).toBe('postgres://localhost/test');
    expect(seen?.env?.CHROME_BIN).toBeUndefined();
    expect(failed.data.filteredEnvNames).toEqual(['CHROME_BIN']);
    const done = await recorder.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    expect(String(done.data.outputTail)).toContain('ACC_TEST_ENV_ALLOW');
    expect(JSON.stringify(recorder.events)).not.toContain('C:/chrome.exe');
  });
});

describe('Codex 配置檔案讀取不影響原有行為', () => {
  it('沒有 config.toml：空列表，不寫日誌', () => {
    const home = tempDir('acc-codex-empty-');
    mkdirSync(join(home, 'x'));
    const logs: string[] = [];
    expect(readCodexConfigEnvNames({ CODEX_HOME: home }, (message) => logs.push(message))).toEqual([]);
    expect(logs).toEqual([]);
  });
});
