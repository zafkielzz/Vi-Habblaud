// Local Habblaud World routes (/api/world/*) with fake world server (server/test/fake-world.ts):
// gates, validation, and full end-to-end flow (registration → verification → waiting list → login →
// character → logout), verifying that device token never leaves world.json.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountsService } from '../accounts/service';
import { DEFAULT_WORLD_URL, parseWorldConfig, worldSocketUrl, type WorldConfig } from '../config';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { FAKE_CODE, startFakeWorld, type FakeWorld } from '../test/fake-world';
import { tempDir } from '../test/fixtures';
import { WorldClient } from './client';
import { createWorldRoutes } from './http';
import { WorldService } from './service';
import { WorldSettingsStore } from './settings';
import { BuildingUplink } from './uplink';
import { WorldViewer } from './viewer';

setQuiet(true);

const EMAIL = 'ana@exemplo.com';
const PASSWORD = 'uma senha bem comprida';
const NAME = 'Ana Pixel';
/** Registration: player name is required (reserved on waiting list). */
const REGISTER = { email: EMAIL, password: PASSWORD, name: NAME };
const CHARACTER = {
  name: 'Ana Pixel',
  look: 'f',
  parts: { skin: '#e8b48c', hairStyle: 'bob' },
  traits: ['games', 'cafeina'],
  intro: 'coffee',
};

interface Harness {
  base: string;
  hub: Hub;
  office: Office;
  uplink?: BuildingUplink;
  viewer?: WorldViewer;
  lastFile: string;
  service?: WorldService;
  store: WorldSettingsStore;
  file: string;
  world?: FakeWorld;
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  setQuiet(true);
  vi.restoreAllMocks();
});

/** Local Habblaud port (guard + API), with world configured as in server/index.ts. */
async function start(opts: { world?: 'off' | 'no-url' | 'on'; terminal?: boolean; meTtlMs?: number; uplink?: boolean } = {}): Promise<Harness> {
  const mode = opts.world ?? 'on';
  const tmp = tempDir();
  closers.push(tmp.cleanup);
  const fake = mode === 'on' ? await startFakeWorld() : undefined;
  if (fake) closers.push(fake.close);
  const config: WorldConfig = { enabled: mode !== 'off', dev: true, ...(fake ? { url: fake.base } : {}) };
  const file = join(tmp.dir, 'data', 'world.json');
  const store = new WorldSettingsStore(file);
  const terminal = opts.terminal ?? true;
  const late: { office?: Office } = {};
  const service = config.enabled
    ? new WorldService({
        config,
        terminal,
        store,
        client: fake ? new WorldClient({ baseUrl: fake.base, version: '9.9.9' }) : undefined,
        onChange: () => late.office?.markDirty(),
        meTtlMs: opts.meTtlMs,
      })
    : undefined;
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
    terminal,
    world: () => service?.meta() ?? { enabled: false, configured: false, state: 'off' },
  });
  late.office = office;
  const hub = new Hub(office, { throttleMs: 0 });
  hub.start();
  closers.push(() => hub.stop());
  // The building, as in server/index.ts (with short timeouts).
  const lastFile = join(tmp.dir, 'data', 'world-last-uplink.json');
  const uplink =
    opts.uplink && service && fake
      ? new BuildingUplink({
          url: worldSocketUrl(fake.base),
          version: '9.9.9',
          build: () => ({ commit: 'unknown', dirty: false }),
          locale: () => 'pt-BR',
          store,
          canAct: () => terminal,
          agents: () => office.list(),
          subscribe: (cb) => office.onChange(cb),
          lastFile,
          onGoodbye: (r) => service.goodbye(r),
          onLeft: () => service.leftElsewhere(),
          onChange: () => office.markDirty(),
          timing: { debounceMs: 20, minGapMs: 60, pingMs: 5_000, backoffMinMs: 20, backoffMaxMs: 60, closeWaitMs: 500 },
        })
      : undefined;
  if (uplink && service) {
    service.attachUplink(uplink);
    uplink.start();
    closers.push(() => uplink.stop());
  }
  // The World scene, as in server/index.ts (with uplink only).
  const viewer = uplink ? new WorldViewer() : undefined;
  if (uplink && viewer) {
    viewer.attach(uplink);
    uplink.attachCity(viewer);
    closers.push(() => viewer.stop());
  }
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: false,
    terminal,
    world: service ? createWorldRoutes(service, viewer) : undefined,
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['meu-mac.local']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  closers.push(() => new Promise<void>((ok) => server.close(() => ok())));
  closers.push(() => server.closeAllConnections());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hub, office, uplink, viewer, lastFile, service, store, file, world: fake };
}

/** All local responses from test, to verify token never leaks. */
const seen: string[] = [];

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; raw: string; headers: http.IncomingHttpHeaders }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((ok, fail) => {
    const req = http.request(
      new URL(path, base),
      { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          seen.push(raw);
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }
          ok({ status: res.statusCode ?? 0, body: parsed, raw, headers: res.headers });
        });
      },
    );
    req.on('error', fail);
    req.end(data);
  });
}

