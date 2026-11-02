// Codex hook events route (POST /api/codex/events) through real routes (guard and app): forwards to live
// Codex source (mock) with the right account (via CODEX_HOME directory), local Host only, POST with JSON only, body up
// to 256 KB; without source, {ok: false}. Synthetic data.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { CodexLive } from '../sources/codex/live';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { codexAccountOf, parseCodexEvent } from './http';

setQuiet(true);

const EVENT = { session_id: '0199b0c0-1234-7abc-8def-0123456789ab', hook_event_name: 'UserPromptSubmit', cwd: '/p/loja', prompt: 'hi' };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(live?: CodexLive): Promise<{ base: string; accounts: AccountsService }> {
  const tmp = tempDir();
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  // Disambiguated Codex account (".codex~2"): host path takes precedence.
  accounts.setProviderAccounts('codex', [
    { dir: '/montada/a', detected: { id: '.codex', configDir: '/Users/x/.codex', short: 'X', name: 'Codex X', color: '#000' } },
    { dir: '/montada/b', detected: { id: '.codex', configDir: '/Volumes/y/.codex', short: 'Y', name: 'Codex Y', color: '#111' } },
  ]);
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, codexLive: live });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () =>
    new Promise((ok) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => {
        tmp.cleanup();
        ok();
      });
    });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, accounts };
}

describe('POST /api/codex/events', () => {
  it('forwards event to Codex source with account from CODEX_HOME folder (or hook) and returns {ok}', async () => {
    const calls: Array<[string | undefined, Record<string, unknown>]> = [];
    const { base } = await serve({ applyHookEvent: (a, e) => (calls.push([a, e]), true) });
    let r = await request(base, '/api/codex/events', { method: 'POST', body: { account: '.codex', codexHome: '/Volumes/y/.codex', event: EVENT } });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    r = await request(base, '/api/codex/events', { method: 'POST', body: { account: '.codex', codexHome: '/montada/a/', event: EVENT } });
    r = await request(base, '/api/codex/events', { method: 'POST', body: { account: '.codex-nova', codexHome: '/outra/.codex-nova', event: EVENT } });
    r = await request(base, '/api/codex/events', { method: 'POST', body: { event: EVENT } });
    expect(calls).toEqual([
      ['.codex~2', EVENT],
      ['.codex', EVENT],
      ['.codex-nova', EVENT],
      [undefined, EVENT],
    ]);
  });

  it('without Codex source (or if it fails): 200 {ok: false}', async () => {
    let s = await serve();
    expect(await request(s.base, '/api/codex/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
    await close!();
    s = await serve({
      applyHookEvent: () => {
        throw new Error('failed');
      },
    });
    expect(await request(s.base, '/api/codex/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('non-local Host: 403; GET: 405; non-JSON: 415; invalid body: 400; over 256 KB: 413', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyHookEvent: (_a, e) => (calls.push(e), true) });
    for (const host of ['habblaud.lan:4747', '192.168.0.10:4747']) {
      const r = await request(base, '/api/codex/events', { method: 'POST', headers: { Host: host }, body: { event: EVENT } });
      expect(r.status, host).toBe(403);
    }
    expect((await request(base, '/api/codex/events')).status).toBe(405);
    expect((await request(base, '/api/codex/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    for (const body of [{}, { event: 'x' }, { event: { session_id: 's' } }, []]) {
      expect((await request(base, '/api/codex/events', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    }
    const big = { event: { ...EVENT, prompt: 'x'.repeat(300 * 1024) } };
    expect((await request(base, '/api/codex/events', { method: 'POST', body: big })).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('pure parts: parseCodexEvent and codexAccountOf', () => {
    expect(parseCodexEvent({ account: ' .codex ', codexHome: '/u/.codex', event: EVENT })).toEqual({ account: '.codex', codexHome: '/u/.codex', event: EVENT });
    expect(() => parseCodexEvent({ event: {} })).toThrow();
    expect(codexAccountOf([], '.codex', 'relative/.codex')).toBe('.codex');
  });
});
