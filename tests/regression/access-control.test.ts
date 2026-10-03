import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@acc/core';
import { LocalTestRunnerAdapter } from '@acc/adapters';
import type { RunningServer, StartServerOptions } from '@acc/server';
import { insecureBindHostProblem, openBrowser, shouldOpenBrowser, startServer } from '@acc/server';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { EnvDumpAgent, ObservedAdapter } from './fakes/env-dump-agent.js';
import { authHeaders, createServerSandbox, expectStartupFailure, sandboxServerOptions, type ServerSandbox } from './fakes/server-sandbox.js';
import { connectWs } from './fakes/ws-client.js';

/**
 * P0-1（H-1、L-10，以及點選劫持線索）：本地服務的訪問控制。
 * 復現（docs/analysis-probes/cswsh.mjs、ws-probe.mjs）：Host 為任意域名時照常 200；帶外域 Origin 的 WS 連線能收到
 * 其他任務的提示詞和輸出；不帶 body 的跨站 POST /cancel 能取消任務；任何網頁 / 本機程序都能呼叫審批端點。
 */

const dumpEnvFixture = fileURLToPath(new URL('./fixtures/dump-env.mjs', import.meta.url));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function sandbox(): ServerSandbox {
  const box = createServerSandbox('acc-access-');
  cleanups.push(box.cleanup);
  return box;
}

function track(server: RunningServer): RunningServer {
  cleanups.push(() => server.close());
  return server;
}

/** 一個會停在 RUNNING 的任務（執行完一個工具、會話仍線上），便於測試取消。 */
const runningAgent = () => [new ScriptedAdapter(new FakeWorld(), [{ kind: 'tool', id: 'tool-A' }])];

async function boot(box: ServerSandbox, adapters: AgentAdapter[] = runningAgent(), overrides: Partial<StartServerOptions> & { env?: Record<string, string | undefined> } = {}) {
  return track(await startServer(sandboxServerOptions(box, adapters, overrides)));
}

/** 同源請求頭：瀏覽器從控制台頁面發請求時的樣子。 */
function sameOrigin(server: RunningServer): Record<string, string> {
  return { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}` };
}

/** 用啟動連結換登入 Cookie（瀏覽器的首次訪問流程），返回可以放進 Cookie 頭的 name=value。 */
async function loginCookie(server: RunningServer): Promise<string> {
  const response = await server.app.inject({ method: 'GET', url: `/?token=${encodeURIComponent(server.accessToken)}`, headers: { host: `127.0.0.1:${server.port}` } });
  expect(response.statusCode).toBe(302);
  const setCookie = String(response.headers['set-cookie']);
  return setCookie.split(';')[0]!;
}

async function createTask(server: RunningServer): Promise<{ id: string; runId: string }> {
  const response = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...authHeaders(server), ...sameOrigin(server) }, payload: { prompt: 'work', agentId: 'claude' } });
  expect(response.statusCode).toBe(201);
  await server.orchestrator.idle();
  return response.json() as { id: string; runId: string };
}

describe('P0-1 Host 白名單（DNS rebinding）', () => {
  it('Host 為任意域名：API、頁面、建立任務一律 403，且不會建立任務', async () => {
    const box = sandbox();
    const server = await boot(box);
    for (const host of ['evil.example', `attacker.test:${server.port}`, `127.0.0.1.evil.example:${server.port}`]) {
      const api = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { ...authHeaders(server), host } });
      expect({ host, status: api.statusCode }).toEqual({ host, status: 403 });
      expect(api.json().code).toBe('ACC_FORBIDDEN_HOST');
      const page = await server.app.inject({ method: 'GET', url: '/', headers: { host } });
      expect(page.statusCode).toBe(403);
    }
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { ...authHeaders(server), host: `rebind.example:${server.port}`, origin: `http://rebind.example:${server.port}` },
      payload: { prompt: 'x', agentId: 'claude', testCommand: 'calc.exe' },
    });
    expect(create.statusCode).toBe(403);
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('只放行 127.0.0.1 / localhost / [::1]（可帶埠）', async () => {
    const box = sandbox();
    const server = await boot(box);
    for (const host of [`127.0.0.1:${server.port}`, 'localhost', `localhost:${server.port}`, `[::1]:${server.port}`, 'LOCALHOST:80']) {
      const response = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { ...authHeaders(server), host } });
      expect({ host, status: response.statusCode }).toEqual({ host, status: 200 });
    }
  });
});

