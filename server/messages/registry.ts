// Messages from the office: the queue of what the page sends to agents.
//
// The page sends via POST /api/messages; the habblaud-mensagens plugin (mod/habblaud-mensagens, polling every 2 s
// in each open session) fetches messages for its own session via POST /api/mod/inbox, delivers each one as if typed
// by the user, and confirms via POST /api/mod/inbox/ack. The registry:
// - marks PRESENCE of each session that polls the inbox (AgentInfo.canMessage, via Office);
// - keeps messages for each agent in order and tracks their status (queued → sent → delivered/failed);
// - fails messages nobody fetched, unconfirmed by the session, from agents that left, or from a conversation that
//   changed (/clear, /resume): each message applies only to the session it was sent to;
// - adds the "Message from Habblaud" activity to the agent when the session confirms delivery;
// - simulates delivery for demo agents (nothing goes to a real session).
// Text goes to the session exactly as typed (from the user) and is never returned in page responses or
// logs; only the feed activity gets the beginning, masked and trimmed.
//
// Codex agents have no plugin: their messages go via Codex deliverer (`codex queue`, messages/codex.ts),
// never via the inbox. In Node mode the server itself runs the command (`codex.run` option); in Docker, the
// host helper (npm run codex:bridge) fetches via POST /api/codex/bridge/poll and confirms via
// POST /api/codex/bridge/ack. Same states, timeouts, and limits; canMessage = deliverer exists (binary in Node mode
// or helper seen within PRESENCE_MS). `delivered` = entered session queue (enters when idle).
import { randomBytes } from 'node:crypto';
import { truncate } from '../../shared/activity';
import { describeMessage, MESSAGE_MAX, SESSION_EFFORTS, SESSION_MODELS } from '../../shared/messages';
import type { Activity, AgentInfo, InboxMessage, OutboxMessage, SessionCommand } from '../../shared/types';
import { errMsg, log } from '../log';
import type { CodexQueueResult, CodexQueueRunner } from './codex';
import { tr } from '../../shared/i18n';

/** Session that checked inbox within this time: can receive messages (canMessage). */
export const PRESENCE_MS = 10_000;
/** Message in queue that the session did not fetch within this time: fails. */
export const QUEUED_TIMEOUT_MS = 60_000;
/** Fetched message that the session did not confirm within this time: fails. */
export const SENT_TIMEOUT_MS = 30_000;
/** Resolved message (delivered or not) stays this long for GET /api/messages/:id and then disappears. */
export const KEEP_MS = 10 * 60_000;
/** Mock delivery of a message to a demo agent. */
export const DEMO_DELIVERY_MS = 1_000;
export const MAX_TEXT = MESSAGE_MAX;
/** Messages not yet resolved per agent (next receives 429). */
export const MAX_OPEN = 5;
/** Messages delivered to plugin per batch. */
export const INBOX_BATCH = 5;

export const ERR_NOT_FETCHED = tr("the session didn't fetch the message: is the habblaud-mensagens plugin installed and the session open?");
export const ERR_NOT_CONFIRMED = tr("the session didn't confirm delivery");
export const ERR_GONE = tr('the agent left the office');
export const ERR_REFUSED = tr("the session didn't accept the message");
export const ERR_SESSION_CHANGED = tr("the agent's conversation changed (/clear or /resume) before delivery");
export const ERR_CODEX_UNAVAILABLE =
  tr('no way to deliver to Codex right now: run Habblaud outside Docker with `codex` in PATH (or HABBLAUD_CODEX_BIN) or, in Docker, keep npm run codex:bridge running on the Mac');
export const ERR_CODEX_NOT_FETCHED = tr("the Codex helper didn't fetch the message: is npm run codex:bridge running on the Mac?");
export const ERR_CODEX_SLOW = tr('Codex took too long with the previous messages to this agent');
export const ERR_CODEX_NOT_CONFIRMED = tr("the Codex helper didn't confirm delivery");
export const ERR_CODEX_HOME = tr("this agent's Codex account folder is unknown");
export const ERR_CODEX_REFUSED = tr("codex queue didn't accept the message");

