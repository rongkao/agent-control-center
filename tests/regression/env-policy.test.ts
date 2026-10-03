import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import {
  ClaudeAgentSdkAdapter,
  CodexAppServerAdapter,
  LocalTestRunnerAdapter,
  claudeRuntimeEnv,
  codexConfigEnvNames,
  codexRuntimeEnv,
  isSensitiveEnvName,
  testRunnerEnv,
} from '@acc/adapters';
import { ClaudeQueryDriver, echoScript } from './fakes/claude-query-driver.js';
import { emitRecorder } from './fakes/event-waiter.js';
import { fakeSpawner } from './fakes/fake-test-child.js';

/**
 * P0-8 / H-15：子程序環境變數改為白名單（packages/adapters/src/env-policy.ts）。
 *
 * 現象（修復前）：測試執行器 `spawn(command, { shell: true, env: process.env })`、Claude 的 query（不傳 env，SDK 預設繼承
 * process.env）、Codex app-server（env: process.env）都把控制面程序的全部環境變數交給子程序——包括各家的 API key、
 * 其他服務的令牌，以及 ACC 自己的配置（ACC_*）。agent 改了測試腳本後，測試步驟就能把這些值外發出去。
 *
 * 期望：
 * - 測試執行器只拿到基礎變數（PATH、SystemRoot、TEMP/TMP、使用者目錄、語言編碼、代理等），任何 *_API_KEY / *_TOKEN /
 *   *_SECRET 和 ACC_* 都不傳；
 * - Claude 執行時在基礎變數之上只多拿 Claude 認證需要的變數（ANTHROPIC_*、CLAUDE_*），Codex 只多拿 OPENAI_*、CODEX_*
 *   （以及它的配置檔案裡 env_key 宣告的變數），兩家互不交叉；ACC_* 一律不傳。
 */

const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };
const dumpEnvFixture = fileURLToPath(new URL('./fixtures/dump-env.mjs', import.meta.url));
const fakeAppServerFixture = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

/** 一份“什麼都有”的源環境（Windows 風格的變數名大小寫）。 */
function windowsSource(): Record<string, string> {
  return {
    Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows',
    SystemDrive: 'C:',
    windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
    USERPROFILE: 'C:\\Users\\me',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    NUMBER_OF_PROCESSORS: '8',
    USERNAME: 'me',
    PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules',
    NODE_OPTIONS: '--max-old-space-size=4096',
    NODE_EXTRA_CA_CERTS: 'C:\\certs\\corp.pem',
    LANG: 'zh_TW.UTF-8',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    no_proxy: 'localhost',
    // 各家憑據與其他服務的機密
    ANTHROPIC_API_KEY: 'sk-ant-fake',
    ANTHROPIC_AUTH_TOKEN: 'fake-anthropic-bearer',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.example',
    CLAUDE_CODE_OAUTH_TOKEN: 'fake-claude-oauth',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-alt',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    CLAUDE_CODE_SOME_SESSION_TOKEN: 'not-an-auth-variable',
    CLAUDECODE: '1',
    OPENAI_API_KEY: 'sk-openai-fake',
    OPENAI_BASE_URL: 'https://api.openai.example/v1',
    CODEX_HOME: 'C:\\Users\\me\\.codex',
    GITHUB_TOKEN: 'ghp_fake',
    AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
    AWS_ACCESS_KEY_ID: 'AKIAFAKE',
    DATABASE_PASSWORD: 'hunter2',
    SOME_SERVICE_SECRET: 'shh',
    DEEPSEEK_API_KEY: 'sk-deepseek-fake',
    // ACC 自己的配置與 npm 注入的變數
    ACC_TOKEN_FILE: 'C:\\secret\\acc-token',
    ACC_DATA_DIR: 'C:\\acc-data',
    ACC_RUNTIME_MODE: 'real',
    INIT_CWD: 'D:\\projects\\app',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_lifecycle_event: 'start',
  };
}

