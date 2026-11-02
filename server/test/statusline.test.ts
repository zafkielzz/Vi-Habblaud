// Statusline tap (scripts/statusline-tap.mjs, tested as a real process) and the installer
// (scripts/statusline-install.ts). Everything uses FAKE HOME and config dirs in temporary folders.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeOriginal,
  detectNodeCommand,
  encodeOriginal,
  planInstall,
  planUninstall,
  run,
  TAP_SCRIPT,
  tildify,
  unwrapCommand,
  wrapCommand,
  writeSettings,
  type RunOptions,
} from '../../scripts/statusline-install';
import { HAS_POSIX_MODES, posixShell, tempDir } from './fixtures';

const TAP = resolve(__dirname, '../../scripts/statusline-tap.mjs');
const { originalShell } = (await import(pathToFileURL(TAP).href)) as { originalShell: (env?: NodeJS.ProcessEnv) => string | true };
const SH = posixShell();
const NOW_S = Math.floor(Date.now() / 1000);

function statusJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'Status',
    session_id: 'sess-1',
    transcript_path: '/fake/home/.claude-conta2/projects/-x-proj/sess-1.jsonl',
    cwd: '/x/proj',
    model: { id: 'claude-teste', display_name: 'Test' },
    workspace: { current_dir: '/x/proj', project_dir: '/x/proj' },
    cost: { total_cost_usd: 1.23 },
    rate_limits: {
      five_hour: { used_percentage: 42.5, resets_at: NOW_S + 3_600 },
      seven_day: { used_percentage: 15, resets_at: NOW_S + 86_400 },
    },
    ...over,
  });
}