describe('HABBLAUD_WORLD and HABBLAUD_WORLD_URL', () => {
  it('HABBLAUD_WORLD=0: 404 on all routes and meta.world off', async () => {
    const s = await start({ world: 'off' });
    for (const [m, p] of [['GET', '/api/world/status'], ['POST', '/api/world/login'], ['PUT', '/api/world/character'], ['GET', '/api/world']]) {
      expect((await call(s.base, m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(404);
    }
    expect(s.hub.current().meta.world).toEqual({ enabled: false, configured: false, state: 'off' });
    expect((await call(s.base, 'GET', '/api/access')).body.world).toBe(false);
  });

  it('without URL (rejected HABBLAUD_WORLD_URL): disabled feature (meta.world without enabled), status off and rest 409 not_configured', async () => {
    const s = await start({ world: 'no-url' });
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: false, state: 'off' });
    const r = await call(s.base, 'POST', '/api/world/register', REGISTER);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_configured');
    expect((await call(s.base, 'PUT', '/api/world/character', CHARACTER)).body.error.code).toBe('not_configured');
    expect((await call(s.base, 'GET', '/api/world/devices')).status).toBe(409);
    expect(s.hub.current().meta.world).toEqual({ enabled: false, configured: false, state: 'off' });
  });

  it('parseWorldConfig: https/wss only; http://127.0.0.1 in development mode; origin only', () => {
    const p = (url: string | undefined, extra: NodeJS.ProcessEnv = {}, argv: string[] = []) =>
      parseWorldConfig({ HABBLAUD_WORLD_URL: url, ...extra }, argv);
    // Without HABBLAUD_WORLD_URL (or empty), default world server; when set, value applies (rejected does not fallback to default).
    expect(p(undefined)).toEqual({ enabled: true, dev: false, url: DEFAULT_WORLD_URL, defaultUrl: true });
    expect(p('  ')).toEqual({ enabled: true, dev: false, url: DEFAULT_WORLD_URL, defaultUrl: true });
    expect(DEFAULT_WORLD_URL).toBe('https://server.habblaud.com');
    expect(p('https://server.habblaud.com')).toEqual({ enabled: true, dev: false, url: 'https://server.habblaud.com' });
    expect(p('https://outro.exemplo.com')).toEqual({ enabled: true, dev: false, url: 'https://outro.exemplo.com' });
    expect(p('wss://server.habblaud.com/').url).toBe('https://server.habblaud.com');
    expect(p('https://server.habblaud.com:8443').url).toBe('https://server.habblaud.com:8443');
    expect(p('http://server.habblaud.com').warning).toMatch(/https/);
    expect(p('http://127.0.0.1:4848').url).toBeUndefined();
    expect(p('http://127.0.0.1:4848').warning).toMatch(/development/);
    expect(p('http://127.0.0.1:4848', {}, ['--dev']).url).toBe('http://127.0.0.1:4848');
    expect(p('ws://127.0.0.1:4848', { HABBLAUD_WORLD_DEV: '1' }).url).toBe('http://127.0.0.1:4848');
    expect(p('http://localhost:4848', {}, ['--dev']).url).toBeUndefined();
    expect(p('http://10.0.0.5:4848', {}, ['--dev']).url).toBeUndefined();
    // World server on host, seen from inside Habblaud container (docker-compose.yml: extra_hosts).
    expect(p('http://host.docker.internal:4848', { HABBLAUD_WORLD_DEV: '1' }).url).toBe('http://host.docker.internal:4848');
    expect(p('ws://host.docker.internal:4848', {}, ['--dev']).url).toBe('http://host.docker.internal:4848');
    expect(p('http://host.docker.internal:4848').url).toBeUndefined();
    expect(p('http://host.docker.internal:4848').warning).toMatch(/host\.docker\.internal.*development/);
    expect(p('http://x.host.docker.internal:4848', {}, ['--dev']).url).toBeUndefined();
    expect(p('http://host.docker.internal.evil.com:4848', {}, ['--dev']).url).toBeUndefined();
    expect(p('https://host.docker.internal:4848').url).toBe('https://host.docker.internal:4848');
    for (const bad of ['https://user:pw@server.habblaud.com', 'https://server.habblaud.com/v1', 'https://server.habblaud.com/?x=1', 'https://x/#a', 'nada']) {
      expect(p(bad).url, bad).toBeUndefined();
      expect(p(bad).warning, bad).toBeTruthy();
      // Warning does not repeat URL (may contain password).
      expect(p(bad).warning).not.toContain('pw@');
    }
    expect(p('https://server.habblaud.com', { HABBLAUD_WORLD: '0' })).toEqual({ enabled: false, dev: false });
    expect(p(undefined, { HABBLAUD_WORLD: 'off' })).toEqual({ enabled: false, dev: false });
    expect(worldSocketUrl('https://server.habblaud.com')).toBe('wss://server.habblaud.com/v1/socket');
    expect(worldSocketUrl('http://127.0.0.1:4848')).toBe('ws://127.0.0.1:4848/v1/socket');
    expect(worldSocketUrl('http://host.docker.internal:4848')).toBe('ws://host.docker.internal:4848/v1/socket');
  });
});

describe('docker-compose.yml', () => {
  it('forwards all Habblaud World variables read by server to container', () => {
    const compose = readFileSync(join(import.meta.dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    const config = readFileSync(join(import.meta.dirname, '..', 'config.ts'), 'utf8');
    const read = [...new Set([...config.matchAll(/env\.(HABBLAUD_WORLD[A-Z_]*)/g)].map((m) => m[1]))].sort();
    expect(read).toEqual(['HABBLAUD_WORLD', 'HABBLAUD_WORLD_DEV', 'HABBLAUD_WORLD_URL']);
    for (const key of read) expect(compose, key).toMatch(new RegExp(`^\\s+${key}: \\$\\{${key}:-\\}$`, 'm'));
  });

  it('container finds host at host.docker.internal (local world server, also on Linux)', () => {
    const compose = readFileSync(join(import.meta.dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/^ {4}extra_hosts:\n {6}- "host\.docker\.internal:host-gateway"$/m);
  });
});

describe('guards', () => {
  it('non-local Host: 403 local_only (network IP or HABBLAUD_ALLOWED_HOSTS name)', async () => {
    const s = await start();
    for (const host of ['192.168.0.10:4747', 'meu-mac.local:4747']) {
      const r = await call(s.base, 'GET', '/api/world/status', undefined, { Host: host });
      expect(r.status, host).toBe(403);
      expect(r.body.error.code).toBe('local_only');
    }
    expect((await call(s.base, 'GET', '/api/world/status', undefined, { Host: 'localhost:4747' })).status).toBe(200);
    expect((await call(s.base, 'GET', '/api/access', undefined, { Host: '192.168.0.10:4747' })).body.world).toBe(false);
    expect((await call(s.base, 'GET', '/api/access')).body.world).toBe(true);
  });

  it('terminal lock disabled: status indicates unavailable and actions receive 403 terminal_off', async () => {
    const s = await start({ terminal: false });
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: false, configured: true, state: 'logged_out', lastError: 'terminal_off' });
    const r = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('terminal_off');
    expect(s.world!.requests).toEqual([]);
    expect((await call(s.base, 'GET', '/api/access')).body.world).toBe(false);
  });

  it('CSRF: non-JSON body and other origins are blocked before route', async () => {
    const s = await start();
    const form = await call(s.base, 'POST', '/api/world/logout', undefined, { 'Content-Type': 'text/plain' });
    expect(form.status).toBe(415);
    const other = await call(s.base, 'POST', '/api/world/logout', {}, { Origin: 'https://site-malvado.com' });
    expect(other.status).toBe(403);
  });

  it('unknown route 404 and wrong method 405', async () => {
    const s = await start();
    expect((await call(s.base, 'GET', '/api/world/nada')).body.error.code).toBe('not_found');
    const r = await call(s.base, 'GET', '/api/world/login');
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
    expect((await call(s.base, 'POST', '/api/world/status', {})).status).toBe(405);
  });
});

describe('validation before reaching world server', () => {
  it('email, password, code, locale and character', async () => {
    const s = await start();
    const code = async (m: string, p: string, b: unknown) => {
      const r = await call(s.base, m, p, b);
      return `${r.status} ${r.body?.error?.code}`;
    };
    expect(await code('POST', '/api/world/register', { email: 'sem-arroba', password: PASSWORD, name: NAME })).toBe('400 invalid_email');
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: 'curta', name: NAME })).toBe('400 password_invalid');
    // Player name is required and checked before password, same as on world server.
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: 'curta' })).toBe('422 name_invalid');
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: PASSWORD, name: 'Admin' })).toBe('422 name_blocked');
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: PASSWORD, name: 'a!' })).toBe('422 name_invalid');
    expect(await code('POST', '/api/world/register', { ...REGISTER, locale: 'de' })).toBe('400 invalid');
    expect(await code('POST', '/api/world/register', { ...REGISTER, invite: '../x' })).toBe('400 invalid');
    expect(await code('POST', '/api/world/verify', { email: EMAIL, code: 'abc' })).toBe('400 invalid_code');
    expect(await code('POST', '/api/world/login', { email: EMAIL })).toBe('400 password_invalid');
    expect(await code('POST', '/api/world/register', [1, 2])).toBe('400 invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, name: 'Admin' })).toBe('422 name_blocked');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, name: 'A​na' })).toBe('422 name_invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, traits: ['timidez', 'piadas'] })).toBe('422 invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, intro: 'emacs' })).toBe('422 invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, parts: { skin: 'red' } })).toBe('422 invalid');
    expect(await code('PUT', '/api/world/visibility', { mode: 'live' })).toBe('422 invalid');
    // Valid, but not logged in.
    expect(await code('PUT', '/api/world/character', CHARACTER)).toBe('401 not_logged_in');
    expect(await code('GET', '/api/world/devices', undefined)).toBe('401 not_logged_in');
    // None of these reached world server.
    expect(s.world!.requests).toEqual([]);
  });
});