const SECRETS = ['sk-ant-fake', 'fake-anthropic-bearer', 'fake-claude-oauth', 'sk-openai-fake', 'ghp_fake', 'fake-aws-secret', 'hunter2', 'shh', 'sk-deepseek-fake', 'not-an-auth-variable'];

/** 大小寫不敏感地取變數（Windows 的環境變數名不區分大小寫）。 */
function getInsensitive(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/** 臨時設定 process.env 裡的變數（用例結束後恢復）。vitest 每個測試檔案在獨立的子程序裡執行，不會影響別的檔案。 */
function setProcessEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const had = Object.prototype.hasOwnProperty.call(process.env, name);
    const previous = process.env[name];
    process.env[name] = value;
    restores.push(() => {
      if (had) process.env[name] = previous;
      else delete process.env[name];
    });
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  restores.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 注入到 process.env 的探針：跑真實子程序時用來確認“看不到”。 */
const PROBES = {
  P08_PROBE_API_KEY: 'probe-api-key-value-7f3a',
  P08_PROBE_TOKEN: 'probe-token-value-7f3a',
  P08_PROBE_SECRET: 'probe-secret-value-7f3a',
  ACC_P08_PROBE: 'probe-acc-value-7f3a',
  npm_config_p08_probe: 'probe-npm-value-7f3a',
};

describe('env-policy：敏感變數名的識別', () => {
  it('*_API_KEY / *_TOKEN / *_SECRET / 密碼 / 憑據類名字都算敏感；普通路徑類變數不算', () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_PASSWORD', 'NPM_AUTH_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'MY_PRIVATE_KEY', 'APIKEY']) {
      expect(isSensitiveEnvName(name), name).toBe(true);
    }
    for (const name of ['PATH', 'SystemRoot', 'TEMP', 'USERPROFILE', 'NODE_OPTIONS', 'LANG', 'HTTPS_PROXY', 'CLAUDE_CONFIG_DIR', 'KEYBOARD_LAYOUT_DIR']) {
      expect(isSensitiveEnvName(name), name).toBe(false);
    }
  });
});

