// World scene viewer (viewer.ts) with fake connection and in-memory responses: `view` only with open stream and
// `view.off` with last stream closed, snapshot on connect and upon restart, resync on rev jump (without passing along
// patch), new connection and disconnect, command limits and filtering.
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { WorldSceneSnapshot } from '../../shared/world/api';
import type { ClientMessage } from '../../shared/world/protocol';
import { WorldViewer, type CityLink } from './viewer';
import { sampleBuildingDetail } from '../../shared/world/visit-sample';

const WELCOME = {
  t: 'welcome',
  me: { id: 'acc_me', name: 'Ana Pixel', look: 'f', parts: {}, traits: ['games', 'cafeina'], intro: 'coffee' },
  city: { districts: ['centro'] },
};

class FakeLink implements CityLink {
  connected = false;
  sent: ClientMessage[] = [];
  /** What the scene wanted on each `cityChanged` notification (paused connections open or close based on this). */
  changes: boolean[] = [];
  viewer?: WorldViewer;
  cityChanged(): void {
    this.changes.push(!!this.viewer?.wantsCity);
  }
  sendCity(msg: ClientMessage): boolean {
    if (!this.connected) return false;
    this.sent.push(msg);
    return true;
  }
  types(): string[] {
    return this.sent.map((m) => m.t);
  }
}

interface FakeStream {
  req: IncomingMessage;
  res: ServerResponse;
  chunks: string[];
  status?: number;
  /** SSE events received ({event, data}). */
  events(): Array<{ event: string; data: any }>;
  snapshots(): WorldSceneSnapshot[];
  world(): any[];
  close(): void;
}

function fakeStream(): FakeStream {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { socket: unknown }).socket = { setTimeout() {}, setNoDelay() {} };
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  const s: FakeStream = {
    req,
    chunks,
    res: Object.assign(emitter, {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      writeHead(status: number) {
        s.status = status;
        return this;
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end() {
        (this as { writableEnded: boolean }).writableEnded = true;
      },
      destroy() {
        (this as { destroyed: boolean }).destroyed = true;
      },
    }) as unknown as ServerResponse,
    events: () =>
      chunks
        .filter((c) => c.startsWith('event: '))
        .map((c) => {
          const [ev, data] = c.split('\n');
          return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
        }),
    snapshots: () => s.events().filter((e) => e.event === 'world.snapshot').map((e) => e.data),
    world: () => s.events().filter((e) => e.event === 'world').map((e) => e.data),
    close: () => {
      (s.res as unknown as { destroyed: boolean }).destroyed = true;
      (req as unknown as EventEmitter).emit('close');
    },
  };
  return s;
}

function setup(opts: { connected?: boolean } = {}) {
  const clock = { t: 1_000 };
  const link = new FakeLink();
  let n = 0;
  const viewer = new WorldViewer({ now: () => clock.t, streamId: () => `s${++n}`, pingMs: 60_000 });
  viewer.attach(link);
  link.viewer = viewer;
  if (opts.connected ?? true) {
    link.connected = true;
    viewer.opened(WELCOME);
  }
  const open = () => {
    const st = fakeStream();
    const r = viewer.open(st.req, st.res);
    return { st, r };
  };
  return { clock, link, viewer, open };
}

