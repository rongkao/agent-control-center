/**
 * 桌面版建置腳本。
 *
 *   node scripts/build.mjs               建置並打包成 Windows 安裝程式（release/）
 *   node scripts/build.mjs --no-package  只建置到 stage/（npm start 用它直接以 Electron 執行）
 *
 * 步驟：
 *   1. 建置網頁（apps/web/dist）；
 *   2. esbuild 把主程序（src/main.ts）和服務端（src/server-entry.ts）各打成一個 ESM 檔案：
 *      我們自己的 TypeScript（@acc/*）打進去，第三方套件保持外部引用；
 *   3. 準備 stage/：package.json（只列執行時需要的第三方套件，版本與開發環境一致）、網頁、說明文件、設定範本；
 *      在 stage/ 裡安裝這些套件（包括 Claude Agent SDK 內建的 claude.exe）；
 *   4. electron-builder 打包：NSIS 安裝程式（繁體中文介面）；含可執行檔的套件從 asar 解開（執行檔不能在 asar 裡執行）。
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const root = path.resolve(desktop, '../..');
const stage = path.join(desktop, 'stage');
const noPackage = process.argv.includes('--no-package');

/** 執行時需要的第三方套件（服務端與各 adapter 的相依）；版本取開發環境實際安裝的版本。 */
const RUNTIME_DEPS = ['fastify', '@fastify/static', '@fastify/websocket', 'zod', '@anthropic-ai/claude-agent-sdk', '@agentclientprotocol/sdk', 'electron-updater'];
const OPTIONAL_DEPS = ['@anthropic-ai/sandbox-runtime'];

const step = (text) => console.log(`\n▶ ${text}`);
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const installedVersion = (name) => JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// Electron 執行檔是安裝時另外下載的；下載失敗（網路中斷等）時這裡補下載一次
if (!existsSync(path.join(root, 'node_modules/electron/dist'))) {
  step('下載 Electron 執行檔');
  run('node install.js', path.join(root, 'node_modules/electron'));
}

step('建置網頁');
run('npm run bundle -w @acc/web');

step('打包主程序與服務端（esbuild）');
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'dist'), { recursive: true });
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  logLevel: 'warning',
  // 我們自己的程式碼打進去；第三方套件與 Electron 保持外部引用
  external: ['electron', ...RUNTIME_DEPS, ...OPTIONAL_DEPS],
  // ESM 打包後仍有部分程式需要 require（例如第三方套件的 CommonJS 互通）
  banner: { js: "import { createRequire as __accCreateRequire } from 'node:module'; const require = __accCreateRequire(import.meta.url);" },
};
await esbuild({ ...common, entryPoints: [path.join(desktop, 'src/main.ts')], outfile: path.join(stage, 'dist/main.mjs') });
await esbuild({ ...common, entryPoints: [path.join(desktop, 'src/server-entry.ts')], outfile: path.join(stage, 'dist/server.mjs') });

step('準備 stage/');
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const pkg = {
  name: 'agent-control-center',
  productName: 'Agent Control Center',
  // 測試自動更新時可以用 ACC_DESKTOP_VERSION 覆蓋版本號
  version: process.env.ACC_DESKTOP_VERSION || rootPkg.version,
  description: '在同一個介面協調 Claude、Codex 等編碼 AI 的本機控制台',
  author: 'rongkao',
  license: 'UNLICENSED',
  type: 'module',
  main: 'dist/main.mjs',
  dependencies: Object.fromEntries(RUNTIME_DEPS.map((name) => [name, installedVersion(name)])),
  optionalDependencies: Object.fromEntries(OPTIONAL_DEPS.filter((name) => existsSync(path.join(root, 'node_modules', name))).map((name) => [name, installedVersion(name)])),
};
writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
cpSync(path.join(root, 'apps/web/dist'), path.join(stage, 'web'), { recursive: true });
mkdirSync(path.join(stage, 'resources'), { recursive: true });
cpSync(path.join(root, '.env.example'), path.join(stage, 'resources/.env.example'));
cpSync(path.join(root, 'docs/使用說明.md'), path.join(stage, 'resources/使用說明.md'));
// 系統匣圖示
cpSync(path.join(desktop, 'build/icon.ico'), path.join(stage, 'resources/icon.ico'));
cpSync(path.join(desktop, 'build/icon.png'), path.join(stage, 'resources/icon.png'));

step('安裝執行時套件');
run('npm install --omit=dev --no-audit --no-fund --no-package-lock', stage);

if (noPackage) {
  console.log(`\n✓ 已建置到 ${stage}（沒有打包）`);
  process.exit(0);
}

step('打包安裝程式（electron-builder）');
const { build } = (await import('electron-builder')).default;
const electronVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const publish = process.argv.includes('--publish');
const artifacts = await build({
  projectDir: desktop,
  // --publish：上傳到 GitHub Releases（需要 GH_TOKEN）；平常只產生安裝程式和自動更新用的 latest.yml
  publish: publish ? 'always' : 'never',
  config: {
    // 自動更新的來源：GitHub Releases
    publish: [{ provider: 'github', owner: 'rongkao', repo: 'agent-control-center', releaseType: 'release' }],
    appId: 'com.rongkao.agentcontrolcenter',
    productName: 'Agent Control Center',
    copyright: 'Copyright © rongkao',
    electronVersion,
    electronDist: path.join(root, 'node_modules/electron/dist'),
    npmRebuild: false,
    directories: { app: stage, output: process.env.ACC_DESKTOP_OUT || path.join(desktop, 'release'), buildResources: path.join(desktop, 'build') },
    files: ['**/*', '!**/*.map'],
    asar: true,
    // Claude Agent SDK 帶的 claude.exe、sandbox-runtime 帶的 srt-win.exe 要在磁碟上才能執行
    asarUnpack: ['node_modules/@anthropic-ai/**'],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: path.join(desktop, 'build/icon.ico'),
      artifactName: 'AgentControlCenter-Setup-${version}.${ext}',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Agent Control Center',
      unicode: true,
      language: '1028',
      installerIcon: path.join(desktop, 'build/icon.ico'),
      uninstallerIcon: path.join(desktop, 'build/icon.ico'),
      // 解除安裝時不刪除資料（任務記錄在 %LOCALAPPDATA%\agent-control-center，與命令列版共用）
      deleteAppDataOnUninstall: false,
    },
  },
});
console.log('\n✓ 打包完成：');
for (const file of artifacts) console.log(`  ${file}`);
