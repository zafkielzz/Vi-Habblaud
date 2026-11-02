import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot } from '../../../shared/types';
import { mockOptionsFrom, OfficeStore, pageBuild, reconnectDelay, type EventSourceLike } from './store';

/** Mock EventSource: test triggers open/error and updates readyState. */
class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  private handlers = new Map<string, ((ev: Event) => void)[]>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  fire(type: string, data?: unknown): void {
    const ev = (data === undefined ? { type } : { type, data: JSON.stringify(data) }) as unknown as Event;
    this.handlers.get(type)?.forEach((fn) => fn(ev));
  }

  open(): void {
    this.readyState = 1;
    this.fire('open');
  }

  /** Permanent error (e.g. HTTP 502): browser gives up and closes the stream. */
  fail(): void {
    this.readyState = 2;
    this.fire('error');
  }
}

describe('mockOptionsFrom', () => {
  it('uses defaults with no query parameters', () => {
    expect(mockOptionsFrom('')).toEqual({ speed: 1, sessions: 4 });
  });

  it('accepts sessions=0 (empty office)', () => {
    expect(mockOptionsFrom('?mock=1&sessions=0').sessions).toBe(0);
  });

  it('ignores invalid values and clamps excessive ones', () => {
    expect(mockOptionsFrom('?sessions=abc&speed=-2')).toEqual({ speed: 1, sessions: 4 });
    expect(mockOptionsFrom('?sessions=&speed=')).toEqual({ speed: 1, sessions: 4 });
    expect(mockOptionsFrom('?sessions=6.7&speed=2')).toEqual({ speed: 2, sessions: 6 });
    expect(mockOptionsFrom('?sessions=999&speed=999')).toEqual({ speed: 50, sessions: 40 });
  });

  it('for screenshots: fixed seed and Codex without quota', () => {
    expect(mockOptionsFrom('?mock=1&seed=7&noquota=1')).toEqual({ speed: 1, sessions: 4, seed: 7, codexNoQuota: true });
    expect(mockOptionsFrom('?seed=-1&noquota=0')).toEqual({ speed: 1, sessions: 4 });
  });
});

