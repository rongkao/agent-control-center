import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

/**
 * 啟動後自動用系統預設瀏覽器開啟帶令牌的訪問連結（P0-1）：使用者是非技術人員，不應該需要自己去終端裡複製連結。
 * 只在命令列入口（npm start / npm run start:real）使用；開發模式（npm run dev，--watch 會反覆重啟）不開啟；
 * 程式呼叫 startServer（測試、以後的桌面外殼）不經過這裡。ACC_NO_OPEN=1 可以關閉。
 */

const isTruthy = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

export function shouldOpenBrowser(input: { env: Record<string, string | undefined>; dev: boolean }): boolean {
  if (input.dev) return false;
  return !isTruthy(input.env.ACC_NO_OPEN);
}

/** 可注入的 spawn（測試用）：只用到 on('error') 與 unref。 */
export type BrowserSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean; shell: false },
) => { on(event: 'error', listener: (error: Error) => void): unknown; unref(): void };

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  spawn?: BrowserSpawn;
  /** 開啟失敗時的提示（例如沒有圖形介面的伺服器上找不到 xdg-open）。 */
  onError?: (error: Error) => void;
}

/**
 * 用系統預設瀏覽器開啟連結。連結作為獨立引數傳遞，不經過 shell（URL 裡的 & 等字元不會被解釋）：
 * - Windows：rundll32 url.dll,FileProtocolHandler <url>
 * - macOS：open <url>
 * - 其他：xdg-open <url>
 */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? (nodeSpawn as unknown as BrowserSpawn);
  const [command, args] =
    platform === 'win32'
      ? [path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.on('error', (error) => options.onError?.(error));
    child.unref();
  } catch (error) {
    options.onError?.(error as Error);
  }
}