describe('WorldViewer: city only with scene open', () => {
  it('without stream, no view; first stream sends view and snapshot; last closed sends view.off', () => {
    const { link, viewer, open } = setup();
    expect(link.sent).toEqual([]);
    const a = open();
    expect(a.r).toEqual({ ok: true, data: { stream: 's1' } });
    expect(a.st.status).toBe(200);
    expect(a.st.chunks[0]).toBe('retry: 2000\n\n');
    expect(link.types()).toEqual(['view']);
    const snap = a.st.snapshots();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ stream: 's1', connected: true, viewing: true, district: 'centro', me: { id: 'acc_me', name: 'Ana Pixel' }, chunks: [], players: [], afk: false, minimap: null });
    const b = open();
    expect(link.types()).toEqual(['view']);
    expect(b.st.snapshots()[0]).toMatchObject({ stream: 's2', viewing: true });
    a.st.close();
    expect(link.types()).toEqual(['view']);
    b.st.close();
    expect(link.types()).toEqual(['view', 'view.off']);
    expect(viewer.size).toBe(0);
    expect(viewer.isViewing).toBe(false);
  });

  it('notifies connection when beginning to want city and when stopping (when paused, opens and closes with scene), after view.off', async () => {
    const { link, viewer, open } = setup({ connected: false });
    const a = open();
    expect(viewer.wantsCity).toBe(true);
    await Promise.resolve();
    expect(link.changes).toEqual([true]);
    const b = open();
    await Promise.resolve();
    expect(link.changes).toEqual([true]);
    // connection opened because of scene: `view` on each welcome
    link.connected = true;
    viewer.opened(WELCOME);
    expect(link.types()).toEqual(['view']);
    a.st.close();
    b.st.close();
    expect(link.types()).toEqual(['view', 'view.off']);
    expect(link.changes).toEqual([true]);
    await Promise.resolve();
    expect(link.changes).toEqual([true, false]);
  });

  it('maximum 4 streams', () => {
    const { open } = setup();
    for (let i = 0; i < 4; i++) expect(open().r.ok).toBe(true);
    expect(open().r).toEqual({ ok: false, status: 429, code: 'too_many_streams' });
  });

  it('without connection: stream opens with connected false; welcome sends view and new snapshot; disconnect forgets city', () => {
    const { link, viewer, open } = setup({ connected: false });
    const a = open();
    expect(a.st.snapshots()).toEqual([expect.objectContaining({ connected: false, viewing: false })]);
    expect(link.sent).toEqual([]);
    link.connected = true;
    viewer.opened(WELCOME);
    expect(link.types()).toEqual(['view']);
    viewer.message({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    viewer.message({ t: 'pos', x: 21, y: 15 });
    expect(a.st.world().map((m) => m.t)).toEqual(['area', 'pos']);
    link.connected = false;
    viewer.closed();
    expect(a.st.snapshots().at(-1)).toMatchObject({ connected: false, viewing: false, chunks: [] });
    expect(a.st.snapshots().at(-1)).not.toHaveProperty('pos');
    // Reconnected: view again, city from scratch.
    link.connected = true;
    viewer.opened(WELCOME);
    expect(link.types()).toEqual(['view', 'view']);
    expect(a.st.snapshots().at(-1)).toMatchObject({ connected: true, viewing: true, chunks: [] });
  });
});

