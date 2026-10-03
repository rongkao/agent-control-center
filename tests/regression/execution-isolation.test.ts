import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, LocalTestRunnerAdapter, SrtCommandSandbox, type CommandSandbox } from '@acc/adapters';
import type { UnifiedEvent } from '@acc/core';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';

/**
 * P2-8 執行隔離：
 * - 測試執行器：有沙箱時執行包裝後的命令（任務級策略：只能寫工作目錄與臨時目錄、只能連允許的域名），結果裡標明 isolation=sandbox；
 *   沙箱不可用時照常執行、標明 degraded，並由 isolation() 說明現在的隔離級別和怎麼開啟；
 * - sandbox-runtime：每次執行按這個任務的目錄 initialize、結束 reset，序列；Windows 沒做 windows-install 時直接降級、不嘗試；
 * - Codex：Windows 上查詢沙箱就緒狀態，沒有配置時可以在介面上一鍵配置（unelevated）。
 */

const ids = { projectId: 'p', taskId: 't', runId: 'r' };

async function runTests(sandbox: CommandSandbox | undefined, spawned: string[]) {
  const events: UnifiedEvent[] = [];
  const adapter = new LocalTestRunnerAdapter({
    sandbox,
    log: () => undefined,
    spawn: (command: string, options: SpawnOptions): ChildProcess => {
      spawned.push(command);
      return spawn('node -e "process.exit(0)"', options);
    },
  });
  await adapter.start({ ...ids, prompt: '', mode: 'test', cwd: process.cwd(), context: { testCommand: 'npm test' } }, (e) => void events.push(e as UnifiedEvent));
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'agent.status' && e.data.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 50));
  return { adapter, done: events.find((e) => e.type === 'agent.status' && e.data.status === 'completed')! };
}

describe('P2-8：測試執行器', () => {
  it('有沙箱：執行包裝後的命令、按任務策略準備、結束後釋放；結果標明 sandbox', async () => {
    const calls: Array<{ command: string; cwd: string; writable: string[]; domains: string[] }> = [];
    let released = 0;
    const sandbox: CommandSandbox = {
      status: async () => ({ level: 'sandbox', ready: true, detail: 'ok' }),
      prepare: async (command, cwd, policy) => {
        calls.push({ command, cwd, writable: policy.writableRoots, domains: policy.allowedDomains });
        return { run: { command: `sandboxed:${command}` }, release: async () => void (released += 1) };
      },
    };
    const spawned: string[] = [];
    const { done, adapter } = await runTests(sandbox, spawned);
    expect(spawned).toEqual(['sandboxed:npm test']);
    expect(calls[0]!.writable[0]).toBe(process.cwd());
    expect(calls[0]!.domains).toContain('registry.npmjs.org');
    expect(released).toBe(1);
    expect(done.data.isolation).toBe('sandbox');
    expect((await adapter.isolation()).level).toBe('sandbox');
  });

  it('沙箱不可用：照常執行原命令，結果標明 degraded，並說明隔離級別', async () => {
    const spawned: string[] = [];
    const { done, adapter } = await runTests(undefined, spawned);
    expect(spawned).toEqual(['npm test']);
    expect(done.data.isolation).toBe('degraded');
    const status = await adapter.isolation();
    expect(status).toMatchObject({ level: 'degraded', ready: false });
    expect(status.detail).toContain('環境變數白名單');
  });
});