describe('end-to-end with fake world server', () => {
  it('registration → verification → waiting list → login → character → logout, without token leaving world.json', async () => {
    setQuiet(false);
    const logs: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    seen.length = 0;
    const s = await start({ meTtlMs: 60_000 });
    const w = s.world!;
    const snapshots: string[] = [];
    const snap = () => {
      const cur = s.hub.current();
      snapshots.push(JSON.stringify(cur));
      return cur.meta.world;
    };
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: true, state: 'logged_out' });

    // Registration: local server fetches and solves ALTCHA automatically, sending tos and locale.
    const reg = await call(s.base, 'POST', '/api/world/register', { ...REGISTER, name: '  Ana   Pixel ', locale: 'es', invite: 'convite_1' });
    expect(reg.status).toBe(202);
    expect(reg.body).toEqual({});
    const sent = w.requests.find((r) => r.path === '/v1/auth/register')!;
    expect(sent.body).toMatchObject({ email: EMAIL, password: PASSWORD, name: NAME, locale: 'es', tos: 'v1', invite: 'convite_1' });
    expect(w.accounts.get(EMAIL)?.verified).toBe(false);
    // Name already reserved by another account: 409 name_taken, with same status and code from world server.
    const taken = await call(s.base, 'POST', '/api/world/register', { ...REGISTER, email: 'bia@exemplo.com', name: 'ana pixel' });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: { code: 'name_taken' } });

    // Wrong code: world server error returns with same status and code.
    const wrong = await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: { code: 'invalid_code' } });

    // Verification: logs in, writes world.json (600) and stays on waiting list.
    const ver = await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: `${FAKE_CODE.slice(0, 3)} ${FAKE_CODE.slice(3)}` });
    expect(ver.status).toBe(200);
    expect(ver.body).toMatchObject({ available: true, configured: true, state: 'waiting', account: { emailMasked: 'a***@exemplo.com', access: 'waiting' } });
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    const first = JSON.parse(readFileSync(s.file, 'utf8'));
    expect(first).toMatchObject({ deviceId: 'dev_1', email: EMAIL, access: 'waiting' });
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'waiting' });

    const waiting = await call(s.base, 'GET', '/api/world/status');
    expect(waiting.body.state).toBe('waiting');
    expect(waiting.body.player).toBeUndefined();
    // Registration name, reserved while there is no character.
    expect(waiting.body.account).toEqual({ emailMasked: 'a***@exemplo.com', access: 'waiting', reservedName: NAME });
    expect(waiting.body.devices).toEqual([{ id: 'dev_1', label: 'Dispositivo 1', createdAt: expect.any(String), lastSeenAt: expect.any(String), current: true }]);

    // Logging in again rotates device and revokes previous one on world server.
    const login = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.state).toBe('waiting');
    const second = JSON.parse(readFileSync(s.file, 'utf8'));
    expect(second.deviceId).toBe('dev_2');
    expect(second.token).not.toBe(first.token);
    expect(w.devices.has(first.token)).toBe(false);
    expect(w.devices.has(second.token)).toBe(true);

    // Character (already on waiting list): name is reservation from registration, and request is sent without `name` (a name in body
    // does not leave here); extra fields sent by server are excluded.
    const { name: _unused, ...noName } = CHARACTER;
    const ch = await call(s.base, 'PUT', '/api/world/character', { ...noName, name: 'Outro Nome' });
    expect(ch.status).toBe(200);
    expect(ch.body).toEqual({ ...CHARACTER, visibility: expect.any(Object), updatedAt: '2026-10-15T12:00:00Z', country: 'BR' });
    expect(w.requests.filter((r) => r.path === '/v1/me/player').map((r) => 'name' in (r.body ?? {}))).toEqual([false]);
    expect(JSON.parse(readFileSync(s.file, 'utf8')).player.name).toBe('Ana Pixel');

    const vis = { mode: 'discreet', closed: true, hideCountry: true, tokensVisible: false, leaderboard: false, compactions: false };
    expect((await call(s.base, 'PUT', '/api/world/visibility', vis)).body).toEqual(vis);
    const st = await call(s.base, 'GET', '/api/world/status');
    expect(st.body.player).toMatchObject({ name: 'Ana Pixel', visibility: vis });
    expect(st.body.account).not.toHaveProperty('reservedName');
    // Editing: trimmed name when provided, kept when absent.
    const ed = await call(s.base, 'PUT', '/api/world/character', { ...CHARACTER, name: '  Ana   Nova ' });
    expect(ed.body.name).toBe('Ana Nova');
    expect((await call(s.base, 'PUT', '/api/world/character', noName)).body.name).toBe('Ana Nova');
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect((await call(s.base, 'GET', '/api/world/devices')).body.devices.map((d: { id: string }) => d.id)).toEqual(['dev_2']);

    // Released by batch: next read (refresh) changes state and snapshot.
    w.accounts.get(EMAIL)!.access = 'approved';
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.state).toBe('approved');
    // With character created, World scene becomes available (no uplink in this test, no `building`).
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'approved', scene: { available: true } });

    // Logout: revokes on server and deletes world.json.
    const out = await call(s.base, 'POST', '/api/world/logout', {});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ available: true, configured: true, state: 'logged_out' });
    expect(existsSync(s.file)).toBe(false);
    expect(w.devices.size).toBe(0);
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'logged_out' });

    // Bearer token only sent on account routes, never in URL, and token never appeared on this side.
    for (const r of w.requests) {
      const needs = r.path.startsWith('/v1/me') || r.path === '/v1/auth/logout';
      expect(!!r.authorization, `${r.method} ${r.path}`).toBe(needs);
      expect(r.path).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    }
    for (const token of [first.token, second.token]) {
      for (const text of [...seen, ...snapshots, ...logs]) expect(text).not.toContain(token);
    }
  });

  it('old account without reservation: creating character requires name (and sends it in request)', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    delete s.world!.accounts.get(EMAIL)!.reservedName;
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.account).not.toHaveProperty('reservedName');
    const { name: _unused, ...noName } = CHARACTER;
    const missing = await call(s.base, 'PUT', '/api/world/character', noName);
    expect(`${missing.status} ${missing.body.error.code}`).toBe('422 name_invalid');
    expect(s.world!.requests.some((r) => r.path === '/v1/me/player')).toBe(false);
    const ch = await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect(ch.status).toBe(200);
    expect(s.world!.requests.find((r) => r.path === '/v1/me/player')!.body).toMatchObject({ name: NAME });
  });

  it('401 from world server (token revoked elsewhere): deletes local session', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    s.world!.devices.clear();
    const r = await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
    expect(existsSync(s.file)).toBe(false);
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'session_expired' });
    expect(s.hub.current().meta.world?.state).toBe('logged_out');
  });

  it('world server down: status with known data and lastError; logout deletes locally anyway', async () => {
    const s = await start({ meTtlMs: 0 });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    await s.world!.close();
    const st = await call(s.base, 'GET', '/api/world/status?refresh=1');
    expect(st.body).toMatchObject({ state: 'waiting', account: { access: 'waiting' }, player: { name: 'Ana Pixel' }, lastError: 'network' });
    const out = await call(s.base, 'POST', '/api/world/logout', {});
    expect(out.body).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'network' });
    expect(existsSync(s.file)).toBe(false);
  });

  it('login requesting ALTCHA: solves and retries; unverified email returns 403', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    const unverified = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe('email_not_verified');
    s.world!.accounts.get(EMAIL)!.verified = true;
    s.world!.options.loginNeedsAltcha = true;
    const r = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(200);
    const logins = s.world!.requests.filter((q) => q.path === '/v1/auth/login');
    expect(logins.map((q) => typeof q.body?.altcha)).toEqual(['undefined', 'undefined', 'string']);
  });

  it('resend code and forgot password solve ALTCHA; password reset for this account logs out here', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    expect((await call(s.base, 'POST', '/api/world/resend', { email: EMAIL })).status).toBe(202);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    expect((await call(s.base, 'POST', '/api/world/password/forgot', { email: EMAIL })).status).toBe(202);
    const reset = await call(s.base, 'POST', '/api/world/password/reset', { email: EMAIL, code: FAKE_CODE, password: 'outra senha bem comprida' });
    expect(reset.status).toBe(204);
    expect(reset.raw).toBe('');
    expect(existsSync(s.file)).toBe(false);
    expect((await call(s.base, 'GET', '/api/world/status')).body.state).toBe('logged_out');
  });

  it('revoking current device logs out here; revoking another only updates list', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    // Another computer on same account.
    await new WorldClient({ baseUrl: s.world!.base, version: '1' }).login({ email: EMAIL, password: PASSWORD });
    const ids = (await call(s.base, 'GET', '/api/world/devices')).body.devices.map((d: { id: string }) => d.id);
    expect(ids).toEqual(['dev_1', 'dev_2']);
    expect((await call(s.base, 'POST', '/api/world/devices/dev_2/revoke', {})).status).toBe(204);
    expect((await call(s.base, 'GET', '/api/world/status')).body.devices.map((d: { id: string }) => d.id)).toEqual(['dev_1']);
    expect((await call(s.base, 'POST', '/api/world/devices/nao-existe/revoke', {})).body.error.code).toBe('not_found');
    expect((await call(s.base, 'POST', '/api/world/devices/dev_1/revoke', {})).status).toBe(204);
    expect(existsSync(s.file)).toBe(false);
    expect((await call(s.base, 'GET', '/api/world/status')).body.state).toBe('logged_out');
  });

  it('two tabs logging in simultaneously: one operation at a time (second login revokes first)', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    s.world!.options.delayMs = 20;
    const [a, b] = await Promise.all([
      call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD }),
      call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Only device from last login remains valid.
    expect(s.world!.devices.size).toBe(1);
    expect([...s.world!.devices.keys()][0]).toBe(s.store.get()?.token);
  });

  it('Habblaud restart: session restored from world.json', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    const again = new WorldSettingsStore(s.file);
    expect(again.load()).toMatchObject({ deviceId: 'dev_1', email: EMAIL, access: 'waiting' });
  });
});

