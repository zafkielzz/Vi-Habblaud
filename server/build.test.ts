import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuildReader, readBuildInfo } from './build';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('createBuildReader', () => {
  it('reads bundle name from index.html and tracks new builds', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-build-'));
    dirs.push(root);
    const read = createBuildReader(root);
    expect(read()).toBeUndefined();
    const html = join(root, 'dist', 'client', 'index.html');
    mkdirSync(join(root, 'dist', 'client'), { recursive: true });
    writeFileSync(html, '<script type="module" crossorigin src="/bundle/main-AAA111.js"></script>');
    expect(read()).toBe('main-AAA111');
    writeFileSync(html, '<script type="module" crossorigin src="/bundle/main-BBB222.js"></script>');
    utimesSync(html, new Date(), new Date(Date.now() + 5_000));
    expect(read()).toBe('main-BBB222');
  });
});

describe('readBuildInfo and scripts/build-info.mjs', () => {
  const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'build-info.mjs');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  const run = (cwd: string, env: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(readFileSync(join(cwd, 'dist', 'build.json'), 'utf8')) as { commit: string; dirty: boolean; builtAt: string };
  };

  it('missing or corrupted file: commit "unknown"', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-build-'));
    dirs.push(root);
    expect(readBuildInfo(root)).toEqual({ commit: 'unknown', dirty: false });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'build.json'), '{"commit": "rm -rf", "dirty": false}');
    expect(readBuildInfo(root)).toEqual({ commit: 'unknown', dirty: false });
    writeFileSync(join(root, 'dist', 'build.json'), 'trash');
    expect(readBuildInfo(root)).toEqual({ commit: 'unknown', dirty: false });
  });

  it('git commit, "dirty" only when tracked file modified, and file read back', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-build-'));
    dirs.push(root);
    git(root, 'init', '-q');
    writeFileSync(join(root, 'a.txt'), 'one');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-q', '-m', 'first');
    const head = git(root, 'rev-parse', 'HEAD');
    const clean = run(root);
    expect(clean).toEqual({ commit: head, dirty: false, builtAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(readBuildInfo(root)).toEqual(clean);
    // Untracked files (such as newly created dist/, a .env, or node_modules symlink) do not count.
    writeFileSync(join(root, 'untracked.txt'), 'x');
    expect(run(root).dirty).toBe(false);
    writeFileSync(join(root, 'a.txt'), 'two');
    expect(run(root)).toMatchObject({ commit: head, dirty: true });
  });

  it('without git: "unknown"; HABBLAUD_BUILD_COMMIT/DIRTY replace git', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-build-'));
    dirs.push(root);
    // GIT_CEILING_DIRECTORIES: prevents traversing up to a parent repository above temp directory.
    expect(run(root, { GIT_CEILING_DIRECTORIES: dirname(root) })).toMatchObject({ commit: 'unknown', dirty: false });
    const sha = 'a'.repeat(40);
    expect(run(root, { HABBLAUD_BUILD_COMMIT: sha, HABBLAUD_BUILD_DIRTY: '1' })).toMatchObject({ commit: sha, dirty: true });
    expect(run(root, { HABBLAUD_BUILD_COMMIT: 'not-a-sha' })).toMatchObject({ commit: 'unknown', dirty: false });
  });
});