describe('P0-1 Origin 校驗', () => {
  it('外域 Origin 的 REST 請求返回 403（即使帶著有效憑據），不會建立任務', async () => {
    const box = sandbox();
    const server = await boot(box);
    for (const origin of ['https://evil.example', 'http://localhost:5174', 'null', `http://127.0.0.1:${server.port + 1}`, `https://127.0.0.1:${server.port}`]) {
      const response = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { ...authHeaders(server), host: `127.0.0.1:${server.port}`, origin } });
      expect({ origin, status: response.statusCode }).toEqual({ origin, status: 403 });
      expect(response.json().code).toBe('ACC_FORBIDDEN_ORIGIN');
    }
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { ...authHeaders(server), host: `127.0.0.1:${server.port}`, origin: 'https://evil.example' },
      payload: { prompt: 'x', agentId: 'claude' },
    });
    expect(create.statusCode).toBe(403);
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('同源 Origin 放行', async () => {
    const box = sandbox();
    const server = await boot(box);
    const response = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { ...authHeaders(server), ...sameOrigin(server) } });
    expect(response.statusCode).toBe(200);
  });

  it('開發模式：額外放行配置裡的 Vite 埠（ACC_WEB_PORT），而不是寫死的 5174', async () => {
    const box = sandbox();
    const server = await boot(box, runningAgent(), { dev: true, env: { ACC_WEB_PORT: '5999' } });
    const headers = (origin: string) => ({ ...authHeaders(server), host: `127.0.0.1:${server.port}`, origin });
    expect((await server.app.inject({ method: 'GET', url: '/api/tasks', headers: headers('http://localhost:5999') })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'GET', url: '/api/tasks', headers: headers('http://127.0.0.1:5999') })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'GET', url: '/api/tasks', headers: headers('http://localhost:5174') })).statusCode).toBe(403);
    expect((await server.app.inject({ method: 'GET', url: '/api/tasks', headers: headers('http://evil.example:5999') })).statusCode).toBe(403);
    // 經 Vite 代理：Host 保持為 Vite 的地址，Origin 與之同源
    const proxied = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { ...authHeaders(server), host: 'localhost:5999', origin: 'http://localhost:5999' } });
    expect(proxied.statusCode).toBe(200);
  });

  it('非開發模式下，Vite 埠的 Origin 同樣被拒絕', async () => {
    const box = sandbox();
    const server = await boot(box, runningAgent(), { env: { ACC_WEB_PORT: '5999' } });
    const response = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { ...authHeaders(server), host: `127.0.0.1:${server.port}`, origin: 'http://localhost:5999' } });
    expect(response.statusCode).toBe(403);
  });
});