async function waitFor(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`waiting: ${what}`);
    await new Promise((ok) => setTimeout(ok, 5));
  }
}

describe('building in world (uplink) via routes', () => {
  it('approved with character: building connects; status, snapshot, last dispatch, theme, pause and resume', async () => {
    seen.length = 0;
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:4242', account: '.claude', sessionId: 'sess-x', cwd: '/Users/ana/projeto-secreto', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    // On waitlist, with or without character: no building.
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toBeUndefined();
    expect(w.ws.connections).toHaveLength(0);

    // Approved: building connects on its own and sends payload.
    w.accounts.get(EMAIL)!.access = 'approved';
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.state).toBe('approved');
    await waitFor(() => w.ws.uplinks.length === 1 && !!s.uplink!.status().lastAck, 'first dispatch');
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.building).toEqual({ connected: true, paused: false, floors: 1, agents: 1, lastUplinkAt: expect.any(Number), lastAck: { ok: true } });
    expect(s.hub.current().meta.world?.building).toEqual({ connected: true, paused: false, floors: 1, agents: 1, lastUplinkAt: st.building.lastUplinkAt });

    // View what was sent: the same object that reached the server.
    const last = (await call(s.base, 'GET', '/api/world/last-uplink')).body;
    expect(last).toEqual({ at: st.building.lastUplinkAt, bytes: w.ws.uplinks[0].bytes, uplink: w.ws.uplinks[0].uplink, ack: { ok: true, at: expect.any(Number), bytes: w.ws.uplinks[0].bytes } });
    expect(JSON.stringify(last)).not.toMatch(/projeto-secreto|Users|\.claude|sess-x/);
    expect(statSync(s.lastFile).mode & 0o777).toBe(0o600);

    // Theme: saves and sends payload with new theme; outside list, 422.
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'christmas' })).body).toEqual({ theme: 'christmas' });
    await waitFor(() => w.ws.uplinks.some((u) => u.uplink.theme === 'christmas'), 'theme in payload');
    expect((await call(s.base, 'GET', '/api/world/status')).body.theme).toBe('christmas');
    expect(JSON.parse(readFileSync(s.file, 'utf8')).theme).toBe('christmas');
    const bad = await call(s.base, 'PUT', '/api/world/theme', { theme: 'pascoa' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid');

    // Pause: when response arrives, connection is already closed; world server is notified.
    const paused = await call(s.base, 'POST', '/api/world/pause', {});
    expect(paused.status).toBe(200);
    expect(w.ws.open).toHaveLength(0);
    expect(paused.body.building).toMatchObject({ connected: false, paused: true });
    expect(JSON.parse(readFileSync(s.file, 'utf8')).paused).toBe(true);
    await waitFor(() => w.requests.some((r) => r.path === '/v1/me/building/pause'), 'pause on server');
    expect(s.hub.current().meta.world?.building).toMatchObject({ connected: false, paused: true });

    // Resume: notifies server and reconnects, with full payload.
    const sent = w.ws.uplinks.length;
    const resumed = await call(s.base, 'POST', '/api/world/resume', {});
    expect(resumed.status).toBe(200);
    expect(resumed.body.building.paused).toBe(false);
    await waitFor(() => w.ws.uplinks.length === sent + 1, 'back online');
    expect(w.requests.map((r) => r.path)).toContain('/v1/me/building/resume');
    expect(w.ws.connections).toHaveLength(2);

    // Token never appears on this side.
    const token = s.store.get()!.token;
    for (const text of [...seen, JSON.stringify(s.hub.current()), readFileSync(s.lastFile, 'utf8')]) expect(text).not.toContain(token);

    // Logout: closes building and last dispatch disappears.
    await call(s.base, 'POST', '/api/world/logout', {});
    await waitFor(() => w.ws.open.length === 0, 'closed');
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).body).toEqual({});
    expect(existsSync(s.lastFile)).toBe(false);
    // Chosen theme remains.
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toEqual({ theme: 'christmas' });
  });

  it('pause and resume immediately: world server receives in order, building stays active', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:7', account: '.claude', sessionId: 'sess-7', cwd: '/p/a', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first dispatch');
    // Pause response takes time: without queue, resume would arrive first and building would stay paused there.
    w.options.pauseDelayMs = 80;
    await call(s.base, 'POST', '/api/world/pause', {});
    await call(s.base, 'POST', '/api/world/resume', {});
    await waitFor(() => w.ws.uplinks.length === 2, 'back online');
    // Wait for delayed pause to finish on server side.
    await new Promise((ok) => setTimeout(ok, 150));
    const order = w.requests.filter((r) => r.path.startsWith('/v1/me/building/')).map((r) => r.path);
    expect(order).toEqual(['/v1/me/building/pause', '/v1/me/building/resume']);
    expect(w.accounts.get(EMAIL)!.buildingPaused).toBe(false);
  });

  it('leave world: closes building before replying, server removes building and nothing reconnects; join world reconnects', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:8', account: '.claude', sessionId: 'sess-8', cwd: '/p/b', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first dispatch');

    const left = await call(s.base, 'POST', '/api/world/leave', {});
    expect(left.status).toBe(200);
    // When response arrives, connection is already closed and DELETE is already sent.
    expect(w.ws.open).toHaveLength(0);
    expect(w.accounts.get(EMAIL)!.buildingLeft).toBe(1);
    const del = w.requests.find((r) => r.method === 'DELETE');
    expect(del).toMatchObject({ path: '/v1/me/building', body: undefined });
    expect(left.body.building).toMatchObject({ connected: false, paused: true, left: true });
    expect(s.hub.current().meta.world?.building).toMatchObject({ connected: false, paused: true, left: true });
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
    // Account and character remain; building does not reconnect on its own (well beyond reconnect backoff).
    await new Promise((ok) => setTimeout(ok, 200));
    expect(w.ws.connections).toHaveLength(1);
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st).toMatchObject({ state: 'approved', player: { name: 'Ana Pixel' }, building: { left: true } });

    // Join world: join responds before reconnecting, and next payload is accepted (a new building).
    const back = await call(s.base, 'POST', '/api/world/join', {});
    expect(back.status).toBe(200);
    expect(w.requests.filter((r) => r.path === '/v1/me/building/join')).toHaveLength(1);
    expect(w.accounts.get(EMAIL)!.left).toBe(false);
    expect(back.body.building).toMatchObject({ paused: false });
    expect(back.body.building.left).toBeUndefined();
    await waitFor(() => w.ws.uplinks.length === 2, 'back in world');
    await waitFor(() => existsSync(s.lastFile) && JSON.parse(readFileSync(s.lastFile, 'utf8')).ack?.ok === true, 'payload accepted');
    expect(JSON.parse(readFileSync(s.file, 'utf8')).left).toBeUndefined();
  });

  it('join world without good response: error returns and nothing changes (remains outside world, without connection)', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first dispatch');
    expect((await call(s.base, 'POST', '/api/world/leave', {})).status).toBe(200);
    w.options.buildingFailures = 1;
    const r = await call(s.base, 'POST', '/api/world/join', {});
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('unavailable');
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
    await new Promise((ok) => setTimeout(ok, 120));
    expect(w.ws.connections).toHaveLength(1);
    // Legacy client calling /resume outside world also goes through join.
    const old = await call(s.base, 'POST', '/api/world/resume', {});
    expect(old.status).toBe(200);
    expect(w.requests.filter((q) => q.path === '/v1/me/building/join')).toHaveLength(2);
    expect(w.requests.filter((q) => q.path === '/v1/me/building/resume')).toHaveLength(0);
    await waitFor(() => w.ws.uplinks.length === 2, 'back in world');
  });

  it('join world without having left (only paused) is resume: calls /resume, not /join, and reconnects', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first dispatch');
    await call(s.base, 'POST', '/api/world/pause', {});
    expect(w.ws.open).toHaveLength(0);
    const r = await call(s.base, 'POST', '/api/world/join', {});
    expect(r.status).toBe(200);
    expect(r.body.building).toMatchObject({ paused: false });
    await waitFor(() => w.ws.uplinks.length === 2, 'back online');
    await waitFor(() => w.accounts.get(EMAIL)!.buildingPaused === false, 'resumed on server');
    expect(w.requests.filter((q) => q.path === '/v1/me/building/join')).toHaveLength(0);
    expect(w.requests.filter((q) => q.path === '/v1/me/building/resume')).toHaveLength(1);
  });

  it('left world on another computer: rejected payload with left writes left and pause, connection does not recover', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:9', account: '.claude', sessionId: 'sess-9', cwd: '/p/c', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first dispatch');
    // Another computer left the world; next office change is sent and returned rejected.
    w.accounts.get(EMAIL)!.left = true;
    s.office.addMain({ id: '.claude:10', account: '.claude', sessionId: 'sess-10', cwd: '/p/d', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await waitFor(() => w.ws.uplinks.length === 2, 'second dispatch');
    await waitFor(() => w.ws.open.length === 0, 'connection closed');
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.building).toMatchObject({ connected: false, paused: true, left: true, lastAck: { ok: false, error: 'left' } });
    expect(s.hub.current().meta.world?.building).toMatchObject({ left: true });
    await new Promise((ok) => setTimeout(ok, 150));
    expect(w.ws.connections).toHaveLength(1);
  });

  it('/v1/me with left: true (left on another computer) also marks this instance outside the world', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    w.accounts.get(EMAIL)!.left = true;
    const st = (await call(s.base, 'GET', '/api/world/status?refresh=1')).body;
    expect(st.building).toMatchObject({ paused: true, left: true });
    await waitFor(() => w.ws.open.length === 0, 'no connection');
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
  });

  it('leave world without good server response: error returns, building stays only paused and pause is notified', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first dispatch');
    w.options.buildingFailures = 1;
    const r = await call(s.base, 'POST', '/api/world/leave', {});
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('unavailable');
    expect(w.ws.open).toHaveLength(0);
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.building).toMatchObject({ connected: false, paused: true });
    expect(st.building.left).toBeUndefined();
    await waitFor(() => w.accounts.get(EMAIL)!.buildingPaused === true, 'pause on server');
    expect(w.accounts.get(EMAIL)!.buildingLeft).toBeUndefined();
  });

  it('logged out: theme saves, pause and resume require account, last dispatch empty', async () => {
    const s = await start({ uplink: true });
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'halloween' })).body).toEqual({ theme: 'halloween' });
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toEqual({ theme: 'halloween' });
    for (const path of ['/api/world/pause', '/api/world/resume', '/api/world/leave', '/api/world/join']) {
      const r = await call(s.base, 'POST', path, {});
      expect(r.status, path).toBe(401);
      expect(r.body.error.code).toBe('not_logged_in');
    }
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).body).toEqual({});
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: true, state: 'logged_out', theme: 'halloween' });
  });

  it('approved without character: no building in status or snapshot', async () => {
    const s = await start({ uplink: true });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    s.world!.accounts.get(EMAIL)!.access = 'approved';
    const st = (await call(s.base, 'GET', '/api/world/status?refresh=1')).body;
    expect(st.state).toBe('approved');
    expect(st.building).toBeUndefined();
    expect(s.hub.current().meta.world?.building).toBeUndefined();
    expect(s.world!.ws.connections).toHaveLength(0);
  });

  it('without terminal lock: theme, pause and resume are rejected; status and last dispatch respond', async () => {
    const s = await start({ uplink: true, terminal: false });
    for (const [method, path] of [['PUT', '/api/world/theme'], ['POST', '/api/world/pause'], ['POST', '/api/world/resume'], ['POST', '/api/world/leave'], ['POST', '/api/world/join']] as const) {
      const r = await call(s.base, method, path, method === 'PUT' ? { theme: 'none' } : {});
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe('terminal_off');
    }
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).status).toBe(200);
    expect((await call(s.base, 'GET', '/api/world/status')).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ World scene (Phase 3)

interface SseClient {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  events(): Array<{ event: string; data: any }>;
  close(): void;
}

/** Opens SSE and accumulates incoming data (for tests: no EventSource in Node). */
function openStream(base: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((ok, fail) => {
    const req = http.request(new URL('/api/world/stream', base), { method: 'GET', headers }, (res) => {
      const c: SseClient = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: '',
        events: () =>
          c.body
            .split('\n\n')
            .filter((b) => b.startsWith('event: '))
            .map((b) => {
              const [ev, data] = b.split('\n');
              return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
            }),
        close: () => req.destroy(),
      };
      res.setEncoding('utf8');
      res.on('data', (d: string) => (c.body += d));
      res.on('error', () => undefined);
      ok(c);
    });
    req.on('error', fail);
    req.end();
  });
}

