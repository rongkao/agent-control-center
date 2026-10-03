import { createRequire } from 'node:module';

/**
 * 測試用 WebSocket 客戶端：使用 node_modules 裡已有的 ws 包（@fastify/websocket 的依賴），
 * 因為它允許自定義 Origin / Host / Cookie 等請求頭，而瀏覽器（和 Node 自帶的 WebSocket）不允許。
 * 倉庫沒有安裝 @types/ws，這裡只宣告用到的最小介面。
 */
export interface WsSocket {
  readonly readyState: number;
  on(event: 'message', listener: (data: Buffer) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'open', listener: () => void): this;
  on(event: 'unexpected-response', listener: (req: { destroy(): void }, res: IncomingLike) => void): this;
  send(data: string): void;
  close(code?: number): void;
  terminate(): void;
}

interface IncomingLike {
  statusCode?: number;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
}

type WsConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WsSocket;

const require = createRequire(import.meta.url);
const WebSocketImpl = require('ws') as WsConstructor;

export type WsOutcome =
  | { kind: 'open'; socket: WsSocket; nextMessage: () => Promise<string>; closed: Promise<number> }
  | { kind: 'rejected'; status: number; body: string }
  | { kind: 'error'; error: Error };

/** 傳輸層出錯（連線被重置等，沒有拿到服務端的任何 HTTP 響應）時最多嘗試幾次。 */
const TRANSPORT_ATTEMPTS = 6;

/**
 * 發起 WS 升級：成功返回已開啟的連線；被服務端以 HTTP 響應拒絕時返回狀態碼和響應體。
 * 結果都透過事件得到，不依賴定時等待判斷結果。
 *
 * 穩定性（P0 第三批審查）：整套測試併發跑、機器負載高時，偶爾在拿到服務端的響應之前就遇到傳輸層錯誤
 * （@fastify/websocket 拒絕升級後立刻 destroy 套接字，Windows 上可能表現為連線被重置）。這種情況下重新連一次，最多 6 次；
 * 只重試“傳輸層出錯”，被服務端拒絕（HTTP 響應）或連上了都照原樣返回，不會把拒絕變成通過。
 */
export async function connectWs(url: string, headers: Record<string, string> = {}): Promise<WsOutcome> {
  let outcome = await connectOnce(url, headers);
  for (let attempt = 1; attempt < TRANSPORT_ATTEMPTS && outcome.kind === 'error'; attempt += 1) {
    // 本機有流量檢查軟體（例如安全軟體、代理的 TUN 模式）時，本地連線偶爾會被拖慢幾百毫秒：退避間隔拉長一些
    await new Promise<void>((resolve) => setTimeout(resolve, 200 * attempt));
    outcome = await connectOnce(url, headers);
  }
  return outcome;
}

/** 發起一次 WS 升級。 */
function connectOnce(url: string, headers: Record<string, string>): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const socket = new WebSocketImpl(url, { headers });
    const queue: string[] = [];
    const waiters: Array<(message: string) => void> = [];
    let settled = false;
    const settle = (outcome: WsOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    let onClosed!: (code: number) => void;
    const closed = new Promise<number>((resolveClosed) => {
      onClosed = resolveClosed;
    });
    socket.on('message', (data) => {
      const text = data.toString();
      const waiter = waiters.shift();
      if (waiter) waiter(text);
      else queue.push(text);
    });
    socket.on('close', (code) => onClosed(code));
    socket.on('error', (error) => settle({ kind: 'error', error }));
    socket.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        settle({ kind: 'rejected', status: res.statusCode ?? 0, body });
        req.destroy();
      });
    });
    socket.on('open', () =>
      settle({
        kind: 'open',
        socket,
        closed,
        nextMessage: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<string>((resolveMessage) => waiters.push(resolveMessage))),
      }),
    );
  });
}