// Each call spawns real processes (on Windows, also Git Bash for original command): with full suite running,
// exceeds standard 5s.
describe('statusline-tap.mjs', { timeout: 20_000 }, () => {
  let tmp: ReturnType<typeof tempDir>;
  let env: NodeJS.ProcessEnv;
  let usageDir: string;

  beforeEach(() => {
    tmp = tempDir();
    usageDir = join(tmp.dir, 'usage');
    // Fake HOME and explicit usage folder: test never touches ~/.habblaud or ~/.claude*.
    // CLAUDE_CODE_GIT_BASH_PATH: same Git Bash as SH also for original command (Windows).
    env = { PATH: process.env.PATH, HOME: join(tmp.dir, 'home'), HABBLAUD_USAGE_DIR: usageDir, CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH };
  });
  afterEach(() => tmp.cleanup());

  const tap = (args: string[], input: string, extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [TAP, ...args], { input, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10_000 });

  it.skipIf(!SH)('forwards stdin to original command and writes ONLY rate limits atomically with mode 600', () => {
    const input = statusJson();
    const r = tap(['--', 'cat'], input);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(input);
    const files = readdirSync(usageDir);
    expect(files).toEqual(['.claude-conta2.json']);
    const file = join(usageDir, files[0]);
    if (HAS_POSIX_MODES) expect(statSync(file).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(rec).sort()).toEqual(['accountId', 'configDir', 'fetchedAt', 'five_hour', 'seven_day']);
    expect(rec).toMatchObject({
      accountId: '.claude-conta2',
      configDir: resolve('/fake/home/.claude-conta2'),
      five_hour: { utilization: 42.5, resets_at: NOW_S + 3_600 },
      seven_day: { utilization: 15, resets_at: NOW_S + 86_400 },
    });
    expect(Math.abs(rec.fetchedAt - Date.now())).toBeLessThan(30_000);
    // Nothing from rest of stdin (cost, session, cwd...).
    const raw = readFileSync(file, 'utf8');
    for (const leak of ['sess-1', 'total_cost_usd', '/x/proj', 'claude-teste']) expect(raw).not.toContain(leak);
  });

  it.skipIf(!SH)('exits with original command exit code; commands with pipes and quotes continue to work', () => {
    expect(tap(['--', 'exit', '7'], statusJson()).status).toBe(7);
    // Installer wraps complex command in single quotes; Claude Code shell strips them and tap
    // receives full command as a single argument.
    const complex = `printf '%s|' "a b" | tr a-z A-Z`;
    const viaShell = spawnSync(SH!, ['-c', `"${process.execPath}" "${TAP}" -- ${encodeOriginal(complex)}`], {
      input: statusJson(),
      env,
      encoding: 'utf8',
    });
    expect(viaShell.status).toBe(0);
    expect(viaShell.stdout).toBe('A B|');
  });

  it('without original command: prints nothing, but captures', () => {
    const r = tap([], statusJson());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(join(usageDir, '.claude-conta2.json'))).toBe(true);
  });

  it.skipIf(!SH)('without rate_limits, invalid JSON, or impossible usage directory: never breaks statusline', () => {
    const noLimits = statusJson({ rate_limits: undefined });
    expect(tap(['--', 'cat'], noLimits).stdout).toBe(noLimits);
    expect(tap(['--', 'cat'], 'this is not json').stdout).toBe('this is not json');
    expect(existsSync(usageDir)).toBe(false);
    // HABBLAUD_USAGE_DIR points to a file: write fails silently.
    writeFileSync(join(tmp.dir, 'file'), 'x');
    const r = tap(['--', 'echo', 'ok'], statusJson(), { HABBLAUD_USAGE_DIR: join(tmp.dir, 'file') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(r.stderr).toBe('');
  });

  it('without transcript_path: CLAUDE_CONFIG_DIR (first in list) and then ~/.claude', () => {
    tap([], statusJson({ transcript_path: undefined }), { CLAUDE_CONFIG_DIR: '/other/.claude-work,/x' });
    expect(JSON.parse(readFileSync(join(usageDir, '.claude-work.json'), 'utf8')).configDir).toBe(resolve('/other/.claude-work'));
    tap([], statusJson({ transcript_path: undefined }));
    expect(JSON.parse(readFileSync(join(usageDir, '.claude.json'), 'utf8')).configDir).toBe(join(env.HOME!, '.claude'));
  });

  it('does not rewrite identical values in less than 10 s', () => {
    tap([], statusJson());
    const file = join(usageDir, '.claude-conta2.json');
    const first = JSON.parse(readFileSync(file, 'utf8')).fetchedAt;
    tap([], statusJson());
    expect(JSON.parse(readFileSync(file, 'utf8')).fetchedAt).toBe(first);
    tap([], statusJson({ rate_limits: { five_hour: { used_percentage: 43, resets_at: NOW_S + 3_600 } } }));
    const changed = JSON.parse(readFileSync(file, 'utf8'));
    expect(changed.five_hour.utilization).toBe(43);
    expect(changed.seven_day).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('originalShell outside Windows: default Node shell (/bin/sh)', () => {
    expect(originalShell({ PATH: process.env.PATH })).toBe(true);
  });

  it.runIf(process.platform === 'win32')('originalShell on Windows: CLAUDE_CODE_GIT_BASH_PATH or Git Bash next to git.exe in PATH', () => {
    const git = join(tmp.dir, 'Git');
    for (const f of ['cmd/git.exe', 'mingw64/bin/git.exe', 'bin/bash.exe', 'other/bash.exe']) {
      mkdirSync(dirname(join(git, f)), { recursive: true });
      writeFileSync(join(git, f), '');
    }
    const bash = join(git, 'bin', 'bash.exe');
    expect(originalShell({ PATH: join(git, 'cmd') })).toBe(bash);
    expect(originalShell({ PATH: join(git, 'mingw64', 'bin') })).toBe(bash);
    expect(originalShell({ PATH: join(git, 'cmd'), CLAUDE_CODE_GIT_BASH_PATH: join(git, 'other', 'bash.exe') })).toBe(join(git, 'other', 'bash.exe'));
    expect(originalShell({ PATH: join(git, 'cmd'), CLAUDE_CODE_GIT_BASH_PATH: join(git, 'does-not-exist.exe') })).toBe(bash);
    expect(originalShell({ PATH: tmp.dir })).toBe(true);
    expect(originalShell({})).toBe(true);
    // Relative entry in PATH does not count: would resolve against cwd.
    const code = `const m = await import(${JSON.stringify(pathToFileURL(TAP).href)}); console.log(m.originalShell({ PATH: 'Git/cmd' }));`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: tmp.dir, encoding: 'utf8' }).stdout.trim()).toBe('true');
  });
});