const ERROR_MAX = 300;
const ID_MAX = 300;
const ACK_MAX = 50;

/** What registry uses from Office (minimal interface: helps testing). */
export interface OfficeLike {
  get(id: string): AgentInfo | undefined;
  list(): AgentInfo[];
  markDirty(): void;
  addActivity(id: string, activity: Activity, current: boolean): void;
}

/** Codex deliverer (`codex queue`). */
export interface CodexDeliveryOptions {
  /** Node mode: runs `codex queue` from here (absent in Docker or without binary: only host helper delivers). */
  run?: CodexQueueRunner;
  /** CODEX_HOME folder (host path: AccountInfo.configDir) of a Codex account. */
  homeOf: (account: string) => string | undefined;
}

export interface MessageRegistryOptions {
  office: OfficeLike;
  /** Demo agent (Office.demoAgent): these only exist in the snapshot. */
  demoAgent?: (id: string) => AgentInfo | undefined;
  /** Mock delivery to a demo agent (Office.deliverDemoMessage); false = already left. */
  demoDeliver?: (agentId: string, text: string) => boolean;
  /** Messages to Codex agents; absent = they do not receive messages. */
  codex?: CodexDeliveryOptions;
  now?: () => number;
  /** Internal clock interval (start). */
  tickMs?: number;
  presenceMs?: number;
  queuedTimeoutMs?: number;
  sentTimeoutMs?: number;
  keepMs?: number;
  demoDeliveryMs?: number;
}

export type SendResult = { message: OutboxMessage } | { error: 'not-found' | 'too-many' } | { error: 'unavailable'; reason: string };

/** Message delivered to Codex host helper (POST /api/codex/bridge/poll): runs `codex queue` with it. */
export interface CodexBridgeMessage {
  id: string;
  account: string;
  /** Account CODEX_HOME, on the host. */
  codexHome: string;
  thread: string;
  /** The text as typed. */
  text: string;
}

/** Body validation error (becomes 400). */
export class InvalidRequest extends Error {}

interface Entry {
  msg: OutboxMessage;
  /** The text as typed; emptied when the message resolves. */
  text: string;
  /** Feed activity when delivery is confirmed (start of text, masked and trimmed). */
  activity: ReturnType<typeof describeMessage>;
  /** Agent session when the message was sent: only it receives (conversation switch = failure). */
  target: string;
  /** Session that fetched the message (sent): only it confirms delivery. */
  session?: string;
  sentAt?: number;
  /** Message to a demo agent: never leaves via inbox. */
  demo?: boolean;
  /** Message to a Codex agent: goes via Codex deliverer ('node' = server ran it; 'bridge' = helper). */
  codex?: true;
  via?: 'node' | 'bridge';
  /** Failed due to lack of confirmation: late confirmation still corrects the status. */
  late?: boolean;
  /** `/model`, `/effort` or `/plan` for the session (the text is its typed form). */
  command?: SessionCommand;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Agent still present in the office (not offline or done). */
function present(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.status !== 'offline' && a.status !== 'done';
}

const isFinal = (e: Entry) => e.msg.status === 'delivered' || e.msg.status === 'failed';

/**
 * Why agent cannot receive messages right now (undefined = can receive). `reachable`: session has plugin connected
 * (or, in Codex, deliverer exists).
 */
function unavailableReason(a: AgentInfo, reachable: boolean): string | undefined {
  if (a.kind !== 'main') return tr("subagents don't receive messages: send it to the main agent");
  if (!present(a)) return tr('the agent has already left the office');
  if (!reachable) return a.provider === 'codex' ? ERR_CODEX_UNAVAILABLE : tr("the session doesn't have the habblaud-mensagens plugin connected (npm run mod:install)");
  return undefined;
}

/** `{name, args}` of POST /api/messages: model, effort or plan, with a value the drawer offers. */
function parseCommand(raw: unknown): SessionCommand {
  const c = rec(raw);
  const args = typeof c?.args === 'string' ? c.args : '';
  if (c?.name === 'model' && (SESSION_MODELS as readonly string[]).includes(args)) return { name: 'model', args };
  if (c?.name === 'effort' && (SESSION_EFFORTS as readonly string[]).includes(args)) return { name: 'effort', args };
  if (c?.name === 'plan' && !args) return { name: 'plan', args: '' };
  throw new InvalidRequest(tr('unknown command (model, effort or plan only)'));
}

/**
 * POST /api/messages body: `{agentId, text}`, or `{agentId, command}` to change the session's model, effort or plan
 * mode (its text is the typed form, "/model opus"). Text is not modified (nor trimmed).
 */
export function parseSend(raw: unknown): { agentId: string; text: string; command?: SessionCommand } {
  const r = rec(raw);
  const agentId = shortStr(r?.agentId, ID_MAX);
  if (r && agentId && r.command !== undefined) {
    const command = parseCommand(r.command);
    return { agentId, text: `/${command.name}${command.args ? ` ${command.args}` : ''}`, command };
  }
  if (!r || !agentId || typeof r.text !== 'string') throw new InvalidRequest('expected {agentId, text}');
  if (!r.text.trim()) throw new InvalidRequest(tr('the message is empty'));
  if (r.text.length > MAX_TEXT) throw new InvalidRequest(tr('the message exceeds 20,000 characters'));
  return { agentId, text: r.text };
}

/** Results from an ack ({results: [{id, ok, error?}]}): valid ones, up to ACK_MAX. */
function ackResults(raw: unknown): Array<{ id: string; ok: boolean; error?: string }> {
  const r = rec(raw);
  if (!r || !Array.isArray(r.results)) return [];
  const out: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const item of r.results.slice(0, ACK_MAX)) {
    const x = rec(item);
    const id = shortStr(x?.id, ID_MAX);
    if (!x || !id || typeof x.ok !== 'boolean') continue;
    out.push({ id, ok: x.ok, ...(typeof x.error === 'string' && x.error.trim() ? { error: truncate(x.error, ERROR_MAX) } : {}) });
  }
  return out;
}