describe('P0-1 啟動令牌與登入 Cookie', () => {
  it('沒有憑據：API 返回 401（中文說明），頁面返回中文說明頁', async () => {
    const box = sandbox();
    const server = await boot(box);
    for (const url of ['/api/tasks', '/api/config', '/health', '/api/dashboard']) {
      const response = await server.app.inject({ method: 'GET', url, headers: sameOrigin(server) });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 401 });
      expect(response.json().code).toBe('ACC_UNAUTHORIZED');
      expect(String(response.json().error)).toContain('連結');
    }
    const wrongBearer = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: 'Bearer not-the-token' } });
    expect(wrongBearer.statusCode).toBe(401);
    const cookieName = (await loginCookie(server)).split('=')[0]!;
    const wrongCookie = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie: `${cookieName}=forged` } });
    expect(wrongCookie.statusCode).toBe(401);

    const page = await server.app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${server.port}` } });
    expect(page.statusCode).toBe(401);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('啟動時');
    expect(page.body).not.toContain(server.accessToken);
  });

  it('帶 ?token= 的首次訪問：換成 HttpOnly; SameSite=Strict 的 Cookie，並重定向去掉 token', async () => {
    const box = sandbox();
    const server = await boot(box);
    const response = await server.app.inject({ method: 'GET', url: `/?view=usage&token=${encodeURIComponent(server.accessToken)}`, headers: { host: `127.0.0.1:${server.port}` } });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/?view=usage');
    expect(String(response.headers['cache-control'])).toContain('no-store');
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//);
    // Cookie 裡不直接放令牌本身
    expect(setCookie).not.toContain(server.accessToken);

    const cookie = setCookie.split(';')[0]!;
    const api = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie, ...sameOrigin(server) } });
    expect(api.statusCode).toBe(200);

    // 錯誤的令牌：說明頁，不發 Cookie
    const wrong = await server.app.inject({ method: 'GET', url: '/?token=wrong-token', headers: { host: `127.0.0.1:${server.port}` } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(wrong.body).toContain('啟動時');
  });

  it('重定向不會變成開放重定向（路徑以 // 開頭時）', async () => {
    const box = sandbox();
    const server = await boot(box);
    const response = await server.app.inject({ method: 'GET', url: `/.//evil.example/?token=${encodeURIComponent(server.accessToken)}`, headers: { host: `127.0.0.1:${server.port}` } });
    expect(response.statusCode).toBe(302);
    expect(String(response.headers.location).startsWith('//')).toBe(false);
  });

  it('前端（開發模式經 Vite 開啟時）可以用 POST /api/auth/session 換 Cookie', async () => {
    const box = sandbox();
    const server = await boot(box);
    const ok = await server.app.inject({ method: 'POST', url: '/api/auth/session', headers: sameOrigin(server), payload: { token: server.accessToken } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect((await server.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })).statusCode).toBe(200);
    const bad = await server.app.inject({ method: 'POST', url: '/api/auth/session', headers: sameOrigin(server), payload: { token: 'nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
  });

  it('令牌持久化在資料目錄：重啟後複用，已登入的頁面（Cookie）繼續有效', async () => {
    const box = sandbox();
    const first = await boot(box);
    const cookie = await loginCookie(first);
    const token = first.accessToken;
    expect(first.tokenPath).toBe(join(box.data, 'access-token'));
    expect(readFileSync(first.tokenPath!, 'utf8').trim()).toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(43);
    await first.close();

    const second = await boot(box);
    expect(second.accessToken).toBe(token);
    // 重啟（埠也變了）之後，瀏覽器裡原來的 Cookie 仍然有效
    expect(second.port).not.toBe(first.port);
    const response = await second.app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });

  it('訪問連結帶令牌（accessUrl），啟動日誌會列印它', async () => {
    const box = sandbox();
    const notices: string[] = [];
    const server = await boot(box, runningAgent(), { quiet: false, notice: (message) => notices.push(message) });
    expect(server.accessUrl).toBe(`http://127.0.0.1:${server.port}/?token=${server.accessToken}`);
    expect(notices.join('\n')).toContain(server.accessUrl);
    // 單實例鎖裡登記的地址不帶令牌
    expect(server.url).not.toContain('token');
  });

  it('開發模式：訪問連結指向 Vite 埠（從配置讀取）', async () => {
    const box = sandbox();
    const server = await boot(box, runningAgent(), { dev: true, env: { ACC_WEB_PORT: '5999' } });
    expect(server.accessUrl).toBe(`http://localhost:5999/?token=${server.accessToken}`);
  });

  it('顯式令牌：程式呼叫傳入 accessToken 時使用它，不寫令牌檔案；ACC_TOKEN_FILE 指向的檔案被讀取', async () => {
    const box = sandbox();
    const explicit = 'explicit-token-0123456789-abcdefghijklmnop';
    const server = await boot(box, runningAgent(), { accessToken: explicit });
    expect(server.accessToken).toBe(explicit);
    expect(existsSync(join(box.data, 'access-token'))).toBe(false);
    await server.close();

    const tokenFile = join(box.root, 'my-token');
    writeFileSync(tokenFile, 'file-token-0123456789-abcdefghijklmnopqrstu\n');
    const fromFile = await boot(box, runningAgent(), { env: { ACC_TOKEN_FILE: tokenFile } });
    expect(fromFile.accessToken).toBe('file-token-0123456789-abcdefghijklmnopqrstu');
    expect(fromFile.tokenPath).toBe(tokenFile);
  });

  it('顯式令牌太短：拒絕啟動', async () => {
    const box = sandbox();
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, runningAgent(), { accessToken: 'short' })));
    expect(error.code).toBe('ACC_TOKEN_INVALID');
  });

  it('ACC_TOKEN_FILE 裡的令牌無效：拒絕啟動，不覆蓋使用者的檔案', async () => {
    const box = sandbox();
    const tokenFile = join(box.root, 'my-token');
    const original = 'too-short';
    writeFileSync(tokenFile, original);
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, runningAgent(), { env: { ACC_TOKEN_FILE: tokenFile } })));
    expect(error.code).toBe('ACC_TOKEN_INVALID');
    expect(error.message).toContain(tokenFile);
    expect(readFileSync(tokenFile, 'utf8')).toBe(original);
  });

  it('令牌檔案落在 agent 的預設工作區裡：拒絕啟動，不寫令牌', async () => {
    const box = sandbox();
    const tokenFile = join(box.workspace, 'acc-token');
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, runningAgent(), { env: { ACC_TOKEN_FILE: tokenFile } })));
    expect(error.code).toBe('ACC_DATA_IN_WORKSPACE');
    expect(error.message).toContain('訪問令牌檔案');
    expect(existsSync(tokenFile)).toBe(false);
  });
});

