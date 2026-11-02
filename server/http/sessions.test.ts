// Terminal history (/api/sessions/* routes): lock (disabled feature or non-local Host = 403),
// validation of account/id/path against path traversal (400/404), methods (405), and SSE for a closed
// session (init with transcript conversation, append for new entries), using real parser. As on
// server, routes go through HistorySet (Claude Code and, in one test, another tool).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RecentSessionsResponse, TerminalEntry, TerminalInit } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { openMainAgent, SessionHistory } from '../sources/history';
import { HistorySet, type HistoryProvider } from '../sources/source';
import { encodeCwd } from '../sources/watcher';
import { appendLines, L, symlinkOrSkip, tempDir, writeLines } from '../test/fixtures';
import { createApiHandler } from './app';
import { createRequestGuard } from './guard';
import { Hub } from './sse';
import { TerminalStreams } from './terminal';

setQuiet(true);

const SID = '00000000-0000-4000-8000-0000000000a1';
const OPEN_SID = '00000000-0000-4000-8000-0000000000b2';
const CWD = '/projetos/loja';

interface Served {
  base: string;
  port: string;
  root: string;
  dir: string;
  transcript: string;
  terminals: TerminalStreams;
  close: () => Promise<void>;
}

async function serve(opts: { terminal?: boolean; extra?: (root: string) => HistoryProvider } = {}): Promise<Served> {
  const tmp = tempDir();
  const terminal = opts.terminal ?? true;
  const dir = join(tmp.dir, '.claude');
  const now = Date.now();
  const transcript = join(dir, 'projects', encodeCwd(CWD), `${SID}.jsonl`);
  writeLines(transcript, [
    L.prompt('Fix the cart', { at: now - 60_000 }),
    L.assistant([L.text('Done: the cart adds shipping.')], { at: now - 50_000, stop: 'end_turn' }),
    L.raw('ai-title', { aiTitle: 'Shopping cart' }),
  ]);
  writeLines(join(dir, 'projects', encodeCwd(CWD), `${OPEN_SID}.jsonl`), [L.prompt('Still open', { at: now - 10_000 })]);
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: now,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
    terminal,
  });
  office.addMain({ id: '.claude:7', account: '.claude', sessionId: OPEN_SID, cwd: CWD, role: 'Main agent', startedAt: now, status: 'working' });
  const hub = new Hub(office, { throttleMs: 10 });
  const terminals = new TerminalStreams({ office, transcriptPathOf: () => undefined, sessionPollMs: 20 });
  const history = new HistorySet([new SessionHistory({ accounts: () => accounts.entries(), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) })]);
  if (opts.extra) history.add(opts.extra(tmp.dir));
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, terminal, terminals, sessions: history });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = String((server.address() as AddressInfo).port);
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    root: tmp.dir,
    dir,
    transcript,
    terminals,
    close: () =>
      new Promise((ok) => {
        terminals.stop();
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          tmp.cleanup();
          ok();
        });
      }),
  };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  events: Array<{ event: string; data: unknown }>;
  close: () => void;
}

/** Raw request (unnormalized path, swappable Host); parses SSE if applicable. */
function request(base: string, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const out: Res = { status: res.statusCode ?? 0, headers: res.headers, body: '', events: [], close: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('error', () => {});
      if (!String(res.headers['content-type']).startsWith('text/event-stream')) {
        res.on('data', (c: string) => (out.body += c));
        res.on('end', () => ok(out));
        return;
      }
      let buf = '';
      res.on('data', (c: string) => {
        buf += c;
        for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data !== undefined) out.events.push({ event, data: JSON.parse(data) });
        }
      });
      ok(out);
    });
    req.on('error', fail);
    req.end();
  });
}

const terminalRoute = (account: string, sid: string) => `/api/sessions/${encodeURIComponent(account)}/${encodeURIComponent(sid)}/terminal`;
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 3_000, interval: 10 });

