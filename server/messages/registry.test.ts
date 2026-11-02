// Office message registry: session presence (canMessage in snapshot), validation, limits, delivery
// to plugin, acknowledgement, timeouts, agent leaving, cleanup of settled messages, and demo mock delivery.
// All with synthetic data and injected clock.
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import {
  ERR_GONE,
  ERR_NOT_CONFIRMED,
  ERR_NOT_FETCHED,
  ERR_REFUSED,
  ERR_SESSION_CHANGED,
  INBOX_BATCH,
  KEEP_MS,
  MAX_OPEN,
  MessageRegistry,
  PRESENCE_MS,
  QUEUED_TIMEOUT_MS,
  SENT_TIMEOUT_MS,
  type SendResult,
} from './registry';

setQuiet(true);

const MAIN = 'acc:1';
const SESSION = 'sess-1';
const OTHER = 'acc:2';
const SUB = `${SESSION}:a1b2c3`;

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let registry: MessageRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    messages: () => registry?.reachable() ?? new Set(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, account: 'acc', sessionId: SESSION, cwd: '/p/loja', role: 'Main agent', startedAt: 0, status: 'idle' });
  office.addMain({ id: OTHER, account: 'acc', sessionId: 'sess-2', cwd: '/p/api', role: 'Main agent', startedAt: 0, status: 'idle' });
  registry = new MessageRegistry({
    office,
    demoAgent: (id) => office.demoAgent(id),
    demoDeliver: (id, text) => office.deliverDemoMessage(id, text),
    now: clock.now,
  });
  return { office, registry, clock };
}

const snapAgent = (office: Office, id: string): AgentInfo | undefined => office.commit().snapshot.agents.find((a) => a.id === id);

function sent(r: SendResult): string {
  if (!('message' in r)) throw new Error(`rejected: ${JSON.stringify(r)}`);
  return r.message.id;
}

describe('MessageRegistry: presence', () => {
  it('session polling inbox starts receiving messages (canMessage) and snapshot changes only on transition', () => {
    const { office, registry, clock } = setup();
    expect(snapAgent(office, MAIN)?.canMessage).toBeUndefined();
    expect(office.commit().changed).toBe(false);

    expect(registry.inbox({ session: SESSION, account: 'acc' })).toEqual([]);
    expect(registry.canMessage(MAIN)).toBe(true);
    expect(registry.reachable()).toEqual(new Set([MAIN]));
    const c1 = office.commit();
    expect(c1.changed).toBe(true);
    expect(c1.snapshot.agents.find((a) => a.id === MAIN)?.canMessage).toBe(true);
    expect(c1.snapshot.agents.find((a) => a.id === OTHER)?.canMessage).toBeUndefined();
    expect(c1.snapshot.meta.messages).toBe(true);

    // Next round (2 s later) does not touch snapshot.
    clock.advance(2_000);
    registry.inbox({ session: SESSION });
    registry.tick();
    expect(office.commit().changed).toBe(false);

    // No round for PRESENCE_MS: stops receiving.
    clock.advance(PRESENCE_MS);
    expect(registry.canMessage(MAIN)).toBe(false);
    registry.tick();
    const c2 = office.commit();
    expect(c2.changed).toBe(true);
    expect(c2.snapshot.agents.find((a) => a.id === MAIN)?.canMessage).toBeUndefined();
  });

  it('unknown session, from another account, from agent that left, or invalid body: no presence', () => {
    const { office, registry } = setup();
    expect(registry.inbox({ session: 'not-found' })).toEqual([]);
    expect(registry.inbox({ session: SESSION, account: 'other-account' })).toEqual([]);
    expect(registry.canMessage(MAIN)).toBe(false);
    office.closeMain(OTHER);
    expect(registry.inbox({ session: 'sess-2' })).toEqual([]);
    expect(registry.canMessage(OTHER)).toBe(false);
    for (const bad of [null, {}, { session: '' }, { session: 42 }, []]) expect(() => registry.inbox(bad)).toThrow(/session/);
  });

  it('subagent never receives (same session as main: presence goes to main)', () => {
    const { office, registry } = setup();
    office.addSub({ id: SUB, parentId: MAIN, sessionId: SESSION, role: 'Explore', background: false, startedAt: 0 });
    registry.inbox({ session: SESSION });
    const snap = office.commit().snapshot;
    expect(snap.agents.find((a) => a.id === MAIN)?.canMessage).toBe(true);
    expect(snap.agents.find((a) => a.id === SUB)?.canMessage).toBeUndefined();
    expect(registry.send({ agentId: SUB, text: 'hi' })).toEqual({ error: 'unavailable', reason: expect.stringMatching(/subagents/) });
  });
});

