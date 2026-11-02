import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyManager, type PtyProcess } from '../pty/manager';
import { agyProfileStates, createAccountsRoutes, nextAgyAcc } from './accounts';

class FakeProc implements PtyProcess {
  constructor(readonly pid: number) {}
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

let home: string;
let agyRoot: string;
let server: Server;
let base: string;
let spawned: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
let claude: { id: string; dir: string; isDefault: boolean }[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'habblaud-accounts-'));
  agyRoot = join(home, '.agy_profiles');
  mkdirSync(join(agyRoot, 'acc1', '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(join(agyRoot, 'acc1', '.gemini', 'antigravity-cli', 'cli.log'), 'I server_oauth.go:42 OAuth: signed in as a.b@gmail.com\n');
  mkdirSync(join(agyRoot, 'acc3', '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(agyRoot, '_backup'));
  writeFileSync(join(agyRoot, 'roles.conf'), 'acc1 impl plan\nacc3 off default\n');
  spawned = [];
  claude = [{ id: '.claude', dir: join(home, '.claude'), isDefault: true }];
  let pid = 100;
  const ptys = new PtyManager({
    spawn: (file, args, o) => {
      spawned.push({ file, args, cwd: o.cwd, env: o.env });
      return new FakeProc(++pid);
    },
    claudeBin: process.execPath,
    accounts: () => claude,
    agent: () => undefined,
    onChange: () => {},
  });
  const handler = createAccountsRoutes({
    ptys,
    home,
    agyRoot,
    claudeBin: process.execPath,
    agyBin: process.execPath,
    claudeAccounts: () => claude,
    addClaudeDir: (dir) => {
      const id = dir.slice(dir.lastIndexOf('/') + 1);
      claude.push({ id, dir, isDefault: false });
      return id;
    },
    refresh: () => {},
  });
  server = createServer((req, res) => handler(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((ok) => server.close(ok));
  rmSync(home, { recursive: true, force: true });
});

const post = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

describe('Antigravity profiles on disk', () => {
  it('lists accN folders with their state (signed in = OAuth e-mail in the agy log) and finds the first free name', () => {
    // agy makes its state folder before you sign in: that alone is not "ready".
    mkdirSync(join(agyRoot, 'acc4', '.gemini', 'antigravity-cli'), { recursive: true });
    expect(agyProfileStates(agyRoot)).toEqual([
      { acc: 'acc1', account: 'agy:acc1', state: 'ready' },
      { acc: 'acc3', account: 'agy:acc3', state: 'off' },
      { acc: 'acc4', account: 'agy:acc4', state: 'new' },
    ]);
    expect(nextAgyAcc(agyRoot)).toBe('acc2');
    expect(agyProfileStates(join(home, 'none'))).toEqual([]);
  });
});

describe('/api/accounts', () => {
  it('GET lists the Antigravity profiles', async () => {
    const r = await fetch(`${base}/api/accounts`);
    expect(((await r.json()) as { agy: unknown[] }).agy).toHaveLength(2);
  });

  it('adds a Claude account: ~/.claude-<name> with projects/, watched, and `claude auth login` in it', async () => {
    const r = await post('/api/accounts/claude', { name: 'nova' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ account: '.claude-nova', pty: { agentId: 'login:.claude-nova' } });
    expect(spawned[0]).toMatchObject({ args: ['auth', 'login'], cwd: home });
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude-nova'));
    expect(agyProfileStates(agyRoot)).toHaveLength(2);
    expect((await post('/api/accounts/claude', { name: 'nova' })).status).toBe(409);
    expect((await post('/api/accounts/claude', { name: '../x' })).status).toBe(400);
  });

  it('adds an Antigravity account in the first free accN, and reuses one whose sign-in was not finished', async () => {
    const r = await post('/api/accounts/agy');
    expect(r.body).toMatchObject({ acc: 'acc2', account: 'agy:acc2', pty: { agentId: 'login:agy:acc2' } });
    expect(spawned[0]).toMatchObject({ args: ['acc2'], cwd: join(agyRoot, 'acc2') });
    // acc2 has no agy state yet: the next "add" opens it again instead of creating acc4.
    expect((await post('/api/accounts/agy')).body.acc).toBe('acc2');
  });

  it('signs in again: Claude default account without CLAUDE_CONFIG_DIR, Antigravity with agy-as accN', async () => {
    expect((await post('/api/accounts/login', { account: '.claude' })).status).toBe(201);
    expect(spawned[0].args).toEqual(['auth', 'login']);
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect((await post('/api/accounts/login', { account: 'agy:acc3' })).body.acc).toBe('acc3');
    expect(spawned[1].args).toEqual(['acc3']);
    expect((await post('/api/accounts/login', { account: 'agy:acc9' })).status).toBe(404);
  });

  it('refuses requests from another site', async () => {
    const r = await fetch(`${base}/api/accounts/agy`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
    expect(r.status).toBe(403);
    expect(spawned).toHaveLength(0);
  });
});
