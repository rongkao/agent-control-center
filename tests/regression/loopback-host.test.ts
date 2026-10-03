import { afterEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '@acc/server';
import { startServer } from '@acc/server';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P0-1 審查：ACC_HOST=127.0.0.x（x≠1）被當作迴環地址、允許在沒有顯式令牌時啟動，但 Host 白名單不含該地址，
 * 訪問連結和所有 API / WS 都返回 403——服務“啟動成功但完全不可用”。
 *
 * 期望：只要監聽地址不是通配地址，就把它加進 Host 白名單（迴環地址也一樣）；以 127.0.0.2 啟動後訪問連結能完成登入。
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// macOS 預設只配置了 127.0.0.1，監聽 127.0.0.2 會失敗；Windows 與 Linux 上整個 127/8 都可用
describe.runIf(process.platform !== 'darwin')('ACC_HOST=127.0.0.2', () => {
  it('訪問連結能完成登入，Bearer 訪問 API 不再被 Host 白名單拒絕', async () => {
    const box = createServerSandbox('acc-loopback-');
    cleanups.push(box.cleanup);
    const server: RunningServer = await startServer(sandboxServerOptions(box, [new ScriptedAdapter(new FakeWorld(), [{ kind: 'complete' }])], { host: '127.0.0.2' }));
    cleanups.push(() => server.close());
    expect(server.accessUrl.startsWith('http://127.0.0.2:')).toBe(true);
    const host = `127.0.0.2:${server.port}`;

    // 瀏覽器開啟訪問連結：用令牌換登入 Cookie 並重定向（而不是 403 “請用本機位址開啟控制台”）
    const url = new URL(server.accessUrl);
    const login = await server.app.inject({ method: 'GET', url: `${url.pathname}${url.search}`, headers: { host } });
    expect(login.statusCode).toBe(302);
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0]!;
    expect(cookie).toContain('acc_session_');
    const page = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { host, cookie } });
    expect(page.statusCode).toBe(200);

    const api = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { host, authorization: `Bearer ${server.accessToken}` } });
    expect(api.statusCode).toBe(200);

    // 其他主機名仍然被拒絕（DNS rebinding 防護不變）
    const evil = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: { host: `evil.example:${server.port}`, authorization: `Bearer ${server.accessToken}` } });
    expect(evil.statusCode).toBe(403);
  });
});
