// Visit scene without DOM: banner and panel models (model.ts), the core applying interior and patches
// (controller.ts), routes called during an entire visit (only /api/world/*), and architectural isolation (no
// office UI actions enter the visit module).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldSceneCommand, WorldSceneSnapshot } from '../../../../shared/world/api';
import type { WorldBuildingDetail } from '../../../../shared/world/protocol';
import { sampleBuildingDetail } from '../../../../shared/world/visit-sample';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { OfficeStore, type EventSourceLike } from '../../net/store';
import { HttpWorldStream } from '../../net/world-stream';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { CityState } from '../city/state';
import { Sim } from '../sim/sim';
import { VISIT_RESYNC_GAP_MS, VisitController } from './controller';
import { agentRow, findAgent, statusText, visitBanner, visitLightOf, visitPanel } from './model';

const ID = 'o_7a8b9c0d1e2f';
const inside = (detail: WorldBuildingDetail = sampleBuildingDetail(), rev = 1) => ({ id: detail.building.id, rev, detail });

describe('visit model', () => {
  it('banner: owner, floors, agents; discreet and lights-off replace agents; own building', () => {
    expect(visitBanner(sampleBuildingDetail(), false)).toEqual({ title: "Helena's building", details: ['3 floors', '6 agents'], mode: null });
    expect(visitBanner(sampleBuildingDetail('discreet'), false)).toEqual({ title: "Helena's building", details: ['3 floors', 'discreet mode'], mode: 'discreet' });
    expect(visitBanner(sampleBuildingDetail('away'), false)).toMatchObject({ details: ['3 floors', 'lights off'], mode: 'away' });
    expect(visitBanner(sampleBuildingDetail(), true).title).toBe('Your building, as others see it');
    // agent mistakenly present in discreet building does not count
    const d = sampleBuildingDetail('discreet');
    d.floors[0]!.agents = sampleBuildingDetail().floors[0]!.agents;
    expect(visitBanner(d, false).details).toEqual(['3 floors', 'discreet mode']);
  });

  it('lights: lights off, discreet, or live', () => {
    expect(visitLightOf(sampleBuildingDetail().building)).toBe('live');
    expect(visitLightOf(sampleBuildingDetail('discreet').building)).toBe('discreet');
    expect(visitLightOf(sampleBuildingDetail('away').building)).toBe('away');
  });

  it('panel: rooms with translated fictional name and agents with name, role, tool, and status (no timestamps)', () => {
    const p = visitPanel(sampleBuildingDetail());
    expect(p.empty).toBeNull();
    expect(p.rooms.map((r) => [r.name, r.agents.length])).toEqual([
      ['Project Ipê', 2],
      ['Project Jade', 2],
      ['Project Aurora', 2],
    ]);
    expect(p.rooms[0]!.agents[1]).toEqual({ id: 'world:a_2a3b4c5d', name: 'Rafael', role: 'Subagent', tool: 'Claude Code', status: 'working', statusText: 'working' });
    expect(p.rooms[1]!.agents.map((a) => [a.tool, a.statusText])).toEqual([
      ['Codex', 'waiting for the owner'],
      ['Codex', 'watching the terminal'],
    ]);
    for (const a of p.rooms.flatMap((r) => r.agents)) expect(Object.keys(a).sort()).toEqual(['id', 'name', 'role', 'status', 'statusText', 'tool']);
    expect(visitPanel(sampleBuildingDetail('discreet'))).toMatchObject({ empty: expect.stringContaining('Discreet mode') });
    expect(visitPanel(sampleBuildingDetail('away')).rooms.every((r) => r.agents.length === 0)).toBe(true);
    // status from newer server version: ignored/fallback
    expect(agentRow({ ...sampleBuildingDetail().floors[0]!.agents[0]!, status: 'sleeping' as never }).status).toBe('idle');
    expect(statusText('idle')).toBe('idle');
  });

  it('card: agent by visit office id with room; discreet, none', () => {
    expect(findAgent(sampleBuildingDetail(), 'world:a_3c4d5e6f')).toMatchObject({ name: 'Beatriz', room: 'Project Jade', tool: 'Codex' });
    expect(findAgent(sampleBuildingDetail(), 'world:does_not_exist')).toBeNull();
    expect(findAgent(sampleBuildingDetail('discreet'), 'world:a_3c4d5e6f')).toBeNull();
  });
});

function controller(detail = sampleBuildingDetail(), rev = 1) {
  const clock = { t: 1_790_000_000_000 };
  const pushed: unknown[] = [];
  const sent: WorldSceneCommand[] = [];
  const c = new VisitController(inside(detail, rev), { push: (s) => pushed.push(s), send: (cmds) => sent.push(...cmds), now: () => clock.t, version: '0.11.0' });
  return { c, clock, pushed, sent };
}