describe('MessageRegistry: send', () => {
  it('model, effort and plan commands: validated, delivered with their typed form, never to other commands', () => {
    const { registry } = setup();
    registry.inbox({ session: SESSION });
    for (const command of [{ name: 'model', args: 'claude-x' }, { name: 'effort', args: 'ultra' }, { name: 'plan', args: 'now' }, { name: 'logout', args: '' }, 'model']) {
      expect(() => registry.send({ agentId: MAIN, command })).toThrow(/command/);
    }
    registry.send({ agentId: MAIN, command: { name: 'model', args: 'opus' } });
    registry.send({ agentId: MAIN, command: { name: 'effort', args: 'low' } });
    registry.send({ agentId: MAIN, command: { name: 'plan' } });
    expect(registry.inbox({ session: SESSION }).map(({ text, command }) => ({ text, command }))).toEqual([
      { text: '/model opus', command: { name: 'model', args: 'opus' } },
      { text: '/effort low', command: { name: 'effort', args: 'low' } },
      { text: '/plan', command: { name: 'plan', args: '' } },
    ]);
  });

  it('validates body: agentId and text, empty and over 20,000 characters', () => {
    const { registry } = setup();
    registry.inbox({ session: SESSION });
    for (const bad of [null, {}, { agentId: MAIN }, { text: 'hi' }, { agentId: MAIN, text: 3 }]) expect(() => registry.send(bad)).toThrow(/agentId/);
    expect(() => registry.send({ agentId: MAIN, text: '  \n ' })).toThrow(/empty/);
    expect(() => registry.send({ agentId: MAIN, text: 'x'.repeat(20_001) })).toThrow(/20,000/);
    expect('message' in registry.send({ agentId: MAIN, text: 'x'.repeat(20_000) })).toBe(true);
  });

  it('unknown agent (not-found), without plugin connected, or that left (unavailable, with reason)', () => {
    const { office, registry } = setup();
    expect(registry.send({ agentId: 'not-found', text: 'hi' })).toEqual({ error: 'not-found' });
    expect(registry.send({ agentId: MAIN, text: 'hi' })).toEqual({ error: 'unavailable', reason: expect.stringMatching(/habblaud-mensagens/) });
    registry.inbox({ session: SESSION });
    office.closeMain(MAIN);
    expect(registry.send({ agentId: MAIN, text: 'hi' })).toEqual({ error: 'unavailable', reason: expect.stringMatching(/left the office/) });
  });

  it(`at most ${MAX_OPEN} unsettled messages per agent (too-many); settled do not count`, () => {
    const { registry } = setup();
    registry.inbox({ session: SESSION });
    registry.inbox({ session: 'sess-2' });
    const ids = Array.from({ length: MAX_OPEN }, (_, i) => sent(registry.send({ agentId: MAIN, text: `m${i}` })));
    expect(registry.send({ agentId: MAIN, text: 'too-many' })).toEqual({ error: 'too-many' });
    // Another agent has its own queue.
    expect('message' in registry.send({ agentId: OTHER, text: 'hi' })).toBe(true);
    const batch = registry.inbox({ session: SESSION });
    registry.ack({ session: SESSION, results: [{ id: batch[0].id, ok: true }] });
    expect(registry.get(ids[0])?.status).toBe('delivered');
    expect('message' in registry.send({ agentId: MAIN, text: 'now fits' })).toBe(true);
  });

  it('response (201/GET) is status only: text never leaks to the page', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const r = registry.send({ agentId: MAIN, text: 'user secret' });
    expect(r).toEqual({ message: { id: expect.stringMatching(/^m-/), agentId: MAIN, status: 'queued', createdAt: clock.now(), updatedAt: clock.now() } });
    const id = sent(r);
    expect(JSON.stringify(registry.get(id))).not.toContain('secret');
  });
});

