import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ptyRequestProblem } from '../http/pty';
import {
  claudeBinFrom,
  findExecutable,
  fixSpawnHelper,
  isExecutableFile,
  MAX_PTYS,
  PtyError,
  PtyManager,
  spawnProblem,
  type PtyAgentRef,
  type PtyManagerOptions,
  type PtyProcess,
  type PtyScreen,
  type SpawnPty,
} from './manager';
import type { ProcInfo } from './procinfo';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PID = 4242;
const STARTED = 1_791_557_339_236;

class FakeProc implements PtyProcess {
  data: (d: string) => void = () => {};
  exit: (e: { exitCode: number }) => void = () => {};
  written: string[] = [];
  constructor(readonly pid: number) {}
  onData(cb: (d: string) => void) {
    this.data = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  kill() {
    this.exit({ exitCode: 0 });
  }
}

interface Setup {
  manager: PtyManager;
  spawned: { args: string[]; cwd: string }[];
  alive: Set<number>;
  killPid: ReturnType<typeof vi.fn>;
  forceKill: ReturnType<typeof vi.fn>;
}

/** Manager with external dependencies mocked: an agent "acc:4242" open in another terminal, alive and verified. */
function setup(over: Partial<Omit<PtyManagerOptions, 'agent'>> & { agent?: Partial<PtyAgentRef>; proc?: ProcInfo | undefined; session?: unknown } = {}): Setup {
  const { agent: agentOver, proc: procOver, session, ...opts } = over;
  const alive = new Set([PID]);
  const spawned: Setup['spawned'] = [];
  let nextPid = 9000;
  const agent: PtyAgentRef = { id: `acc:${PID}`, kind: 'main', account: 'acc', sessionId: SESSION, cwd: tmpdir(), ...agentOver };
  const proc = 'proc' in over ? procOver : { startMs: STARTED - 800, name: 'claude' };
  const killPid = vi.fn((pid: number) => void alive.delete(pid));
  const forceKill = vi.fn((pid: number) => void alive.delete(pid));
  const manager = new PtyManager({
    spawn: (_file, args, o) => {
      spawned.push({ args, cwd: o.cwd });
      return new FakeProc(++nextPid);
    },
    claudeBin: process.execPath,
    accounts: () => [{ id: 'acc', dir: join(tmpdir(), 'conta'), isDefault: true }],
    agent: (id) => (id === agent.id ? agent : undefined),
    onChange: () => {},
    readSession: () => session ?? { sessionId: SESSION, startedAt: STARTED },
    procInfo: async (pid) => (alive.has(pid) ? proc : undefined),
    isAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    killPid,
    forceKill,
    ...opts,
  });
  return { manager, spawned, alive, killPid, forceKill };
}

async function rejects(p: Promise<unknown>, status: number): Promise<PtyError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PtyError);
  expect((err as PtyError).status).toBe(status);
  return err as PtyError;
}