describe('WorldViewer: city messages', () => {
  it('relays as received; rev jump requests resync and does not relay patch; non-scene messages stay', () => {
    const { link, viewer, open } = setup();
    const a = open();
    const area = { t: 'area', chunk: 'centro:0,0', rev: 4, buildings: [{ id: 'b1', likes: 0, lot: { district: 'centro', x: 3, y: 0 } }] };
    viewer.message(area);
    viewer.message({ t: 'area.patch', chunk: 'centro:0,0', rev: 5, changes: [{ id: 'b1', likes: 2 }] });
    viewer.message({ t: 'area.patch', chunk: 'centro:0,0', rev: 7, changes: [{ id: 'b1', likes: 9 }] });
    viewer.message({ t: 'uplink.ack', at: 1, bytes: 2 });
    viewer.message({ t: 'player.join', player: { id: 'p1', name: 'Zeca', pos: { x: 1, y: 1, dir: 's', moving: false } } });
    expect(a.st.world()).toEqual([area, { t: 'area.patch', chunk: 'centro:0,0', rev: 5, changes: [{ id: 'b1', likes: 2 }] }, { t: 'player.join', player: { id: 'p1', name: 'Zeca', pos: { x: 1, y: 1, dir: 's', moving: false } } }]);
    expect(link.sent).toEqual([{ t: 'view' }, { t: 'resync', chunk: 'centro:0,0' }]);
    // A new stream receives everything in the snapshot.
    const b = open();
    expect(b.st.snapshots()[0]).toMatchObject({ chunks: [{ chunk: 'centro:0,0', rev: 5, buildings: [{ id: 'b1', likes: 2 }] }], players: [{ id: 'p1' }] });
    expect(viewer.current().chunks[0]?.rev).toBe(5);
  });

  it('without open scene, only notices pass through', () => {
    const { viewer, open } = setup();
    const a = open();
    a.st.close();
    const b = open();
    b.st.close();
    viewer.message({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    expect(viewer.current().chunks).toEqual([]);
  });

  it('with closed scene, likes today and owner summary stay for scene opening later (knock does not)', () => {
    const { viewer, open } = setup();
    const summary = { since: '2026-10-15', visits: 1, likes: 1, stamps: [{ stampId: 'coffee', count: 1 }] };
    viewer.message({ t: 'likes.today', count: 1 });
    viewer.message({ t: 'away.summary', ...summary });
    viewer.message({ t: 'knock' });
    const a = open();
    expect(a.st.snapshots()[0]).toMatchObject({ likesToday: 1, summary });
    expect(a.st.world()).toEqual([]);
  });
});

describe('WorldViewer: visit (Phase 4)', () => {
  const detail = () => sampleBuildingDetail();
  const ID = 'o_7a8b9c0d1e2f';

  it('relays building, building.patch and visitors; jump in building rev requests resync {building} and does not relay', () => {
    const { link, viewer, open } = setup();
    const a = open();
    viewer.command({ stream: 's1', cmds: [{ t: 'enter', buildingId: ID, extra: 'x' }] });
    expect(link.sent.at(-1)).toEqual({ t: 'enter', buildingId: ID });
    viewer.message({ t: 'building', rev: 3, detail: detail() });
    viewer.message({ t: 'building.patch', rev: 4, visitors: 2 });
    viewer.message({ t: 'building.patch', rev: 6, visitors: 5 });
    viewer.message({ t: 'visitors', count: 1 });
    expect(a.st.world().map((m) => `${m.t}${m.rev ?? ''}`)).toEqual(['building3', 'building.patch4', 'visitors']);
    expect(link.sent.at(-1)).toEqual({ t: 'resync', building: ID });
    expect(viewer.current().inside).toMatchObject({ id: ID, rev: 4, detail: { visitors: 2 } });
    // A new stream during visit receives interior in snapshot.
    const b = open();
    expect(b.st.snapshots()[0]?.inside).toMatchObject({ id: ID, rev: 4 });
    // Browser requests building again: id only, field by field.
    expect(viewer.command({ stream: 's1', cmds: [{ t: 'resync', building: ID, token: 'x' }] })).toEqual({ ok: true, data: { sent: 1 } });
    expect(link.sent.at(-1)).toEqual({ t: 'resync', building: ID });
  });

  it('inside, pos is return to street; leave uploads as received; closing last stream sends view.off (and forgets interior)', () => {
    const { link, viewer, open } = setup();
    const a = open();
    viewer.message({ t: 'building', rev: 1, detail: detail() });
    viewer.command({ stream: 's1', cmds: [{ t: 'leave' }] });
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });
    viewer.message({ t: 'pos', x: 40, y: 13 });
    expect(viewer.current().inside).toBeUndefined();
    expect(a.st.world().at(-1)).toEqual({ t: 'pos', x: 40, y: 13 });
    viewer.message({ t: 'building', rev: 1, detail: detail() });
    a.st.close();
    expect(link.types().at(-1)).toBe('view.off');
    expect(viewer.current().inside).toBeUndefined();
  });
});

