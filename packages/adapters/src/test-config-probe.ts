import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { TestConfigFile, TestConfigFingerprint, TestConfigGuard } from '@acc/core';

/**
 * 測試配置的本地讀取（P0-8 / H-15）。編排器在任務建立時和每次測試步驟之前呼叫它，比較兩次的指紋。
 *
 * 檢查範圍（都相對任務的工作目錄，檔案不存在就不列）：
 * - package.json：只取 scripts（包括 pretest / posttest）和測試框架寫在裡面的配置（jest、mocha、ava、nyc、c8）——
 *   改依賴、版本號不算改測試配置；
 * - 測試框架的配置檔案：vitest / vite（vitest 會讀 vite 的配置）/ jest / mocha / ava / karma / playwright / cypress、
 *   pytest.ini、tox.ini、noxfile.py、bunfig.toml；
 * - pyproject.toml、setup.cfg：只取測試相關的段落（[tool.pytest…]、[tool.tox…]、[tool:pytest]、pytest 外掛入口等）；
 * - .npmrc / .yarnrc / .yarnrc.yml：可以改變腳本用哪個 shell、給 node 加啟動引數；按鍵名識別登入憑據（_authToken、_password、
 *   npmAuthToken 等），憑據行只保留鍵名和值的雜湊（改了憑據能發現，但值不會讀進快照）；其餘設定原樣比較（P0 第三批審查：
 *   以前按整行子串丟棄，值裡帶 key / token 字樣的 node-options、script-shell 改動發現不了）；
 * - testCommand 以 make 開頭時的 Makefile、以 deno 開頭時的 deno.json；
 * - testCommand 直接引用的腳本檔案（例如 `node scripts/run-tests.mjs` 裡的 scripts/run-tests.mjs）。
 * 只因為 testCommand 才檢查的檔案（Makefile、deno.json、引用的腳本）標記 scope = 'command'：同一目錄換了測試命令時，
 * 編排器只沿用上一次確認過的共用部分（見 @acc/core 的 rebaseTrustedTestConfig）。
 *
 * 不在範圍內的（已知限制）：測試檔案本身、測試配置裡再引用的 setup 檔案、Maven / Gradle 等構建配置。
 * agent 改這些同樣能在測試時執行程式碼——長期要靠把測試放進沙箱執行（路線圖 P2-8）。
 */

/** 測試框架的配置檔案（原樣比較）。 */
const CONFIG_FILES: readonly string[] = [
  ...['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].flatMap((ext) => [`vitest.config.${ext}`, `vite.config.${ext}`, `jest.config.${ext}`, `playwright.config.${ext}`, `cypress.config.${ext}`]),
  ...['ts', 'js', 'mjs', 'json'].map((ext) => `vitest.workspace.${ext}`),
  'jest.config.json',
  ...['js', 'cjs', 'mjs', 'json', 'jsonc', 'yml', 'yaml'].map((ext) => `.mocharc.${ext}`),
  ...['js', 'cjs', 'mjs'].map((ext) => `ava.config.${ext}`),
  ...['js', 'cjs', 'ts'].map((ext) => `karma.conf.${ext}`),
  'pytest.ini',
  'tox.ini',
  'noxfile.py',
  'bunfig.toml',
];

/** package.json 裡與測試有關的欄位。 */
const PACKAGE_JSON_KEYS = ['scripts', 'jest', 'mocha', 'ava', 'nyc', 'c8'] as const;

/** 唯讀取這麼多位元組（配置檔案不會這麼大；更大的只比較前面這部分再加上檔案大小）。 */
const MAX_READ_BYTES = 2 * 1024 * 1024;
/** 快照裡儲存的、用於顯示差異的文字上限。 */
const MAX_TEXT_CHARS = 64 * 1024;
/** 最多檢查 testCommand 裡引用的幾個檔案。 */
const MAX_REFERENCED_FILES = 10;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 讀檔案（最多 MAX_READ_BYTES）；不存在或不是普通檔案時返回 undefined。 */
function readText(file: string): { text: string; size: number } | { error: string } | undefined {
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return undefined;
    size = stat.size;
  } catch {
    return undefined;
  }
  try {
    const length = Math.min(size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, buffer, offset, length - offset, offset);
        if (read <= 0) break;
        offset += read;
      }
    } finally {
      closeSync(fd);
    }
    return { text: buffer.toString('utf8'), size };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
  }
}