describe('H-15 測試執行器：只拿到基礎環境變數', () => {
  it('Windows：保留 PATH、SystemRoot、TEMP/TMP、使用者目錄、ComSpec、PATHEXT、NODE 相關、語言編碼和代理；其餘一律不傳', () => {
    const env = testRunnerEnv(windowsSource(), 'win32');
    for (const name of ['Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'LANG', 'HTTPS_PROXY', 'no_proxy']) {
      expect(env[name], name).toBe(windowsSource()[name]);
    }
    const serialized = JSON.stringify(env);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    for (const name of Object.keys(env)) {
      expect(name.toUpperCase().startsWith('ACC_'), name).toBe(false);
      expect(name.toLowerCase().startsWith('npm_'), name).toBe(false);
    }
    expect(env.INIT_CWD).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('Windows 上變數名不區分大小寫：小寫的 path / systemroot 同樣保留（保持原來的寫法）', () => {
    const env = testRunnerEnv({ path: 'C:\\bin', systemroot: 'C:\\Windows', github_token: 'ghp_lower' }, 'win32');
    expect(env).toEqual({ path: 'C:\\bin', systemroot: 'C:\\Windows' });
  });

  it('POSIX：保留 HOME、PATH、SHELL、TMPDIR、LANG、LC_*、TERM；不傳憑據', () => {
    const env = testRunnerEnv(
      { HOME: '/home/me', PATH: '/usr/bin', SHELL: '/bin/bash', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm', OPENAI_API_KEY: 'sk-openai-fake', ACC_HOST: '0.0.0.0' },
      'linux',
    );
    expect(env).toEqual({ HOME: '/home/me', PATH: '/usr/bin', SHELL: '/bin/bash', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm' });
  });

  it('真實子程序：LocalTestRunnerAdapter 執行的測試命令看不到 API key、令牌、機密和 ACC_* 變數，但能正常找到 node', async () => {
    setProcessEnv(PROBES);
    const dir = tempDir('acc-p08-env-');
    const dump = join(dir, 'test-env.json');
    const runner = new LocalTestRunnerAdapter({ defaultCwd: dir });
    const recorder = emitRecorder();
    await runner.start({ ...ids, prompt: 'test', mode: 'test', context: { testCommand: `"${process.execPath}" "${dumpEnvFixture}" "${dump}"` } }, recorder.emit);
    const finished = await recorder.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    expect(finished.data.testPassed).toBe(true);

    const childEnv = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    const serialized = JSON.stringify(childEnv);
    for (const value of Object.values(PROBES)) expect(serialized).not.toContain(value);
    expect(Object.keys(childEnv).filter((name) => name.toUpperCase().startsWith('ACC_'))).toEqual([]);
    expect(getInsensitive(childEnv, 'PATH')).toBeTruthy();
  });

  it('注入的 spawn 收到的是過濾後的新物件，不是 process.env 本身', async () => {
    setProcessEnv(PROBES);
    const spawner = fakeSpawner();
    let seen: SpawnOptions | undefined;
    const runner = new LocalTestRunnerAdapter({
      defaultCwd: tempDir('acc-p08-spawn-'),
      spawn: (command, options) => {
        seen = options;
        return spawner.spawn(command);
      },
    });
    const recorder = emitRecorder();
    await runner.start({ ...ids, prompt: 'test', mode: 'test', context: { testCommand: 'npm test' } }, recorder.emit);
    const child = await spawner.next(1);
    child.finish(0);
    await recorder.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    expect(seen?.env).toBeDefined();
    expect(seen?.env).not.toBe(process.env);
    const serialized = JSON.stringify(seen?.env);
    for (const value of Object.values(PROBES)) expect(serialized).not.toContain(value);
  });
});

describe('Claude 執行時：基礎變數 + Claude 認證需要的變數', () => {
  it('保留 ANTHROPIC_* / CLAUDE_* 的認證與配置變數；不傳 OpenAI / Codex / 其他服務的憑據和 ACC_*', () => {
    const env = claudeRuntimeEnv(windowsSource(), 'win32');
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'Path', 'SystemRoot', 'USERPROFILE', 'HTTPS_PROXY']) {
      expect(env[name], name).toBe(windowsSource()[name]);
    }
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'DATABASE_PASSWORD', 'DEEPSEEK_API_KEY', 'ACC_TOKEN_FILE', 'ACC_DATA_DIR', 'INIT_CWD', 'CLAUDECODE']) {
      expect(env[name], name).toBeUndefined();
    }
    // CLAUDE_ 前綴下看起來像憑據、但不是 Claude 認證變數的，同樣不傳
    expect(env.CLAUDE_CODE_SOME_SESSION_TOKEN).toBeUndefined();
  });

  it('在 Claude Code 裡啟動 ACC 時，標識上一層會話的變數不傳給 ACC 啟動的獨立 CLI', () => {
    const env = claudeRuntimeEnv({ ...windowsSource(), CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '123', CLAUDE_EFFORT: 'high' }, 'win32');
    for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDECODE']) expect(env[name], name).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(windowsSource().CLAUDE_CONFIG_DIR);
  });

  it('只有顯式使用 Bedrock 時才放行 AWS 憑據', () => {
    const source = { ...windowsSource(), CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' };
    const env = claudeRuntimeEnv(source, 'win32');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAFAKE');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('fake-aws-secret');
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('adapter 把白名單環境交給 SDK（options.env），不再預設繼承 process.env', async () => {
    setProcessEnv({ ...PROBES, OPENAI_API_KEY: 'sk-openai-probe-7f3a', ANTHROPIC_BASE_URL: 'https://anthropic.probe.example' });
    const driver = new ClaudeQueryDriver(echoScript);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, defaultCwd: tempDir('acc-p08-claude-') });
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'hi', mode: 'implement' }, recorder.emit);
    const options = (await driver.query(1)).options;
    expect(options.env).toBeDefined();
    const serialized = JSON.stringify(options.env);
    for (const value of Object.values(PROBES)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('sk-openai-probe-7f3a');
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://anthropic.probe.example');
    expect(getInsensitive(options.env as Record<string, string>, 'PATH')).toBeTruthy();
    adapter.dispose();
  });
});

describe('Codex app-server：基礎變數 + Codex 認證需要的變數', () => {
  it('保留 OPENAI_* / CODEX_*；不傳 Anthropic / Claude / 其他服務的憑據和 ACC_*', () => {
    const env = codexRuntimeEnv(windowsSource(), 'win32');
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'Path', 'SystemRoot', 'USERPROFILE', 'HTTPS_PROXY']) {
      expect(env[name], name).toBe(windowsSource()[name]);
    }
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_PASSWORD', 'DEEPSEEK_API_KEY', 'ACC_TOKEN_FILE', 'INIT_CWD']) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('Codex 配置裡自定義模型提供方的 env_key、MCP 伺服器的 env_vars 點名的變數也放行（否則自定義提供方無法認證）', () => {
    const toml = [
      'model_provider = "deepseek"',
      '[model_providers.deepseek]',
      'name = "DeepSeek"',
      'env_key = "DEEPSEEK_API_KEY"',
      '# env_key = "COMMENTED_OUT_KEY"',
      "[model_providers.azure]",
      "env_key = 'AZURE_OPENAI_API_KEY'",
      'env_key = "not a valid name!"',
      '[mcp_servers.github]',
      'env_vars = ["GITHUB_TOKEN", "bad name"]',
    ].join('\n');
    expect(codexConfigEnvNames(toml)).toEqual(['DEEPSEEK_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN']);
    const env = codexRuntimeEnv(windowsSource(), 'win32', { extraNames: codexConfigEnvNames(toml) });
    expect(env.DEEPSEEK_API_KEY).toBe('sk-deepseek-fake');
    expect(env.GITHUB_TOKEN).toBe('ghp_fake');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('真實子程序：adapter 預設啟動的 app-server 程序拿到的是白名單環境（ACC_CODEX_BIN 指向假 app-server）', async () => {
    const dir = tempDir('acc-p08-codex-');
    const codexHome = join(dir, 'codex-home');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'config.toml'), '[model_providers.custom]\nenv_key = "P08_CUSTOM_PROVIDER_KEY"\n');
    const dump = join(dir, 'codex-env.json');
    setProcessEnv({
      ...PROBES,
      ANTHROPIC_API_KEY: 'sk-ant-probe-7f3a',
      OPENAI_API_KEY: 'sk-openai-probe-7f3a',
      CODEX_P08_MARKER: 'codex-marker-7f3a',
      P08_CUSTOM_PROVIDER_KEY: 'custom-provider-key-7f3a',
      CODEX_HOME: codexHome,
      ACC_CODEX_BIN: `"${process.execPath}" "${fakeAppServerFixture}" "${dump}"`,
    });
    const adapter = new CodexAppServerAdapter({ defaultCwd: dir, requestTimeoutMs: 20_000 });
    const recorder = emitRecorder();
    try {
      await adapter.start({ ...ids, prompt: 'hi', mode: 'implement' }, recorder.emit);
      await recorder.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    } finally {
      adapter.dispose();
    }
    const childEnv = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    const serialized = JSON.stringify(childEnv);
    for (const value of Object.values(PROBES)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('sk-ant-probe-7f3a');
    expect(Object.keys(childEnv).filter((name) => name.toUpperCase().startsWith('ACC_'))).toEqual([]);
    expect(childEnv.OPENAI_API_KEY).toBe('sk-openai-probe-7f3a');
    expect(childEnv.CODEX_P08_MARKER).toBe('codex-marker-7f3a');
    expect(childEnv.P08_CUSTOM_PROVIDER_KEY).toBe('custom-provider-key-7f3a');
    expect(getInsensitive(childEnv, 'PATH')).toBeTruthy();
  }, 30_000);
});
