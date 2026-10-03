import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * 本地服務訪問控制（P0-1：H-1、L-10、點選劫持）。
 *
 * 所有請求（包括 WebSocket 升級，@fastify/websocket 會先把升級請求交給 Fastify 的鉤子）依次檢查：
 * 1. Host 白名單：只接受 127.0.0.1、localhost、[::1]（可帶任意埠）——擋住 DNS rebinding；
 * 2. Origin：帶 Origin 頭時只放行同源（Origin 等於 http://<Host>），以及開發模式下 Vite 開發伺服器的埠；
 * 3. 改變狀態的請求（POST 等）必須是 application/json——跨站“簡單請求”（表單、text/plain、無 body）一律 415；
 * 4. 登入：有效的會話 Cookie（HttpOnly; SameSite=Strict）或 Authorization: Bearer <令牌>。
 *    頁面請求帶 ?token= 時換成 Cookie 並重定向去掉令牌；沒登入的頁面請求得到一張中文說明頁，API 請求得到 401。
 * 所有響應都帶 frame-ancestors 'none' 與 X-Frame-Options: DENY，防止審批介面被嵌進別的網頁點選劫持。
 */

/** 預設允許的 Host 主機名（小寫；IPv6 帶方括號）。 */
export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'] as const;

export interface AccessControlOptions {
  /** 訪問令牌。 */
  token: string;
  /** 會話 Cookie 名（按埠區分，同一台機器上的多個實例互不覆蓋）。 */
  cookieName: string;
  /** 額外允許的 Host 主機名（例如顯式配置令牌後監聽的區域網地址、ACC_ALLOWED_HOSTS）。 */
  extraHostnames?: string[];
  /** 額外放行的 Origin 埠（開發模式下 Vite 開發伺服器的埠）。 */
  devOriginPorts?: number[];
  /** Cookie 有效期（秒），預設 30 天。 */
  cookieMaxAgeSeconds?: number;
}

export interface ParsedHost {
  /** 小寫主機名；IPv6 帶方括號。 */
  hostname: string;
  port?: number;
}

/** 解析 Host 頭（或 Origin 裡的 host 部分）。格式不合法時返回 undefined。 */
export function parseHostHeader(value: string | undefined): ParsedHost | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return undefined;
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  return { hostname: match[1]!, port };
}

/** Host 頭是否在白名單內（只看主機名：埠由瀏覽器按實際訪問的地址填寫，經 Vite 代理時是 Vite 的埠）。 */
export function isAllowedHost(hostHeader: string | undefined, allowedHostnames: ReadonlySet<string>): boolean {
  const parsed = parseHostHeader(hostHeader);
  return parsed !== undefined && allowedHostnames.has(parsed.hostname);
}

/**
 * Origin 是否可以放行：
 * - 同源：Origin 恰好是 http://<Host>（Host 已經過白名單校驗）——瀏覽器從控制台頁面發出的請求（含經 Vite 代理的請求）；
 * - 開發模式：Origin 是迴環地址上的 Vite 埠。
 * 其他一律拒絕，包括 "null"（沙箱 iframe、file:// 頁面）。
 */
export function isAllowedOrigin(origin: string, hostHeader: string | undefined, devOriginPorts: readonly number[] = []): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search) return false;
  const originHost = parseHostHeader(url.host);
  const requestHost = parseHostHeader(hostHeader);
  if (!originHost || !requestHost) return false;
  const effectivePort = (host: ParsedHost) => host.port ?? 80;
  if (originHost.hostname === requestHost.hostname && effectivePort(originHost) === effectivePort(requestHost)) return true;
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(originHost.hostname) && devOriginPorts.includes(effectivePort(originHost));
}

/** 會話 Cookie 的值：由令牌派生（HMAC），Cookie 裡不直接放令牌本身。令牌不變，Cookie 就一直有效（重啟後仍然登入）。 */
export function sessionCookieValue(token: string): string {
  return createHmac('sha256', token).update('acc-session-v1').digest('base64url');
}