describe('VisitController', () => {
  it('publishes interior office on entry; subsequent patch applies, duplicate and old do not', () => {
    const { c, pushed } = controller();
    expect(pushed).toHaveLength(1);
    expect(c.snapshot.agents).toHaveLength(6);
    expect(c.snapshot.meta.version).toBe('0.11.0');
    const floors = sampleBuildingDetail().floors;
    floors[1]!.agents[0]!.status = 'working';
    expect(c.patch({ rev: 2, floors })).toBe('apply');
    expect(c.snapshot.agents.find((a) => a.name === 'Beatriz')?.status).toBe('working');
    expect(pushed).toHaveLength(2);
    expect(c.patch({ rev: 2, visitors: 9 })).toBe('stale');
    expect(c.patch({ rev: 1, visitors: 9 })).toBe('stale');
    expect(c.detail.visitors).toBe(1);
    // visitors only: does not change office (nothing published), but count updates
    expect(c.patch({ rev: 3, visitors: 4 })).toBe('apply');
    expect(c.detail.visitors).toBe(4);
    expect(pushed).toHaveLength(2);
  });

  it('building becomes discreet (only `building` in patch): empty rooms; lights follow building', () => {
    const { c } = controller();
    expect(c.light).toBe('live');
    expect(c.patch({ rev: 2, building: sampleBuildingDetail('discreet').building })).toBe('apply');
    expect(c.snapshot.agents).toHaveLength(0);
    expect(c.light).toBe('discreet');
    // floors arrive later, still discreet: current `building` (4th arg) hides agents
    expect(c.patch({ rev: 3, floors: sampleBuildingDetail().floors })).toBe('apply');
    expect(c.snapshot.agents).toHaveLength(0);
    expect(c.patch({ rev: 4, building: sampleBuildingDetail('away').building })).toBe('apply');
    expect(c.light).toBe('away');
  });

  it('rev gap: requests resync {building} (at most once every 5 s); full interior replaces everything like patch', () => {
    const { c, clock, sent } = controller();
    const marina = () => c.snapshot.agents.find((a) => a.name === 'Marina')!;
    const since = marina().statusSince;
    expect(c.patch({ rev: 5, visitors: 2 })).toBe('resync');
    expect(c.patch({ rev: 6, visitors: 2 })).toBe('resync');
    expect(sent).toEqual([{ t: 'resync', building: ID }]);
    clock.t += VISIT_RESYNC_GAP_MS;
    c.patch({ rev: 7, visitors: 2 });
    expect(sent).toHaveLength(2);
    clock.t += 1000;
    const d = sampleBuildingDetail();
    d.floors[1]!.agents[0]!.status = 'working';
    c.replace({ rev: 7, detail: d });
    expect(c.rev).toBe(7);
    // agents with unchanged status do not move (statusSince remains); changed status restarts
    expect(marina().statusSince).toBe(since);
    expect(c.snapshot.agents.find((a) => a.name === 'Beatriz')).toMatchObject({ status: 'working', statusSince: clock.t });
    expect(c.patch({ rev: 8, visitors: 1 })).toBe('apply');
  });

  it('leave: single leave, no move or view commands', () => {
    const { c, sent } = controller();
    expect(c.leave()).toBe(true);
    expect(c.leave()).toBe(false);
    expect(sent).toEqual([{ t: 'leave' }]);
  });
});

// ------------------------------------------------------------------------------------------------ routes

class FakeES implements EventSourceLike {
  readyState = 1;
  private readonly l = new Map<string, Array<(ev: Event) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, cb: (ev: Event) => void): void {
    if (!this.l.has(type)) this.l.set(type, []);
    this.l.get(type)!.push(cb);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(type: string, data: unknown): void {
    for (const cb of this.l.get(type) ?? []) cb({ data: JSON.stringify(data) } as unknown as Event);
  }
}