describe('reconnectDelay', () => {
  it('doubles on each attempt up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe('OfficeStore: reconnection', () => {
  let sources: FakeSource[];
  let store: OfficeStore;
  const last = () => sources[sources.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    store = new OfficeStore({
      eventSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
    });
  });

  afterEach(() => {
    store.disconnect();
    vi.useRealTimers();
  });

  it('repeated connect() maintains a single stream, closed by disconnect()', () => {
    store.connect();
    store.connect();
    last().open();
    store.connect();
    store.disconnect();
    expect(sources.map((s) => s.closed)).toEqual([true]);
  });

  it('reconnects automatically with exponential backoff when browser drops stream', () => {
    const states: string[] = [];
    store.on('connection', (s) => states.push(s));
    store.connect();
    last().fail();
    expect(store.connection).toBe('closed');
    expect(sources).toHaveLength(1);

    vi.advanceTimersByTime(1_999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    expect(sources[0].closed).toBe(true);

    // Second consecutive failure: waits 4 s.
    last().fail();
    vi.advanceTimersByTime(3_999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);

    // Connected: resets wait.
    last().open();
    expect(store.connection).toBe('open');
    last().fail();
    vi.advanceTimersByTime(2_000);
    expect(sources).toHaveLength(4);
    expect(states).toEqual(['closed', 'connecting', 'closed', 'connecting', 'open', 'closed', 'connecting']);
  });

  it('transient error (browser retries) does not schedule own reconnection', () => {
    store.connect();
    last().open();
    last().readyState = 0;
    last().fire('error');
    expect(store.connection).toBe('connecting');
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });

  it('"Retry now" reconnects immediately and cancels scheduled attempt', () => {
    store.connect();
    last().fail();
    expect(store.nextRetryAt).not.toBeNull();
    store.reconnectNow();
    expect(sources).toHaveLength(2);
    expect(store.connection).toBe('connecting');
    expect(store.nextRetryAt).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(2);
  });

  it('disconnect() removes network listener and connect() restores it without accumulating', () => {
    const online = new Set<EventListener>();
    vi.stubGlobal('addEventListener', (type: string, cb: EventListener) => {
      if (type === 'online') online.add(cb);
    });
    vi.stubGlobal('removeEventListener', (type: string, cb: EventListener) => {
      if (type === 'online') online.delete(cb);
    });
    store = new OfficeStore({
      eventSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
    });
    try {
      for (let i = 0; i < 3; i++) {
        store.connect();
        expect(online.size).toBe(1);
        last().fail();
        online.forEach((cb) => cb(new Event('online')));
        expect(sources).toHaveLength((i + 1) * 2);
        expect(store.nextRetryAt).toBeNull();
        store.disconnect();
        expect(online.size).toBe(0);
        vi.advanceTimersByTime(60_000);
        expect(sources).toHaveLength((i + 1) * 2);
      }
    } finally {
      store.disconnect();
      vi.unstubAllGlobals();
    }
  });

  it('disconnect() does not reconnect and events from old stream are ignored', () => {
    store.connect();
    const old = last();
    store.disconnect();
    old.fail();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
    expect(store.connection).toBe('connecting');
  });

  it('applies snapshot, feed, and notices; invalid JSON is ignored', () => {
    const notices: unknown[] = [];
    store.on('notice', (n) => notices.push(n));
    store.connect();
    last().open();
    const snap = { rev: 1, serverTime: 0, rooms: [], agents: [], accounts: [], meta: { demo: false, sources: [], startedAt: 1, version: 't' } };
    last().fire('snapshot', snap);
    expect(store.snapshot?.rev).toBe(1);
    last().fire('feed', [{ id: 'f1', agentId: 'a', roomId: 'r', agentName: 'Ana', roomName: 'x', activity: { id: 'x', at: 0, kind: 'tool', icon: '·', text: 't' } }]);
    expect(store.feed).toHaveLength(1);
    last().fire('notice', { id: 'n', level: 'info', text: 'hi', at: 0 });
    expect(notices).toHaveLength(1);
    expect(() => last().fire('snapshot', undefined)).not.toThrow();
    const bad = { type: 'snapshot', data: '{broken' } as unknown as Event;
    expect(() => (last() as unknown as { handlers: Map<string, ((e: Event) => void)[]> }).handlers.get('snapshot')![0](bad)).not.toThrow();
    expect(store.snapshot?.rev).toBe(1);
  });
});

const snap = (rev: number, build?: string): OfficeSnapshot => ({
  rev,
  serverTime: 0,
  rooms: [],
  agents: [],
  accounts: [],
  meta: { demo: false, sources: [], startedAt: 1, version: '0.1.0', build },
});

describe('new version detection', () => {
  it('reads build from bundle URL and ignores dev mode source files', () => {
    expect(pageBuild('http://localhost:4747/bundle/main-BFqheOCa.js')).toBe('main-BFqheOCa');
    expect(pageBuild('http://192.168.0.10:4747/bundle/main-a_b-C1.js')).toBe('main-a_b-C1');
    expect(pageBuild('http://localhost:5173/src/net/store.ts')).toBeUndefined();
    expect(pageBuild('not a url')).toBeUndefined();
  });

  it('notifies once when the server serves a different build', () => {
    const store = new OfficeStore();
    store.pageBuildId = 'main-old';
    const seen: string[] = [];
    store.on('update', (u) => seen.push(`${u.current}->${u.build}`));
    const apply = (s: OfficeSnapshot) => (store as unknown as { applySnapshot(s: OfficeSnapshot): void }).applySnapshot(s);
    apply(snap(1, 'main-old'));
    expect(seen).toEqual([]);
    apply(snap(2, 'main-new'));
    apply(snap(3, 'main-new'));
    expect(seen).toEqual(['main-old->main-new']);
  });

  it('does not notify without server build, in dev mode, or in mock', () => {
    const dev = new OfficeStore();
    dev.pageBuildId = undefined;
    const mock = new OfficeStore({ mock: true });
    mock.pageBuildId = 'main-old';
    const noBuild = new OfficeStore();
    noBuild.pageBuildId = 'main-old';
    let count = 0;
    for (const s of [dev, mock, noBuild]) s.on('update', () => count++);
    const apply = (s: OfficeStore, x: OfficeSnapshot) => (s as unknown as { applySnapshot(s: OfficeSnapshot): void }).applySnapshot(x);
    apply(dev, snap(1, 'main-new'));
    apply(mock, snap(1, 'main-new'));
    apply(noBuild, snap(1));
    expect(count).toBe(0);
  });
});

describe('alternative source (timelapse)', () => {
  it('preserves live snapshots during replay and reverts to them at the end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const store = new OfficeStore();
      const seen: number[] = [];
      store.on('snapshot', (s) => seen.push(s.rev));
      const apply = (s: OfficeSnapshot) => (store as unknown as { applySnapshot(s: OfficeSnapshot): void }).applySnapshot(s);
      apply({ ...snap(5), serverTime: 9_000 });
      expect(store.replaying).toBe(false);

      const replayed = { ...snap(1), serverTime: 1_000, agents: [{ id: 'tl', roomId: 'r' } as OfficeSnapshot['agents'][number]] };
      store.pushReplay(replayed);
      expect(store.replaying).toBe(true);
      expect(store.snapshot).toBe(replayed);
      expect(store.agent('tl')).toBeDefined();
      // Live snapshots arriving underneath: preserved without emitting, and older ones remain discarded.
      apply({ ...snap(6), serverTime: 9_500 });
      apply(snap(4));
      expect(store.snapshot).toBe(replayed);
      expect(store.liveSnapshot?.rev).toBe(6);
      expect(seen).toEqual([5, 1]);

      vi.setSystemTime(12_000);
      store.stopReplay();
      expect(store.replaying).toBe(false);
      expect(store.snapshot?.rev).toBe(6);
      // UI clock derives from serverTime: advances by the time the snapshot was buffered.
      expect(store.snapshot?.serverTime).toBe(9_500 + 2_000);
      expect(store.agent('tl')).toBeUndefined();
      expect(seen).toEqual([5, 1, 6]);
      store.stopReplay();
      expect(seen).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('project character (store)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('saveCharacter: PUT JSON on agent route; returns undefined or server error message', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Ana is already in the office in api' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = new OfficeStore();
    expect(await store.saveCharacter('.claude:1', { name: 'Ana', seed: 1, parts: {} })).toBe('Ana is already in the office in api');
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/.claude%3A1/character', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"Ana","seed":1,"parts":{}}',
    });
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    expect(await store.saveCharacter('.claude:1', { name: 'Ana', seed: 1, parts: {} })).toBeUndefined();
  });

  it('resetCharacter: DELETE with JSON body; no connection returns message; mock does not touch network', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new OfficeStore().resetCharacter('a')).toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/agents/a/character', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'));
    expect(await new OfficeStore().resetCharacter('a')).toBe('No connection to Habblaud.');
    const calls = fetchMock.mock.calls.length;
    expect(await new OfficeStore({ mock: true }).resetCharacter('a')).toMatch(/live office/);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