describe('P2-8：sandbox-runtime 封裝', () => {
  function fakeSrt(options: { provisioned?: boolean } = {}) {
    const log: string[] = [];
    const mod = {
      VENDORED_SRT_WIN_EXE: 'C:/srt-win.exe',
      getWindowsSandboxUserStatus: () => ({ provisioned: options.provisioned ?? false }),
      SandboxManager: {
        initialize: async (config: Record<string, unknown>) => void log.push(`init ${JSON.stringify(config)}`),
        isSupportedPlatform: () => true,
        checkDependencies: () => ({ errors: [], warnings: [] }),
        wrapWithSandbox: async (command: string) => `bwrap -- ${command}`,
        wrapWithSandboxArgv: async (command: string) => ({ argv: ['srt-win.exe', 'exec', command], env: {} }),
        reset: async () => void log.push('reset'),
      },
    };
    return { log, load: async () => mod };
  }

  it('每次執行按任務目錄初始化、結束 reset；同一時間只跑一個', async () => {
    const srt = fakeSrt();
    const sandbox = new SrtCommandSandbox({ load: srt.load, platform: 'linux' });
    expect((await sandbox.status()).level).toBe('sandbox');
    const policy = { writableRoots: ['/work/a'], allowedDomains: ['registry.npmjs.org'] };
    const first = await sandbox.prepare('npm test', '/work/a', policy);
    expect(first?.run).toEqual({ command: 'bwrap -- npm test' });
    expect(srt.log[0]).toContain('"allowWrite":["/work/a"]');
    expect(srt.log[0]).toContain('"allowedDomains":["registry.npmjs.org"]');
    let secondReady = false;
    const second = sandbox.prepare('npm test', '/work/b', { ...policy, writableRoots: ['/work/b'] }).then((r) => {
      secondReady = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(secondReady).toBe(false);
    await first!.release();
    const b = await second;
    expect(srt.log).toEqual([expect.stringContaining('/work/a'), 'reset', expect.stringContaining('/work/b')]);
    await b!.release();
  });

  it('Windows 沒有做 windows-install：直接降級（不 initialize），並給出開啟方式', async () => {
    const srt = fakeSrt({ provisioned: false });
    const sandbox = new SrtCommandSandbox({ load: srt.load, platform: 'win32' });
    const status = await sandbox.status();
    expect(status).toMatchObject({ level: 'degraded', ready: false });
    expect(status.setupHint).toContain('windows-install');
    expect(await sandbox.prepare('npm test', 'C:/w', { writableRoots: ['C:/w'], allowedDomains: [] })).toBeUndefined();
    expect(srt.log).toEqual([]);

    const ready = fakeSrt({ provisioned: true });
    const winSandbox = new SrtCommandSandbox({ load: ready.load, platform: 'win32' });
    const prepared = await winSandbox.prepare('npm test', 'C:/w', { writableRoots: ['C:/w'], allowedDomains: [] });
    expect(prepared?.run).toEqual({ argv: ['srt-win.exe', 'exec', 'npm test'], env: {} });
    expect(ready.log[0]).toContain('"srtWin":{"path":"C:/srt-win.exe"}');
    await prepared!.release();
  });

  it('沒有安裝 sandbox-runtime：降級並說明', async () => {
    const sandbox = new SrtCommandSandbox({ load: async () => undefined, platform: 'linux' });
    expect(await sandbox.status()).toMatchObject({ level: 'degraded', setupHint: 'npm install @anthropic-ai/sandbox-runtime' });
    expect(await sandbox.prepare('x', '/w', { writableRoots: [], allowedDomains: [] })).toBeUndefined();
  });
});

describe('P2-8：Codex 的 Windows 沙箱', () => {
  it('查詢就緒狀態；沒有配置時可以一鍵配置（unelevated），完成後變成就緒', async () => {
    const server = new FakeCodexServer(new FakeCodexDisk(), () => []);
    const codex = new CodexAppServerAdapter({ transportFactory: () => server.transport, platform: 'win32' });
    try {
      expect(await codex.isolation()).toMatchObject({ level: 'degraded', ready: false, canSetup: true });
      expect(await codex.setupIsolation()).toMatchObject({ ok: true });
      expect(server.received.find((r) => r.method === 'windowsSandbox/setupStart')?.params).toMatchObject({ mode: 'unelevated' });
      expect(await codex.isolation()).toMatchObject({ level: 'sandbox', ready: true });
    } finally {
      await codex.dispose();
    }
    const other = new CodexAppServerAdapter({ transportFactory: () => server.transport, platform: 'linux' });
    expect((await other.isolation()).level).toBe('sandbox');
  });
});