describe('World scene via routes (stream and commands)', () => {
  async function approved() {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => s.uplink!.connected, 'connection accepted');
    return { s, w, conn: () => w.ws.open[0]! };
  }

  it('stream sends snapshot, activates city (view), forwards what comes from world, and when closed sends view.off', async () => {
    const { s, conn } = await approved();
    expect(conn().messages.filter((m) => m.t === 'view')).toHaveLength(0);
    const sse = await openStream(s.base);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    await waitFor(() => sse.events().length >= 1, 'snapshot');
    const snap = sse.events()[0];
    expect(snap.event).toBe('world.snapshot');
    expect(snap.data).toMatchObject({ connected: true, viewing: true, district: 'centro', me: { id: 'acc_1', name: 'Ana Pixel' }, chunks: [], players: [] });
    expect(typeof snap.data.stream).toBe('string');
    await waitFor(() => conn().messages.some((m) => m.t === 'view'), 'view on world server');

    conn().send({ t: 'pos', x: 21, y: 15 });
    conn().send({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    conn().send({ t: 'player.join', player: { id: 'p_2', name: 'Zeca', look: 'm', parts: {}, traits: ['games', 'cafeina'], likesReceived: 0, pos: { x: 25, y: 15, dir: 'w', moving: true }, where: 'street' } });
    conn().send({ t: 'area.patch', chunk: 'centro:0,0', rev: 3, changes: [] });
    await waitFor(() => conn().messages.some((m) => m.t === 'resync'), 'gap resync');
    expect(conn().messages.find((m) => m.t === 'resync')).toEqual({ t: 'resync', chunk: 'centro:0,0' });
    expect(sse.events().filter((e) => e.event === 'world').map((e) => e.data.t)).toEqual(['pos', 'area', 'player.join']);
    // Nothing of building (nor token) in stream.
    expect(sse.body).not.toContain(s.store.get()!.token);
    expect(sse.body).not.toContain('uplink');

    // Commands: only last move of each batch goes to world server.
    const stream = snap.data.stream;
    const r = await call(s.base, 'POST', '/api/world/cmd', {
      stream,
      cmds: [
        { t: 'move', x: 22, y: 15, dir: 'e', moving: true },
        { t: 'move', x: 23, y: 15, dir: 'e', moving: true, extra: 'not uploaded' },
        { t: 'profile', playerId: 'p_2' },
      ],
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ sent: 2 });
    await waitFor(() => conn().messages.some((m) => m.t === 'profile'), 'commands on world server');
    const city = conn().messages.filter((m) => m.t === 'move' || m.t === 'profile');
    expect(city).toEqual([{ t: 'move', x: 23, y: 15, dir: 'e', moving: true }, { t: 'profile', playerId: 'p_2' }]);
    // Anything outside the scene never passes.
    for (const bad of [{ t: 'hello', v: 1, token: 'x' }, { t: 'uplink', uplink: {} }]) {
      const b = await call(s.base, 'POST', '/api/world/cmd', { stream, cmds: [bad] });
      expect(b.status).toBe(400);
      expect(b.body.error.code).toBe('invalid');
    }
    expect((await call(s.base, 'POST', '/api/world/cmd', { stream: 'none', cmds: [{ t: 'view' }] })).body.error.code).toBe('no_stream');

    sse.close();
    await waitFor(() => conn().messages.some((m) => m.t === 'view.off'), 'view.off');
    expect(s.viewer!.size).toBe(0);
  });

  it('walking in city while paused or outside world: connection stays (or reconnects) only with scene open and without any uplink', async () => {
    const { s, w, conn } = await approved();
    await waitFor(() => w.ws.uplinks.length >= 1, 'first dispatch');
    const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
    /** What the scene may send when building is paused or outside the world. */
    const SCENE_ONLY = new Set(['hello', 'view', 'view.off', 'move', 'profile', 'ping', 'pong']);
    const sse = await openStream(s.base);
    await waitFor(() => conn().messages.some((m) => m.t === 'view'), 'view');
    const first = conn();
    const stream = sse.events()[0].data.stream;

    // Pause with scene open: connection remains, new theme (which would change payload) is not uploaded.
    expect((await call(s.base, 'POST', '/api/world/pause', {})).status).toBe(200);
    const sent = w.ws.uplinks.length;
    const fromPause = first.messages.length;
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'christmas' })).status).toBe(200);
    s.office.markDirty();
    await sleep(250);
    expect(first.open).toBe(true);
    expect(w.ws.uplinks).toHaveLength(sent);
    const move = await call(s.base, 'POST', '/api/world/cmd', { stream, cmds: [{ t: 'move', x: 22, y: 15, dir: 'e', moving: true }] });
    expect(move.status).toBe(202);
    await waitFor(() => first.messages.some((m) => m.t === 'move'), 'move paused');
    // Card and badge: paused and off (scene connection does not activate building).
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toMatchObject({ connected: false, paused: true });
    expect(s.service!.meta().scene).toEqual({ available: true });

    // Close scene: `view.off` and paused connection closes.
    sse.close();
    await waitFor(() => first.messages.some((m) => m.t === 'view.off'), 'view.off');
    await waitFor(() => !first.open, 'connection closed');
    expect(first.messages.slice(fromPause).every((m) => SCENE_ONLY.has(m.t as string))).toBe(true);

    // Scene again, still paused: new connection with `hello` and `view`, and no payload (not even from welcome).
    const sse2 = await openStream(s.base);
    await waitFor(() => w.ws.open.length === 1 && w.ws.open[0] !== first && w.ws.open[0]!.messages.some((m) => m.t === 'view'), 'view on new connection');
    const second = w.ws.open[0]!;
    await sleep(250);
    expect(w.ws.uplinks).toHaveLength(sent);
    expect(second.messages.map((m) => m.t)).toEqual(['hello', 'view']);

    // Resume with scene open: full payload sent over same connection, already with new theme.
    expect((await call(s.base, 'POST', '/api/world/resume', {})).status).toBe(200);
    await waitFor(() => w.ws.uplinks.length > sent, 'payload after resume');
    expect(w.ws.uplinks.at(-1)).toMatchObject({ conn: second.id, uplink: { theme: 'christmas' } });
    expect(second.open).toBe(true);

    // Leave world with scene open: connection remains without payload; command still goes through.
    expect((await call(s.base, 'POST', '/api/world/leave', {})).status).toBe(200);
    const atLeave = w.ws.uplinks.length;
    const fromLeave = second.messages.length;
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'halloween' })).status).toBe(200);
    await sleep(250);
    expect(w.ws.uplinks).toHaveLength(atLeave);
    expect(second.open).toBe(true);
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toMatchObject({ connected: false, paused: true, left: true });
    const stream2 = sse2.events()[0].data.stream;
    expect((await call(s.base, 'POST', '/api/world/cmd', { stream: stream2, cmds: [{ t: 'profile', playerId: 'p_2' }] })).status).toBe(202);
    await waitFor(() => second.messages.some((m) => m.t === 'profile'), 'profile outside world');
    sse2.close();
    await waitFor(() => !second.open, 'connection closed outside world');
    expect(second.messages.slice(fromLeave).every((m) => SCENE_ONLY.has(m.t as string))).toBe(true);
    expect(w.ws.open).toHaveLength(0);
  });

  it('banned or suspended: World button disappears (scene.available false) and city does not open', async () => {
    const { s, conn } = await approved();
    expect(s.service!.meta().scene).toEqual({ available: true });
    conn().send({ t: 'goodbye', reason: 'suspended' });
    await waitFor(() => !s.uplink!.connected, 'connection closed');
    expect(s.service!.meta().scene).toEqual({ available: false });
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toMatchObject({ stopped: 'suspended' });
  });

  it('stream only opens from own page: Origin from another site or Sec-Fetch-Site cross-site receive 403', async () => {
    const { s, conn } = await approved();
    const refused: Array<Record<string, string>> = [{ Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }];
    for (const headers of refused) {
      const r = await call(s.base, 'GET', '/api/world/stream', undefined, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.body.error.code).toBe('local_only');
    }
    expect(conn().messages.some((m) => m.t === 'view')).toBe(false);
    // Own page (same origin) opens.
    const port = new URL(s.base).port;
    const ok = await openStream(s.base, { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    ok.close();
  });

  it('at most 4 streams; fifth receives 429 too_many_streams', async () => {
    const { s } = await approved();
    const open: SseClient[] = [];
    for (let i = 0; i < 4; i++) open.push(await openStream(s.base));
    expect(open.map((o) => o.status)).toEqual([200, 200, 200, 200]);
    const fifth = await call(s.base, 'GET', '/api/world/stream');
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('too_many_streams');
    open.forEach((o) => o.close());
  });

  it('guards: without terminal lock, 403; without URL, 409; without account, stream opens without connection', async () => {
    const off = await start({ uplink: true, terminal: false });
    for (const [method, path] of [['GET', '/api/world/stream'], ['POST', '/api/world/cmd']] as const) {
      const r = await call(off.base, method, path, method === 'GET' ? undefined : { stream: 'x', cmds: [{ t: 'view' }] });
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe('terminal_off');
    }
    const noUrl = await start({ world: 'no-url' });
    for (const [method, path] of [['GET', '/api/world/stream'], ['POST', '/api/world/cmd']] as const) {
      const r = await call(noUrl.base, method, path, method === 'GET' ? undefined : { stream: 'x', cmds: [{ t: 'view' }] });
      expect(r.status, path).toBe(409);
      expect(r.body.error.code).toBe('not_configured');
    }
    const none = await start({ uplink: true });
    const sse = await openStream(none.base);
    await waitFor(() => sse.events().length >= 1, 'snapshot');
    expect(sse.events()[0].data).toMatchObject({ connected: false, viewing: false });
    expect(none.world!.ws.connections).toHaveLength(0);
    sse.close();
  });
});