export class MessageRegistry {
  private messages = new Map<string, Entry>();
  /** Last time each main agent's session checked the inbox. */
  private seen = new Map<string, number>();
  /** Last time Codex host helper fetched messages. */
  private bridgeAt?: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly presenceMs: number;
  private readonly queuedTimeoutMs: number;
  private readonly sentTimeoutMs: number;
  private readonly keepMs: number;
  private readonly demoDeliveryMs: number;

  constructor(private readonly opts: MessageRegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.presenceMs = opts.presenceMs ?? PRESENCE_MS;
    this.queuedTimeoutMs = opts.queuedTimeoutMs ?? QUEUED_TIMEOUT_MS;
    this.sentTimeoutMs = opts.sentTimeoutMs ?? SENT_TIMEOUT_MS;
    this.keepMs = opts.keepMs ?? KEEP_MS;
    this.demoDeliveryMs = opts.demoDeliveryMs ?? DEMO_DELIVERY_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`messages-tick:${errMsg(err)}`, tr('Messages: clock failed ({0}).', [errMsg(err)]));
      }
    }, this.opts.tickMs ?? 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stored messages (including resolved ones, until pruned). */
  get size(): number {
    return this.messages.size;
  }

  /**
   * Main agents currently present that can receive messages: Claude Code agents whose session recently checked the
   * inbox and Codex agents, if a deliverer exists. This is what Office puts into the snapshot.
   */
  reachable(): Set<string> {
    const out = new Set<string>();
    for (const id of this.seen.keys()) if (this.canMessage(id)) out.add(id);
    if (this.codexAvailable()) for (const a of this.opts.office.list()) if (a.provider === 'codex' && a.kind === 'main' && present(a)) out.add(a.id);
    return out;
  }

  canMessage(agentId: string): boolean {
    const a = this.opts.office.get(agentId);
    if (a?.provider === 'codex') return this.codexAvailable() && present(a) && a.kind === 'main';
    const at = this.seen.get(agentId);
    if (at === undefined || this.now() - at >= this.presenceMs) return false;
    return present(a) && a.kind === 'main';
  }

  /** Can deliver to Codex: binary in Node mode or host helper seen recently. */
  codexAvailable(): boolean {
    const c = this.opts.codex;
    return !!c && (!!c.run || this.bridgeRecent());
  }

  /**
   * Message from the page. `{error}`: unknown agent (not-found), cannot receive messages (unavailable, with
   * reason: subagent, left/done, session without plugin, or Codex without deliverer), or too many messages waiting
   * (too-many). Invalid body: throws InvalidRequest.
   */
  send(raw: unknown): SendResult {
    const { agentId, text, command } = parseSend(raw);
    const real = this.opts.office.get(agentId);
    const demo = real ? undefined : this.opts.demoAgent?.(agentId);
    const agent = real ?? demo;
    if (!agent) return { error: 'not-found' };
    const reason = unavailableReason(agent, real ? this.canMessage(agentId) : demo!.canMessage === true);
    if (reason) return { error: 'unavailable', reason };
    if (command && (agent.provider ?? 'claude') !== 'claude') return { error: 'unavailable', reason: tr('only Claude Code sessions take /model, /effort and /plan') };
    let open = 0;
    for (const e of this.messages.values()) if (e.msg.agentId === agentId && !isFinal(e)) open++;
    if (open >= MAX_OPEN) return { error: 'too-many' };

    const now = this.now();
    const id = `m-${now.toString(36)}-${++this.seq}-${randomBytes(9).toString('base64url')}`;
    const entry: Entry = { msg: { id, agentId, status: 'queued', createdAt: now, updatedAt: now }, text, activity: describeMessage(text), target: agent.sessionId };
    if (command) entry.command = command;
    if (demo) entry.demo = true;
    else if (real?.provider === 'codex') entry.codex = true;
    this.messages.set(id, entry);
    const out = { ...entry.msg };
    if (entry.codex) this.pumpCodex();
    return { message: out };
  }

  /** Status of a message (without text), or undefined. */
  get(id: string): OutboxMessage | undefined {
    const e = this.messages.get(id);
    return e ? { ...e.msg } : undefined;
  }

  /**
   * Plugin polling round: marks session presence and delivers next messages for its agent (marking them
   * `sent`). Session without known main agent: no messages. Invalid body: throws InvalidRequest.
   */
  inbox(raw: unknown): InboxMessage[] {
    const r = rec(raw);
    const session = shortStr(r?.session, ID_MAX);
    if (!r || !session) throw new InvalidRequest('expected {session, account?}');
    const account = shortStr(r.account, ID_MAX);
    // The plugin is for Claude Code: Codex agents never receive messages here.
    const agent = this.opts.office
      .list()
      .find((a) => a.kind === 'main' && a.provider !== 'codex' && a.sessionId === session && (!account || a.account === account) && present(a));
    if (!agent) return [];

    const now = this.now();
    const was = this.canMessage(agent.id);
    this.seen.set(agent.id, now);
    // Only presence change updates snapshot (polling repeats every 2 s).
    if (!was) this.opts.office.markDirty();

    const out: InboxMessage[] = [];
    for (const e of this.messages.values()) {
      if (out.length >= INBOX_BATCH) break;
      if (e.demo || e.codex || e.msg.agentId !== agent.id || e.msg.status !== 'queued' || e.target !== session) continue;
      this.setStatus(e, 'sent', now);
      e.session = session;
      e.sentAt = now;
      out.push(e.command ? { id: e.msg.id, text: e.text, command: e.command } : { id: e.msg.id, text: e.text });
    }
    return out;
  }

  /**
   * Plugin confirmation: `sent` → `delivered` (ok) or `failed` (with reason). Only valid from session that fetched the
   * message; unknown ids or in another status are ignored. A late confirmation (message already failed for lack of
   * ack) still corrects the status: plugin knows if text entered.
   */
  ack(raw: unknown): void {
    const r = rec(raw);
    const session = shortStr(r?.session, ID_MAX);
    if (!r || !session || !Array.isArray(r.results)) throw new InvalidRequest('expected {session, results: [{id, ok, error?}]}');
    const now = this.now();
    for (const x of ackResults(r)) {
      const e = this.messages.get(x.id);
      if (!e || e.demo || e.codex || e.session !== session) continue;
      if (e.msg.status !== 'sent' && !(e.msg.status === 'failed' && e.late)) continue;
      if (x.ok) this.finish(e, 'delivered', now);
      else this.fail(e, now, x.error ?? ERR_REFUSED);
    }
  }

  /**
   * Codex host helper polling round: marks helper presence and delivers next messages to Codex agents
   * (marking them `sent`), in agent order (none for an agent that still has another being delivered). In Node mode
   * the server delivers: nothing sent here (avoids duplicate delivery).
   */
  codexPoll(raw: unknown): CodexBridgeMessage[] {
    if (!rec(raw)) throw new InvalidRequest(tr('expected a JSON object ({})'));
    const c = this.opts.codex;
    if (!c) return [];
    const now = this.now();
    const was = this.codexAvailable();
    this.bridgeAt = now;
    if (!was) this.opts.office.markDirty();
    if (c.run) return [];

    const busy = new Set<string>();
    for (const e of this.messages.values()) if (e.codex && e.msg.status === 'sent') busy.add(e.msg.agentId);
    const out: CodexBridgeMessage[] = [];
    for (const e of this.messages.values()) {
      if (out.length >= INBOX_BATCH) break;
      if (!e.codex || e.msg.status !== 'queued' || busy.has(e.msg.agentId)) continue;
      busy.add(e.msg.agentId);
      const target = this.codexTarget(e, now);
      if (!target) continue;
      this.setStatus(e, 'sent', now);
      e.sentAt = now;
      e.via = 'bridge';
      out.push({ id: e.msg.id, account: target.account, codexHome: target.codexHome, thread: target.thread, text: e.text });
    }
    return out;
  }

  /**
   * Codex helper confirmation: `sent` → `delivered` (`codex queue` accepted) or `failed` (with reason). Only
   * applies to messages it fetched; late ack still corrects status, as with plugin. Invalid body: throws.
   */
  codexAck(raw: unknown): void {
    const r = rec(raw);
    if (!r || !Array.isArray(r.results)) throw new InvalidRequest('expected {results: [{id, ok, error?}]}');
    const now = this.now();
    this.bridgeAt = now;
    for (const x of ackResults(r)) {
      const e = this.messages.get(x.id);
      if (!e || !e.codex || e.via !== 'bridge') continue;
      if (e.msg.status !== 'sent' && !(e.msg.status === 'failed' && e.late)) continue;
      if (x.ok) this.finish(e, 'delivered', now);
      else this.fail(e, now, x.error ?? ERR_CODEX_REFUSED);
    }
  }

  /** Clock: timeouts, agent that left, demo mock delivery, expired presence, and resolved messages cleanup. */
  tick(): void {
    const now = this.now();
    for (const [id, e] of this.messages) {
      if (isFinal(e)) {
        if (now - e.msg.updatedAt >= this.keepMs) this.messages.delete(id);
        continue;
      }
      if (e.demo) {
        if (!present(this.opts.demoAgent?.(e.msg.agentId))) this.fail(e, now, ERR_GONE);
        else if (now - e.msg.createdAt >= this.demoDeliveryMs) {
          if (this.opts.demoDeliver?.(e.msg.agentId, e.text)) this.finish(e, 'delivered', now);
          else this.fail(e, now, ERR_GONE);
        }
        continue;
      }
      const a = this.opts.office.get(e.msg.agentId);
      if (!present(a)) this.fail(e, now, ERR_GONE);
      else if (e.msg.status === 'queued' && a.sessionId !== e.target) this.fail(e, now, ERR_SESSION_CHANGED);
      else if (e.msg.status === 'queued' && now - e.msg.createdAt >= this.queuedTimeoutMs) {
        this.fail(e, now, !e.codex ? ERR_NOT_FETCHED : this.opts.codex?.run ? ERR_CODEX_SLOW : ERR_CODEX_NOT_FETCHED);
      } else if (e.msg.status === 'sent' && now - (e.sentAt ?? now) >= this.sentTimeoutMs) {
        this.fail(e, now, e.codex ? ERR_CODEX_NOT_CONFIRMED : ERR_NOT_CONFIRMED);
        e.late = true;
      }
    }
    // Expired presence (or from departed agent): snapshot updates to show messages unavailable.
    for (const [agentId, at] of this.seen) {
      if (now - at < this.presenceMs && present(this.opts.office.get(agentId))) continue;
      this.seen.delete(agentId);
      this.opts.office.markDirty();
    }
    if (this.bridgeAt !== undefined && now - this.bridgeAt >= this.presenceMs) {
      this.bridgeAt = undefined;
      // Without binary in Node mode, Codex agents stop receiving.
      if (!this.opts.codex?.run) this.opts.office.markDirty();
    }
    this.pumpCodex();
  }

  // ---------------------------------------------------------------- internals

  private bridgeRecent(): boolean {
    return this.bridgeAt !== undefined && this.now() - this.bridgeAt < this.presenceMs;
  }

  /** Thread and account directory for a message to Codex; without them, message fails (and returns undefined). */
  private codexTarget(e: Entry, now: number): { account: string; codexHome: string; thread: string } | undefined {
    const a = this.opts.office.get(e.msg.agentId);
    if (!present(a)) return void this.fail(e, now, ERR_GONE);
    if (a.sessionId !== e.target) return void this.fail(e, now, ERR_SESSION_CHANGED);
    const codexHome = this.opts.codex?.homeOf(a.account);
    if (!codexHome) return void this.fail(e, now, ERR_CODEX_HOME);
    return { account: a.account, codexHome, thread: a.sessionId };
  }

  /**
   * Node mode: runs `codex queue` for next message of each Codex agent (one at a time per agent, in order;
   * next goes out when previous completes).
   */
  private pumpCodex(): void {
    const run = this.opts.codex?.run;
    if (!run) return;
    const busy = new Set<string>();
    for (const e of this.messages.values()) if (e.codex && e.msg.status === 'sent') busy.add(e.msg.agentId);
    const now = this.now();
    for (const e of this.messages.values()) {
      if (!e.codex || e.msg.status !== 'queued' || busy.has(e.msg.agentId)) continue;
      busy.add(e.msg.agentId);
      const target = this.codexTarget(e, now);
      if (!target) continue;
      this.setStatus(e, 'sent', now);
      e.sentAt = now;
      e.via = 'node';
      run({ codexHome: target.codexHome, thread: target.thread, text: e.text }).then(
        (r) => this.codexDone(e, r),
        (err: unknown) => this.codexDone(e, { ok: false, error: errMsg(err) }),
      );
    }
  }

  /** Completion of a `codex queue` run from here. */
  private codexDone(e: Entry, r: CodexQueueResult): void {
    if (this.messages.get(e.msg.id) !== e) return;
    if (e.msg.status !== 'sent' && !(e.msg.status === 'failed' && e.late)) return;
    const now = this.now();
    if (r.ok) this.finish(e, 'delivered', now);
    else this.fail(e, now, truncate(r.error, ERROR_MAX) || ERR_CODEX_REFUSED);
    this.pumpCodex();
  }

  private setStatus(e: Entry, status: OutboxMessage['status'], now: number): void {
    e.msg.status = status;
    e.msg.updatedAt = now;
  }

  /** Resolves message: text is no longer needed. */
  private finish(e: Entry, status: 'delivered' | 'failed', now: number): void {
    this.setStatus(e, status, now);
    delete e.late;
    if (status === 'delivered') {
      delete e.msg.error;
      // Demo message goes to mock agent (Office.deliverDemoMessage).
      if (!e.demo) this.opts.office.addActivity(e.msg.agentId, { id: `${e.msg.agentId}#msg:${e.msg.id}`, at: now, ...e.activity }, false);
    }
    e.text = '';
  }

  private fail(e: Entry, now: number, error: string): void {
    e.msg.error = error;
    this.finish(e, 'failed', now);
  }
}