/** 常量時間比較，避免按響應時間逐字元猜測。 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** API 與 WebSocket 路徑：未登入時回 JSON（401），而不是說明頁。 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/api' || pathname.startsWith('/api/') || pathname === '/ws' || pathname.startsWith('/ws/');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isJsonContentType(value: string | undefined): boolean {
  return (value ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}

const LOGIN_HINT = '請用啟動時自動開啟的連結（或啟動服務的終端視窗裡印出的「訪問連結」）重新進入。';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** 未登入 / 被拒絕時給瀏覽器看的中文說明頁（不含腳本、不載入外部資源）。 */
export function explanationPage(kind: 'login' | 'invalid-token' | 'forbidden'): string {
  const title =
    kind === 'forbidden' ? '請用本機位址開啟控制台' : kind === 'invalid-token' ? '這個連結已失效或不正確' : '請用啟動時開啟的連結進入';
  const lead =
    kind === 'forbidden'
      ? '為了防止其他網頁冒充本機偷偷操作你的 AI 代理，控制台只接受 127.0.0.1 或 localhost 的位址。'
      : '為了防止其他網頁或程式偷偷操作你的 AI 代理，Agent Control Center 需要一個只有你知道的訪問連結。';
  const steps = [
    '服務啟動時（npm start）會自動用瀏覽器開啟這個連結；',
    '如果沒有自動開啟，請到啟動服務的終端視窗，複製「訪問連結」那一行的網址，貼到瀏覽器的網址列開啟；',
    '進入一次之後，這個瀏覽器會記住登入狀態，之後直接開啟控制台即可。',
  ];
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Control Center</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Microsoft JhengHei","PingFang TC",sans-serif;background:#f5f7fb;color:#182235}
main{max-width:560px;margin:12vh auto;background:#fff;border:1px solid #dfe6f1;border-radius:14px;padding:28px 32px;box-shadow:0 6px 24px rgba(24,34,53,.06)}
h1{font-size:20px;margin:0 0 12px}p,li{line-height:1.7}ol{padding-left:22px}.muted{color:#7b899c;font-size:13px}
</style></head>
<body><main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(lead)}</p>
<ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
<p class="muted">這個連結等同於登入密碼，請不要分享給別人。</p>
</main></body></html>`;
}

/** 去掉 URL 裡的 token 引數，只保留路徑和其餘引數（不會變成指向其他站點的開放重定向）。 */
function stripTokenFromUrl(rawUrl: string): string {
  const url = new URL(rawUrl, 'http://localhost');
  url.searchParams.delete('token');
  const pathname = `/${url.pathname.replace(/^\/+/, '')}`;
  const search = url.searchParams.toString();
  return `${pathname}${search ? `?${search}` : ''}`;
}

export interface AccessControl {
  /** 判斷請求是否已登入（Cookie 或 Bearer）。 */
  isAuthenticated(request: FastifyRequest): boolean;
  /** 在響應上設定登入 Cookie。 */
  setSessionCookie(reply: FastifyReply): void;
  /** 常量時間比較令牌。 */
  tokenMatches(candidate: string): boolean;
}

/**
 * 註冊訪問控制鉤子與登入端點。必須在 @fastify/websocket 註冊之後呼叫（它的 onRequest 鉤子要先標記升級請求，
 * 被拒絕的升級請求才會在響應後關閉底層連線），並且在其他業務鉤子和路由之前。
 */
export function installAccessControl(app: FastifyInstance, options: AccessControlOptions): AccessControl {
  const allowedHostnames = new Set<string>([...LOOPBACK_HOSTNAMES, ...(options.extraHostnames ?? []).map((host) => host.toLowerCase())]);
  const devOriginPorts = options.devOriginPorts ?? [];
  const expectedCookie = sessionCookieValue(options.token);
  const maxAge = options.cookieMaxAgeSeconds ?? 30 * 24 * 60 * 60;

  const tokenMatches = (candidate: string) => safeEqual(candidate, options.token);

  const isAuthenticated = (request: FastifyRequest): boolean => {
    const cookie = parseCookies(firstHeader(request.headers.cookie)).get(options.cookieName);
    if (cookie !== undefined && safeEqual(cookie, expectedCookie)) return true;
    const authorization = firstHeader(request.headers.authorization);
    const bearer = authorization && /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return Boolean(bearer && tokenMatches(bearer[1]!.trim()));
  };

  const setSessionCookie = (reply: FastifyReply) => {
    reply.header('set-cookie', `${options.cookieName}=${expectedCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
  };

  const deny = (reply: FastifyReply, api: boolean, status: 401 | 403, code: string, error: string, page: 'login' | 'invalid-token' | 'forbidden') => {
    reply.header('cache-control', 'no-store');
    if (api) return reply.code(status).send({ error, code });
    return reply.code(status).type('text/html; charset=utf-8').send(explanationPage(page));
  };

  app.addHook('onRequest', async (request, reply) => {
    // 防點選劫持：所有響應（包括下面的拒絕響應和靜態頁面）都不允許被嵌入別的頁面
    reply.header('content-security-policy', "frame-ancestors 'none'");
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    // 連結裡帶著令牌：任何情況下都不透過 Referer 洩露出去
    reply.header('referrer-policy', 'no-referrer');

    const rawUrl = request.raw.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';
    const api = isApiPath(pathname);
    const host = firstHeader(request.headers.host);

    if (!isAllowedHost(host, allowedHostnames)) {
      return deny(reply, api, 403, 'ACC_FORBIDDEN_HOST', `拒絕存取：不允許的主機名稱「${host ?? ''}」。控制台只接受 127.0.0.1 或 localhost，${LOGIN_HINT}`, 'forbidden');
    }
    const origin = firstHeader(request.headers.origin);
    if (origin !== undefined && !isAllowedOrigin(origin, host, devOriginPorts)) {
      return deny(reply, api, 403, 'ACC_FORBIDDEN_ORIGIN', `拒絕存取：不允許來自「${origin}」的請求（只接受控制台自己的頁面）。${LOGIN_HINT}`, 'forbidden');
    }
    if (!SAFE_METHODS.has(request.method) && !isJsonContentType(firstHeader(request.headers['content-type']))) {
      return reply.code(415).send({ error: '請求格式錯誤：必須是 JSON（Content-Type: application/json）。', code: 'ACC_JSON_REQUIRED' });
    }

    // 登入端點本身不要求已登入（它校驗請求體裡的令牌）
    if (request.method === 'POST' && pathname === '/api/auth/session') return;

    // 頁面請求帶 ?token=：換成 Cookie，然後重定向去掉令牌（位址列、歷史記錄裡不留令牌）
    const isPage = !api && (request.method === 'GET' || request.method === 'HEAD');
    const queryToken = isPage && rawUrl.includes('token=') ? new URL(rawUrl, 'http://localhost').searchParams.get('token') : null;
    if (queryToken !== null) {
      if (!tokenMatches(queryToken)) {
        // 已經登入的瀏覽器開啟了一箇舊連結：不必攔下，去掉引數即可
        if (!isAuthenticated(request)) return deny(reply, false, 401, 'ACC_UNAUTHORIZED', '', 'invalid-token');
      } else {
        setSessionCookie(reply);
      }
      reply.header('cache-control', 'no-store');
      return reply.redirect(stripTokenFromUrl(rawUrl), 302);
    }

    if (isAuthenticated(request)) return;
    return deny(reply, api, 401, 'ACC_UNAUTHORIZED', `需要登入：${LOGIN_HINT}`, 'login');
  });

  // 用令牌換 Cookie：開發模式下頁面由 Vite 提供，帶 ?token= 的連結由前端呼叫這個端點完成登入
  app.post('/api/auth/session', async (request, reply) => {
    const token = (request.body as { token?: unknown } | undefined)?.token;
    reply.header('cache-control', 'no-store');
    if (typeof token !== 'string' || !tokenMatches(token)) {
      return reply.code(401).send({ error: `連結無效或已過期：${LOGIN_HINT}`, code: 'ACC_UNAUTHORIZED' });
    }
    setSessionCookie(reply);
    return { ok: true };
  });

  // 登入狀態探測（前端 WebSocket 斷開後用它區分“服務沒開”和“登入失效”）
  app.get('/api/auth/status', async () => ({ ok: true }));

  return { isAuthenticated, setSessionCookie, tokenMatches };
}

/** 請求日誌裡去掉 URL 中的令牌（ACC_LOG_REQUESTS=1 時請求 URL 會寫進日誌）。 */
export function redactToken(url: string | undefined): string | undefined {
  return url?.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}
