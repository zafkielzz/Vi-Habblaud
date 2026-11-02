// Owner's lightweight social features on local server (server/world/social.ts): likes today, knocks, "while you
// were away" summary (with grace period for seen summary), /v1/me, session switching, unblocking, and local routes
// over the building connection against fake world server.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientMessage, MeResponse } from '../../shared/world/protocol';
import { VISIBILITY_DEFAULTS } from '../../shared/world/protocol';
import { worldSocketUrl } from '../config';
import { setQuiet } from '../log';
import { startFakeWorld } from '../test/fake-world';
import { tempDir } from '../test/fixtures';
import { parseMe, parseVisibility, WorldClient } from './client';
import { createWorldRoutes } from './http';
import { WorldService } from './service';
import { WorldSettingsStore } from './settings';
import { OwnerSocial, parseBlocked, parseMeBuilding, SUMMARY_SEEN_GRACE_MS, summaryWithin, UNBLOCK_GRACE_MS } from './social';
import { BuildingUplink } from './uplink';

setQuiet(true);

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const SUMMARY = { since: '2026-10-14', visits: 5, likes: 12, stamps: [{ stampId: 'star' as const, count: 2 }] };

function unit(o: { connected?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const session = { key: 'dev_1' as string | undefined };
  const sent: ClientMessage[] = [];
  const link = { connected: o.connected ?? true, sendCity: (m: ClientMessage) => (link.connected ? (sent.push(m), true) : false) };
  const changes = { n: 0 };
  const social = new OwnerSocial({ session: () => session.key, now: () => clock.t, onChange: () => changes.n++ });
  social.attach(link);
  return { social, sent, link, clock, session, changes };
}

const me = (extra: Partial<MeResponse> = {}): MeResponse => ({
  account: { emailMasked: 'a***@x.com', access: 'approved', locale: 'pt-BR', createdAt: '' },
  devices: [],
  ...extra,
});

const building = (extra: Record<string, unknown> = {}) =>
  parseMeBuilding({ state: 'online', paused: false, lot: { district: 'centro', x: 3, y: 1 }, floors: 4, agents: { total: 3, working: 1, waiting: 1, idle: 1 }, likes: 40, firstOnlineMonth: '2026-10', ...extra })!;

describe('OwnerSocial: what arrives through building connection', () => {
  it('likes today and knocks go to meta (numbers only); repeated does not republish', () => {
    const { social, changes } = unit();
    social.message({ t: 'likes.today', count: 3 });
    social.message({ t: 'likes.today', count: 3 });
    social.message({ t: 'likes.today', count: -1 });
    expect(changes.n).toBe(1);
    social.message({ t: 'knock' });
    social.message({ t: 'knock', fromName: 'someone' });
    expect(social.meta()).toEqual({ likesToday: 3, knocks: 2 });
    expect(JSON.stringify(social.meta())).not.toContain('someone');
    social.message({ t: 'other' });
    expect(changes.n).toBe(3);
  });

  it('summary with updates: meta only indicates presence; status carries counts; without updates, nothing', () => {
    const { social } = unit();
    social.message({ t: 'away.summary', since: '2026-10-14', visits: 0, likes: 0, stamps: [] });
    expect(social.meta()).toEqual({});
    social.message({ t: 'away.summary', ...SUMMARY });
    expect(social.meta()).toEqual({ awaySummary: true });
    expect(social.status()).toEqual({ summary: SUMMARY });
  });

  it('seen while connected: summary.seen sent immediately, summary disappears and leftover does not return (returns on new updates)', () => {
    const { social, sent, clock } = unit();
    social.message({ t: 'away.summary', ...SUMMARY });
    expect(social.summarySeen()).toEqual({ ok: true });
    expect(sent).toEqual([{ t: 'summary.seen' }]);
    expect(social.status().summary).toBeUndefined();
    // world read before summary.seen: same summary arrives again
    social.message({ t: 'away.summary', ...SUMMARY });
    expect(social.status().summary).toBeUndefined();
    // one more like since then: new update
    social.message({ t: 'away.summary', ...SUMMARY, likes: 13 });
    expect(social.status().summary?.likes).toBe(13);
    social.summarySeen();
    // after grace period, identical summary is genuine (owner dismissed today and receives again)
    clock.t += SUMMARY_SEEN_GRACE_MS + 1;
    social.message({ t: 'away.summary', ...SUMMARY });
    expect(social.status().summary).toEqual(SUMMARY);
  });

  it('seen without connection: summary disappears locally immediately and summary.seen is sent when connection opens', () => {
    const { social, sent, link } = unit({ connected: false });
    social.message({ t: 'away.summary', ...SUMMARY });
    expect(social.summarySeen()).toEqual({ ok: true });
    expect(sent).toEqual([]);
    expect(social.meta()).toEqual({});
    link.connected = true;
    // world sends summary on connect before knowing it was seen: does not return
    social.message({ t: 'away.summary', ...SUMMARY });
    social.opened();
    expect(sent).toEqual([{ t: 'summary.seen' }]);
    expect(social.meta()).toEqual({});
    social.opened();
    expect(sent).toHaveLength(1);
  });

  it('/v1/me: likes today, code, summary and blocked list; a /v1/me from before "seen" does not bring summary back', () => {
    const { social, clock } = unit();
    social.fromMe(me({ building: building({ likesToday: 7, code: 'HB-4F2K', summary: SUMMARY }), blocked: [{ id: 'p_2', name: 'Bia' }] }), clock.t);
    expect(social.status()).toEqual({ likesToday: 7, code: 'HB-4F2K', summary: SUMMARY });
    expect(social.blocked()).toEqual([{ id: 'p_2', name: 'Bia' }]);
    const before = clock.t;
    clock.t += 50;
    social.summarySeen();
    social.fromMe(me({ building: building({ likesToday: 7, summary: SUMMARY }) }), before);
    expect(social.status().summary).toBeUndefined();
    // without summary in /v1/me: nothing to display
    clock.t += SUMMARY_SEEN_GRACE_MS + 1;
    social.fromMe(me({ building: building({ likesToday: 8 }) }), clock.t);
    expect(social.status()).toEqual({ likesToday: 8, code: 'HB-4F2K' });
  });

  it('another session (another account on this computer) starts from scratch; without session, nothing', () => {
    const { social, session } = unit();
    social.message({ t: 'likes.today', count: 3 });
    social.message({ t: 'knock' });
    session.key = 'dev_2';
    expect(social.meta()).toEqual({});
    session.key = undefined;
    social.message({ t: 'likes.today', count: 9 });
    expect(social.meta()).toEqual({});
    expect(social.summarySeen()).toMatchObject({ ok: false, status: 401 });
  });

  it('unblock: without connection, 409; with connection, unblock is sent and player disappears from list even in stale /v1/me', () => {
    const { social, sent, link, clock } = unit({ connected: false });
    social.fromMe(me({ blocked: [{ id: 'p_2', name: 'Bia' }, { id: 'p_3', name: 'Caio' }] }), clock.t);
    expect(social.unblock('p_2')).toEqual({ ok: false, status: 409, code: 'not_connected' });
    link.connected = true;
    const before = clock.t;
    clock.t += 10;
    expect(social.unblock('p_2')).toEqual({ ok: true });
    expect(sent).toEqual([{ t: 'unblock', playerId: 'p_2' }]);
    expect(social.blocked()).toEqual([{ id: 'p_3', name: 'Caio' }]);
    social.fromMe(me({ blocked: [{ id: 'p_2', name: 'Bia' }, { id: 'p_3', name: 'Caio' }] }), before);
    expect(social.blocked()?.map((p) => p.id)).toEqual(['p_3']);
    // blocked again later (via scene), new /v1/me brings player back
    clock.t += UNBLOCK_GRACE_MS + 10;
    social.fromMe(me({ blocked: [{ id: 'p_2', name: 'Bia' }, { id: 'p_3', name: 'Caio' }] }), clock.t);
    expect(social.blocked()?.map((p) => p.id)).toEqual(['p_2', 'p_3']);
  });
});

describe('reading /v1/me and visibility', () => {
  it('parseMeBuilding: only protocol fields; malformed code and crooked summary are excluded', () => {
    const b = building({ likesToday: 3, code: 'HB-4F2K', summary: SUMMARY, tokens: { day: 2, week: 9 }, secret: 'x' });
    expect(b).toMatchObject({ state: 'online', likesToday: 3, code: 'HB-4F2K', summary: SUMMARY });
    expect(b).not.toHaveProperty('tokens');
    expect(b).not.toHaveProperty('secret');
    expect(building({ code: 'HB-0O1I' })).not.toHaveProperty('code');
    expect(building({ summary: { since: 'x' } })).not.toHaveProperty('summary');
    expect(parseMeBuilding({ state: 'flying', lot: { district: 'centro', x: 0, y: 0 } })).toBeUndefined();
    expect(parseMeBuilding({ state: 'online' })).toBeUndefined();
  });

  it('parseBlocked and parseMe: list of {id, name}, without duplicates or extra fields', () => {
    expect(parseBlocked([{ id: 'p_1', name: 'Ana', email: 'x' }, { id: 'p_1', name: 'Ana' }, { id: '', name: 'x' }, { id: 'p_2' }, 7])).toEqual([{ id: 'p_1', name: 'Ana' }]);
    expect(parseBlocked('x')).toBeUndefined();
    const m = parseMe({ account: { emailMasked: 'a***@x.com', access: 'approved' }, devices: [], blocked: [{ id: 'p_1', name: 'Ana' }], building: { state: 'away', paused: true, lot: { district: 'centro', x: 1, y: 0 }, likesToday: 2 } });
    expect(m?.blocked).toEqual([{ id: 'p_1', name: 'Ana' }]);
    expect(m?.building).toMatchObject({ state: 'away', paused: true, likesToday: 2 });
  });

  it('parseVisibility: optional knocks (missing does not change), boolean only', () => {
    const base = { ...VISIBILITY_DEFAULTS };
    delete (base as { knocks?: boolean }).knocks;
    expect(parseVisibility(base)).not.toHaveProperty('knocks');
    expect(parseVisibility({ ...base, knocks: true })).toMatchObject({ knocks: true });
    expect(parseVisibility({ ...base, knocks: 'yes' })).toBeUndefined();
  });

  it('summaryWithin: nothing beyond what was already present (same day, no count higher)', () => {
    expect(summaryWithin(SUMMARY, SUMMARY)).toBe(true);
    expect(summaryWithin({ ...SUMMARY, visits: 4 }, SUMMARY)).toBe(true);
    expect(summaryWithin({ ...SUMMARY, since: '2026-10-15' }, SUMMARY)).toBe(false);
    expect(summaryWithin({ ...SUMMARY, stamps: [{ stampId: 'heart', count: 1 }] }, { ...SUMMARY, stamps: [{ stampId: 'star', count: 5 }] })).toBe(false);
  });
});

describe('over building connection and local routes', () => {
  async function approved() {
    const world = await startFakeWorld();
    closers.push(world.close);
    const tmp = tempDir();
    closers.push(tmp.cleanup);
    const token = randomBytes(32).toString('base64url');
    const player = { name: 'Ana Pixel', look: 'f' as const, parts: {}, traits: ['games' as const, 'cafeina' as const], intro: 'coffee' as const, visibility: { ...VISIBILITY_DEFAULTS }, updatedAt: 'x' };
    world.accounts.set('ana@exemplo.com', {
      email: 'ana@exemplo.com', password: 'x', verified: true, access: 'approved', code: '123456', player, locale: 'pt-BR',
      meExtra: { building: { state: 'online', paused: false, lot: { district: 'centro', x: 3, y: 1 }, floors: 1, agents: { total: 1, working: 1, waiting: 0, idle: 0 }, likes: 4, firstOnlineMonth: '2026-10', code: 'HB-4F2K', likesToday: 1, summary: SUMMARY }, blocked: [{ id: 'p_9', name: 'Zeca' }] },
    });
    world.devices.set(token, { email: 'ana@exemplo.com', deviceId: 'dev_1' });
    const store = new WorldSettingsStore(join(tmp.dir, 'world.json'));
    store.save({ deviceId: 'dev_1', token, email: 'ana@exemplo.com', access: 'approved', player });
    const changes = { n: 0 };
    const social = new OwnerSocial({ session: () => store.get()?.deviceId, onChange: () => changes.n++ });
    const service = new WorldService({ config: { enabled: true, dev: true, url: world.base }, terminal: true, store, client: new WorldClient({ baseUrl: world.base, version: '9.9.9' }), social });
    closers.push(() => service.stop());
    const uplink = new BuildingUplink({
      url: worldSocketUrl(world.base),
      version: '9.9.9',
      build: () => ({ commit: 'unknown', dirty: false }),
      locale: () => 'pt-BR',
      store,
      canAct: () => true,
      agents: () => [],
      lastFile: join(tmp.dir, 'last.json'),
      timing: { debounceMs: 20, minGapMs: 60, pingMs: 5_000, backoffMinMs: 20, backoffMaxMs: 60, closeWaitMs: 300 },
    });
    service.attachUplink(uplink);
    social.attach(uplink);
    uplink.attachOwner(social);
    uplink.start();
    closers.push(() => uplink.stop());
    const routes = createWorldRoutes(service, undefined, social);
    const server = http.createServer((req, res) => routes(req, res, new URL(req.url ?? '/', 'http://x')));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    closers.push(() => new Promise<void>((ok) => server.close(() => ok())));
    closers.push(() => server.closeAllConnections());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const until = Date.now() + 3_000;
    while (!uplink.connected) {
      if (Date.now() > until) throw new Error('no connection');
      await new Promise((ok) => setTimeout(ok, 5));
    }
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { world, service, social, uplink, base, post, changes, conn: () => world.ws.open[0]! };
  }

  const wait = async (cond: () => boolean) => {
    const until = Date.now() + 3_000;
    while (!cond()) {
      if (Date.now() > until) throw new Error('waiting');
      await new Promise((ok) => setTimeout(ok, 5));
    }
  };

  it('likes today, knocks and summary arrive with closed scene and go to meta and status (with /v1/me)', async () => {
    const { service, conn } = await approved();
    conn().send({ t: 'likes.today', count: 3 });
    conn().send({ t: 'knock' });
    conn().send({ t: 'away.summary', ...SUMMARY });
    await wait(() => service.meta().building?.knocks === 1 && !!service.meta().building?.awaySummary);
    expect(service.meta().building).toMatchObject({ likesToday: 3, knocks: 1, awaySummary: true });
    expect(JSON.stringify(service.meta())).not.toContain('2026-10-14');
    const st = await service.status(true);
    expect(st.building).toMatchObject({ likesToday: 1, knocks: 1, code: 'HB-4F2K', summary: SUMMARY });
    expect(st.blocked).toEqual([{ id: 'p_9', name: 'Zeca' }]);
  });

  it('POST /api/world/summary/seen and /api/world/unblock: sent over connection; malformed body, 400', async () => {
    const { post, conn, social } = await approved();
    conn().send({ t: 'away.summary', ...SUMMARY });
    await wait(() => !!social.meta().awaySummary);
    expect((await post('/api/world/summary/seen', {})).status).toBe(204);
    await wait(() => conn().messages.some((m) => m.t === 'summary.seen'));
    expect(social.meta().awaySummary).toBeUndefined();
    const bad = await post('/api/world/unblock', { playerId: '' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid');
    expect((await post('/api/world/unblock', { playerId: 'p_9', extra: 1 })).status).toBe(204);
    await wait(() => conn().messages.some((m) => m.t === 'unblock'));
    expect(conn().messages.find((m) => m.t === 'unblock')).toEqual({ t: 'unblock', playerId: 'p_9' });
  });

  it('without connection (paused, closed scene): unblock responds 409 not_connected', async () => {
    const { post, service, uplink } = await approved();
    await service.pause();
    await wait(() => !uplink.connected);
    const r = await post('/api/world/unblock', { playerId: 'p_9' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('not_connected');
    expect((await post('/api/world/summary/seen', {})).status).toBe(204);
  });
});
