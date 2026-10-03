import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * 子程序樹的結束與輸出解碼（P1-5：M-21、L-8、L-32）。
 *
 * - Windows：用 taskkill /T /F 結束整棵程序樹。平時非同步執行（不阻塞事件迴圈）；
 *   服務關閉時（程序馬上要退出）用同步版本，保證在退出前真正結束。
 * - POSIX：子程序用 detached 啟動成為獨立程序組，按程序組發訊號，孫程序一併結束
 *   （否則只結束 sh，孫程序繼續佔著管道，超時 kill 形同虛設）。
 */

export interface KillTreeOptions {
  /** 同步結束（服務關閉時用）；預設非同步。 */
  sync?: boolean;
}

/** POSIX 上是否用獨立程序組啟動子程序（配合 killProcessTree 按組結束）。 */
export const useProcessGroup = process.platform !== 'win32';

export function killProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'> | undefined, options: KillTreeOptions = {}): void {
  const pid = child?.pid;
  if (!child || pid === undefined) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T', '/F'];
    if (options.sync) {
      spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      return;
    }
    const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    // taskkill 本身啟動失敗（極少見）時退回直接結束子程序
    killer.on('error', () => {
      try {
        child.kill();
      } catch {
        // 程序可能已經退出
      }
    });
    return;
  }
  try {
    // 負 PID：結束整個程序組（子程序以 detached 啟動時它就是組長）
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // 程序可能已經退出
    }
  }
}

/**
 * 有上限的位元組緩衝：按原始位元組收集子程序輸出，最後統一解碼。
 * 按塊呼叫 toString() 會把跨塊的多位元組字元切壞（L-32），這裡只在結束時解碼一次。
 */
export class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(data: Buffer | string): void {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    // 超過上限時丟棄最早的塊，只保留尾部
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    let buffer = Buffer.concat(this.chunks);
    if (buffer.length > this.maxBytes) buffer = buffer.subarray(buffer.length - this.maxBytes);
    return decodeProcessOutput(buffer);
  }
}

/**
 * 解碼子程序輸出：優先按 UTF-8；不是合法 UTF-8 且在 Windows 上時，按系統內碼表（中文 Windows 為 GBK/cp936）解碼，
 * 避免中文程式的輸出變成亂碼後再作為上下文交給 retry/rescue 的 agent。
 * 尾部截斷可能切開開頭的一個多位元組字元，先跳過開頭的 UTF-8 續位元組。
 */
export function decodeProcessOutput(buffer: Buffer, platform: NodeJS.Platform = process.platform): string {
  let start = 0;
  while (start < buffer.length && start < 3 && (buffer[start]! & 0xc0) === 0x80) start += 1;
  const body = start > 0 ? buffer.subarray(start) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    if (platform === 'win32') {
      try {
        return new TextDecoder('gbk').decode(buffer);
      } catch {
        // 執行時不帶 GBK 解碼（small-icu）：退回寬鬆的 UTF-8
      }
    }
    return new TextDecoder('utf-8').decode(body);
  }
}

/** 給含空格的可執行檔案路徑加引號（經 shell 啟動時，Program Files 下的路徑否則會被拆開）。 */
export function quoteExecutable(path: string): string {
  if (!/\s/.test(path) || /^".*"$/.test(path)) return path;
  return `"${path}"`;
}