describe('P0-1 令牌不進入環境變數，也不傳給 agent 和測試子程序', () => {
  it('服務程序 process.env 裡沒有令牌；agent 子程序繼承到的環境變數裡也沒有', async () => {
    const box = sandbox();
    const dump = join(box.root, 'agent-env.json');
    const agent = new EnvDumpAgent(dumpEnvFixture, dump);
    const server = await boot(box, [agent]);
    const created = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: authHeaders(server), payload: { prompt: 'hi', agentId: 'claude', workflow: 'manual' } });
    expect(created.statusCode).toBe(201);
    await agent.done;

    const token = server.accessToken;
    expect(Object.entries(process.env).filter(([, value]) => value?.includes(token))).toEqual([]);
    const childEnv = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    expect(Object.keys(childEnv).length).toBeGreaterThan(0);
    expect(JSON.stringify(childEnv)).not.toContain(token);
  });

  it('測試執行器（真實的 LocalTestRunnerAdapter）執行的測試命令看不到令牌', async () => {
    const box = sandbox();
    const dump = join(box.root, 'test-env.json');
    const runner = new ObservedAdapter(new LocalTestRunnerAdapter({ defaultCwd: box.workspace }));
    const implementer = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const server = await boot(box, [implementer, runner]);
    const testCommand = `"${process.execPath}" "${dumpEnvFixture}" "${dump}"`;
    const created = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: authHeaders(server), payload: { prompt: 'implement', agentId: 'claude', testCommand } });
    expect(created.statusCode).toBe(201);
    const finished = await runner.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    expect(finished.data.testPassed).toBe(true);

    const childEnv = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    expect(Object.keys(childEnv).length).toBeGreaterThan(0);
    expect(JSON.stringify(childEnv)).not.toContain(server.accessToken);
  });
});

