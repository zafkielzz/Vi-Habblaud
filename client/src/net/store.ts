// Office state in browser: receives snapshots/feed/notices from server via SSE
// (or local simulator when URL has ?mock=1) and notifies subscribers.
// Alternative source (timelapse, ui/timelapse.ts): pushReplay() publishes reconstructed snapshots while
// SSE remains connected underneath, keeping live snapshots until stopReplay().
// Also handles reconnection: when browser gives up on stream (EventSource closed after HTTP error,
// e.g. server restarting behind proxy), retries with exponential backoff.
import type { AppearanceParts } from '../../../shared/appearance';
import type { Activity, AgentDetail, AgentInfo, FeedItem, Notice, OfficeSnapshot, OutboxMessage, PermissionDecision, PermissionRequestInfo, RoomInfo, SessionCommand } from '../../../shared/types';
import { DemoSimulator } from '../../../shared/demo/simulator';
import { tr } from '../../../shared/i18n';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'mock';

export interface StoreEvents {
  snapshot: OfficeSnapshot;
  feed: FeedItem[];
  notice: Notice;
  connection: ConnectionState;
  /** Server is serving another client build: this page is outdated. Emitted once. */
  update: { build: string; current: string };
}

/**
 * Build of this page: main bundle name (e.g. "main-BFqheOCa"), taken from module URL itself.
 * In dev mode (source code served by Vite) there is no bundle and result is undefined.
 */
export function pageBuild(moduleUrl: string = import.meta.url): string | undefined {
  try {
    return /\/bundle\/(main-[\w-]+)\.js$/.exec(new URL(moduleUrl).pathname)?.[1];
  } catch {
    return undefined;
  }
}

type Listener<K extends keyof StoreEvents> = (value: StoreEvents[K]) => void;

/** Minimal EventSource surface used by the store (allows injecting mock in tests). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export interface StoreOptions {
  mock?: boolean;
  /** Mock mode parameters (default: page query string). */
  search?: string;
  /** Stream factory (default: `new EventSource(url)`). */
  eventSource?: (url: string) => EventSourceLike;
}

const FEED_LIMIT = 200;
/** EventSource.CLOSED (literal constant: EventSource does not exist in Node test environment). */
const ES_CLOSED = 2;
/** Wait time between reconnection attempts: 2 s, 4 s, 8 s… up to 30 s. */
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * Simulator options from query string (?speed=2&sessions=6). `sessions=0` is valid: empty office. For
 * screenshots: `seed=N` repeats the same office and `noquota=1` leaves Codex account "out of quota".
 */
export function mockOptionsFrom(search: string): { speed: number; sessions: number; seed?: number; codexNoQuota?: boolean } {
  const params = new URLSearchParams(search);
  const num = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const speed = num('speed');
  const sessions = num('sessions');
  const seed = num('seed');
  return {
    speed: speed !== null && speed > 0 ? Math.min(speed, 50) : 1,
    sessions: sessions !== null && sessions >= 0 ? Math.min(Math.floor(sessions), 40) : 4,
    ...(seed !== null && seed >= 0 ? { seed: Math.floor(seed) } : {}),
    ...(params.get('noquota') === '1' ? { codexNoQuota: true } : {}),
  };
}

export class OfficeStore {
  snapshot: OfficeSnapshot | null = null;
  /** Global feed, from oldest to newest. */
  feed: FeedItem[] = [];
  connection: ConnectionState = 'connecting';
  readonly mock: boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<keyof StoreEvents, Set<(value: any) => void>>();
  private agentIndex = new Map<string, AgentInfo>();
  private roomIndex = new Map<string, RoomInfo>();
  private source: EventSourceLike | null = null;
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private readonly search: string;
  private readonly openStream: (url: string) => EventSourceLike;
  /** Reconnection: consecutive failed attempts and next attempt timer. */
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt: number | null = null;
  /** Stopped intentionally (disconnect()): does not reconnect automatically. */
  private stopped = true;
  private readonly onOnline = () => {
    if (!this.stopped && this.connection === 'closed') this.reconnectNow();
  };
  /** Timelapse enabled: `snapshot` is reconstructed; last live snapshot is in `live` (with arrival time). */
  private replay = false;
  private live: { snap: OfficeSnapshot; at: number } | null = null;

  constructor(opts: StoreOptions = {}) {
    this.mock = !!opts.mock;
    this.search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    this.openStream = opts.eventSource ?? ((url) => new EventSource(url));
  }

