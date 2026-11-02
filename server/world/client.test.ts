import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CODE, startFakeWorld } from '../test/fake-world';
import { encodeAltchaPayload, solveAltcha } from './altcha';
import { EXPORT_MAX_BYTES, parseMe, parsePlayer, parseVisibility, WorldClient } from './client';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** Server that always responds the same way (for edge cases). */
async function rawServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  closers.push(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fake() {
  const w = await startFakeWorld();
  closers.push(w.close);
  return { w, client: new WorldClient({ baseUrl: `${w.base}/`, version: '9.9.9' }) };
}

describe('WorldClient', () => {
  it('registration with ALTCHA, verification, and /v1/me: Bearer only on account routes', async () => {
    const { w, client } = await fake();
    const ch = await client.altcha();
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const altcha = encodeAltchaPayload(ch.data, (await solveAltcha(ch.data))!);
    const reg = await client.register({ email: 'ana@exemplo.com', password: 'very-long-password', name: 'Ana Pixel', locale: 'pt-BR', tos: 'v1', altcha });
    expect(reg).toEqual({ ok: true, status: 202, data: {} });
    expect(w.requests[1].body).toMatchObject({ email: 'ana@exemplo.com', name: 'Ana Pixel', tos: 'v1' });
    const ver = await client.verify({ email: 'ana@exemplo.com', code: FAKE_CODE });
    expect(ver.ok && ver.data.access).toBe('waiting');
    if (!ver.ok) return;
    const me = await client.me(ver.data.token);
    expect(me.ok && me.data.account.emailMasked).toBe('a***@exemplo.com');
    // Registration name is reserved while there is no character.
    expect(me.ok && me.data.account.reservedName).toBe('Ana Pixel');
    expect(w.requests.map((r) => `${r.method} ${r.path} ${r.authorization ? 'auth' : '-'}`)).toEqual([
      'GET /v1/altcha -',
      'POST /v1/auth/register -',
      'POST /v1/auth/verify -',
      'GET /v1/me auth',
    ]);
    expect(w.requests[3].authorization).toBe(`Bearer ${ver.data.token}`);
    expect(w.requests.every((r) => r.userAgent === 'Habblaud/9.9.9')).toBe(true);
    // Token is never sent in URL.
    expect(w.requests.some((r) => r.path.includes(ver.data.token))).toBe(false);
  });

  it('relays world server error with same status and code (without english message)', async () => {
    const { client } = await fake();
    expect(await client.verify({ email: 'nobody@example.com', code: '000000' })).toEqual({ ok: false, status: 400, code: 'invalid_code' });
    expect(await client.login({ email: 'nobody@example.com', password: 'x' })).toEqual({ ok: false, status: 401, code: 'invalid_credentials' });
    expect(await client.me('nonexistent-token-AAAAAAAAAAAAAAAA')).toEqual({ ok: false, status: 401, code: 'unauthorized' });
  });

  it('registration with name already in use: 409 name_taken before ALTCHA; creating player with reservation goes without name', async () => {
    const { w, client } = await fake();
    const ch = await client.altcha();
    if (!ch.ok) throw new Error('altcha');
    const altcha = encodeAltchaPayload(ch.data, (await solveAltcha(ch.data))!);
    expect(await client.register({ email: 'ana@exemplo.com', password: 'very-long-password', name: 'Ana Pixel', locale: 'pt-BR', tos: 'v1', altcha })).toMatchObject({ ok: true });
    expect(await client.register({ email: 'bia@exemplo.com', password: 'very-long-password', name: 'ANA  PIXEL', locale: 'pt-BR', tos: 'v1', altcha: 'x' })).toEqual({ ok: false, status: 409, code: 'name_taken' });
    expect(await client.register({ email: 'bia@exemplo.com', password: 'very-long-password', name: 'a!', locale: 'pt-BR', tos: 'v1', altcha: 'x' })).toEqual({ ok: false, status: 422, code: 'name_invalid' });
    const ver = await client.verify({ email: 'ana@exemplo.com', code: FAKE_CODE });
    if (!ver.ok) throw new Error('verify');
    const p = await client.putPlayer(ver.data.token, { look: 'f', parts: {}, traits: ['games', 'cafeina'], intro: 'coffee' });
    expect(p.ok && p.data.name).toBe('Ana Pixel');
    expect(w.requests.find((r) => r.path === '/v1/me/player')!.body).not.toHaveProperty('name');
    const me = await client.me(ver.data.token);
    expect(me.ok && me.data.account).not.toHaveProperty('reservedName');
  });

  it('logout sends POST with empty JSON and accepts 204 without body', async () => {
    const { w, client } = await fake();
    const r = await client.logout('any-token-AAAAAAAAAAAAAAAA');
    expect(r).toEqual({ ok: false, status: 401, code: 'unauthorized' });
    expect(w.requests[0]).toMatchObject({ method: 'POST', contentType: 'application/json', body: {} });
  });

  it('Retry-After, unreadable code, and unusual statuses', async () => {
    const base = await rawServer((req, res) => {
      if (req.url === '/v1/me') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
        return res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }));
      }
      if (req.url === '/v1/auth/verify') {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        return res.end('<h1>Bad gateway</h1>');
      }
      if (req.url === '/v1/auth/login') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'Weird Code <script>' } }));
      }
      res.writeHead(302, { Location: 'https://other.example.com/' });
      res.end();
    });
    const client = new WorldClient({ baseUrl: base, version: '1' });
    expect(await client.me('t'.repeat(43))).toEqual({ ok: false, status: 429, code: 'rate_limited', retryAfter: 30 });
    expect(await client.verify({ email: 'a@b.co', code: '123456' })).toEqual({ ok: false, status: 500, code: 'world_error' });
    expect(await client.login({ email: 'a@b.co', password: 'x' })).toEqual({ ok: false, status: 400, code: 'world_error' });
    // Redirects are not followed (token never goes to another address).
    expect(await client.logout('t'.repeat(43))).toEqual({ ok: false, status: 502, code: 'world_bad_response' });
  });

  it('success response malformed, oversized, or not JSON', async () => {
    const base = await rawServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/v1/auth/verify') return res.end(JSON.stringify({ deviceId: 'd', token: 'short', access: 'waiting' }));
      if (req.url === '/v1/me') return res.end('x'.repeat(300 * 1024));
      res.end('not json');
    });
    const client = new WorldClient({ baseUrl: base, version: '1' });
    expect(await client.verify({ email: 'a@b.co', code: '123456' })).toEqual({ ok: false, status: 502, code: 'world_bad_response' });
    expect(await client.me('t'.repeat(43))).toEqual({ ok: false, status: 502, code: 'world_bad_response' });
    expect(await client.altcha()).toEqual({ ok: false, status: 502, code: 'world_bad_response' });
  });

  it('delete account and export data: POST with code, GET raw JSON (up to 8 MB, remainder rejected)', async () => {
    const big = { account: { email: 'ana@exemplo.com' }, likesGiven: Array.from({ length: 30_000 }, (_, i) => `b_${i.toString(16).padStart(8, '0')}`) };
    const body = JSON.stringify(big);
    expect(body.length).toBeGreaterThan(256 * 1024);
    const seen: Array<{ method?: string; url?: string; body: string; auth?: string }> = [];
    const base = await rawServer((req, res) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body: data, auth: req.headers.authorization });
        if (req.url === '/v1/me/export') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return void res.end(body);
        }
        if (req.url === '/v1/me/delete') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          return void res.end('{}');
        }
        res.writeHead(204);
        res.end();
      });
    });
    const client = new WorldClient({ baseUrl: base, version: '9.9.9' });
    expect(await client.requestDeletion('tok_aaaaaaaaaaaaaaaa')).toEqual({ ok: true, status: 202, data: {} });
    expect(await client.confirmDeletion('tok_aaaaaaaaaaaaaaaa', FAKE_CODE)).toEqual({ ok: true, status: 204, data: {} });
    const exp = await client.exportData('tok_aaaaaaaaaaaaaaaa');
    expect(exp).toEqual({ ok: true, status: 200, data: big });
    expect(seen.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual(['POST /v1/me/delete {}', `POST /v1/me/delete/confirm {"code":"${FAKE_CODE}"}`, 'GET /v1/me/export ']);
    expect(seen.every((r) => r.auth === 'Bearer tok_aaaaaaaaaaaaaaaa')).toBe(true);
    // An array (not an object) or exceeding max limit: malformed response.
    const odd = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(_req.url === '/v1/me/export' ? '[1,2]' : '{}');
    });
    expect(await new WorldClient({ baseUrl: odd, version: '9' }).exportData('tok_aaaaaaaaaaaaaaaa')).toEqual({ ok: false, status: 502, code: 'world_bad_response' });
    const huge = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(EXPORT_MAX_BYTES + 1) });
      res.end();
    });
    expect((await new WorldClient({ baseUrl: huge, version: '9' }).exportData('tok_aaaaaaaaaaaaaaaa')).ok).toBe(false);
  });

  it('parseVisibility: inactivity notification is optional and boolean only when present', () => {
    const v = { mode: 'live', closed: false, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false };
    expect(parseVisibility(v)).toEqual(v);
    expect('notifyInactivity' in parseVisibility(v)!).toBe(false);
    expect(parseVisibility({ ...v, notifyInactivity: false })).toEqual({ ...v, notifyInactivity: false });
    expect(parseVisibility({ ...v, notifyInactivity: 'yes' })).toBeUndefined();
    expect(parseVisibility({ ...v, notifyInactivity: null })).toBeUndefined();
    expect(parseVisibility({ ...v, extra: 1 })).toEqual(v);
  });

  it('offline and timeout', async () => {
    const base = await rawServer(() => {
      // never responds
    });
    const slow = new WorldClient({ baseUrl: base, version: '1', timeoutMs: 50 });
    expect(await slow.altcha()).toEqual({ ok: false, status: 504, code: 'world_timeout' });
    const down = new WorldClient({ baseUrl: 'http://127.0.0.1:1', version: '1' });
    expect(await down.altcha()).toEqual({ ok: false, status: 502, code: 'world_unreachable' });
  });

  it('strange device id never leaves computer', async () => {
    const { w, client } = await fake();
    expect(await client.revokeDevice('t'.repeat(43), '../../admin')).toEqual({ ok: false, status: 404, code: 'not_found' });
    expect(w.requests).toEqual([]);
  });
});