/** 把用於比較的內容變成指紋條目（過長時不儲存文字，只儲存雜湊）。 */
function entry(content: string, note?: string, size?: number, scope?: TestConfigFile['scope']): TestConfigFile {
  const hash = sha256(size !== undefined && size > MAX_READ_BYTES ? `${content}\u0000size:${size}` : content);
  const scoped = scope ? { scope } : {};
  if (content.length > MAX_TEXT_CHARS) return { hash, note: `${note ? `${note}；` : ''}內容較長（${Math.round(content.length / 1024)} KB），不顯示差異`, ...scoped };
  return { hash, text: content, ...(note ? { note } : {}), ...scoped };
}

/** package.json：只取 scripts 與測試框架的配置。解析失敗時按原文比較。 */
function packageJsonPart(text: string): { content: string; note?: string } | undefined {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of PACKAGE_JSON_KEYS) if (pkg[key] !== undefined) picked[key] = pkg[key];
    if (Object.keys(picked).length === 0) return undefined;
    return { content: `${JSON.stringify(picked, null, 2)}\n`, note: '只比較 scripts 與測試框架的設定' };
  } catch {
    return { content: text, note: 'package.json 無法解析，按原文比較' };
  }
}

/** INI / TOML 類檔案：只取名字滿足條件的段落。 */
function sectionsPart(text: string, wanted: (section: string) => boolean): string {
  const out: string[] = [];
  let include = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) include = wanted(header[1]!.replace(/["']/g, '').trim());
    if (include) out.push(line);
  }
  while (out.length && !out.at(-1)!.trim()) out.pop();
  return out.length ? `${out.join('\n')}\n` : '';
}

const PYPROJECT_SECTION = /^(tool\.(pytest|tox|hatch\.envs|poe|pdm\.scripts|nox)(\.|$))|pytest11/;
const SETUP_CFG_SECTION = /^(tool:pytest|pytest|tox:tox)$/;
/** .npmrc / .yarnrc / .yarnrc.yml 的寫法：key=value、key value、key: value。 */
type RcFormat = 'npmrc' | 'yarnrc' | 'yarnrc-yml';

/**
 * 登入憑據的鍵名（只看鍵名，不看值）：npm 的 _auth、_authToken、_password、username、email、cert、key、otp（可以帶 //host/: 前綴），
 * yarn 的 npmAuthToken、npmAuthIdent、npmPassword 等。node-options、script-shell、certfile、keyfile 這些不是憑據，原樣比較。
 */
const RC_CREDENTIAL_KEY = /(^_?auth$|auth_?token$|auth_?ident$|token$|password$|passwd$|secret|^_pass$|^username$|^email$|^cert$|^key$|^otp$)/i;

/** 拆出一行設定的鍵、分隔符和值（拆不出時返回 undefined，整行原樣比較）。 */
function splitRcLine(line: string, format: RcFormat): { key: string; separator: string; value: string } | undefined {
  if (format === 'npmrc') {
    const eq = line.indexOf('=');
    return eq > 0 ? { key: line.slice(0, eq).trim(), separator: '=', value: line.slice(eq + 1).trim() } : undefined;
  }
  const match = format === 'yarnrc' ? /^("[^"]*"|'[^']*'|\S+)(\s+)(.*)$/.exec(line) : /^("[^"]*"|'[^']*'|[^:\s]+)(\s*:\s*)(.*)$/.exec(line);
  return match ? { key: match[1]!, separator: match[2]!, value: match[3]! } : undefined;
}

/** 鍵名（去掉引號和 //host/: 這樣的作用域前綴）是否是登入憑據。 */
function isRcCredentialKey(key: string): boolean {
  const unquoted = key.replace(/^["']|["']$/g, '');
  const name = unquoted.slice(unquoted.lastIndexOf(':') + 1).trim();
  return RC_CREDENTIAL_KEY.test(name);
}

/** .npmrc / .yarnrc：去掉註釋；憑據行只保留鍵名和值的雜湊（改了能發現，值不讀進快照），其餘原樣比較。 */
function rcPart(text: string, format: RcFormat): string {
  const kept = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'))
    .map((line) => {
      const parts = splitRcLine(line, format);
      if (!parts || !isRcCredentialKey(parts.key)) return line;
      return `${parts.key}${parts.separator}<已隱藏，雜湊 ${sha256(parts.value).slice(0, 12)}>`;
    });
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** 把 testCommand 切成詞（支援引號）。 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  return tokens.filter(Boolean);
}

/** testCommand 的第一個程式名（跳過 FOO=bar 形式的環境變數賦值）。 */
function commandProgram(tokens: string[]): string {
  const first = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ?? '';
  return first.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/** 顯示用的路徑：工作目錄內用相對路徑（/ 分隔），之外用絕對路徑。 */
function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return file;
}

/** testCommand 直接引用的、真實存在的檔案。 */
function referencedFiles(cwd: string, tokens: string[]): string[] {
  const files: string[] = [];
  for (const token of tokens.slice(1)) {
    if (files.length >= MAX_REFERENCED_FILES) break;
    if (token.startsWith('-') || /[*?<>|&;$`]/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token.includes('://')) continue;
    const candidate = resolve(cwd, token);
    try {
      if (statSync(candidate).isFile() && !files.includes(candidate)) files.push(candidate);
    } catch {
      // 不是檔案：跳過
    }
  }
  return files;
}

/** 讀取工作目錄裡與測試相關的配置，生成指紋。 */
export function captureTestConfig(cwd: string, testCommand: string): TestConfigFingerprint {
  const files: Record<string, TestConfigFile> = {};
  // Windows 的檔名不區分大小寫：Makefile 與 makefile 是同一個檔案，只記一次
  const seen = new Set<string>();
  const add = (file: string, part: (text: string) => { content: string; note?: string } | undefined, scope?: TestConfigFile['scope']) => {
    const identity = process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
    if (seen.has(identity)) return;
    const read = readText(file);
    if (!read) return;
    seen.add(identity);
    const key = displayPath(cwd, file);
    if ('error' in read) {
      files[key] = { hash: sha256(`unreadable:${read.error}`), note: `無法讀取（${read.error}）`, ...(scope ? { scope } : {}) };
      return;
    }
    const picked = part(read.text);
    if (picked === undefined || picked.content === '') return;
    files[key] = entry(picked.content, picked.note, read.size, scope);
  };
  const whole = (text: string) => ({ content: text });

  add(join(cwd, 'package.json'), packageJsonPart);
  for (const name of CONFIG_FILES) add(join(cwd, name), whole);
  add(join(cwd, 'pyproject.toml'), (text) => ({ content: sectionsPart(text, (s) => PYPROJECT_SECTION.test(s)), note: '只比較測試相關的段落' }));
  add(join(cwd, 'setup.cfg'), (text) => ({ content: sectionsPart(text, (s) => SETUP_CFG_SECTION.test(s)), note: '只比較測試相關的段落' }));
  const rcFiles: Array<[string, RcFormat]> = [
    ['.npmrc', 'npmrc'],
    ['.yarnrc', 'yarnrc'],
    ['.yarnrc.yml', 'yarnrc-yml'],
  ];
  for (const [name, format] of rcFiles) add(join(cwd, name), (text) => ({ content: rcPart(text, format), note: '登入憑據只比較雜湊、不顯示內容' }));

  const tokens = tokenize(testCommand);
  const program = commandProgram(tokens);
  // 只因為這條測試命令才檢查的檔案：scope = command
  if (['make', 'gmake', 'mingw32-make', 'nmake'].includes(program)) for (const name of ['Makefile', 'makefile', 'GNUmakefile']) add(join(cwd, name), whole, 'command');
  if (program === 'deno') for (const name of ['deno.json', 'deno.jsonc']) add(join(cwd, name), whole, 'command');
  for (const file of referencedFiles(cwd, tokens)) add(file, whole, 'command');
  return { files };
}

/** 服務端注入給編排器的本地實現。 */
export function createLocalTestConfigGuard(): TestConfigGuard {
  return { capture: (cwd, testCommand) => captureTestConfig(cwd, testCommand) };
}