const appearance: Appearance = {
  skin: '#f0c8a0', hair: '#3a2a20', hairStyle: 'short', eyes: '#222', top: '#3f7fd8', topAccent: '#fff', topStyle: 'tshirt',
  bottom: '#333', shoes: '#111', accessory: 'none', accessoryColor: '#000', lanyard: null, look: 'm',
};
const theme: RoomTheme = { carpet: '#4f6d8f', carpet2: '#486685', wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' }, accent: '#3f7fd8', deskVariant: 'wood', chairVariant: 'black' };
const art = { appearanceFromSeed: () => appearance, roomTheme: () => theme } as unknown as ArtModule;

describe('routes during visit', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('entire visit (entry, patches, walk, leave) only communicates with /api/world/* (no terminal, messages, permissions...)', async () => {
    const urls: string[] = [];
    // any fetch outside stream (store, world, UI) is also recorded
    vi.stubGlobal('fetch', (input: unknown) => {
      urls.push(`global:${String(input)}`);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    let es: FakeES | null = null;
    const timers: Array<() => void> = [];
    const stream = new HttpWorldStream({
      eventSource: (url) => {
        urls.push(url);
        return (es = new FakeES(url));
      },
      fetch: ((input: string, init?: RequestInit) => {
        urls.push(`${init?.method ?? 'GET'} ${input} ${String(init?.body ?? '')}`);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as typeof fetch,
      setTimeout: (cb) => timers.push(cb),
      clearTimeout: () => undefined,
    });
    const flush = async () => {
      while (timers.length) {
        timers.shift()!();
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    const city = new CityState();
    const store = new OfficeStore({ search: '' });
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS }), null, { visit: true });
    let now = 1_790_000_000_000;
    store.on('snapshot', (s) => sim.applySnapshot(s, now));
    let visit: VisitController | null = null;
    stream.on((ev) => {
      if (ev.type === 'snapshot') city.applySnapshot(ev.snapshot, now);
      if (ev.type !== 'message') return;
      const eff = city.apply(ev.msg, now);
      if (eff?.type === 'building') visit = new VisitController(eff.inside, { push: (s) => store.pushReplay(s), send: (c) => stream.send(c), now: () => now, version: 't' });
      if (eff?.type === 'building.patch') visit?.patch(eff.msg);
      if (eff?.type === 'pos') visit = null;
    });
    const snap: WorldSceneSnapshot = { stream: 's1', connected: true, viewing: true, afk: false, chunks: [], players: [], minimap: null, pos: { x: 40, y: 13, dir: 's', moving: false } };
    es!.emit('world.snapshot', snap);
    stream.send([{ t: 'enter', buildingId: ID }]);
    await flush();
    es!.emit('world', { t: 'building', rev: 1, detail: sampleBuildingDetail() });
    expect(visit).not.toBeNull();
    sim.setVisitor({ ...sim.chars.values().next().value!.info, id: 'visit:me' }, now);
    for (let i = 0; i < 300; i++) {
      now += 33;
      sim.visitorIntent = { dx: i < 150 ? 1 : 0, dy: i < 150 ? 0 : 1, run: false };
      sim.update(1 / 30, now);
    }
    const floors = sampleBuildingDetail().floors;
    floors[0]!.agents[0]!.status = 'waiting';
    es!.emit('world', { t: 'building.patch', rev: 2, floors });
    es!.emit('world', { t: 'building.patch', rev: 4, visitors: 3 });
    await flush();
    visit!.leave();
    await flush();
    es!.emit('world', { t: 'pos', x: 40, y: 13 });
    expect(visit).toBeNull();
    expect(store.snapshot?.agents.find((a) => a.name === 'Marina')?.status).toBe('waiting');
    // no route outside /api/world/*, no move inside and no view
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u, u).toMatch(/^(GET |POST )?\/api\/world\/(stream|cmd)\b/);
    const sentCmds = urls.filter((u) => u.startsWith('POST')).flatMap((u) => (JSON.parse(u.slice(u.indexOf('{'))) as { cmds: WorldSceneCommand[] }).cmds);
    expect(sentCmds.map((c) => c.t)).toEqual(['enter', 'resync', 'leave']);
    expect(sentCmds[1]).toEqual({ t: 'resync', building: ID });
    stream.close();
  });
});

// ------------------------------------------------------------------------------------------------ architectural isolation

/** Joins a relative path to a folder (posix, no node:path). */
function join(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Source code of all client files (key: path from client/src; Vite provides relative to this folder). */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('../../**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).map(([k, v]) => [join('world/visit', k), v]),
);

/** Client files that a module imports recursively (by relative paths; others excluded). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const dir = file.split('/').slice(0, -1).join('/');
    for (const m of (SOURCES[file] ?? '').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
      const base = join(dir, m[1]!);
      const hit = [`${base}.ts`, `${base}/index.ts`].find((f) => f in SOURCES);
      if (hit) visit(hit);
    }
  };
  visit(entry);
  return seen;
}

describe('architectural isolation', () => {
  it('Visit scene imports nothing from office UI beyond basic DOM (no terminal, drawer, feed, permissions, messages...)', () => {
    expect(Object.keys(SOURCES)).toContain('world/visit/index.ts');
    const files = importGraph('world/visit/index.ts');
    expect(files.has('world/index.ts')).toBe(true);
    const ui = [...files].filter((f) => f.startsWith('ui/'));
    expect(ui).toEqual(['ui/dom.ts']);
    // and from network, only store (which never connects): neither World routes client (net/world.ts) nor stream
    expect([...files].filter((f) => f.startsWith('net/')).sort()).toEqual(['net/store.ts']);
  });
});