describe('MessageRegistry: delivery via plugin', () => {
  it('polling round delivers agent messages in order (up to 5) with verbatim text and marks sent', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    registry.inbox({ session: 'sess-2' });
    const text = '  Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 in .env\n\nand run `npm test`  ';
    const first = sent(registry.send({ agentId: MAIN, text }));
    const others = [1, 2, 3, 4].map((i) => sent(registry.send({ agentId: MAIN, text: `m${i}` })));
    sent(registry.send({ agentId: OTHER, text: 'to the other' }));
    clock.advance(500);

    const batch = registry.inbox({ session: SESSION });
    expect(batch.length).toBe(INBOX_BATCH);
    expect(batch[0]).toEqual({ id: first, text });
    expect(batch.slice(1).map((m) => m.id)).toEqual(others);
    expect(registry.get(first)).toMatchObject({ status: 'sent', updatedAt: clock.now() });
    // Already fetched messages are not returned again; another agent's only go to its session.
    expect(registry.inbox({ session: SESSION })).toEqual([]);
    expect(registry.inbox({ session: 'sess-2' }).map((m) => m.text)).toEqual(['to the other']);
  });

  it('ack: ok → delivered with activity (masked and truncated) in feed; failure → failed with reason', () => {
    const { office, registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const a = sent(registry.send({ agentId: MAIN, text: `Use ${secret} ${'and a bit more '.repeat(40)}` }));
    const b = sent(registry.send({ agentId: MAIN, text: 'another' }));
    const c = sent(registry.send({ agentId: MAIN, text: 'third' }));
    registry.inbox({ session: SESSION });
    office.commit();
    clock.advance(1_000);
    registry.ack({ session: SESSION, results: [{ id: a, ok: true }, { id: b, ok: false, error: 'session refused (drop)' }, { id: c, ok: false }] });
    expect(registry.get(a)).toEqual({ id: a, agentId: MAIN, status: 'delivered', createdAt: clock.now() - 1_000, updatedAt: clock.now() });
    expect(registry.get(b)).toMatchObject({ status: 'failed', error: 'session refused (drop)' });
    expect(registry.get(c)).toMatchObject({ status: 'failed', error: ERR_REFUSED });

    const commit = office.commit();
    const feed = commit.feed.map((f) => f.activity);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'communicate', icon: '✉️', text: 'Message via Habblaud', at: clock.now() });
    expect(feed[0].detail).not.toContain(secret);
    expect(feed[0].detail!.length).toBeLessThanOrEqual(300);
    expect(feed[0].detail).toMatch(/^Use /);
  });

  it('ack from another session, unknown id, or unfetched message is ignored; invalid body throws', () => {
    const { registry } = setup();
    registry.inbox({ session: SESSION });
    const queued = sent(registry.send({ agentId: MAIN, text: 'in queue' }));
    registry.ack({ session: SESSION, results: [{ id: queued, ok: true }, { id: 'not-found', ok: true }, { foo: 1 }, null] });
    expect(registry.get(queued)?.status).toBe('queued');
    const [m] = registry.inbox({ session: SESSION });
    registry.ack({ session: 'sess-2', results: [{ id: m.id, ok: true }] });
    expect(registry.get(m.id)?.status).toBe('sent');
    for (const bad of [null, {}, { session: SESSION }, { session: SESSION, results: 'x' }]) expect(() => registry.ack(bad)).toThrow(/results/);
  });
});

