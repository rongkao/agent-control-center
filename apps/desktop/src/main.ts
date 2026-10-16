/**
 * Agent Control Center 桌面版主程序（Electron）。
 *
 * - 服務端在 utilityProcess 子程序裡執行（server-entry.ts），當掉不會拖垮視窗，可以從對話方塊重新啟動；
 * - 視窗直接載入服務端給的帶令牌連結，沿用網頁版的登入機制；
 * - 資料目錄與命令列版共用（%LOCALAPPDATA%\agent-control-center），單實例鎖保證兩邊不會同時開同一份資料；
 * - 設定：資料目錄裡的 .env（與命令列版相同的設定項）；預設工作資料夾第一次啟動時選擇，之後可從選單更換；
 * - 關閉視窗：預設縮到系統匣（AI 的工作不中斷）；從系統匣或選單「結束」時先讓服務端優雅關閉（停下 AI、關好資料庫），再結束；
 * - 自動更新：從 GitHub Releases 檢查新版本，背景下載，下載完問要不要重新啟動更新（.env 設 ACC_AUTO_UPDATE=0 可關閉）。
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import electronUpdater from 'electron-updater';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { resolveControlPlanePaths } from '@acc/server/data-paths';

const APP_ID = 'com.rongkao.agentcontrolcenter';
const SMOKE = process.env.ACC_DESKTOP_SMOKE === '1';
// 測試用：把 Electron 的使用者資料（視窗設定、日誌）放到指定目錄，不碰真實的設定
if (process.env.ACC_DESKTOP_USER_DATA) app.setPath('userData', process.env.ACC_DESKTOP_USER_DATA);

interface DesktopSettings {
  workspace?: string;
  /** 關閉視窗時縮到系統匣（預設 true）。 */
  closeToTray?: boolean;
  /** 已經提示過「仍在背景執行」。 */
  trayHintShown?: boolean;
  bounds?: { x?: number; y?: number; width: number; height: number };
  maximized?: boolean;
}

interface ServerReady {
  accessUrl: string;
  url: string;
  workspace: string;
  dataDir: string;
  warnings: string[];
}

let win: BrowserWindow | undefined;
let server: UtilityProcess | undefined;
let ready: ServerReady | undefined;
let quitting = false;
let restarting = false;
let tray: Tray | undefined;

// ---------------------------------------------------------------- 路徑與設定

/** 打包後的資源位置：網頁、說明文件、設定範本都在 app 目錄（asar 內）的 resources 裡。 */
const appDir = app.getAppPath();
const resource = (...parts: string[]) => path.join(appDir, ...parts);
const settingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');
const logFile = () => path.join(app.getPath('userData'), 'logs', 'desktop.log');

function readSettings(): DesktopSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as DesktopSettings;
  } catch {
    return {};
  }
}