describe('statusline-install.ts (pure functions)', () => {
  it('tildify: ~/ for paths under HOME (on Windows, also with \\), remainder unchanged', () => {
    const home = resolve('/u/someone');
    expect(tildify(home, home)).toBe('~');
    expect(tildify(join(home, '.claude', 'settings.json'), home)).toBe('~/.claude/settings.json');
    expect(tildify(`${home}-other`, home)).toBe(`${home}-other`);
    expect(tildify(resolve('/x/y'), home)).toBe(resolve('/x/y'));
  });

  const tapPath = '/repo/habblaud/scripts/statusline-tap.mjs';

  it('wraps and unwraps preserving the original command', () => {
    expect(wrapCommand('node', tapPath, 'npx -y ccstatusline')).toBe('node "/repo/habblaud/scripts/statusline-tap.mjs" -- npx -y ccstatusline');
    expect(wrapCommand('node', tapPath)).toBe('node "/repo/habblaud/scripts/statusline-tap.mjs"');
    for (const original of ['npx -y ccstatusline', `bash -c 'echo "hi" | head -1'`, '~/.claude/statusline.sh 2>/dev/null', `echo 'it'"'"'s'`]) {
      const wrapped = wrapCommand('/opt/homebrew/bin/node', tapPath, original);
      expect(unwrapCommand(wrapped)).toEqual({ tapPath, original });
    }
    expect(unwrapCommand(wrapCommand('node', '/path with $ and "/statusline-tap.mjs', 'x'))).toEqual({ tapPath: '/path with $ and "/statusline-tap.mjs', original: 'x' });
    expect(unwrapCommand('npx -y ccstatusline')).toBeUndefined();
    expect(decodeOriginal(encodeOriginal('a | b'))).toBe('a | b');
  });

  it('install and uninstall plans', () => {
    const settings = { model: 'opus', statusLine: { type: 'command', command: 'npx -y ccstatusline', padding: 0 }, permissions: { allow: ['Bash(ls:*)'] } };
    const inst = planInstall(settings, 'node', tapPath);
    expect(inst.action).toBe('install');
    if (inst.action !== 'install') return;
    expect(inst.settings).toEqual({ ...settings, statusLine: { type: 'command', command: wrapCommand('node', tapPath, 'npx -y ccstatusline'), padding: 0 } });
    expect(Object.keys(inst.settings)).toEqual(['model', 'statusLine', 'permissions']);
    expect(planInstall(inst.settings, 'node', tapPath).action).toBe('none');
    // Repo moved: updates path without losing original.
    const moved = planInstall(inst.settings, 'node', '/new/scripts/statusline-tap.mjs');
    expect(moved.action === 'install' && unwrapCommand(String((moved.settings.statusLine as { command: string }).command))).toEqual({ tapPath: '/new/scripts/statusline-tap.mjs', original: 'npx -y ccstatusline' });
    const un = planUninstall(inst.settings);
    expect(un.action === 'uninstall' && un.settings).toEqual(settings);
    expect(planUninstall(settings).action).toBe('none');
    // Without statusLine: creates one with just the tap; uninstall removes field.
    const created = planInstall({ model: 'x' }, 'node', tapPath);
    expect(created.action === 'install' && created.settings).toEqual({ model: 'x', statusLine: { type: 'command', command: wrapCommand('node', tapPath) } });
    expect(created.action === 'install' && planUninstall(created.settings)).toMatchObject({ action: 'uninstall', settings: { model: 'x' } });
    expect(planInstall({ statusLine: 'text' }, 'node', tapPath).action).toBe('skip');
    expect(planInstall({ statusLine: { type: 'other' } }, 'node', tapPath).action).toBe('skip');
  });

  // Stable locations on macOS and Linux; on Windows binary is node.exe and command is always "node".
  it.skipIf(process.platform === 'win32')('stable node in PATH becomes absolute path; nvm/fnm become just "node"', () => {
    const home = '/Users/someone';
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(detectNodeCommand({ PATH: '/opt/homebrew/bin:/usr/bin' }, home, has(['/opt/homebrew/bin/node', '/usr/bin/node']))).toBe('/opt/homebrew/bin/node');
    expect(detectNodeCommand({ PATH: `${home}/.nvm/versions/node/v24.1.0/bin:/opt/homebrew/bin` }, home, has([`${home}/.nvm/versions/node/v24.1.0/bin/node`, '/opt/homebrew/bin/node']))).toBe('node');
    expect(detectNodeCommand({ PATH: '' }, home, () => false)).toBe('node');
  });
});