/** 獨立於實現的 ACL 讀取：icacls /save 輸出與語言無關的 SDDL。 */
function windowsDacl(file: string): string {
  const system32 = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const dir = mkdtempSync(join(tmpdir(), 'acc-acl-test-'));
  try {
    const out = join(dir, 'acl.txt');
    const result = spawnSync(win32.join(system32, 'icacls.exe'), [file, '/save', out], { encoding: 'latin1', windowsHide: true });
    expect(result.status).toBe(0);
    return readFileSync(out).toString('utf16le').split(/\r?\n/)[1] ?? '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function currentUserSid(): string {
  const system32 = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const result = spawnSync(win32.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'latin1', windowsHide: true });
  const sids = result.stdout.match(/S-1-\d+(?:-\d+)+/g) ?? [];
  expect(sids.length).toBeGreaterThan(0);
  return sids[sids.length - 1]!;
}

/**
 * SDDL 裡的 SID 可能是縮寫：內建的 Administrator 帳號（RID 500，例如 GitHub Actions 的 runneradmin）寫成 LA。
 * 比較前把它換回完整的 SID。
 */
function expandSid(sid: string, current: string): string {
  return sid === 'LA' && /-500$/.test(current) ? current : sid;
}

/** SDDL 裡的全部 ACE（型別與 SID）。 */
function aces(sddl: string): Array<{ type: string; sid: string }> {
  return [...sddl.matchAll(/\(([^)]*)\)/g)].map((match) => {
    const parts = match[1]!.split(';');
    return { type: parts[0]!, sid: parts[5]! };
  });
}

describe('P0-1 令牌檔案只允許當前使用者讀取', () => {
  it.runIf(process.platform === 'win32')('Windows：ACL 不繼承上級目錄，只授權給當前使用者', async () => {
    const box = sandbox();
    const server = await boot(box);
    const sddl = windowsDacl(server.tokenPath!);
    expect(sddl).toMatch(/^D:P/);
    const me = currentUserSid();
    expect(aces(sddl).map((a) => ({ ...a, sid: expandSid(a.sid, me) }))).toEqual([{ type: 'A', sid: me }]);
  });

  it.runIf(process.platform === 'win32')('Windows：啟動自檢發現 ACL 被放寬（授權給 Everyone）時自動修復，並繼續使用原令牌', async () => {
    const box = sandbox();
    const first = await boot(box);
    const token = first.accessToken;
    const tokenPath = first.tokenPath!;
    await first.close();
    const system32 = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    expect(spawnSync(win32.join(system32, 'icacls.exe'), [tokenPath, '/grant', '*S-1-1-0:(R)'], { windowsHide: true }).status).toBe(0);
    expect(aces(windowsDacl(tokenPath)).some((ace) => ace.sid === 'WD')).toBe(true);

    const second = await boot(box);
    expect(second.accessToken).toBe(token);
    const me = currentUserSid();
    expect(aces(windowsDacl(tokenPath)).map((a) => ({ ...a, sid: expandSid(a.sid, me) }))).toEqual([{ type: 'A', sid: me }]);
  });

  it.runIf(process.platform !== 'win32')('POSIX：權限為 600，被放寬後啟動時修復', async () => {
    const box = sandbox();
    const first = await boot(box);
    const tokenPath = first.tokenPath!;
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    await first.close();
    chmodSync(tokenPath, 0o644);
    const second = await boot(box);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(second.accessToken).toBe(first.accessToken);
  });

  it('自檢不通過（權限無法收緊）：拒絕啟動，說明原因，且不開啟資料庫', async () => {
    const box = sandbox();
    const error = await expectStartupFailure(
      startServer(
        sandboxServerOptions(box, runningAgent(), {
          tokenFileGuard: { restrict: () => undefined, check: () => '模擬：其他使用者也能讀取' },
        }),
      ),
    );
    expect(error.code).toBe('ACC_TOKEN_FILE_INSECURE');
    expect(error.message).toContain(join(box.data, 'access-token'));
    expect(error.message).toContain('模擬：其他使用者也能讀取');
    expect(existsSync(join(box.data, 'agent-control.db'))).toBe(false);
  });
});

