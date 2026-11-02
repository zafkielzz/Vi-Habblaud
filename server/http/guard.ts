// HTTP server boundary protections (apply to API, static assets, and dev-mode Vite).
//
// 1) DNS rebinding: a malicious site could resolve its own domain to 127.0.0.1 and
//    thereby read /api/snapshot "as same origin". The browser sends Host header
//    with the attacker's domain, so we only accept Host that is a literal IP, `localhost`
//    (or `*.localhost`), or a name permitted in HABBLAUD_ALLOWED_HOSTS.
// 2) CSRF: state-changing requests (POST) require `Content-Type: application/json` — which a
//    form or "simple" fetch from another site cannot send without CORS preflight, which
//    this server never authorizes — and, when `Origin` is present, it must be same-origin or local.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { tr } from '../../shared/i18n';

/** Names allowed by HABBLAUD_ALLOWED_HOSTS (comma-separated list; port is ignored). */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of (raw ?? '').split(',')) {
    const name = hostnameOf(item.trim());
    if (name) out.add(name);
  }
  return out;
}

/**
 * Host name (lowercase, without port and without IPv6 brackets) from a Host header
 * or a `host[:port]`. Returns undefined if value is invalid.
 */
export function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return undefined;
    const rest = v.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return undefined;
    return v.slice(1, end);
  }
  const m = /^([a-z0-9._-]+)(?::\d{1,5})?$/.exec(v);
  return m ? m[1].replace(/\.$/, '') : undefined;
}

function isLoopbackName(name: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '::1') return true;
  return isIP(name) === 4 && name.startsWith('127.');
}

/**
 * Local Host header (`localhost`, `*.localhost`, 127.x, or `[::1]`; port ignored)? Used by terminal,
 * permissions, and messages, which only serve requests opened from the computer itself: a LAN IP or a name
 * from HABBLAUD_ALLOWED_HOSTS (proxy, tunnel) is not accepted. Missing or invalid: false.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const name = hostnameOf(host);
  return !!name && isLoopbackName(name);
}

/**
 * Host accepted? Literal IP (no DNS involved, hence no rebinding), `localhost`/`*.localhost`
 * (browsers always resolve to loopback), or a name in HABBLAUD_ALLOWED_HOSTS.
 * Without Host header (HTTP/1.0, CLI tools): accepted — browsers always send it.
 */
export function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (host === undefined) return true;
  const name = hostnameOf(host);
  if (!name) return false;
  return isIP(name) !== 0 || isLoopbackName(name) || allowed.has(name);
}

/**
 * Origin accepted for state-changing requests: missing (curl, scripts), same origin as
 * request Host, local (localhost/loopback), or a name in HABBLAUD_ALLOWED_HOSTS.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (host !== undefined && url.host.toLowerCase() === host.trim().toLowerCase()) return true;
  const name = hostnameOf(url.host);
  return !!name && (isLoopbackName(name) || allowed.has(name));
}

export function isJsonContentType(value: string | undefined): boolean {
  return !!value && /^application\/json\s*(;|$)/i.test(value.trim());
}

function reject(res: ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export interface GuardOptions {
  /** Extra names accepted in Host/Origin (HABBLAUD_ALLOWED_HOSTS). */
  allowedHosts?: ReadonlySet<string>;
}

/**
 * Returns a filter for the start of each request: responds (and returns true) when the
 * request should be rejected; otherwise returns false without touching response.
 */
export function createRequestGuard(opts: GuardOptions = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const allowed = opts.allowedHosts ?? new Set<string>();
  return (req, res) => {
    const host = req.headers.host;
    if (!hostAllowed(host, allowed)) {
      reject(
        res,
        403,
        tr('Host not allowed: {0}. Open Habblaud at http://localhost (or by IP) ', [String(host).slice(0, 100)]) +
          tr('or allow the name in HABBLAUD_ALLOWED_HOSTS.'),
      );
      return true;
    }
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originAllowed(origin, host, allowed)) {
      reject(res, 403, tr('Origin not allowed.'));
      return true;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/api/') && !isJsonContentType(req.headers['content-type'])) {
      reject(res, 415, tr('Send the body as JSON (Content-Type: application/json).'));
      return true;
    }
    return false;
  };
}