  on<K extends keyof StoreEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.mock) return this.startMock();
    this.startSSE();
  }

  disconnect(): void {
    this.stopped = true;
    if (typeof removeEventListener === 'function') removeEventListener('online', this.onOnline);
    this.clearRetry();
    this.closeSource();
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }

  /** Reconnects immediately ("Try now" button), without waiting for next interval. */
  reconnectNow(): void {
    if (this.mock) return;
    this.clearRetry();
    this.closeSource();
    this.stopped = false;
    this.startSSE();
  }

  /** Next automatic reconnection attempt time (epoch ms), or null. */
  get nextRetryAt(): number | null {
    return this.retryAt;
  }

  agent(id: string): AgentInfo | undefined {
    return this.agentIndex.get(id);
  }

  room(id: string): RoomInfo | undefined {
    return this.roomIndex.get(id);
  }

  agentsInRoom(roomId: string): AgentInfo[] {
    return (this.snapshot?.agents ?? []).filter((a) => a.roomId === roomId);
  }

  /** Long agent history (server). In mock mode and timelapse returns `recent`. */
  async agentHistory(id: string): Promise<Activity[]> {
    if (this.mock || this.replay) return this.agent(id)?.recent ?? [];
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
    if (!res.ok) return this.agent(id)?.recent ?? [];
    const detail = (await res.json()) as AgentDetail;
    return detail.history;
  }

  /** Enables/disables demo agents on server. */
  async setDemo(enabled: boolean): Promise<boolean> {
    if (this.mock) return true;
    const res = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  }

  /** "Check now": requests GitHub query from server (result arrives in snapshot). */
  async checkUpdates(): Promise<boolean> {
    if (this.mock) return false;
    const res = await fetch('/api/updates/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return res.ok;
  }

  // ---------------------------------------------------------------- timelapse

  /** Snapshots come from alternative source (timelapse), not SSE. */
  get replaying(): boolean {
    return this.replay;
  }

  /** Last live snapshot (during timelapse, `snapshot` is reconstructed). */
  get liveSnapshot(): OfficeSnapshot | null {
    return this.replay ? (this.live?.snap ?? null) : this.snapshot;
  }

  /** Publishes snapshot from alternative source; first one enables replay mode (live is saved). */
  pushReplay(snap: OfficeSnapshot): void {
    if (!this.replay) {
      this.replay = true;
      this.live = this.snapshot ? { snap: this.snapshot, at: Date.now() } : null;
    }
    this.setSnapshot(snap);
  }

  /** Disables alternative source and reverts to last live snapshot. */
  stopReplay(): void {
    if (!this.replay) return;
    this.replay = false;
    const live = this.live;
    this.live = null;
    if (live) {
      // `serverTime` advanced by elapsed time: UI aligns clock to freshly arrived snapshot.
      this.setSnapshot({ ...live.snap, serverTime: live.snap.serverTime + (Date.now() - live.at) });
    } else {
      this.snapshot = null;
      this.agentIndex = new Map();
      this.roomIndex = new Map();
    }
  }

  /**
   * Detail of a permission request (with arguments: command, diff...). Demo requests arrive
   * complete in snapshot; real ones come from GET /api/permissions/:id (local access only).
   */
  async permissionDetail(agentId: string, id: string): Promise<PermissionRequestInfo | undefined> {
    const inline = this.agent(agentId)?.permission;
    if (inline?.id === id && inline.input !== undefined) return inline;
    if (this.mock) return inline?.id === id ? inline : undefined;
    const res = await fetch(`/api/permissions/${encodeURIComponent(id)}`);
    if (!res.ok) return undefined;
    return (await res.json()) as PermissionRequestInfo;
  }

  /**
   * Replies to permission request from office. Returns undefined on success, or server error
   * message (request already answered, non-local access...).
   */
  async decidePermission(id: string, d: PermissionDecision): Promise<string | undefined> {
    if (this.mock) {
      const sim = this.mockSim;
      if (!sim?.decidePermission(id, d)) return tr('This request has already been answered.');
      this.applySnapshot(sim.snapshot());
      return undefined;
    }
    const res = await fetch(`/api/permissions/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
    if (res.ok) return undefined;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') return body.error;
    } catch {
      // Non-JSON response (e.g. guard): uses default message.
    }
    return tr("Couldn't reply (error {0}).", [res.status]);
  }

  /**
   * Saves project character (PUT /api/agents/:id/character). Returns undefined on success, or error
   * message (name in use, non-local access...).
   */
  async saveCharacter(id: string, body: { name: string; seed: number; parts: AppearanceParts }): Promise<string | undefined> {
    return this.characterRequest(id, 'PUT', body);
  }

  /** "Reroll": deletes project character (DELETE /api/agents/:id/character). */
  async resetCharacter(id: string): Promise<string | undefined> {
    return this.characterRequest(id, 'DELETE', {});
  }

  private async characterRequest(id: string, method: 'PUT' | 'DELETE', body: object): Promise<string | undefined> {
    if (this.mock || this.replay) return tr('Editing the character only works with the live office.');
    let res: Response;
    try {
      res = await fetch(`/api/agents/${encodeURIComponent(id)}/character`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return tr('No connection to Habblaud.');
    }
    if (res.ok) return undefined;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') return data.error;
    } catch {
      // Non-JSON response (e.g. guard): fall back to default message.
    }
    return tr("Couldn't save the character (error {0}).", [res.status]);
  }

  // ---------------------------------------------------------------- Antigravity workers (manual mode)

  /**
   * POST /api/agy/jobs, /api/agy/stop or /api/agy/defaults: undefined on success, otherwise server message. No connection: throws.
   * `stopped` = how many jobs were stopped (stop only).
   */
  async agyRequest(
    path: 'jobs' | 'stop' | 'defaults',
    body: { agentId: string; prompt?: string; mode?: string; role?: string; effort?: string },
  ): Promise<{ error?: string; stopped?: number }> {
    const res = await fetch(`/api/agy/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data: { error?: unknown; stopped?: unknown } | undefined;
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // non-JSON (e.g. guard)
    }
    if (res.ok) return typeof data?.stopped === 'number' ? { stopped: data.stopped } : {};
    return { error: typeof data?.error === 'string' ? data.error : tr('error {0}', [res.status]) };
  }

  // ---------------------------------------------------------------- messages across office

  /**
   * Sends message to an agent (POST /api/messages): created message (status `queued`) or server error
   * (agent does not accept messages, queue full, non-local access...). No connection: throws.
   * In ?mock=1 delivery is simulated (simulator attaches activity to agent).
   */
  async sendMessage(agentId: string, text: string): Promise<{ message: OutboxMessage } | { error: string }> {
    if (this.mock) return this.mockSend(agentId, text);
    const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, text }) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Non-JSON response (e.g. guard): fall back to default message.
    }
    if (res.status === 201 && body && typeof body === 'object') return { message: body as OutboxMessage };
    const error = (body as { error?: unknown } | undefined)?.error;
    return { error: typeof error === 'string' ? error : tr('error {0}', [res.status]) };
  }

  /**
   * Changes a Claude Code session's model, effort or plan mode (POST /api/messages with `command`): the
   * habblaud-mensagens plugin runs `/model`, `/effort` or `/plan` there. Same answers as sendMessage.
   */
  async sendCommand(agentId: string, command: SessionCommand): Promise<{ message: OutboxMessage } | { error: string }> {
    if (this.mock) return { error: tr('not in the demo') };
    const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, command }) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Non-JSON response (e.g. guard): fall back to default message.
    }
    if (res.status === 201 && body && typeof body === 'object') return { message: body as OutboxMessage };
    const error = (body as { error?: unknown } | undefined)?.error;
    return { error: typeof error === 'string' ? error : tr('error {0}', [res.status]) };
  }

  /** Status of a message (GET /api/messages/:id). null = server does not know it (404). No connection: throws. */
  async messageStatus(id: string): Promise<OutboxMessage | null> {
    if (this.mock) {
      const m = this.mockOutbox.get(id);
      return m ? { ...m } : null;
    }
    const res = await fetch(`/api/messages/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(tr('error {0}', [res.status]));
    return (await res.json()) as OutboxMessage;
  }

  /** Messages in ?mock=1 (delivered by simulator after ~1 s). */
  private mockOutbox = new Map<string, OutboxMessage>();
  private mockSeq = 0;

  private mockSend(agentId: string, text: string): { message: OutboxMessage } | { error: string } {
    const a = this.agent(agentId);
    if (!a) return { error: tr('unknown agent: has it already left the office?') };
    if (!a.canMessage || a.kind !== 'main' || a.status === 'offline') return { error: tr("this agent can't receive messages right now") };
    const now = Date.now();
    const msg: OutboxMessage = { id: `mock-${now.toString(36)}-${++this.mockSeq}`, agentId, status: 'queued', createdAt: now, updatedAt: now };
    this.mockOutbox.set(msg.id, msg);
    setTimeout(() => {
      const sim = this.mockSim;
      const ok = !!sim?.receiveMessage(agentId, text);
      Object.assign(msg, { status: ok ? 'delivered' : 'failed', updatedAt: Date.now() }, ok ? {} : { error: tr('the agent left the office') });
      if (ok && sim) this.applySnapshot(sim.snapshot());
    }, 1_000);
    return { message: { ...msg } };
  }

  // ---------------------------------------------------------------- internal

  private emit<K extends keyof StoreEvents>(event: K, value: StoreEvents[K]): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(value);
      } catch (err) {
        console.error(`[store] listener for "${event}" failed`, err);
      }
    });
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit('connection', state);
  }

  private applySnapshot(snap: OfficeSnapshot): void {
    const cur = this.replay ? this.live?.snap : this.snapshot;
    if (cur && snap.rev < cur.rev && snap.meta.startedAt === cur.meta.startedAt) return;
    if (this.replay) this.live = { snap, at: Date.now() };
    else this.setSnapshot(snap);
    this.checkBuild(snap.meta.build);
  }

  private setSnapshot(snap: OfficeSnapshot): void {
    this.snapshot = snap;
    this.agentIndex = new Map(snap.agents.map((a) => [a.id, a]));
    this.roomIndex = new Map(snap.rooms.map((r) => [r.id, r]));
    this.emit('snapshot', snap);
  }

  private updateAnnounced = false;
  /** Build of this page (see pageBuild); exposed for tests. */
  pageBuildId: string | undefined = pageBuild();

  /** Notifies (once) when server starts serving a different client build. */
  private checkBuild(serverBuild: string | undefined): void {
    if (this.updateAnnounced || this.mock || !serverBuild) return;
    const current = this.pageBuildId;
    if (!current || current === serverBuild) return;
    this.updateAnnounced = true;
    this.emit('update', { build: serverBuild, current });
  }

  private applyFeed(items: FeedItem[]): void {
    if (!items.length) return;
    const known = new Set(this.feed.map((f) => f.id));
    const fresh = items.filter((f) => !known.has(f.id));
    if (!fresh.length) return;
    this.feed = [...this.feed, ...fresh].slice(-FEED_LIMIT);
    this.emit('feed', fresh);
  }

  /** Reads SSE event JSON; corrupted messages are ignored without dropping stream. */
  private parse<T>(ev: Event, what: string): T | null {
    try {
      return JSON.parse((ev as MessageEvent).data) as T;
    } catch (err) {
      console.warn(`[store] invalid ${what} ignored`, err);
      return null;
    }
  }

  private startSSE(): void {
    // Network restored (Wi-Fi, VPN): reconnects without waiting for next interval.
    if (typeof addEventListener === 'function') addEventListener('online', this.onOnline);
    this.setConnection('connecting');
    let es: EventSourceLike;
    try {
      es = this.openStream('/api/stream');
    } catch (err) {
      console.error('[store] could not open stream', err);
      this.setConnection('closed');
      this.scheduleRetry();
      return;
    }
    this.source = es;
    // Events from a replaced stream (reconnection) are discarded.
    const current = () => this.source === es;
    es.addEventListener('open', () => {
      if (!current()) return;
      this.attempts = 0;
      this.clearRetry();
      this.setConnection('open');
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: browser itself will retry. CLOSED: gave up; reconnection is handled by us.
      if (es.readyState === ES_CLOSED) {
        this.setConnection('closed');
        this.scheduleRetry();
      } else {
        this.setConnection('connecting');
      }
    });
    es.addEventListener('snapshot', (ev) => {
      if (!current()) return;
      const snap = this.parse<OfficeSnapshot>(ev, 'snapshot');
      if (snap) this.applySnapshot(snap);
    });
    es.addEventListener('feed', (ev) => {
      if (!current()) return;
      const items = this.parse<FeedItem[]>(ev, 'feed');
      if (items) this.applyFeed(items);
    });
    es.addEventListener('notice', (ev) => {
      if (!current()) return;
      const n = this.parse<Notice>(ev, 'notice');
      if (n) this.emit('notice', n);
    });
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.mock || this.stopped) return;
    const delay = reconnectDelay(this.attempts);
    this.attempts++;
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      if (!this.stopped && this.connection === 'closed') {
        this.closeSource();
        this.startSSE();
      }
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  /** Simulator for ?mock=1 mode (also answers mock permission requests). */
  private mockSim: DemoSimulator | null = null;

  private startMock(): void {
    if (this.mockTimer) return;
    this.setConnection('mock');
    const sim = new DemoSimulator(mockOptionsFrom(this.search));
    this.mockSim = sim;
    this.applySnapshot(sim.snapshot());
    this.mockTimer = setInterval(() => {
      const now = Date.now();
      const r = sim.tick(now);
      if (r.changed) this.applySnapshot(sim.snapshot(now));
      this.applyFeed(r.feed);
      r.notices.forEach((n) => this.emit('notice', n));
    }, 250);
  }
}