function writeSettings(patch: Partial<DesktopSettings>): void {
  const next = { ...readSettings(), ...patch };
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

function log(line: string): void {
  try {
    mkdirSync(path.dirname(logFile()), { recursive: true });
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // 寫日誌失敗不影響使用
  }
}

/** 控制面資料目錄（與命令列版相同的規則：ACC_DATA_DIR 優先）。 */
function dataDir(): string {
  return resolveControlPlanePaths({ env: process.env, homedir: homedir(), cwd: homedir() }).dataDir;
}

/** 資料目錄裡的 .env（與命令列版相同的設定項）；沒有就回傳空物件。 */
function readDotEnv(): Record<string, string> {
  const file = path.join(dataDir(), '.env');
  try {
    return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 最近 40 行服務端輸出（錯誤對話方塊裡顯示）。 */
let serverOutput: string[] = [];
function remember(text: string): void {
  for (const raw of text.split(/\r?\n/)) {
    // 訪問令牌等同於密碼：不寫進日誌檔案，也不顯示在錯誤對話方塊裡
    const line = raw.replace(/token=[A-Za-z0-9_-]+/g, 'token=***');
    if (!line.trim()) continue;
    serverOutput.push(line);
    log(`[server] ${line}`);
  }
  if (serverOutput.length > 40) serverOutput = serverOutput.slice(-40);
}

/**
 * 打包後 Claude Agent SDK 自己找到的 claude.exe 路徑在 app.asar 裡（不能執行）；
 * 實際檔案被解開在 app.asar.unpacked，這裡直接指定給服務端。開發時（沒有打包）交給 SDK 自己找。
 */
function claudeExecutableEnv(): Record<string, string> {
  if (!app.isPackaged || process.env.ACC_CLAUDE_EXECUTABLE) return {};
  const exe = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(exe) ? { ACC_CLAUDE_EXECUTABLE: exe } : {};
}

// ---------------------------------------------------------------- 工作資料夾

/** 讓使用者選擇 AI 預設工作的資料夾；取消時回傳 undefined。 */
async function chooseWorkspace(current?: string): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
    title: '選擇 AI 預設工作的專案資料夾',
    defaultPath: current ?? path.join(homedir(), 'Documents'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用這個資料夾',
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function ensureWorkspace(): Promise<string> {
  const env = readDotEnv();
  const fromEnv = process.env.ACC_WORKSPACE || env.ACC_WORKSPACE;
  if (fromEnv) return fromEnv;
  const saved = readSettings().workspace;
  if (saved && existsSync(saved)) return saved;
  if (SMOKE) return homedir();
  await dialog.showMessageBox({
    type: 'info',
    title: 'Agent Control Center',
    message: '歡迎使用 Agent Control Center',
    detail: '第一次使用：請選擇 AI 預設工作的專案資料夾（之後建任務時也可以另外指定，或從選單「檔案 → 更換預設工作資料夾」修改）。',
    buttons: ['選擇資料夾'],
  });
  const picked = (await chooseWorkspace()) ?? path.join(homedir(), 'Documents');
  writeSettings({ workspace: picked });
  return picked;
}

// ---------------------------------------------------------------- 服務端程序

function startServerProcess(workspace: string): void {
  ready = undefined;
  serverOutput = [];
  // 優先順序與命令列版相同：環境變數 > 資料目錄的 .env > 預設值（預設用真實的 AI；.env 裡可以改成 mock 試用）
  const env: Record<string, string> = {
    ACC_RUNTIME_MODE: 'real',
    ...readDotEnv(),
    ...(process.env as Record<string, string>),
    ACC_WORKSPACE: workspace,
    ACC_NO_OPEN: '1',
    ACC_DESKTOP_WEB_ROOT: resource('web'),
    ACC_APP_VERSION: app.getVersion(),
    ...claudeExecutableEnv(),
  };
  log(`starting server (workspace=${workspace})`);
  server = utilityProcess.fork(resource('dist', 'server.mjs'), [], { env, stdio: 'pipe', serviceName: 'Agent Control Center 服務' });
  server.stdout?.on('data', (d: Buffer) => remember(String(d)));
  server.stderr?.on('data', (d: Buffer) => remember(String(d)));
  server.on('message', (message: { type?: string } & Record<string, unknown>) => {
    if (message.type === 'ready') {
      ready = message as unknown as ServerReady;
      log(`server ready at ${ready.url}`);
      void win?.loadURL(ready.accessUrl);
      for (const warning of ready.warnings) remember(`[警告] ${warning}`);
    } else if (message.type === 'failed') {
      void showStartupFailure(String(message.message));
    } else if (message.type === 'fatal') {
      remember(`[致命錯誤] ${String(message.message)}`);
    }
  });
  server.on('exit', (code) => {
    log(`server exited (code ${code})`);
    server = undefined;
    if (quitting || restarting) return;
    // 不是使用者要關的：說明原因，讓使用者選擇重新啟動或結束
    void (async () => {
      const { response } = await dialog.showMessageBox(win ?? (undefined as unknown as BrowserWindow), {
        type: 'error',
        title: 'Agent Control Center',
        message: ready ? '服務意外結束了' : '服務沒能啟動',
        detail: `${serverOutput.slice(-15).join('\n') || `結束代碼 ${code}`}\n\n完整日誌：${logFile()}`,
        buttons: ['重新啟動', '結束'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) startServerProcess(workspace);
      else app.quit();
    })();
  });
}

async function showStartupFailure(message: string): Promise<void> {
  remember(message);
  if (SMOKE) {
    writeSmoke({ ok: false, error: message });
    app.exit(1);
    return;
  }
  // 結束代碼由 exit 事件的對話方塊處理；這裡只記下原因
}

/** 讓服務端優雅關閉；最多等 12 秒。 */
function stopServer(): Promise<void> {
  const proc = server;
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, 12_000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.postMessage({ type: 'shutdown' });
  });
}

async function restartServer(): Promise<void> {
  restarting = true;
  await stopServer();
  restarting = false;
  showLoading('正在重新啟動服務……');
  startServerProcess(await ensureWorkspace());
}

// ---------------------------------------------------------------- 視窗

function loadingPage(text: string): string {
  const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Agent Control Center</title>
<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,'Microsoft JhengHei',sans-serif;background:#f5f7fb;color:#344054">
<div style="text-align:center"><div style="font-size:22px;margin-bottom:8px">✦ Agent Control Center</div><div style="color:#667085">${text}</div></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showLoading(text: string): void {
  void win?.loadURL(loadingPage(text));
}

function createWindow(): void {
  const settings = readSettings();
  win = new BrowserWindow({
    width: settings.bounds?.width ?? 1400,
    height: settings.bounds?.height ?? 900,
    x: settings.bounds?.x,
    y: settings.bounds?.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Agent Control Center',
    backgroundColor: '#f5f7fb',
    show: !SMOKE,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (settings.maximized) win.maximize();
  showLoading('正在啟動服務……');

  // 外部連結用系統瀏覽器開啟；控制台本身的頁面留在視窗裡
  const isInternal = (url: string) => Boolean(ready && url.startsWith(ready.url)) || url.startsWith('data:');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isInternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (SMOKE && ready && win?.webContents.getURL().startsWith(ready.url)) void smokeCheck();
  });

  const saveBounds = () => {
    if (!win || win.isMinimized()) return;
    if (win.isMaximized()) writeSettings({ maximized: true });
    else writeSettings({ maximized: false, bounds: win.getBounds() });
  };
  win.on('close', (event) => {
    saveBounds();
    // 縮到系統匣：AI 的工作不中斷；真正結束走系統匣或選單的「結束」
    if (!quitting && !SMOKE && readSettings().closeToTray !== false && tray) {
      event.preventDefault();
      win?.hide();
      if (!readSettings().trayHintShown) {
        writeSettings({ trayHintShown: true });
        tray.displayBalloon({ title: 'Agent Control Center 仍在背景執行', content: 'AI 的工作不會中斷，需要你處理時會通知你。點系統匣圖示重新開啟，右鍵選「結束」關閉。', iconType: 'info' });
      }
    }
  });
  win.on('closed', () => {
    win = undefined;
  });
}

// ---------------------------------------------------------------- 系統匣

function showWindow(): void {
  if (!win) createWindow();
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resource('resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Agent Control Center');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '開啟控制台', click: showWindow },
      { type: 'separator' },
      { label: '結束（停下 AI 並關閉）', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

// ---------------------------------------------------------------- 自動更新

const { autoUpdater } = electronUpdater;
let updateReady = false;

/** 自動更新：打包後才啟用（或用 ACC_UPDATE_FEED 指向測試用的更新來源）；.env 設 ACC_AUTO_UPDATE=0 關閉。 */
function setupAutoUpdate(): void {
  const feed = process.env.ACC_UPDATE_FEED;
  if ((!app.isPackaged && !feed) || (process.env.ACC_AUTO_UPDATE ?? readDotEnv().ACC_AUTO_UPDATE) === '0') return;
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  autoUpdater.autoDownload = true;
  // 結束程式時自動安裝下載好的更新；冒煙測試只驗證下載，絕不安裝（否則會真的裝到這台電腦上）
  autoUpdater.autoInstallOnAppQuit = !SMOKE;
  autoUpdater.logger = { info: (m: unknown) => log(`[update] ${String(m)}`), warn: (m: unknown) => log(`[update] ${String(m)}`), error: (m: unknown) => log(`[update] ${String(m)}`), debug: () => undefined };
  autoUpdater.on('update-downloaded', (info) => void onUpdateDownloaded(info.version));
  autoUpdater.on('error', (error) => log(`[update] 失敗：${error.message}`));
  // 啟動後稍等再檢查，之後每 6 小時檢查一次
  setTimeout(() => void checkForUpdates(false), SMOKE ? 500 : 15_000).unref?.();
  setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000).unref?.();
}

async function checkForUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged && !process.env.ACC_UPDATE_FEED) {
    if (manual) void dialog.showMessageBox({ type: 'info', title: '檢查更新', message: '開發版不檢查更新。' });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version;
    if (manual && (!latest || latest === app.getVersion())) {
      await dialog.showMessageBox({ type: 'info', title: '檢查更新', message: `已經是最新版本（${app.getVersion()}）。` });
    } else if (manual && !updateReady) {
      await dialog.showMessageBox({ type: 'info', title: '檢查更新', message: `發現新版本 ${latest}，正在背景下載，下載完會通知你。` });
    }
  } catch (error) {
    log(`[update] 檢查失敗：${(error as Error).message}`);
    if (manual) await dialog.showMessageBox({ type: 'warning', title: '檢查更新', message: '沒辦法檢查更新', detail: (error as Error).message });
  }
}

async function onUpdateDownloaded(version: string): Promise<void> {
  updateReady = true;
  log(`[update] 新版本 ${version} 已下載`);
  if (SMOKE) {
    smokeUpdate = version;
    return;
  }
  const { response } = await dialog.showMessageBox(win ?? (undefined as unknown as BrowserWindow), {
    type: 'info',
    title: '有新版本',
    message: `Agent Control Center ${version} 已經下載好了`,
    detail: '現在重新啟動就會完成更新（會先停下 AI、關好資料庫）。也可以之後再說，下次結束程式時自動安裝。',
    buttons: ['現在重新啟動並更新', '之後再說'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  quitting = true;
  showLoading('正在更新：停下 AI、關好資料庫……');
  await stopServer();
  autoUpdater.quitAndInstall(false, true);
}

// ---------------------------------------------------------------- 選單

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '檔案',
      submenu: [
        {
          label: '更換預設工作資料夾…',
          click: async () => {
            const picked = await chooseWorkspace(readSettings().workspace);
            if (!picked) return;
            writeSettings({ workspace: picked });
            await restartServer();
          },
        },
        { label: '開啟設定檔（.env）', click: () => void openSettingsFile() },
        { label: '開啟資料資料夾', click: () => void shell.openPath(dataDir()) },
        { label: '開啟日誌', click: () => void shell.openPath(path.dirname(logFile())) },
        { type: 'separator' },
        {
          label: '關閉視窗時縮到系統匣',
          type: 'checkbox',
          checked: readSettings().closeToTray !== false,
          click: (item) => writeSettings({ closeToTray: item.checked }),
        },
        { label: '重新啟動服務', click: () => void restartServer() },
        { type: 'separator' },
        { label: '結束', role: 'quit' },
      ],
    },
    {
      label: '編輯',
      submenu: [
        { label: '復原', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪下', role: 'cut' },
        { label: '複製', role: 'copy' },
        { label: '貼上', role: 'paste' },
        { label: '全選', role: 'selectAll' },
      ],
    },
    {
      label: '檢視',
      submenu: [
        { label: '重新整理', role: 'reload' },
        { label: '實際大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '縮小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全螢幕', role: 'togglefullscreen' },
        { label: '開發者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '說明',
      submenu: [
        { label: '使用說明', click: () => void shell.openPath(resource('resources', '使用說明.md')) },
        { label: '在 GitHub 上檢視', click: () => void shell.openExternal('https://github.com/rongkao/agent-control-center') },
        { label: '檢查更新…', click: () => void checkForUpdates(true) },
        { type: 'separator' },
        {
          label: '關於 Agent Control Center',
          click: () =>
            void dialog.showMessageBox(win ?? (undefined as unknown as BrowserWindow), {
              type: 'info',
              title: '關於',
              message: `Agent Control Center ${app.getVersion()}`,
              detail: `在同一個介面協調 Claude、Codex 等編碼 AI 的本機控制台。\n\n工作資料夾：${ready?.workspace ?? '—'}\n資料目錄：${dataDir()}\nElectron ${process.versions.electron} · Node ${process.versions.node}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 開啟資料目錄裡的 .env；還沒有時從範本建立一份（全部設定都是註解，不改變任何行為）。 */
async function openSettingsFile(): Promise<void> {
  const file = path.join(dataDir(), '.env');
  if (!existsSync(file)) {
    mkdirSync(dataDir(), { recursive: true });
    const template = resource('resources', '.env.example');
    if (existsSync(template)) {
      const commented = readFileSync(template, 'utf8')
        .split(/\r?\n/)
        .map((line) => (line.trim() && !line.trim().startsWith('#') ? `# ${line}` : line))
        .join('\n');
      writeFileSync(file, `# Agent Control Center 設定檔：去掉行首的 # 並修改值即可生效，存檔後從選單「檔案 → 重新啟動服務」。\n\n${commented}`);
    } else {
      writeFileSync(file, '# Agent Control Center 設定檔：每行一個「名稱=值」，存檔後從選單「檔案 → 重新啟動服務」。\n');
    }
  }
  await shell.openPath(file);
}

// ---------------------------------------------------------------- 自動測試（ACC_DESKTOP_SMOKE=1）

/** 冒煙測試期間下載到的更新版本（ACC_UPDATE_FEED）。 */
let smokeUpdate: string | undefined;

function writeSmoke(result: Record<string, unknown>): void {
  const out = process.env.ACC_DESKTOP_SMOKE_OUT;
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
}

/** 冒煙測試：介面載入完成後檢查頁面與 API，寫出結果並結束。 */
async function smokeCheck(): Promise<void> {
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const page = (await win!.webContents.executeJavaScript(
      `(async () => ({
        title: document.title,
        text: document.body.innerText.slice(0, 2000),
        config: await fetch('/api/config').then((r) => r.json()),
        agents: await fetch('/api/agents').then((r) => r.json()),
        isolation: await fetch('/api/isolation').then((r) => r.json()),
      }))()`,
    )) as Record<string, unknown>;
    // ACC_DESKTOP_SMOKE_PROMPT：再跟 Claude 真的對話一輪（確認打包後能啟動 claude.exe）
    const prompt = process.env.ACC_DESKTOP_SMOKE_PROMPT;
    if (prompt) {
      page.reply = await win!.webContents.executeJavaScript(
        `(async () => {
          const task = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: ${JSON.stringify(prompt)}, agentId: 'claude', workflow: 'manual' }) }).then((r) => r.json());
          for (let i = 0; i < 120; i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
            const detail = await fetch('/api/tasks/' + task.id).then((r) => r.json());
            const events = detail.events ?? [];
            const reply = events.find((e) => e.type === 'agent.message' && e.data.direction === 'from-agent' && !e.data.ephemeral);
            const error = events.find((e) => e.type === 'runtime.error');
            if (reply) return { ok: true, text: String(reply.data.message).slice(0, 200) };
            if (error) return { ok: false, error: JSON.stringify(error.data).slice(0, 400) };
          }
          return { ok: false, error: 'timeout' };
        })()`,
      );
    }
    // ACC_UPDATE_FEED：等更新下載完（最多 60 秒）
    if (process.env.ACC_UPDATE_FEED) {
      for (let i = 0; i < 120 && !smokeUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
      page.update = smokeUpdate ?? null;
    }
    writeSmoke({ ok: true, url: ready?.url, workspace: ready?.workspace, ...page });
  } catch (error) {
    writeSmoke({ ok: false, error: String(error) });
  }
  quitting = true;
  await stopServer();
  app.exit(0);
}

// ---------------------------------------------------------------- 生命週期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.on('second-instance', showWindow);
  app.on('before-quit', (event) => {
    if (quitting) return;
    // 先讓服務端優雅關閉，再真正結束
    event.preventDefault();
    quitting = true;
    showLoading('正在關閉（停下 AI、關好資料庫）……');
    void stopServer().finally(() => app.exit(0));
  });
  // 縮到系統匣時視窗只是隱藏：不因為沒有視窗就結束
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
  void app.whenReady().then(async () => {
    buildMenu();
    createWindow();
    if (!SMOKE) createTray();
    setupAutoUpdate();
    startServerProcess(await ensureWorkspace());
  });
}