describe('field-by-field copied responses', () => {
  it('parsePlayer drops what protocol does not define', () => {
    const p = parsePlayer({
      name: 'Ana', look: 'f', parts: { skin: '#E8B48C', seed: 1 }, traits: ['games', 'xadrez'], intro: 'vim', country: 'BR',
      visibility: { mode: 'live', closed: false, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false },
      updatedAt: '2026-10-15T00:00:00Z', internalScore: 99,
    });
    expect(p).toEqual({
      name: 'Ana', look: 'f', parts: {}, traits: ['games'], intro: 'vim', country: 'BR',
      visibility: { mode: 'live', closed: false, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false },
      updatedAt: '2026-10-15T00:00:00Z',
    });
    expect(parsePlayer({ name: 'Ana' })).toBeUndefined();
  });

  it('parsePlayer: mustRename only when true (name forcibly renamed by moderation)', () => {
    const base = { name: '???', look: 'm', parts: {}, traits: ['games', 'cafeina'], intro: 'vim', updatedAt: '' };
    expect(parsePlayer({ ...base, mustRename: true })?.mustRename).toBe(true);
    expect(parsePlayer({ ...base, mustRename: 'yes' })).not.toHaveProperty('mustRename');
    expect(parsePlayer(base)).not.toHaveProperty('mustRename');
  });

  it('parseMe requires account with known access', () => {
    expect(parseMe({ account: { emailMasked: 'a***@b.co', access: 'banned' }, devices: [] })).toBeUndefined();
    expect(parseMe({ account: { emailMasked: 'a***@b.co', access: 'approved', locale: 'xx' }, devices: [{ id: 'd1', current: true }, { id: '../x' }] })).toEqual({
      account: { emailMasked: 'a***@b.co', access: 'approved', locale: 'en', createdAt: '' },
      devices: [{ id: 'd1', label: '', createdAt: '', lastSeenAt: '', current: true }],
    });
  });

  it('parseMe: reservedName only when short text (null, absent, or unexpected types excluded)', () => {
    const base = { account: { emailMasked: 'a***@b.co', access: 'waiting', locale: 'en', createdAt: '' }, devices: [] };
    expect(parseMe({ ...base, account: { ...base.account, reservedName: 'Ana Pixel' } })?.account.reservedName).toBe('Ana Pixel');
    expect(parseMe({ ...base, account: { ...base.account, reservedName: null } })?.account).not.toHaveProperty('reservedName');
    expect(parseMe(base)?.account).not.toHaveProperty('reservedName');
    expect(parseMe({ ...base, account: { ...base.account, reservedName: 7 } })?.account).not.toHaveProperty('reservedName');
    expect(parseMe({ ...base, account: { ...base.account, reservedName: 'x'.repeat(65) } })?.account).not.toHaveProperty('reservedName');
  });
});
