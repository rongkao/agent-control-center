import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants as fsConstants, openSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '@acc/server';
import { startServer } from '@acc/server';
import { EventBus, INSTANCE_LEASE_NOT_HELD, Orchestrator } from '@acc/core';
import { InstanceLockError, SqliteControlPlaneStore, acquireInstanceLock } from '@acc/storage';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { authHeaders, createServerSandbox, expectStartupFailure, readDatabaseRows, sandboxServerOptions, type ServerSandbox } from './fakes/server-sandbox.js';

/**
 * P0-3（H-3）：單實例。
 * 復現（docs/analysis-probes/repro-two-instances.mts）：兩個實例共用一個庫時，第二個實例先 recover 並執行了新工具 Z、
 * 寫入新事件，第一個實例隨後的操作員訊息全部 500（UNIQUE constraint failed: events.run_id, events.sequence）。
 */

const fixture = fileURLToPath(new URL('./fixtures/instance-holder-child.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** libuv 的 UV_FS_O_EXLOCK（Windows 獨佔共享模式開啟）；Node 沒有匯出這個常量，但會原樣透傳給 libuv。 */
const UV_FS_O_EXLOCK = 0x10000000;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function sandbox(): ServerSandbox {
  const box = createServerSandbox('acc-single-');
  cleanups.push(box.cleanup);
  return box;
}

function track(server: RunningServer): RunningServer {
  cleanups.push(() => server.close());
  return server;
}

/** 與探針一致：任務執行完 tool-A 後仍在 RUNNING（會話線上、有已完成的副作用）。 */
async function startWithRunningTask(box: ServerSandbox, world: FakeWorld) {
  const server = track(await startServer(sandboxServerOptions(box, [new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }])])));
  const created = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: authHeaders(server), payload: { prompt: 'do work', agentId: 'claude' } });
  expect(created.statusCode).toBe(201);
  const task = created.json() as { id: string; runId: string };
  await server.orchestrator.idle();
  expect((await server.store.getRun(task.runId))?.status).toBe('RUNNING');
  return { server, task };
}

/** 等子程序輸出匹配的一行；子程序提前退出則失敗（附帶 stderr）。 */
function waitForLine(child: ChildProcess, pattern: RegExp): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(pattern);
        if (match) resolve(match);
      }
    });
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code) => reject(new Error(`child exited early (code ${code}): ${stderr}`)));
  });
}