describe('WorldViewer: commands', () => {
  it('only scene commands, rebuilt; per batch only last move; move enters my position', () => {
    const { link, viewer, open } = setup();
    const { st } = open();
    const r = viewer.command({
      stream: 's1',
      cmds: [
        { t: 'move', x: 22, y: 15, dir: 'e', moving: true },
        { t: 'profile', playerId: 'p1', extra: 'x' },
        { t: 'move', x: 23, y: 15, dir: 'e', moving: true },
      ],
    });
    expect(r).toEqual({ ok: true, data: { sent: 2 } });
    expect(link.sent.slice(1)).toEqual([{ t: 'profile', playerId: 'p1' }, { t: 'move', x: 23, y: 15, dir: 'e', moving: true }]);
    expect(viewer.current().pos).toEqual({ x: 23, y: 15, dir: 'e', moving: true });
    for (const bad of [{ t: 'hello', v: 1, token: 'x' }, { t: 'uplink', uplink: {} }, { t: 'ping' }]) {
      expect(viewer.command({ stream: 's1', cmds: [{ t: 'view' }, bad] }), bad.t).toEqual({ ok: false, status: 400, code: 'invalid' });
    }
    expect(link.sent).toHaveLength(3);
    expect(viewer.command({ stream: 's1', cmds: [] })).toMatchObject({ status: 400 });
    expect(viewer.command({ stream: 's1', cmds: Array(21).fill({ t: 'view' }) })).toMatchObject({ status: 400 });
    expect(viewer.command({ cmds: [{ t: 'view' }] })).toMatchObject({ status: 400 });
    expect(viewer.command({ stream: 'other', cmds: [{ t: 'view' }] })).toEqual({ ok: false, status: 409, code: 'no_stream' });
    expect(st.status).toBe(200);
  });

  it('up to 5 batches per second per stream: one batch every 200 ms is never rejected; burst exceeds limit', () => {
    const { clock, viewer, open } = setup();
    open();
    open();
    const move = (x: number) => ({ stream: 's1', cmds: [{ t: 'move', x, y: 15, dir: 'e', moving: true }] });
    for (let i = 0; i < 50; i++) {
      clock.t += 200;
      expect(viewer.command(move(21 + i * 0.1)).ok, `batch ${i}`).toBe(true);
    }
    // Paused for 1 s, bucket fills: 5 at once pass, sixth does not.
    clock.t += 1_000;
    for (let i = 0; i < 5; i++) expect(viewer.command(move(30)).ok).toBe(true);
    expect(viewer.command(move(30))).toEqual({ ok: false, status: 429, code: 'rate_limited', retryAfter: 1 });
    // The other stream has its own bucket.
    expect(viewer.command({ ...move(30), stream: 's2' }).ok).toBe(true);
    clock.t += 200;
    expect(viewer.command(move(30)).ok).toBe(true);
  });

  it('without connection: 409 not_connected', () => {
    const { link, viewer, open } = setup();
    open();
    link.connected = false;
    viewer.closed();
    expect(viewer.command({ stream: 's1', cmds: [{ t: 'move', x: 1, y: 1, dir: 'n', moving: false }] })).toEqual({ ok: false, status: 409, code: 'not_connected' });
  });

  it('view.off from one stream: with none wanting, view.off; view returns; view with open city restarts (new snapshot)', () => {
    const { link, viewer, open } = setup();
    const { st } = open();
    viewer.message({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    expect(viewer.command({ stream: 's1', cmds: [{ t: 'view.off' }] })).toEqual({ ok: true, data: { sent: 1 } });
    expect(link.types()).toEqual(['view', 'view.off']);
    expect(st.snapshots().at(-1)).toMatchObject({ viewing: false, chunks: [] });
    expect(viewer.command({ stream: 's1', cmds: [{ t: 'view' }] })).toEqual({ ok: true, data: { sent: 1 } });
    expect(link.types()).toEqual(['view', 'view.off', 'view']);
    viewer.message({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    const before = st.snapshots().length;
    expect(viewer.command({ stream: 's1', cmds: [{ t: 'view' }] }).ok).toBe(true);
    expect(link.types()).toEqual(['view', 'view.off', 'view', 'view']);
    expect(st.snapshots()).toHaveLength(before + 1);
    expect(st.snapshots().at(-1)).toMatchObject({ viewing: true, chunks: [] });
  });

  it('slow client (buffer above limit) is disconnected and, without streams, view.off is sent', () => {
    const { link, viewer, open } = setup();
    const { st } = open();
    (st.res as unknown as { writableLength: number }).writableLength = 2 * 1024 * 1024;
    viewer.message({ t: 'pos', x: 21, y: 15 });
    expect((st.res as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(viewer.size).toBe(0);
    expect(link.types()).toEqual(['view', 'view.off']);
  });
});