describe('session history: lock', () => {
  it('disabled feature: 403 on both routes', async () => {
    const env = await serve({ terminal: false });
    try {
      for (const path of ['/api/sessions/recent', terminalRoute('.claude', SID)]) {
        const r = await request(env.base, path);
        expect(r.status).toBe(403);
        expect(JSON.parse(r.body).error).toMatch(/disabled/);
      }
      expect(env.terminals.size).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('non-local Host (network IP or HABBLAUD_ALLOWED_HOSTS name): 403; localhost opens', async () => {
    const env = await serve();
    try {
      for (const host of [`192.168.0.10:${env.port}`, `habblaud.lan:${env.port}`]) {
        for (const path of ['/api/sessions/recent', terminalRoute('.claude', SID)]) {
          const r = await request(env.base, path, { headers: { Host: host } });
          expect(r.status).toBe(403);
          expect(JSON.parse(r.body).error).toMatch(/computer running Habblaud/);
        }
      }
      expect(env.terminals.size).toBe(0);
      const ok = await request(env.base, '/api/sessions/recent', { headers: { Host: `localhost:${env.port}` } });
      expect(ok.status).toBe(200);
    } finally {
      await env.close();
    }
  });
});

describe('session history: listing', () => {
  it('GET /api/sessions/recent: open (with agent) and closed, from newest to oldest', async () => {
    const env = await serve();
    try {
      const r = await request(env.base, '/api/sessions/recent');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const body = JSON.parse(r.body) as RecentSessionsResponse;
      expect(body).toMatchObject({ days: 7, limit: 150 });
      expect(body.sessions.map((s) => [s.sessionId, s.open, s.agentId])).toEqual([
        [OPEN_SID, true, '.claude:7'],
        [SID, false, undefined],
      ]);
      expect(body.sessions[1]).toMatchObject({ account: '.claude', title: 'Shopping cart', projectDir: encodeCwd(CWD) });
    } finally {
      await env.close();
    }
  });

  it('methods: POST/PUT -> 405; HEAD valid only on listing; unknown subroute -> 404', async () => {
    const env = await serve();
    try {
      const json = { 'Content-Type': 'application/json' };
      const post = await request(env.base, '/api/sessions/recent', { method: 'POST', headers: json });
      expect(post.status).toBe(405);
      expect(post.headers.allow).toBe('GET, HEAD');
      expect((await request(env.base, '/api/sessions/recent', { method: 'HEAD' })).status).toBe(200);
      const head = await request(env.base, terminalRoute('.claude', SID), { method: 'HEAD' });
      expect(head.status).toBe(405);
      expect(head.headers.allow).toBe('GET');
      expect((await request(env.base, terminalRoute('.claude', SID), { method: 'PUT', headers: json })).status).toBe(405);
      for (const path of ['/api/sessions/', '/api/sessions/x', `/api/sessions/.claude/${SID}`, `/api/sessions/.claude/${SID}/terminal/x`]) {
        expect((await request(env.base, path)).status).toBe(404);
      }
    } finally {
      await env.close();
    }
  });
});

describe('session history: validation (path traversal)', () => {
  it('non-UUID id: 400; unknown account or outside projects/: 404; never opens external file', async ({ skip }) => {
    const env = await serve();
    try {
      writeFileSync(join(env.root, 'secret.jsonl'), `${L.prompt('cannot leak')}\n`);
      const bad400 = [
        `/api/sessions/.claude/..%2F..%2Fsecret/terminal`,
        `/api/sessions/.claude/${SID}%2F..%2F${SID}/terminal`,
        `/api/sessions/.claude/${SID}.jsonl/terminal`,
        `/api/sessions/.claude/%E0%A4%A/terminal`,
        `/api/sessions/%E0%A4%A/${SID}/terminal`,
      ];
      for (const path of bad400) {
        const r = await request(env.base, path);
        expect(r.status, path).toBe(400);
        expect(r.events).toEqual([]);
      }
      const bad404 = [
        `/api/sessions/..%2F..%2F/${SID}/terminal`,
        `/api/sessions/.claude%2F..%2F.claude/${SID}/terminal`,
        `/api/sessions/${encodeURIComponent(env.dir)}/${SID}/terminal`,
        `/api/sessions/.claude-other/${SID}/terminal`,
        terminalRoute('.claude', '00000000-0000-4000-8000-000000000999'),
        // Segments ".." (raw or %2e%2e): normalized URL leaves /api/sessions/ (unknown route).
        `/api/sessions/.claude/../../secret/terminal`,
        `/api/sessions/.claude/%2e%2e/terminal`,
      ];
      for (const path of bad404) {
        const r = await request(env.base, path);
        expect(r.status, path).toBe(404);
        expect(r.events).toEqual([]);
      }
      // Symlink inside projects/ pointing outside: 404.
      const linked = '00000000-0000-4000-8000-0000000000c3';
      symlinkOrSkip(skip, join(env.root, 'secret.jsonl'), join(env.dir, 'projects', encodeCwd(CWD), `${linked}.jsonl`));
      mkdirSync(join(env.dir, 'projects', 'empty'), { recursive: true });
      const r = await request(env.base, terminalRoute('.claude', linked));
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body)).toEqual({ error: 'session not found' });
      expect(env.terminals.size).toBe(0);
    } finally {
      await env.close();
    }
  });
});

describe('session history: another tool', () => {
  const XID = '019a0000-0000-7000-8000-0000000000d4';
  /** Mock provider for account ".codex": one session, read with custom parser (each line becomes "cx-<n>"). */
  const codexHistory = (root: string): HistoryProvider => {
    const path = join(root, 'rollout.jsonl');
    writeFileSync(path, 'a\nb\n');
    let n = 0;
    return {
      provider: 'codex',
      hasAccount: (a) => a === '.codex',
      list: async () => [{ account: '.codex', provider: 'codex', sessionId: XID, projectDir: '2026/10/09', lastAt: Date.now() + 60_000, size: 4, open: false }],
      resolve: (_account, sessionId) =>
        sessionId === XID
          ? { path, createParser: () => ({ push: (): TerminalEntry[] => [{ kind: 'user', id: `cx-${++n}`, at: 0, text: 'cx' }] }) }
          : { status: 404, error: 'session not found' },
    };
  };

  it('listing combines tools; session terminal uses tool-specific parser', async () => {
    const env = await serve({ extra: codexHistory });
    try {
      const body = JSON.parse((await request(env.base, '/api/sessions/recent')).body) as RecentSessionsResponse;
      expect(body.sessions.map((s) => [s.account, s.sessionId, s.provider])).toEqual([
        ['.codex', XID, 'codex'],
        ['.claude', OPEN_SID, undefined],
        ['.claude', SID, undefined],
      ]);
      const s = await request(env.base, terminalRoute('.codex', XID));
      expect(s.status).toBe(200);
      await waitFor(() => expect(s.events.filter((e) => e.event === 'init')).toHaveLength(1));
      const init = s.events[0].data as TerminalInit;
      expect(init.agentId).toBe(`session:.codex:${XID}`);
      expect(init.entries.map((e) => e.id)).toEqual(['cx-1', 'cx-2']);
      s.close();
      // Claude Code account retains its parser; unknown account with usual errors.
      const c = await request(env.base, terminalRoute('.claude', SID));
      await waitFor(() => expect(c.events.filter((e) => e.event === 'init')).toHaveLength(1));
      expect((c.events[0].data as TerminalInit).entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
      c.close();
      expect((await request(env.base, terminalRoute('.codex', '00000000-0000-4000-8000-000000000999'))).status).toBe(404);
      expect(JSON.parse((await request(env.base, terminalRoute('.other', SID))).body)).toEqual({ error: 'unknown account' });
      expect((await request(env.base, terminalRoute('.other', 'x'))).status).toBe(400);
    } finally {
      await env.close();
    }
  });
});

describe('session history: closed session SSE', () => {
  it('init with transcript conversation (real parser); then append with added entries', async () => {
    const env = await serve();
    try {
      const s = await request(env.base, terminalRoute('.claude', SID));
      expect(s.status).toBe(200);
      expect(s.headers['content-type']).toMatch(/^text\/event-stream/);
      await waitFor(() => expect(s.events.filter((e) => e.event === 'init')).toHaveLength(1));
      const init = s.events[0].data as TerminalInit;
      expect(init.agentId).toBe(`session:.claude:${SID}`);
      expect(init.truncated).toBe(false);
      expect(init.entries.map((e) => [e.kind, 'text' in e ? e.text : undefined])).toEqual([
        ['user', 'Fix the cart'],
        ['assistant', 'Done: the cart adds shipping.'],
      ]);
      expect(env.terminals.size).toBe(1);
      // Resumed with /resume: transcript grows and stream follows.
      appendLines(env.transcript, [L.prompt('One more thing')]);
      await waitFor(() => {
        const appended = s.events.filter((e) => e.event === 'append').flatMap((e) => e.data as TerminalEntry[]);
        expect(appended.map((e) => e.kind === 'user' && e.text)).toEqual(['One more thing']);
      });
      s.close();
      await waitFor(() => expect(env.terminals.size).toBe(0));
    } finally {
      await env.close();
    }
  });
});