describe('P0-3 單實例：兩個實例共用一個庫', () => {
  it('第二個實例在寫入任何資料之前就拒絕啟動，不再出現 UNIQUE 衝突', async () => {
    const box = sandbox();
    const world = new FakeWorld();
    const { server: first, task } = await startWithRunningTask(box, world);
    const before = await Promise.all([first.store.listEvents(task.runId), first.store.getRun(task.runId)]);

    // 第二個實例（探針裡它會續跑並執行新工具 Z）
    const secondWorld = new FakeWorld();
    const secondAdapter = new ScriptedAdapter(secondWorld, [
      { kind: 'tool', id: 'tool-A' },
      { kind: 'tool', id: 'tool-Z' },
    ]);
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, [secondAdapter])));
    expect(error.code).toBe('ACC_ALREADY_RUNNING');
    expect(error.message).toContain('已有一個 Agent Control Center 在執行');
    // 持有者資訊：讓使用者知道去哪裡找已經在執行的那個
    expect(error.message).toContain(String(process.pid));
    expect(error.message).toContain(first.url);

    // 第二個實例沒有續跑、沒有執行任何工具、沒有寫任何資料
    expect(secondAdapter.calls.resume).toBe(0);
    expect(secondAdapter.calls.start).toBe(0);
    expect(secondWorld.executions).toEqual([]);
    const after = await Promise.all([first.store.listEvents(task.runId), first.store.getRun(task.runId)]);
    expect(after).toEqual(before);
    expect(Object.values(after[1]!.agentSessions).map((s) => s.ownerInstanceId)).toEqual([first.instanceId]);

    // 第一個實例繼續正常工作：操作員訊息不再因為序號衝突返回 500
    const message = await first.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/message`, headers: authHeaders(first), payload: { agentId: 'claude', message: 'hello' } });
    expect(message.statusCode).toBe(200);
    expect(world.executions).toEqual(['tool-A']);
  });

  it('先監聽埠成功、再執行恢復：埠被佔用時不續跑、不寫庫；埠空出來後正常恢復且不重放副作用', async () => {
    const box = sandbox();
    const world = new FakeWorld();
    const { server: first, task } = await startWithRunningTask(box, world);
    const dbPath = first.paths.dbPath;
    await first.close(); // 正常退出：run 仍是 RUNNING，下次啟動需要恢復
    const before = readDatabaseRows(dbPath);

    const blocker = createServer();
    blocker.listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const busyPort = (blocker.address() as AddressInfo).port;

    const blockedAdapter = new ScriptedAdapter(world, [
      { kind: 'tool', id: 'tool-A' },
      { kind: 'tool', id: 'tool-Z' },
    ]);
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, [blockedAdapter], { port: busyPort })));
    expect(error.code).toBe('ACC_PORT_IN_USE');
    expect(error.message).toContain(String(busyPort));
    expect(blockedAdapter.calls.resume).toBe(0);
    expect(world.executions).toEqual(['tool-A']);
    expect(readDatabaseRows(dbPath)).toEqual(before);

    // 失敗的啟動已釋放鎖：換個埠就能正常啟動並恢復
    const adapter = new ScriptedAdapter(world, [
      { kind: 'tool', id: 'tool-A' },
      { kind: 'tool', id: 'tool-Z' },
    ]);
    const server = track(await startServer(sandboxServerOptions(box, [adapter])));
    expect(server.recovery.resumed).toEqual([task.runId]);
    await server.orchestrator.idle();
    expect(world.executions).toEqual(['tool-A', 'tool-Z']);
  });

  it(
    '強殺後殘留的鎖能被新實例接管；舊程序還活著時明確拒絕；會話歸屬只在確認原租約失效後轉移',
    async () => {
      const box = sandbox();
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, box.data, box.workspace, box.home], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      cleanups.push(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      const ready = await waitForLine(child, /^READY (.+)$/);
      const holder = JSON.parse(ready[1]!) as { instanceId: string; taskId: string; runId: string; pid: number };

      // 舊程序仍然活著、鎖檔案控制代碼仍被它佔用：明確拒絕，不接管、不續跑
      const world = new FakeWorld();
      const adapter = new ScriptedAdapter(world, [
        { kind: 'tool', id: 'tool-A' },
        { kind: 'tool', id: 'tool-Z' },
      ]);
      const refused = await expectStartupFailure(startServer(sandboxServerOptions(box, [adapter])));
      expect(refused.code).toBe('ACC_ALREADY_RUNNING');
      expect(refused.message).toContain(String(holder.pid));
      expect(adapter.calls.resume).toBe(0);

      // 強殺（Windows 上即 TerminateProcess）：不做任何清理，鎖檔案和租約記錄都殘留在磁碟上
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;

      // 作業系統釋放控制代碼可能有極短的延遲：靠啟動邏輯自帶的有限重試，而不是測試裡 sleep
      const server = track(
        await startServer(sandboxServerOptions(box, [adapter], { instanceLock: { retries: 40, retryDelayMs: 50, heartbeatMs: 0 } })),
      );
      expect(server.lock?.previous).toMatchObject({ instanceId: holder.instanceId, pid: holder.pid, processAlive: false });
      expect(server.recovery.resumed).toEqual([holder.runId]);
      await server.orchestrator.idle();
      // tool-A 已在舊程序裡完成，不重放；只執行後續的 tool-Z
      expect(world.executions).toEqual(['tool-Z']);
      const transferred = (await server.store.listEvents(holder.runId)).find((e) => e.data.code === 'SESSION_OWNER_TRANSFERRED');
      expect(transferred?.data).toMatchObject({ from: holder.instanceId, to: server.instanceId });
      const run = await server.store.getRun(holder.runId);
      expect(Object.values(run!.agentSessions).map((s) => s.ownerInstanceId)).toEqual([server.instanceId]);
    },
    60_000,
  );
});

describe('P0-3 實例鎖（租約）', () => {
  function lockPath(): string {
    return join(sandbox().root, 'agent-control.db.lock');
  }

  it('同一個庫的第二次獲取（同一程序內的第二個編排器）被拒絕，並帶出持有者資訊', async () => {
    const path = lockPath();
    const first = await acquireInstanceLock({ lockPath: path, instanceId: 'first', heartbeatMs: 0 });
    cleanups.push(() => first.release());
    first.setOwnerInfo({ url: 'http://127.0.0.1:18788' });
    const error = await acquireInstanceLock({ lockPath: path, instanceId: 'second', heartbeatMs: 0, retries: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstanceLockError);
    expect((error as InstanceLockError).code).toBe('ACC_ALREADY_RUNNING');
    expect((error as InstanceLockError).holder).toMatchObject({ instanceId: 'first', pid: process.pid, url: 'http://127.0.0.1:18788' });
    expect(first.isHeld()).toBe(true);
  });

  it('斷電後殘留的租約（持有者程序已不存在、心跳早已過期）能被接管，並報告原持有者', async () => {
    const path = lockPath();
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid!; // 已經退出的程序
    const now = 50_000_000;
    // 模擬斷電：持有者的連線憑空消失（作業系統釋放了鎖），但租約記錄留在檔案裡
    let ghostDb: DatabaseSync | undefined;
    await acquireInstanceLock({
      lockPath: path,
      instanceId: 'ghost',
      pid: deadPid,
      now: () => now - 3_600_000,
      heartbeatMs: 0,
      openDatabase: (file) => (ghostDb = new DatabaseSync(file, { timeout: 0 })),
    });
    ghostDb!.close();

    const lock = await acquireInstanceLock({ lockPath: path, instanceId: 'fresh', now: () => now, heartbeatMs: 0, retries: 0 });
    expect(lock.previous).toMatchObject({ instanceId: 'ghost', pid: deadPid, heartbeatAt: now - 3_600_000, heartbeatExpired: true, processAlive: false });
    lock.release();

    // 正常釋放不留殘留：下一次獲取沒有“上一任”
    const again = await acquireInstanceLock({ lockPath: path, instanceId: 'next', heartbeatMs: 0, retries: 0 });
    expect(again.previous).toBeUndefined();
    again.release();
  });

  it('程序號已被別的程序複用（心跳過期）：以作業系統鎖為準，照樣接管', async () => {
    const path = lockPath();
    const now = 90_000_000;
    let ghostDb: DatabaseSync | undefined;
    // 殘留租約裡的 pid 恰好是一個活著的程序（這裡用本程序），但它並不持有鎖
    await acquireInstanceLock({
      lockPath: path,
      instanceId: 'reused-pid',
      now: () => now - 600_000,
      heartbeatMs: 0,
      openDatabase: (file) => (ghostDb = new DatabaseSync(file, { timeout: 0 })),
    });
    ghostDb!.close();
    const lock = await acquireInstanceLock({ lockPath: path, instanceId: 'fresh', now: () => now, heartbeatMs: 0, retries: 0 });
    expect(lock.previous).toMatchObject({ instanceId: 'reused-pid', heartbeatExpired: true, processAlive: true });
    lock.release();
  });

  it('殘留的鎖檔案損壞（斷電時寫了一半）：移到一邊重建，照樣能啟動', async () => {
    const path = lockPath();
    writeFileSync(path, 'garbage left by a power loss, definitely not a sqlite database header at all ...................');
    const lock = await acquireInstanceLock({ lockPath: path, instanceId: 'fresh', heartbeatMs: 0, retries: 1, wait: async () => undefined });
    expect(lock.isHeld()).toBe(true);
    expect(lock.previous).toBeUndefined();
    expect(readdirSync(dirname(path)).some((name) => name.startsWith('agent-control.db.lock.corrupt-'))).toBe(true);
    lock.release();
  });

  it('鎖檔案控制代碼被其他程序佔用（EBUSY/EPERM/無法開啟）：按次數重試，最後給出明確的中文說明', async () => {
    const waits: number[] = [];
    const error = await acquireInstanceLock({
      lockPath: lockPath(),
      retries: 2,
      retryDelayMs: 300,
      wait: async (ms) => {
        waits.push(ms);
      },
      heartbeatMs: 0,
      openDatabase: () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked, open 'agent-control.db.lock'"), { code: 'EBUSY' });
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstanceLockError);
    expect((error as InstanceLockError).code).toBe('ACC_LOCK_FILE_BUSY');
    expect((error as InstanceLockError).message).toContain('被其他程式佔用');
    expect(waits).toEqual([300, 300]);
  });

  it.runIf(process.platform === 'win32')('Windows：鎖檔案被舊程序控制代碼獨佔時明確報錯；控制代碼在重試期間釋放後可以接管', async () => {
    const path = lockPath();
    writeFileSync(path, '');
    // 模擬“舊程序還沒完全退出 / 防毒軟體正在掃描”：以獨佔共享模式持有鎖檔案控制代碼
    const fd = openSync(path, fsConstants.O_RDWR | UV_FS_O_EXLOCK);
    let released = false;
    cleanups.push(() => {
      if (!released) closeSync(fd);
    });

    const waits: number[] = [];
    const error = await acquireInstanceLock({ lockPath: path, retries: 2, retryDelayMs: 200, wait: async (ms) => void waits.push(ms), heartbeatMs: 0 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstanceLockError);
    expect((error as InstanceLockError).code).toBe('ACC_LOCK_FILE_BUSY');
    expect((error as InstanceLockError).message).toContain(path);
    expect(waits).toEqual([200, 200]);

    // 舊程序在重試等待期間退出（控制代碼釋放）：下一次嘗試接管成功
    const lock = await acquireInstanceLock({
      lockPath: path,
      retries: 3,
      heartbeatMs: 0,
      wait: async () => {
        if (!released) {
          closeSync(fd);
          released = true;
        }
      },
    });
    expect(released).toBe(true);
    expect(lock.isHeld()).toBe(true);
    lock.release();
  }, 20_000);

  it('心跳發現租約已丟失（連線被意外關閉）：標記為未持有並通知 onLost，只通知一次', async () => {
    const lost: Error[] = [];
    let db: DatabaseSync | undefined;
    let clock = 1_000;
    const lock = await acquireInstanceLock({
      lockPath: lockPath(),
      now: () => clock,
      heartbeatMs: 0,
      onLost: (error) => lost.push(error),
      openDatabase: (file) => (db = new DatabaseSync(file, { timeout: 0 })),
    });
    clock = 2_000;
    expect(lock.heartbeat()).toBe(true);
    expect(lock.info.heartbeatAt).toBe(2_000);

    db!.close();
    expect(lock.heartbeat()).toBe(false);
    expect(lock.heartbeat()).toBe(false);
    expect(lock.isHeld()).toBe(false);
    expect(lost).toHaveLength(1);
    expect((lost[0] as InstanceLockError).code).toBe('ACC_LEASE_LOST');
    lock.release(); // 丟失後釋放不拋錯
  });

  it('編排器：租約已不在本實例手裡時拒絕恢復，不轉移會話歸屬、不寫庫', async () => {
    const box = sandbox();
    const dbPath = join(box.root, 'agent-control.db');
    const world = new FakeWorld();
    // 先由一個“舊實例”留下一個執行到一半的任務
    const oldStore = new SqliteControlPlaneStore({ path: dbPath });
    const oldOrchestrator = new Orchestrator(oldStore, new EventBus(), { instanceId: 'old-instance' });
    oldOrchestrator.registerAdapter(new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }]));
    const task = await oldOrchestrator.createTask({ title: 't', prompt: 'do work', agentId: 'claude' });
    await oldOrchestrator.idle();
    oldStore.close();
    const before = readDatabaseRows(dbPath);

    const lock = await acquireInstanceLock({ lockPath: `${dbPath}.lock`, instanceId: 'new-instance', heartbeatMs: 0 });
    lock.release(); // 例如心跳發現租約丟失
    const store = new SqliteControlPlaneStore({ path: dbPath });
    cleanups.push(() => store.close());
    const adapter = new ScriptedAdapter(world, [
      { kind: 'tool', id: 'tool-A' },
      { kind: 'tool', id: 'tool-Z' },
    ]);
    const orchestrator = new Orchestrator(store, new EventBus(), { instanceId: 'new-instance', instanceLease: lock });
    orchestrator.registerAdapter(adapter);
    await expect(orchestrator.recover()).rejects.toThrow(INSTANCE_LEASE_NOT_HELD);
    expect(adapter.calls.resume).toBe(0);
    expect(readDatabaseRows(dbPath)).toEqual(before);
    expect((await store.getRun(task.runId))!.agentSessions.claude?.ownerInstanceId).toBe('old-instance');
  });

  it('服務端：租約丟失時立即自行關閉（fail-safe），並通知宿主', async () => {
    const box = sandbox();
    let db: DatabaseSync | undefined;
    const fatal: Error[] = [];
    const server = track(
      await startServer(
        sandboxServerOptions(box, [new ScriptedAdapter(new FakeWorld(), [{ kind: 'complete' }])], {
          instanceLock: { retries: 0, heartbeatMs: 0, openDatabase: (file: string) => (db = new DatabaseSync(file, { timeout: 0 })) },
          onFatal: (error) => fatal.push(error),
        }),
      ),
    );
    db!.close();
    expect(server.lock!.heartbeat()).toBe(false);
    await server.closed;
    expect(fatal).toHaveLength(1);
    expect((fatal[0] as Error & { code?: string }).code).toBe('ACC_LEASE_LOST');
    expect(server.app.server.listening).toBe(false);
  });
});