describe('MessageRegistry: timeouts and cleanup', () => {
  it('queued without fetch: fails after 60 s; fetched without ack: fails after 30 s', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const a = sent(registry.send({ agentId: MAIN, text: 'a' }));
    clock.advance(QUEUED_TIMEOUT_MS - 1);
    // Session remains present (polls inbox), but without fetching this one: only timeout counts.
    registry.inbox({ session: 'sess-2' });
    registry.tick();
    expect(registry.get(a)?.status).toBe('queued');
    clock.advance(1);
    registry.tick();
    expect(registry.get(a)).toMatchObject({ status: 'failed', error: ERR_NOT_FETCHED });

    registry.inbox({ session: SESSION });
    const b = sent(registry.send({ agentId: MAIN, text: 'b' }));
    registry.inbox({ session: SESSION });
    clock.advance(SENT_TIMEOUT_MS - 1);
    registry.tick();
    expect(registry.get(b)?.status).toBe('sent');
    clock.advance(1);
    registry.tick();
    expect(registry.get(b)).toMatchObject({ status: 'failed', error: ERR_NOT_CONFIRMED });
  });

  it('late ack (after timeout) still resolves status: plugin knows whether it arrived', () => {
    const { office, registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const id = sent(registry.send({ agentId: MAIN, text: 'arrived late' }));
    registry.inbox({ session: SESSION });
    clock.advance(SENT_TIMEOUT_MS);
    registry.tick();
    expect(registry.get(id)?.status).toBe('failed');
    office.commit();
    registry.ack({ session: SESSION, results: [{ id, ok: true }] });
    expect(registry.get(id)).toMatchObject({ status: 'delivered' });
    expect(registry.get(id)?.error).toBeUndefined();
    expect(office.commit().feed.map((f) => f.activity.detail)).toEqual(['arrived late']);
    // Settled for good: another ack does not change anything.
    registry.ack({ session: SESSION, results: [{ id, ok: false, error: 'x' }] });
    expect(registry.get(id)?.status).toBe('delivered');
  });

  it('agent leaving: unsettled messages fail and presence is cleared', () => {
    const { office, registry } = setup();
    registry.inbox({ session: SESSION });
    const a = sent(registry.send({ agentId: MAIN, text: 'a' }));
    const b = sent(registry.send({ agentId: MAIN, text: 'b' }));
    registry.inbox({ session: SESSION });
    const c = sent(registry.send({ agentId: MAIN, text: 'c' }));
    office.closeMain(MAIN);
    registry.tick();
    for (const id of [a, b, c]) expect(registry.get(id)).toMatchObject({ status: 'failed', error: ERR_GONE });
    expect(registry.reachable().size).toBe(0);
  });

  it('/clear or /resume before fetch: message does not go to new session and fails', () => {
    const { office, registry } = setup();
    registry.inbox({ session: SESSION });
    const id = sent(registry.send({ agentId: MAIN, text: 'for old conversation' }));
    office.switchSession(MAIN, 'sess-new');
    expect(registry.inbox({ session: 'sess-new' })).toEqual([]);
    registry.tick();
    expect(registry.get(id)).toMatchObject({ status: 'failed', error: ERR_SESSION_CHANGED });
    // Sent after switch goes to the new session.
    const next = sent(registry.send({ agentId: MAIN, text: 'for new' }));
    expect(registry.inbox({ session: 'sess-new' }).map((m) => m.id)).toEqual([next]);
  });

  it('settled remain 10 min for queries and then disappear', () => {
    const { registry, clock } = setup();
    registry.inbox({ session: SESSION });
    const id = sent(registry.send({ agentId: MAIN, text: 'a' }));
    registry.ack({ session: SESSION, results: [{ id: registry.inbox({ session: SESSION })[0].id, ok: true }] });
    clock.advance(KEEP_MS - 1);
    registry.tick();
    expect(registry.get(id)?.status).toBe('delivered');
    clock.advance(1);
    registry.tick();
    expect(registry.get(id)).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});

describe('MessageRegistry: demo', () => {
  it('demo agent: mock delivery in ~1 s with activity on agent; never leaves via inbox', () => {
    const { office, registry, clock } = setup();
    office.setDemo(true);
    const demo = office.commit().snapshot.agents.find((a) => a.id.startsWith('demo:') && a.kind === 'main' && a.status !== 'offline')!;
    expect(demo.canMessage).toBe(true);
    const id = sent(registry.send({ agentId: demo.id, text: 'hi, demo' }));
    // Neither mock session nor a real one receives demo message.
    expect(registry.inbox({ session: demo.sessionId })).toEqual([]);
    expect(registry.inbox({ session: SESSION })).toEqual([]);
    clock.advance(999);
    registry.tick();
    expect(registry.get(id)?.status).toBe('queued');
    clock.advance(1);
    registry.tick();
    expect(registry.get(id)?.status).toBe('delivered');
    const after = office.commit().snapshot.agents.find((a) => a.id === demo.id)!;
    expect(after.recent.at(-1)).toMatchObject({ kind: 'communicate', text: 'Message via Habblaud', detail: 'hi, demo' });
  });

  it('demo turned off midway: message fails (agent left)', () => {
    const { office, registry } = setup();
    office.setDemo(true);
    const demo = office.commit().snapshot.agents.find((a) => a.id.startsWith('demo:') && a.kind === 'main' && a.status !== 'offline')!;
    const id = sent(registry.send({ agentId: demo.id, text: 'hi' }));
    office.setDemo(false);
    registry.tick();
    expect(registry.get(id)).toMatchObject({ status: 'failed', error: ERR_GONE });
  });
});