describe('P0-1 所有 POST 都要求 application/json（L-10）', () => {
  it('不帶 body 的 POST /cancel 失敗：同源 415，跨站 403；任務不被取消', async () => {
    const box = sandbox();
    const server = await boot(box);
    const task = await createTask(server);
    const cancelUrl = `/api/tasks/${task.id}/cancel`;

    const bare = await server.app.inject({ method: 'POST', url: cancelUrl, headers: { ...authHeaders(server), ...sameOrigin(server) } });
    expect(bare.statusCode).toBe(415);
    const text = await server.app.inject({ method: 'POST', url: cancelUrl, headers: { ...authHeaders(server), ...sameOrigin(server), 'content-type': 'text/plain' }, payload: 'x' });
    expect(text.statusCode).toBe(415);
    const form = await server.app.inject({
      method: 'POST',
      url: cancelUrl,
      headers: { ...authHeaders(server), ...sameOrigin(server), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(form.statusCode).toBe(415);
    const crossSite = await server.app.inject({ method: 'POST', url: cancelUrl, headers: { ...authHeaders(server), host: `127.0.0.1:${server.port}`, origin: 'https://evil.example' } });
    expect(crossSite.statusCode).toBe(403);
    const emptyJson = await server.app.inject({ method: 'POST', url: cancelUrl, headers: { ...authHeaders(server), ...sameOrigin(server), 'content-type': 'application/json' } });
    expect(emptyJson.statusCode).toBe(400);
    expect((await server.store.getTask(task.id))?.status).toBe('RUNNING');

    const json = await server.app.inject({ method: 'POST', url: cancelUrl, headers: { ...authHeaders(server), ...sameOrigin(server) }, payload: {} });
    expect(json.statusCode).toBe(200);
    expect((await server.store.getTask(task.id))?.status).toBe('CANCELLED');
  });
});

describe('P0-1 防點選劫持響應頭', () => {
  it('API、頁面、401 說明頁、403 都帶 frame-ancestors none 與 X-Frame-Options', async () => {
    const box = sandbox();
    const server = await boot(box);
    const responses = [
      await server.app.inject({ method: 'GET', url: '/api/tasks', headers: authHeaders(server) }),
      await server.app.inject({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${server.port}` } }),
      await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { host: 'evil.example' } }),
    ];
    for (const response of responses) {
      expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(response.headers['x-frame-options']).toBe('DENY');
    }
  });
});

describe('P0-1 WebSocket 升級', () => {
  it('外域 Origin、偽造 Host 返回 403；沒有憑據返回 401；同源且已登入才能連上', async () => {
    const box = sandbox();
    const server = await boot(box);
    const cookie = await loginCookie(server);
    const url = `ws://127.0.0.1:${server.port}/ws/events`;

    const foreign = await connectWs(url, { origin: 'https://evil.example', cookie });
    expect(foreign).toMatchObject({ kind: 'rejected', status: 403 });
    const rebound = await connectWs(url, { host: `evil.example:${server.port}`, origin: `http://evil.example:${server.port}`, cookie });
    expect(rebound).toMatchObject({ kind: 'rejected', status: 403 });
    const anonymous = await connectWs(url, { origin: `http://127.0.0.1:${server.port}` });
    expect(anonymous).toMatchObject({ kind: 'rejected', status: 401 });

    const ok = await connectWs(url, { origin: `http://127.0.0.1:${server.port}`, cookie });
    expect(ok.kind).toBe('open');
    if (ok.kind !== 'open') return;
    cleanups.push(() => ok.socket.terminate());
    expect(JSON.parse(await ok.nextMessage()).type).toBe('system.connected');
  });

  it('超過 maxPayload 的訊息：連線被關閉（1009）', async () => {
    const box = sandbox();
    const server = await boot(box, runningAgent(), { websocket: { maxPayload: 1024 } });
    const cookie = await loginCookie(server);
    const ok = await connectWs(`ws://127.0.0.1:${server.port}/ws/events`, { origin: `http://127.0.0.1:${server.port}`, cookie });
    expect(ok.kind).toBe('open');
    if (ok.kind !== 'open') return;
    cleanups.push(() => ok.socket.terminate());
    ok.socket.send('x'.repeat(4096));
    expect(await ok.closed).toBe(1009);
  });

  it('超過連線數上限：新的連線被拒絕', async () => {
    const box = sandbox();
    const server = await boot(box, runningAgent(), { websocket: { maxConnections: 2 } });
    const cookie = await loginCookie(server);
    const url = `ws://127.0.0.1:${server.port}/ws/events`;
    const headers = { origin: `http://127.0.0.1:${server.port}`, cookie };
    for (let i = 0; i < 2; i++) {
      const ok = await connectWs(url, headers);
      expect(ok.kind).toBe('open');
      if (ok.kind === 'open') {
        cleanups.push(() => ok.socket.terminate());
        await ok.nextMessage(); // system.connected：服務端已登記該連線
      }
    }
    const third = await connectWs(url, headers);
    expect(third).toMatchObject({ kind: 'rejected', status: 503 });
  });
});

describe('P0-1 ACC_HOST 為非迴環地址且沒有顯式令牌時拒絕啟動', () => {
  it('監聽 0.0.0.0 / 區域網地址：啟動失敗，什麼都不寫', async () => {
    for (const host of ['0.0.0.0', '192.168.1.10']) {
      const box = sandbox();
      const error = await expectStartupFailure(startServer(sandboxServerOptions(box, runningAgent(), { host })));
      expect({ host, code: error.code }).toEqual({ host, code: 'ACC_INSECURE_HOST' });
      expect(error.message).toContain('ACC_TOKEN_FILE');
      expect(existsSync(box.data)).toBe(false);
    }
    // 透過環境變數 ACC_HOST 指定時同樣拒絕
    const box = sandbox();
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, runningAgent(), { host: undefined, env: { ACC_HOST: '0.0.0.0' } })));
    expect(error.code).toBe('ACC_INSECURE_HOST');
  });

  it('迴環地址不需要顯式令牌；非迴環地址有顯式令牌配置時允許', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) expect({ host, problem: insecureBindHostProblem(host, false) }).toEqual({ host, problem: undefined });
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'my-pc.local']) {
      expect(insecureBindHostProblem(host, false)).toBeTruthy();
      expect(insecureBindHostProblem(host, true)).toBeUndefined();
    }
  });
});