describe('statusline-install.ts (files, fake HOME)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let out: string[];
  const original = { model: 'opus', statusLine: { type: 'command', command: 'npx -y ccstatusline', padding: 0 }, env: { FOO: '1' } };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    out = [];
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-conta2', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(original, null, 2)}\n`, { mode: 0o644 });
  });
  afterEach(() => tmp.cleanup());

  const exec = (command: RunOptions['command'], extra: Partial<RunOptions> = {}) =>
    run(
      { command, dryRun: false, nodeCmd: process.execPath, ...extra },
      { env: { HOME: home, HABBLAUD_USAGE_DIR: join(tmp.dir, 'usage') }, home, now: new Date(2026, 9, 6, 14, 5, 9), tapPath: TAP_SCRIPT, out: (l) => out.push(l) },
    );
  const read = (acc: string) => JSON.parse(readFileSync(join(home, acc, 'settings.json'), 'utf8'));

  it('install: backup, only statusLine changes, permission preserved; again = nothing to do', () => {
    expect(exec('install')).toBe(0);
    const c = read('.claude');
    expect(c.model).toBe('opus');
    expect(c.env).toEqual({ FOO: '1' });
    expect(c.statusLine).toEqual({ type: 'command', command: wrapCommand(process.execPath, TAP_SCRIPT, 'npx -y ccstatusline'), padding: 0 });
    if (HAS_POSIX_MODES) expect(statSync(join(home, '.claude', 'settings.json')).mode & 0o777).toBe(0o644);
    const backup = join(home, '.claude', 'settings.json.habblaud-backup-20261006-140509');
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual(original);
    // Account without settings.json: creates one with just the tap statusline (no backup, nothing existed).
    expect(read('.claude-conta2')).toEqual({ statusLine: { type: 'command', command: wrapCommand(process.execPath, TAP_SCRIPT) } });
    expect(readdirSync(join(home, '.claude-conta2'))).not.toContain(expect.stringContaining('backup'));

    out = [];
    expect(exec('install')).toBe(0);
    expect(out.join('\n')).toContain('already installed');
    expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('backup'))).toHaveLength(1);
  });

  it.skipIf(!SH)('installed command works for real: forwards output and captures usage', () => {
    exec('install');
    const cmd: string = read('.claude').statusLine.command.replace('npx -y ccstatusline', 'cat');
    const usageDir = join(tmp.dir, 'usage');
    const input = statusJson({ transcript_path: join(home, '.claude', 'projects', '-p', 's.jsonl') });
    const r = spawnSync(SH!, ['-c', cmd], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, HABBLAUD_USAGE_DIR: usageDir } });
    expect(r.stdout).toBe(input);
    expect(JSON.parse(readFileSync(join(usageDir, '.claude.json'), 'utf8')).five_hour.utilization).toBe(42.5);
  });

  it('status and uninstall restore everything as it was', () => {
    exec('install');
    out = [];
    exec('status');
    expect(out.join('\n')).toMatch(/\.claude \(.*\): installed \(in front of: npx -y ccstatusline\); no usage captured yet/);
    expect(exec('uninstall')).toBe(0);
    expect(read('.claude')).toEqual(original);
    expect(read('.claude-conta2')).toEqual({});
    out = [];
    exec('uninstall');
    expect(out.join('\n')).toContain("wasn't installed");
  });

  it('old name: install moves ~/.codetown to ~/.habblaud (even with HABBLAUD_USAGE_DIR elsewhere); status and uninstall do not', () => {
    mkdirSync(join(home, '.codetown', 'usage'), { recursive: true });
    writeFileSync(join(home, '.codetown', 'usage', '.claude.json'), '{"fetchedAt":1}');
    exec('status');
    exec('uninstall');
    exec('install', { dryRun: true });
    expect(existsSync(join(home, '.codetown', 'usage', '.claude.json'))).toBe(true);
    expect(out.filter((l) => l.includes('old name'))).toEqual(['~ ~/.codetown (old name) goes to ~/.habblaud (dry run: nothing moved)']);
    out = [];
    expect(exec('install')).toBe(0);
    expect(out[0]).toBe('✓ ~/.codetown (old name) is now ~/.habblaud.');
    expect(existsSync(join(home, '.codetown'))).toBe(false);
    expect(readFileSync(join(home, '.habblaud', 'usage', '.claude.json'), 'utf8')).toBe('{"fetchedAt":1}');
    expect(read('.claude').statusLine.command).toBe(wrapCommand(process.execPath, TAP_SCRIPT, 'npx -y ccstatusline'));
    // Already migrated: nothing to say.
    out = [];
    exec('install');
    expect(out.join('\n')).not.toContain('old name');
  });

  // On Windows chmod does not remove write permission from a directory: rename would succeed.
  it.skipIf(!HAS_POSIX_MODES)('old name: if unable to move, warns and installs anyway', () => {
    mkdirSync(join(home, '.codetown', 'usage'), { recursive: true });
    // Read-only HOME: rename of ~/.codetown fails (accounts inside remain writable).
    chmodSync(home, 0o555);
    try {
      expect(exec('install')).toBe(0);
    } finally {
      chmodSync(home, 0o755);
    }
    expect(out[0]).toMatch(/^! couldn't move ~\/\.codetown to ~\/\.habblaud \(.+\); move the folder by hand\.$/);
    expect(existsSync(join(home, '.codetown', 'usage'))).toBe(true);
    expect(read('.claude').statusLine.command).toContain('statusline-tap.mjs');
  });

  it('--dry-run does not write; invalid JSON is never overwritten', () => {
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    exec('install', { dryRun: true });
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(home, '.claude-conta2', 'settings.json'))).toBe(false);
    writeFileSync(join(home, '.claude-conta2', 'settings.json'), '{ broken');
    expect(exec('install')).toBe(1);
    expect(readFileSync(join(home, '.claude-conta2', 'settings.json'), 'utf8')).toBe('{ broken');
    expect(out.join('\n')).toContain('invalid JSON');
  });

  it('writeSettings: no race, writes and backup is the content replaced by rename', () => {
    const file = join(home, '.claude', 'settings.json');
    const raw = readFileSync(file, 'utf8');
    const next = { ...original, statusLine: { type: 'command', command: 'tap' } };
    const backup = writeSettings(file, next, raw, new Date(2026, 9, 6, 14, 5, 9));
    expect(backup).toBe(`${file}.habblaud-backup-20261006-140509`);
    expect(readFileSync(backup!, 'utf8')).toBe(raw);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(next);
    if (HAS_POSIX_MODES) expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it('writeSettings: concurrent edit between read and write aborts and file remains intact', () => {
    const file = join(home, '.claude', 'settings.json');
    const raw = readFileSync(file, 'utf8');
    const concurrent = `${JSON.stringify({ ...original, enabledPlugins: { other: true } }, null, 2)}\n`;
    expect(concurrent).not.toBe(raw);
    writeFileSync(file, concurrent);
    let message = '';
    try {
      writeSettings(file, { ...original, statusLine: { type: 'command', command: 'tap' } }, raw, new Date(2026, 9, 6, 14, 5, 9));
    } catch (err) {
      message = (err as Error).message;
    }
    // Key written in between stays in the file: install aborts leaving no backup or temporary file.
    expect(readFileSync(file, 'utf8')).toBe(concurrent);
    expect(message).toMatch(/run the command again/);
    expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('habblaud-backup') || f.includes('habblaud-tmp'))).toEqual([]);
  });
});
