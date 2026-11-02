import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { compareVersions, parseRegistryEntry, registryStatus, RegistryReader } from './registry';

const entry = (pid: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: '/projetos/app', startedAt: 1, kind: 'interactive', status: 'idle', ...extra });

describe('session registry', () => {
  let tmp: ReturnType<typeof tempDir>;
  let sessions: string;
  beforeEach(() => {
    tmp = tempDir();
    sessions = join(tmp.dir, 'sessions');
    mkdirSync(sessions);
  });
  afterEach(() => tmp.cleanup());

  it('maps busy/idle/waiting/shell', () => {
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'busy' }))!)).toEqual({ status: 'working' });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'idle' }))!)).toEqual({ status: 'idle' });
    // Idle with background shell running (Claude Code 2.1.292+).
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'shell' }))!)).toEqual({ status: 'shell' });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'waiting', waitingFor: 'input needed' }))!)).toEqual({
      status: 'waiting',
      waitingFor: 'answer a question',
    });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'waiting', waitingFor: 'Allow Bash(rm -rf x)?' }))!)).toEqual({
      status: 'waiting',
      waitingFor: 'approve a permission',
    });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: undefined }))!)).toEqual({});
  });

  it('compares Claude Code versions', () => {
    expect(compareVersions('2.1.292', '2.1.292')).toBe(0);
    expect(compareVersions('2.1.300', '2.1.292')).toBeGreaterThan(0);
    expect(compareVersions('2.1.29', '2.1.292')).toBeLessThan(0);
    expect(compareVersions('2.2.0-beta', '2.1.999')).toBeGreaterThan(0);
  });

  it('rejects entries missing essential fields', () => {
    expect(parseRegistryEntry('{"pid":1}')).toBeUndefined();
    expect(parseRegistryEntry('not json')).toBeUndefined();
    expect(parseRegistryEntry(entry(7, { agent: 'frinus' }))).toMatchObject({ pid: 7, sessionId: 's-7', agent: 'frinus' });
  });

  it('lists alive sessions, ignores .key, and checks PID outside Docker', () => {
    writeFileSync(join(sessions, '10.json'), entry(10));
    writeFileSync(join(sessions, '11.json'), entry(11));
    writeFileSync(join(sessions, '10.abcdef.key'), 'secret');
    const alive = new Set([10]);
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: (pid) => alive.has(pid) });
    expect(reader.poll().entries.map((e) => e.pid)).toEqual([10]);
    const docker = new RegistryReader(tmp.dir, { checkPid: false });
    expect(docker.poll().entries.map((e) => e.pid).sort()).toEqual([10, 11]);
  });

  it('invalid JSON (write in progress) keeps last good version', () => {
    const file = join(sessions, '20.json');
    writeFileSync(file, entry(20, { status: 'busy' }));
    const reader = new RegistryReader(tmp.dir, { checkPid: false });
    expect(reader.poll().entries[0].status).toBe('busy');
    writeFileSync(file, '{"pid":20,"sessionId":"s-20","cw');
    expect(reader.poll().entries[0].status).toBe('busy');
    writeFileSync(file, entry(20, { status: 'idle', extra: 'x' }));
    expect(reader.poll().entries[0].status).toBe('idle');
    rmSync(file);
    expect(reader.poll().entries).toEqual([]);
  });

  it('missing sessions/ directory is reported as source with error', () => {
    const reader = new RegistryReader(join(tmp.dir, 'nada'), { checkPid: false });
    expect(reader.poll()).toMatchObject({ ok: false, entries: [] });
  });
});