describe('P0-1 啟動時自動開啟瀏覽器（非開發模式）', () => {
  it('npm start 預設開啟；ACC_NO_OPEN=1 或開發模式不開啟', () => {
    expect(shouldOpenBrowser({ env: {}, dev: false })).toBe(true);
    expect(shouldOpenBrowser({ env: { ACC_NO_OPEN: '1' }, dev: false })).toBe(false);
    expect(shouldOpenBrowser({ env: { ACC_NO_OPEN: 'true' }, dev: false })).toBe(false);
    expect(shouldOpenBrowser({ env: {}, dev: true })).toBe(false);
    // 測試執行時全域性關閉（vitest.config.ts）
    expect(process.env.ACC_NO_OPEN).toBe('1');
    expect(shouldOpenBrowser({ env: process.env, dev: false })).toBe(false);
  });

  it('用系統預設瀏覽器開啟：連結作為單獨引數傳遞，不經過 shell', () => {
    const url = 'http://127.0.0.1:8788/?token=abc_DEF-123';
    for (const [platform, command] of [
      ['win32', /rundll32\.exe$/i],
      ['darwin', /^open$/],
      ['linux', /^xdg-open$/],
    ] as const) {
      const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
      openBrowser(url, {
        platform,
        spawn: (cmd, args, options) => {
          calls.push({ command: cmd, args, options: options as Record<string, unknown> });
          return { on: () => undefined, unref: () => undefined };
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toMatch(command);
      expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(url);
      expect(calls[0]!.options.shell).not.toBe(true);
    }
  });
});
