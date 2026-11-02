// Office messages via real routes (guard, app, and server/messages/http.ts): config lock
// (terminal + HABBLAUD_MENSAGENS), route lock (feature disabled / non-local Host), statuses (400, 404,
// 405, 409, 429), full flow page -> plugin inbox -> ack -> query, and demo.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxMessage, OfficeSnapshot, OutboxMessage } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { loadConfig, messagesOffReason } from '../config';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { request } from '../test/permission-server';
import { tempDir } from '../test/fixtures';
import { createMessageRoutes } from './http';
import { MessageRegistry, type MessageRegistryOptions } from './registry';

setQuiet(true);

const MAIN = 'acc:1';
const SESSION = 'sess-1';

interface MessageServer {
  base: string;
  office: Office;
  registry?: MessageRegistry;
  close(): Promise<void>;
}

/** Office + Hub + real routes on a free 127.0.0.1 port, with a main agent in session "sess-1". */
async function serveMessages(opts: { enabled?: boolean; demo?: boolean; registry?: Partial<MessageRegistryOptions> } = {}): Promise<MessageServer> {
  const tmp = tempDir();
  const enabled = opts.enabled ?? true;
  const late: { registry?: MessageRegistry } = {};
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: Date.now(),
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    terminal: true,
    messages: enabled ? () => late.registry?.reachable() ?? new Set() : undefined,
  });
  const hub = new Hub(office, { throttleMs: 10 });
  const registry = enabled
    ? new MessageRegistry({
        office,
        demoAgent: (id) => office.demoAgent(id),
        demoDeliver: (id, text) => office.deliverDemoMessage(id, text),
        tickMs: 20,
        ...opts.registry,
      })
    : undefined;
  late.registry = registry;
  registry?.start();
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: 't',
    inDocker: false,
    terminal: true,
    messages: registry ? createMessageRoutes(registry) : undefined,
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  office.addMain({ id: MAIN, account: 'acc', sessionId: SESSION, cwd: '/p/loja', role: 'Main agent', startedAt: Date.now(), status: 'idle' });
  if (opts.demo) office.setDemo(true);
  return {
    base: `http://127.0.0.1:${port}`,
    office,
    registry,
    close: () =>
      new Promise((ok) => {
        registry?.stop();
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          tmp.cleanup();
          ok();
        });
      }),
  };
}

let srv: MessageServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const post = (s: MessageServer, path: string, body: unknown, headers?: Record<string, string>) => request(s.base, path, { method: 'POST', body, headers });
const snapshot = async (s: MessageServer) => (await request(s.base, '/api/snapshot')).json as OfficeSnapshot;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe('messages lock (config)', () => {
  it('messagesOffReason: terminal lock and HABBLAUD_MENSAGENS (0/false/off/no disable)', () => {
    expect(messagesOffReason({}, '127.0.0.1', false)).toBeUndefined();
    for (const v of ['1', 'true', 'sim', '']) expect(messagesOffReason({ HABBLAUD_MENSAGENS: v }, '127.0.0.1', false), v).toBeUndefined();
    for (const v of ['0', 'false', 'off', 'no']) expect(messagesOffReason({ HABBLAUD_MENSAGENS: v }, '127.0.0.1', false)).toBe(`HABBLAUD_MENSAGENS=${v}`);
    expect(messagesOffReason({}, '0.0.0.0', false)).toMatch(/^same lock as the terminal: the port is exposed/);
    expect(messagesOffReason({ HABBLAUD_TERMINAL: '0' }, '127.0.0.1', false)).toMatch(/HABBLAUD_TERMINAL=0/);
    // Enabling messages does not enable what the terminal lock disables.
    expect(messagesOffReason({ HABBLAUD_MENSAGENS: '1' }, '0.0.0.0', false)).toBeDefined();
    expect(messagesOffReason({ HABBLAUD_MENSAGENS: '1', HABBLAUD_BIND: '127.0.0.1' }, '0.0.0.0', true)).toBeUndefined();
    expect(messagesOffReason({ HABBLAUD_MENSAGENS: '1' }, '0.0.0.0', true)).toMatch(/HABBLAUD_BIND/);
  });

  it('loadConfig populates ServerConfig.messages', () => {
    const tmp = tempDir();
    try {
      const cfg = (env: NodeJS.ProcessEnv) => loadConfig({ HOME: tmp.dir, HABBLAUD_IN_DOCKER: '0', ...env }, []);
      expect(cfg({})).toMatchObject({ terminal: true, messages: true });
      expect(cfg({ HABBLAUD_MENSAGENS: '0' })).toMatchObject({ terminal: true, messages: false });
      expect(cfg({ HABBLAUD_TERMINAL: '0' })).toMatchObject({ terminal: false, messages: false });
      expect(cfg({ HABBLAUD_HOST: '0.0.0.0', HABBLAUD_MENSAGENS: '1' })).toMatchObject({ terminal: false, messages: false });
      expect(cfg({ HABBLAUD_IN_DOCKER: '1', HABBLAUD_HOST: '0.0.0.0', HABBLAUD_BIND: '127.0.0.1' })).toMatchObject({ terminal: true, messages: true });
    } finally {
      tmp.cleanup();
    }
  });
});