describe('PtyManager: check process before stopping', () => {
  it('stops when registration, start time, and executable match', async () => {
    const s = setup();
    await s.manager.stop(`acc:${PID}`);
    expect(s.killPid).toHaveBeenCalledWith(PID, expect.objectContaining({ name: 'claude' }));
  });

  it('rejects when registration belongs to another session', async () => {
    const s = setup({ session: { sessionId: 'other', startedAt: STARTED } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('rejects a reused PID (live process started well after registration)', async () => {
    const s = setup({ proc: { startMs: STARTED + 3_600_000, name: 'claude' } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('rejects when executable is not Claude Code', async () => {
    const s = setup({ proc: { startMs: STARTED - 800, name: 'chrome' } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('on Windows, registration FILETIME must match exactly', async () => {
    const reg = { sessionId: SESSION, startedAt: STARTED, procStart: '134360309381229341' };
    const other = setup({ session: reg, proc: { startMs: STARTED - 800, name: 'claude', fileTime: '134360309381229342' } });
    await rejects(other.manager.stop(`acc:${PID}`), 409);
    const same = setup({ session: reg, proc: { startMs: STARTED - 800, name: 'claude', fileTime: '134360309381229341' } });
    await same.manager.stop(`acc:${PID}`);
    expect(same.killPid).toHaveBeenCalledOnce();
  });

  it('rejects when nothing can be learned about the process', async () => {
    const s = setup({ proc: undefined });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });
});

describe('PtyManager: takeover', () => {
  it('terminates there and resumes same conversation here', async () => {
    const s = setup();
    const info = await s.manager.takeover(`acc:${PID}`);
    expect(s.killPid).toHaveBeenCalledOnce();
    expect(s.spawned).toEqual([{ args: ['--resume', SESSION], cwd: tmpdir() }]);
    expect(info).toMatchObject({ resumed: SESSION, fromAgent: `acc:${PID}` });
  });

  it('an agent with a terminal of its own (the Antigravity boss) is reopened, nothing is stopped', async () => {
    const own = { id: 'p9-1', pid: 1, cwd: tmpdir(), account: 'agy:acc1', agentId: 'agy:acc1', startedAt: 0 };
    const s = setup({ reopen: (id) => (id === 'agy:acc1' ? own : undefined) });
    expect(await s.manager.takeover('agy:acc1')).toBe(own);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.spawned).toEqual([]);
  });

  it('nonexistent folder: rejects before stopping session there', async () => {
    const s = setup({ agent: { cwd: join(tmpdir(), 'nonexistent-habblaud-test') } });
    await rejects(s.manager.takeover(`acc:${PID}`), 400);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.alive.has(PID)).toBe(true);
  });

  it('unknown account: rejects before stopping', async () => {
    const s = setup({ agent: { account: 'gone', id: `gone:${PID}` } });
    await rejects(s.manager.takeover(`gone:${PID}`), 400);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('terminal limit: rejects before stopping', async () => {
    const s = setup();
    for (let i = 0; i < MAX_PTYS; i++) s.manager.create({ cwd: tmpdir() });
    await rejects(s.manager.takeover(`acc:${PID}`), 429);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('last slot reserved for takeover in progress', async () => {
    const s = setup();
    for (let i = 0; i < MAX_PTYS - 1; i++) s.manager.create({ cwd: tmpdir() });
    const run = s.manager.takeover(`acc:${PID}`);
    expect(() => s.manager.create({ cwd: tmpdir() })).toThrow(/limit/);
    await run;
    expect(s.spawned).toHaveLength(MAX_PTYS);
  });

  it('simultaneous requests for same agent open only one terminal', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.manager.takeover(`acc:${PID}`), s.manager.takeover(`acc:${PID}`)]);
    expect(a.id).toBe(b.id);
    expect(s.killPid).toHaveBeenCalledOnce();
    expect(s.spawned).toHaveLength(1);
  });

  it('did not exit in time: force kills and proceeds with --resume', async () => {
    const s = setup({ killPid: vi.fn() });
    await s.manager.takeover(`acc:${PID}`);
    expect(s.forceKill).toHaveBeenCalledWith(PID);
    expect(s.spawned).toHaveLength(1);
  });

  it('not even force kill: error, without opening duplicate conversation', async () => {
    const s = setup({ killPid: vi.fn(), forceKill: vi.fn() });
    const err = await rejects(s.manager.takeover(`acc:${PID}`), 500);
    expect(err.message).toMatch(/still open/);
    expect(s.spawned).toHaveLength(0);
  });

  it('non-runnable claude: rejects before stopping', async () => {
    const s = setup({ claudeBin: join(tmpdir(), 'nonexistent-habblaud-claude') });
    await rejects(s.manager.takeover(`acc:${PID}`), 503);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.alive.has(PID)).toBe(true);
  });

  it('failed to open here after stopping there: error explains how to continue conversation', async () => {
    const s = setup({
      spawn: () => {
        throw new Error('posix_spawnp failed.');
      },
    });
    const err = await rejects(s.manager.takeover(`acc:${PID}`), 500);
    expect(err.message).toContain(`claude --resume ${SESSION}`);
    expect(err.message).toContain('posix_spawnp failed');
  });

  it('old registration (reused PID): does not stop anyone', async () => {
    const s = setup({ proc: { startMs: STARTED + 86_400_000, name: 'node' } });
    await rejects(s.manager.takeover(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.spawned).toHaveLength(0);
  });
});

/** Mock SSE response: stores written chunks. */
function fakeStream(): { req: IncomingMessage; res: ServerResponse; out: string[] } {
  const out: string[] = [];
  const req = Object.assign(new EventEmitter(), { socket: { setTimeout() {}, setNoDelay() {} } }) as unknown as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead() {},
    write(chunk: string) {
      out.push(chunk);
      return true;
    },
    end() {
      (this as { writableEnded: boolean }).writableEnded = true;
    },
  }) as unknown as ServerResponse;
  return { req, res, out };
}

describe('PtyManager: screen for connecting clients', () => {
  it('sends assembled screen and then output that arrived while it finished processing', () => {
    const pendingWrites: (() => void)[] = [];
    let content = '';
    const screen: PtyScreen = {
      write(data, done) {
        // Process later, like xterm.
        pendingWrites.push(() => {
          content += data;
          done?.();
        });
      },
      resize() {},
      serialize: () => `[screen:${content}]`,
      dispose() {},
    };
    let proc: FakeProc | undefined;
    const manager = new PtyManager({
      spawn: () => (proc = new FakeProc(77)),
      claudeBin: process.execPath,
      accounts: () => [{ id: 'acc', dir: tmpdir(), isDefault: true }],
      agent: () => undefined,
      onChange: () => {},
      createScreen: () => screen,
    });
    const info = manager.create({ cwd: tmpdir() });
    proc!.data('before ');
    const { req, res, out } = fakeStream();
    manager.attach(info.id, req, res);
    proc!.data('during');
    // Nothing beyond header until screen processes preceding data.
    expect(out.join('')).not.toContain('screen');
    for (const w of pendingWrites.splice(0)) w();
    const text = out.join('');
    expect(text.indexOf('[screen:before ]')).toBeGreaterThan(-1);
    expect(text.indexOf('during')).toBeGreaterThan(text.indexOf('[screen:before ]'));
    proc!.data('after');
    expect(out.join('')).toContain('after');
  });
});

describe('ptyRequestProblem', () => {
  const req = (h: Record<string, string>, addr = '127.0.0.1') => ({ socket: { remoteAddress: addr }, headers: h }) as unknown as IncomingMessage;

  it('accepts same computer, same origin', () => {
    expect(ptyRequestProblem(req({ host: 'localhost:4747', origin: 'http://localhost:4747', 'sec-fetch-site': 'same-origin' }))).toBeNull();
    expect(ptyRequestProblem(req({ host: '127.0.0.1:4747' }, '::ffff:127.0.0.1'))).toBeNull();
  });

  it('rejects external connection, network Host, other origin, and cross-site request', () => {
    expect(ptyRequestProblem(req({ host: 'localhost:4747' }, '192.168.0.9'))).toMatch(/computer running Habblaud/);
    expect(ptyRequestProblem(req({ host: 'meu-mac.local:4747' }))).toMatch(/localhost/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', origin: 'http://evil.example' }))).toMatch(/origin/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', 'sec-fetch-site': 'same-site' }))).toMatch(/origin/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', 'sec-fetch-site': 'cross-site' }))).toMatch(/origin/);
  });
});

describe('load node-pty and find claude', () => {
  const unix = process.platform !== 'win32';

  /** Temporary directory, deleted at end. */
  function withDir(fn: (dir: string) => void | Promise<void>) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), 'habblaud-pty-'));
      try {
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it.runIf(unix)(
    'restores execute permission to spawn-helper (node-pty 1.1.0 publishes without it)',
    withDir((dir) => {
      const sub = join(dir, 'prebuilds', 'darwin-arm64');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'spawn-helper'), '');
      chmodSync(join(sub, 'spawn-helper'), 0o644);
      fixSpawnHelper(dir, 'darwin', 'arm64');
      expect(statSync(join(sub, 'spawn-helper')).mode & 0o777).toBe(0o755);
      // Without any spawn-helper: nothing to do, no error.
      expect(() => fixSpawnHelper(join(dir, 'empty'), 'darwin', 'arm64')).not.toThrow();
    }),
  );

  it('test terminal: indicates reason when spawn fails or process exits with error', async () => {
    const failing: SpawnPty = () => {
      throw new Error('posix_spawnp failed.');
    };
    expect(await spawnProblem(failing)).toMatch(/posix_spawnp failed/);
    const exiting = (code: number): SpawnPty => () => {
      const p = new FakeProc(1);
      queueMicrotask(() => p.exit({ exitCode: code }));
      return p;
    };
    expect(await spawnProblem(exiting(0))).toBeNull();
    expect(await spawnProblem(exiting(1))).toMatch(/code 1/);
  });

  it.runIf(unix)(
    'executable: must exist and be runnable; PATH skips non-runnable',
    withDir((dir) => {
      const a = join(dir, 'a');
      const b = join(dir, 'b');
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(join(a, 'claude'), '#!/bin/sh\n');
      chmodSync(join(a, 'claude'), 0o644);
      writeFileSync(join(b, 'claude'), '#!/bin/sh\n');
      chmodSync(join(b, 'claude'), 0o755);
      expect(isExecutableFile(join(a, 'claude'))).toBe(false);
      expect(isExecutableFile(join(b, 'claude'))).toBe(true);
      expect(isExecutableFile(dir)).toBe(false);
      const env = { PATH: `${a}:${b}` };
      expect(findExecutable('claude', env)).toBe(join(b, 'claude'));
      expect(claudeBinFrom(env)).toBe(join(b, 'claude'));
      // HABBLAUD_CLAUDE_BIN: a path is used as-is; a name is looked up in PATH.
      expect(claudeBinFrom({ ...env, HABBLAUD_CLAUDE_BIN: join(a, 'claude') })).toBe(join(a, 'claude'));
      expect(claudeBinFrom({ ...env, HABBLAUD_CLAUDE_BIN: 'claude' })).toBe(join(b, 'claude'));
      expect(claudeBinFrom({ ...env, HABBLAUD_CLAUDE_BIN: 'other' })).toBeUndefined();
    }),
  );
});

describe('PtyManager: interactive agy of an Antigravity worker', () => {
  const agy = { bin: process.execPath, cwd: tmpdir(), worker: (id: string) => (id === 'agy:acc2' ? { acc: 'acc2', account: 'agy:acc2' } : undefined) };

  it('opens agy-as <acc> in the Antigravity room, tied to the worker; a second open returns the same terminal', () => {
    const s = setup({ agy });
    const info = s.manager.openAgy({ agent: 'agy:acc2', cols: 120, rows: 32 });
    expect(s.spawned).toEqual([{ args: ['acc2'], cwd: tmpdir() }]);
    expect(info).toMatchObject({ agentId: 'agy:acc2', account: 'agy:acc2', cwd: tmpdir() });
    expect(s.manager.openAgy({ agent: 'agy:acc2' }).id).toBe(info.id);
    expect(s.spawned).toHaveLength(1);
  });

  it('"End" closes it like any terminal opened here', async () => {
    const s = setup({ agy });
    s.manager.openAgy({ agent: 'agy:acc2' });
    await s.manager.stop('agy:acc2');
    expect(s.manager.list()[0].exitedAt).toBeDefined();
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('a program that ignores SIGHUP (agy at its trust prompt) gets SIGTERM, then SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const s = setup({ agy, signal: (_pid, sig) => void sent.push(sig) });
      s.manager.openAgy({ agent: 'agy:acc2' });
      const proc = (s.manager as unknown as { ptys: Map<string, { proc: FakeProc }> }).ptys.values().next().value!.proc;
      proc.kill = () => {};
      await s.manager.stop('agy:acc2');
      vi.advanceTimersByTime(2_000);
      expect(sent).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(3_000);
      expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unknown or vacant workers, no Antigravity workers at all, and a missing agy-as', () => {
    expect(() => setup({ agy }).manager.openAgy({ agent: 'agy:acc3' })).toThrow(PtyError);
    expect(() => setup().manager.openAgy({ agent: 'agy:acc2' })).toThrow(PtyError);
    const missing = setup({ agy: { ...agy, bin: join(tmpdir(), 'no-agy-as') } });
    expect(() => missing.manager.openAgy({ agent: 'agy:acc2' })).toThrow(/agy-as/);
    expect(missing.spawned).toHaveLength(0);
  });
});

describe('PtyManager: sign-in terminal (accounts dialog)', () => {
  it('runs the command with its env, tied to "login:<account>"; asking again returns it; onExit when it closes', () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const s = setup();
    const spawn: SpawnPty = (file, args, o) => {
      envs.push(o.env);
      s.spawned.push({ args, cwd: o.cwd });
      return new FakeProc(7000 + envs.length);
    };
    const m = setup({ spawn });
    const onExit = vi.fn();
    const p = { account: '.claude-nova', file: process.execPath, args: ['auth', 'login'], cwd: tmpdir(), env: { CLAUDE_CONFIG_DIR: '/x/.claude-nova' }, onExit };
    const info = m.manager.openLogin(p);
    expect(info).toMatchObject({ agentId: 'login:.claude-nova', account: '.claude-nova', cwd: tmpdir() });
    expect(s.spawned).toEqual([{ args: ['auth', 'login'], cwd: tmpdir() }]);
    expect(envs[0].CLAUDE_CONFIG_DIR).toBe('/x/.claude-nova');
    expect(m.manager.openLogin(p).id).toBe(info.id);
    expect(envs).toHaveLength(1);
    m.manager.close(info.id);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('rejects a command that does not run', () => {
    const s = setup();
    expect(() => s.manager.openLogin({ account: 'agy:acc7', file: join(tmpdir(), 'no-agy-as'), args: ['acc7'], cwd: tmpdir() })).toThrow(PtyError);
    expect(s.spawned).toHaveLength(0);
  });
});