describe('account and data (Phase 6)', () => {
  async function approved(opts: { building?: Record<string, unknown> } = {}) {
    const s = await start({ uplink: true });
    const w = s.world!;
    if (opts.building) w.ws.options.building = opts.building;
    s.office.addMain({ id: '.claude:6', account: '.claude', sessionId: 'sess-6', cwd: '/p/f6', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1 && existsSync(s.lastFile), 'first dispatch');
    return { s, w };
  }

  it('delete account: code requested, wrong code does not delete, correct closes building and deletes entire world.json before replying', async () => {
    seen.length = 0;
    const { s, w } = await approved();
    // A chosen theme: logging out would keep it in world.json; deleting deletes entire file.
    await call(s.base, 'PUT', '/api/world/theme', { theme: 'halloween' });
    const token = s.store.get()!.token;

    const asked = await call(s.base, 'POST', '/api/world/delete-account', {});
    expect(asked.status).toBe(202);
    expect(asked.body).toEqual({});
    expect(w.requests.find((r) => r.path === '/v1/me/delete')).toMatchObject({ method: 'POST', authorization: `Bearer ${token}` });

    // Invalid format, rejected here; wrong code, rejected there: nothing changes.
    expect((await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: '12' })).body.error.code).toBe('invalid_code');
    expect(w.requests.filter((r) => r.path === '/v1/me/delete/confirm')).toHaveLength(0);
    const wrong = await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('invalid_code');
    expect(s.store.get()?.token).toBe(token);
    expect(w.ws.open).toHaveLength(1);

    const done = await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: '123 456' });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'account_deleted' });
    expect(w.requests.filter((r) => r.path === '/v1/me/delete/confirm').map((r) => r.body)).toEqual([{ code: '000000' }, { code: FAKE_CODE }]);
    // When response arrives: connection is closed, world.json (including theme) and last dispatch are gone.
    expect(w.ws.open).toHaveLength(0);
    expect(existsSync(s.file)).toBe(false);
    expect(existsSync(s.lastFile)).toBe(false);
    expect(s.store.get()).toBeUndefined();
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).body).toEqual({});
    expect(s.hub.current().meta.world).toEqual({ enabled: true, configured: true, state: 'logged_out' });
    // Nothing reconnects, and status keeps reporting why.
    await new Promise((ok) => setTimeout(ok, 200));
    expect(w.ws.open).toHaveLength(0);
    expect((await call(s.base, 'GET', '/api/world/status')).body.lastError).toBe('account_deleted');
    // Without account, account routes require account.
    expect((await call(s.base, 'POST', '/api/world/delete-account', {})).body.error.code).toBe('not_logged_in');
    for (const text of seen) expect(text).not.toContain(token);
  });

  it('goodbye deleted (account deleted on another computer): session and world.json disappear here', async () => {
    const { s, w } = await approved();
    w.ws.open[0].goodbye('deleted');
    await waitFor(() => !s.store.get() && !existsSync(s.file), 'session deleted');
    await waitFor(() => !existsSync(s.lastFile), 'last dispatch deleted');
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'account_deleted' });
    await new Promise((ok) => setTimeout(ok, 150));
    expect(w.ws.connections).toHaveLength(1);
  });

  it('download my data: JSON as attachment, once per day; only from own page; HEAD does not consume quota', async () => {
    const { s, w } = await approved();
    const head = await call(s.base, 'HEAD', '/api/world/export');
    expect(head.status).toBe(200);
    const refused: Array<Record<string, string>> = [{ Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of refused) {
      const r = await call(s.base, 'GET', '/api/world/export', undefined, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.body.error.code).toBe('local_only');
    }
    expect(w.requests.filter((r) => r.path === '/v1/me/export')).toHaveLength(0);

    const r = await call(s.base, 'GET', '/api/world/export', undefined, { 'Sec-Fetch-Site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="habblaud-world-dados.json"');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ format: 'habblaud-world-export', version: 1, account: { email: EMAIL }, player: { name: 'Ana Pixel' }, likesGiven: [], blocks: [], reportsMade: [] });
    expect(w.requests.find((q) => q.path === '/v1/me/export')?.method).toBe('GET');
    // Second request in same day: 429, with retry delay.
    const again = await call(s.base, 'GET', '/api/world/export');
    expect(again.status).toBe(429);
    expect(again.body.error).toEqual({ code: 'rate_limited', retryAfter: 86400 });
    expect(again.headers['retry-after']).toBe('86400');
  });

  it('download my data and delete: without account 401, without terminal lock 403, without URL 409', async () => {
    const s = await start();
    expect((await call(s.base, 'GET', '/api/world/export')).body.error.code).toBe('not_logged_in');
    expect((await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: FAKE_CODE })).body.error.code).toBe('not_logged_in');
    const off = await start({ terminal: false });
    for (const [m, p] of [['GET', '/api/world/export'], ['POST', '/api/world/delete-account'], ['POST', '/api/world/delete-account/confirm']]) {
      const r = await call(off.base, m, p, m === 'GET' ? undefined : { code: FAKE_CODE });
      expect(r.status, p).toBe(403);
      expect(r.body.error.code).toBe('terminal_off');
    }
    const noUrl = await start({ world: 'no-url' });
    expect((await call(noUrl.base, 'GET', '/api/world/export')).body.error.code).toBe('not_configured');
    expect(s.world!.requests).toEqual([]);
    expect(off.world!.requests).toEqual([]);
  });

  it('inactivity notice: included in visibility PUT only when provided; invalid format, 422', async () => {
    const { s, w } = await approved();
    const vis = { mode: 'live', closed: false, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false };
    expect((await call(s.base, 'PUT', '/api/world/visibility', { ...vis, notifyInactivity: 'yes' })).body.error.code).toBe('invalid');
    expect((await call(s.base, 'PUT', '/api/world/visibility', vis)).status).toBe(200);
    expect('notifyInactivity' in (w.requests.at(-1)!.body ?? {})).toBe(false);
    const off = await call(s.base, 'PUT', '/api/world/visibility', { ...vis, notifyInactivity: false });
    expect(off.body).toEqual({ ...vis, notifyInactivity: false });
    expect(w.requests.at(-1)!.body).toEqual({ ...vis, notifyInactivity: false });
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.player.visibility.notifyInactivity).toBe(false);
  });

  it('maintenance: status reports it (503 maintenance), building retries with backoff and resumes when finished', async () => {
    const { s, w } = await approved();
    w.options.maintenance = true;
    w.ws.open[0].goodbye('deploy');
    const st = await call(s.base, 'GET', '/api/world/status?refresh=1');
    expect(st.body.lastError).toBe('maintenance');
    expect((await call(s.base, 'POST', '/api/world/delete-account', {})).body.error.code).toBe('maintenance');
    // Rejected on each hello, with growing delay (20, 40, 60 ms in tests): few retries, never in burst.
    await new Promise((ok) => setTimeout(ok, 400));
    const tries = w.ws.connections.length;
    expect(tries).toBeGreaterThan(2);
    expect(tries).toBeLessThan(15);
    w.options.maintenance = false;
    await waitFor(() => s.uplink!.connected, 'back online');
    await waitFor(() => w.ws.uplinks.length >= 2, 'payload again');
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.lastError).toBeUndefined();
  });

  it('unverified badge and account id: from welcome to status (never in snapshot); city updates badge', async () => {
    const { s, w } = await approved({ building: { id: 'acc_1', floors: 1, agents: { total: 1, working: 1, waiting: 0, idle: 0 }, unverified: true } });
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.account).toEqual({ emailMasked: 'a***@exemplo.com', access: 'approved', id: 'acc_1' });
    expect(st.building.unverified).toBe(true);
    expect(JSON.stringify(s.hub.current().meta.world)).not.toMatch(/unverified|acc_1/);
    // Review removed badge: city patch (entire building, with lot and without field) updates it.
    w.ws.open[0].send({ t: 'area.patch', chunk: 'centro:0,0', rev: 1, changes: [{ id: 'acc_1', lot: { district: 'centro', x: 0, y: 0 }, floors: 1 }] });
    await waitFor(() => !s.uplink!.status().unverified, 'badge removed');
    w.ws.open[0].send({ t: 'area.patch', chunk: 'centro:0,0', rev: 2, changes: [{ id: 'acc_1', unverified: true }] });
    await waitFor(() => s.uplink!.status().unverified === true, 'badge back');
    // From another building, nothing changes.
    w.ws.open[0].send({ t: 'area', chunk: 'centro:0,0', rev: 3, buildings: [{ id: 'acc_9', unverified: false }] });
    await new Promise((ok) => setTimeout(ok, 50));
    expect(s.uplink!.status().unverified).toBe(true);
  });
});