describe('route lock', () => {
  const ROUTES: Array<[string, string]> = [
    ['POST', '/api/messages'],
    ['GET', '/api/messages/x'],
    ['POST', '/api/mod/inbox'],
    ['POST', '/api/mod/inbox/ack'],
  ];

  it('disabled: 403 on all routes; health and snapshot report messages: false; /api/mod/summary stays up', async () => {
    srv = await serveMessages({ enabled: false });
    for (const [method, path] of ROUTES) {
      const r = await request(srv.base, path, { method, body: method === 'POST' ? {} : undefined });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json).toMatchObject({ error: expect.stringMatching(/disabled/) });
    }
    expect((await request(srv.base, '/api/health')).json).toMatchObject({ messages: false });
    expect((await snapshot(srv)).meta.messages).toBe(false);
    const summary = await request(srv.base, '/api/mod/summary');
    expect(summary.status).toBe(200);
    expect(summary.json).toMatchObject({ version: 't', agents: 1 });
  });

  it('non-local Host (proxy/tunnel from HABBLAUD_ALLOWED_HOSTS or network IP): 403', async () => {
    srv = await serveMessages();
    expect((await request(srv.base, '/api/health')).json).toMatchObject({ messages: true });
    expect((await snapshot(srv)).meta.messages).toBe(true);
    for (const host of ['habblaud.lan', '192.168.0.10:4747']) {
      for (const [method, path] of ROUTES) {
        const r = await request(srv.base, path, { method, body: method === 'POST' ? { session: SESSION } : undefined, headers: { Host: host } });
        expect(r.status, `${host} ${path}`).toBe(403);
        expect(r.json).toMatchObject({ error: expect.stringMatching(/computer running Habblaud/) });
      }
    }
    expect((await post(srv, '/api/mod/inbox', { session: SESSION }, { Host: 'localhost:4747' })).status).toBe(200);
  });

  it('guard: POST without JSON (415) or from other origin (403) blocked before route', async () => {
    srv = await serveMessages();
    expect((await post(srv, '/api/messages', 'agentId=x&text=hi', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await post(srv, '/api/mod/inbox', { session: SESSION }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(srv, '/api/messages', { agentId: MAIN, text: 'hi' }, { Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('routes', () => {
  it('400 (invalid body, empty, too long), 404 (unknown agent or message), 405, 409, and 429', async () => {
    srv = await serveMessages();
    for (const body of [{}, '{broken', { agentId: MAIN }, { agentId: MAIN, text: '   ' }, { agentId: MAIN, text: 'x'.repeat(20_001) }]) {
      const r = await post(srv, '/api/messages', body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(r.json).toMatchObject({ error: expect.any(String) });
    }
    expect((await post(srv, '/api/messages', { agentId: 'not-found', text: 'hi' })).status).toBe(404);
    expect((await request(srv.base, '/api/messages/not-found')).status).toBe(404);
    // Session without connected plugin.
    const noPlugin = await post(srv, '/api/messages', { agentId: MAIN, text: 'hi' });
    expect(noPlugin.status).toBe(409);
    expect(noPlugin.json).toMatchObject({ error: expect.stringMatching(/habblaud-mensagens/) });
    expect((await request(srv.base, '/api/messages')).status).toBe(405);
    expect((await request(srv.base, '/api/mod/inbox')).status).toBe(405);
    expect((await request(srv.base, '/api/messages/x', { method: 'POST', body: {} })).status).toBe(405);
    expect((await request(srv.base, '/api/messages/x/y')).status).toBe(404);
    expect((await post(srv, '/api/mod/inbox', {})).status).toBe(400);
    expect((await post(srv, '/api/mod/inbox/ack', { session: SESSION })).status).toBe(400);

    // With plugin: 5 queued, 6th gets 429.
    expect((await post(srv, '/api/mod/inbox', { session: SESSION, account: 'acc' })).json).toEqual({ messages: [] });
    for (let i = 0; i < 5; i++) expect((await post(srv, '/api/messages', { agentId: MAIN, text: `m${i}` })).status).toBe(201);
    const full = await post(srv, '/api/messages', { agentId: MAIN, text: 'too-many' });
    expect(full.status).toBe(429);
    expect(full.json).toMatchObject({ error: expect.stringMatching(/5 messages/) });
  });

  it('inbox for unknown session: 200 with no messages (never 404)', async () => {
    srv = await serveMessages();
    const r = await post(srv, '/api/mod/inbox', { session: 'not-found', account: 'acc' });
    expect(r).toMatchObject({ status: 200, json: { messages: [] } });
    expect((await post(srv, '/api/mod/inbox/ack', { session: 'not-found', results: [{ id: 'x', ok: true }] })).json).toEqual({ ok: true });
  });

  it('flow: plugin connects (canMessage) → page sends (201) → plugin fetches → acks → page queries (delivered) and feed shows', async () => {
    srv = await serveMessages();
    expect((await snapshot(srv)).agents.find((a) => a.id === MAIN)?.canMessage).toBeUndefined();
    expect((await post(srv, '/api/mod/inbox', { session: SESSION, account: 'acc' })).json).toEqual({ messages: [] });
    await sleep(30);
    expect((await snapshot(srv)).agents.find((a) => a.id === MAIN)?.canMessage).toBe(true);

    const text = 'Now run the tests again\nand tell me what failed ';
    const created = await post(srv, '/api/messages', { agentId: MAIN, text });
    expect(created.status).toBe(201);
    const msg = created.json as OutboxMessage;
    expect(msg).toMatchObject({ agentId: MAIN, status: 'queued' });
    expect(created.text).not.toContain('tests');
    expect(((await request(srv.base, `/api/messages/${encodeURIComponent(msg.id)}`)).json as OutboxMessage).status).toBe('queued');

    const inbox = (await post(srv, '/api/mod/inbox', { session: SESSION, account: 'acc' })).json as { messages: InboxMessage[] };
    expect(inbox.messages).toEqual([{ id: msg.id, text }]);
    expect(((await request(srv.base, `/api/messages/${encodeURIComponent(msg.id)}`)).json as OutboxMessage).status).toBe('sent');

    expect((await post(srv, '/api/mod/inbox/ack', { session: SESSION, results: [{ id: msg.id, ok: true }] })).json).toEqual({ ok: true });
    const done = (await request(srv.base, `/api/messages/${encodeURIComponent(msg.id)}`)).json as OutboxMessage;
    expect(done).toMatchObject({ id: msg.id, status: 'delivered' });
    expect(done.updatedAt).toBeGreaterThanOrEqual(done.createdAt);
    const agent = (await snapshot(srv)).agents.find((a) => a.id === MAIN)!;
    expect(agent.recent.at(-1)).toMatchObject({ icon: '✉️', text: 'Message via Habblaud', detail: 'Now run the tests again and tell me what failed' });
  });

  it('session disappears (no polling): canMessage returns to undefined and queued message times out', async () => {
    let now = 1_000_000;
    srv = await serveMessages({ registry: { now: () => now, presenceMs: 100, queuedTimeoutMs: 150 } });
    await post(srv, '/api/mod/inbox', { session: SESSION });
    const created = await post(srv, '/api/messages', { agentId: MAIN, text: 'hi' });
    expect(created.status).toBe(201);
    const msg = created.json as OutboxMessage;
    now += 250;
    srv.registry!.tick();
    expect((await snapshot(srv)).agents.find((a) => a.id === MAIN)?.canMessage).toBeUndefined();
    expect((await request(srv.base, `/api/messages/${encodeURIComponent(msg.id)}`)).json).toMatchObject({ status: 'failed', error: expect.stringMatching(/didn't fetch the message/) });
    expect((await post(srv, '/api/messages', { agentId: MAIN, text: 'hi' })).status).toBe(409);
  });

  it('demo: message to a demo agent is delivered without going through any session', async () => {
    srv = await serveMessages({ demo: true, registry: { demoDeliveryMs: 50 } });
    const demo = (await snapshot(srv)).agents.find((a) => a.id.startsWith('demo:') && a.kind === 'main' && a.status !== 'offline')!;
    expect(demo.canMessage).toBe(true);
    const created = await post(srv, '/api/messages', { agentId: demo.id, text: 'hi, demo' });
    expect(created.status).toBe(201);
    const msg = created.json as OutboxMessage;
    expect((await post(srv, '/api/mod/inbox', { session: demo.sessionId })).json).toEqual({ messages: [] });
    await sleep(150);
    expect((await request(srv.base, `/api/messages/${encodeURIComponent(msg.id)}`)).json).toMatchObject({ status: 'delivered' });
    srv.office.tick();
    const after = (await snapshot(srv)).agents.find((a) => a.id === demo.id)!;
    expect(after.recent.some((a) => a.text === 'Message via Habblaud' && a.detail === 'hi, demo')).toBe(true);
  });

  it('demo with feature disabled: demo agents do not receive either', async () => {
    srv = await serveMessages({ enabled: false, demo: true });
    expect((await snapshot(srv)).agents.filter((a) => a.canMessage)).toEqual([]);
  });
});
