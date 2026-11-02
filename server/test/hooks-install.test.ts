// Permission hook installer (scripts/hooks-install.ts): pure plans and real command on
// settings.json in temp folders (FAKE HOME and accounts: never touches ~/.claude*).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUT_S,
  HOOK_SCRIPT,
  hookCommand,
  hookEntry,
  installedHook,
  isOurHook,
  LEGACY_HOOK_SCRIPT,
  parseArgs,
  planInstall,
  planUninstall,
  run,
  scriptPathOf,
  STATUS_MESSAGE,
  type RunOptions,
} from '../../scripts/hooks-install';
import { HAS_POSIX_MODES, posixShell, tempDir } from './fixtures';

const OPTS = { port: 4747, timeoutS: DEFAULT_TIMEOUT_S };
const SH = posixShell();

describe('hooks-install.ts (pure functions)', () => {
  const entry = hookEntry(hookCommand('node', '/repo/habblaud/mod/habblaud-permissoes/hooks/permission-hook.mjs', OPTS), OPTS);

  it('hook command and entry: options only when different from default; timeout with margin', () => {
    expect(hookCommand('node', '/r/mod/habblaud-permissoes/hooks/permission-hook.mjs', OPTS)).toBe('node "/r/mod/habblaud-permissoes/hooks/permission-hook.mjs"');
    expect(hookCommand('/opt/homebrew/bin/node', '/r/x/permission-hook.mjs', { port: 4851, timeoutS: 120 })).toBe('/opt/homebrew/bin/node "/r/x/permission-hook.mjs" --port 4851 --timeout 120');
    expect(hookCommand('/caminho com espaço/node', "/r/$x/permission-hook.mjs", OPTS)).toBe(`"/caminho com espaço/node" '/r/$x/permission-hook.mjs'`);
    expect(entry).toEqual({
      type: 'command',
      command: 'node "/repo/habblaud/mod/habblaud-permissoes/hooks/permission-hook.mjs"',
      timeout: DEFAULT_TIMEOUT_S + 30,
      statusMessage: STATUS_MESSAGE,
    });
    expect(scriptPathOf('node "/a b/permission-hook.mjs" --port 1')).toBe('/a b/permission-hook.mjs');
    expect(scriptPathOf("node '/a/it'\\''s/permission-hook.mjs'")).toBe("/a/it's/permission-hook.mjs");
    expect(scriptPathOf('node /a/permission-hook.mjs')).toBe('/a/permission-hook.mjs');
    expect(scriptPathOf('echo oi')).toBeUndefined();
  });

  it('install: adds a matcher "*" group without touching other hooks; idempotent; updates in place', () => {
    const other = { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'echo ok' }] };
    const settings = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }], PermissionRequest: [other] } };
    const p = planInstall(settings, entry);
    expect(p.action).toBe('install');
    const next = p.action === 'install' ? p.settings : {};
    expect(next).toEqual({ model: 'opus', hooks: { PreToolUse: settings.hooks.PreToolUse, PermissionRequest: [other, { matcher: '*', hooks: [entry] }] } });
    expect(planInstall(next, entry)).toEqual({ action: 'none', message: 'already installed' });
    // Different path (moved folder) or other options: updates without duplicating.
    const moved = hookEntry(hookCommand('node', '/novo/scripts/permission-hook.mjs', OPTS), OPTS);
    const upd = planInstall(next, moved);
    expect(upd.action).toBe('install');
    const list = upd.action === 'install' ? (upd.settings.hooks as { PermissionRequest: unknown[] }).PermissionRequest : [];
    expect(list).toEqual([other, { matcher: '*', hooks: [moved] }]);
  });

  it('script lives in habblaud-permissoes plugin; old path (scripts/, up to 0.2) and new path are "ours"', () => {
    expect(HOOK_SCRIPT.endsWith(join('mod', 'habblaud-permissoes', 'hooks', 'permission-hook.mjs'))).toBe(true);
    expect(existsSync(HOOK_SCRIPT)).toBe(true);
    // Old path became symlink to new (pre-0.3 installs keep working).
    expect(existsSync(LEGACY_HOOK_SCRIPT)).toBe(true);
    const legacy = hookEntry(hookCommand('node', '/repo/habblaud/scripts/permission-hook.mjs', OPTS), OPTS);
    expect(isOurHook(legacy)).toBe(true);
    expect(isOurHook(entry)).toBe(true);
    expect(isOurHook({ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs"' })).toBe(true);
    expect(isOurHook({ type: 'command', command: 'meu-hook' })).toBe(false);
    expect(scriptPathOf(String(legacy.command))).toBe('/repo/habblaud/scripts/permission-hook.mjs');
    expect(scriptPathOf(String(entry.command))).toBe('/repo/habblaud/mod/habblaud-permissoes/hooks/permission-hook.mjs');
    // Old install: install replaces with new path (without duplicating) and uninstall removes.
    const old = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [legacy] }] } };
    const upd = planInstall(old, entry);
    expect(upd.action === 'install' && upd.settings).toEqual({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [entry] }] } });
    expect(upd.message).toMatch(/updated/);
    expect(planUninstall(old)).toEqual({ action: 'uninstall', settings: {}, message: 'Habblaud hook removed' });
  });

  it('legacy name path (mod/codetown-permissoes/, up to 0.3.2) is also "ours": install replaces, uninstall removes', () => {
    const renamed = hookEntry(hookCommand('node', '/repo/codetown/mod/codetown-permissoes/hooks/permission-hook.mjs', OPTS), OPTS);
    expect(isOurHook(renamed)).toBe(true);
    expect(scriptPathOf(String(renamed.command))).toBe('/repo/codetown/mod/codetown-permissoes/hooks/permission-hook.mjs');
    const old = { model: 'opus', hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'meu-hook' }, renamed] }] } };
    expect(installedHook(old)).toEqual(renamed);
    const upd = planInstall(old, entry);
    expect(upd.action === 'install' && upd.settings).toEqual({
      model: 'opus',
      hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'meu-hook' }] }, { matcher: '*', hooks: [entry] }] },
    });
    expect(planUninstall(old)).toEqual({
      action: 'uninstall',
      settings: { model: 'opus', hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'meu-hook' }] }] } },
      message: 'Habblaud hook removed',
    });
  });

  it('install without prior hooks; unknown formats are untouched', () => {
    const p = planInstall({}, entry);
    expect(p.action === 'install' && p.settings).toEqual({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [entry] }] } });
    expect(planInstall({ hooks: [] }, entry).action).toBe('skip');
    expect(planInstall({ hooks: { PermissionRequest: {} } }, entry).action).toBe('skip');
  });

  it('uninstall: removes only Habblaud hook; empty entries are removed', () => {
    const mixed = { matcher: '*', hooks: [{ type: 'command', command: 'meu-hook' }, entry] };
    const p = planUninstall({ hooks: { PermissionRequest: [mixed], Stop: [] } });
    expect(p.action === 'uninstall' && p.settings).toEqual({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'meu-hook' }] }], Stop: [] } });
    const only = planUninstall({ theme: 'dark', hooks: { PermissionRequest: [{ matcher: '*', hooks: [entry] }] } });
    expect(only.action === 'uninstall' && only.settings).toEqual({ theme: 'dark' });
    expect(planUninstall({ theme: 'dark' })).toEqual({ action: 'none', message: "wasn't installed" });
    expect(installedHook({ hooks: { PermissionRequest: [mixed] } })).toEqual(entry);
    expect(installedHook({})).toBeUndefined();
  });

  it('parseArgs', () => {
    expect(parseArgs(['install'], {})).toEqual({ command: 'install', dryRun: false, nodeCmd: undefined, port: 4747, timeoutS: 300 });
    expect(parseArgs(['status', '--port', '4851', '--timeout', '60', '--dry-run'], {})).toMatchObject({ command: 'status', port: 4851, timeoutS: 60, dryRun: true });
    expect(parseArgs(['install'], { HABBLAUD_PORT: '4848' })).toMatchObject({ port: 4848 });
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(() => parseArgs([], {})).toThrow(/install, uninstall or status/);
    expect(() => parseArgs(['install', '--timeout', '2'], {})).toThrow(/--timeout/);
    expect(() => parseArgs(['install', '--port', 'x'], {})).toThrow(/--port/);
  });
});

describe('hooks-install.ts (files, fake HOME)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let out: string[];
  const original = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say pronto' }] }] }, env: { FOO: '1' } };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    out = [];
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-conta2', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(original, null, 2)}\n`, { mode: 0o644 });
  });
  afterEach(() => tmp.cleanup());

  const exec = (command: RunOptions['command'], extra: Partial<RunOptions> = {}, health?: { permissions?: boolean }) =>
    run(
      { command, dryRun: false, nodeCmd: process.execPath, port: 4747, timeoutS: DEFAULT_TIMEOUT_S, ...extra },
      { env: { HOME: home }, home, now: new Date(2026, 9, 8, 9, 30, 0), hookPath: HOOK_SCRIPT, out: (l) => out.push(l), health: async () => health },
    );
  const read = (acc: string) => JSON.parse(readFileSync(join(home, acc, 'settings.json'), 'utf8'));
  const expected = hookEntry(hookCommand(process.execPath, HOOK_SCRIPT, OPTS), OPTS);

  it('install: backup, only hooks.PermissionRequest changes, file permissions preserved; repeat = nothing to do', async () => {
    expect(await exec('install')).toBe(0);
    const c = read('.claude');
    expect(c).toEqual({ ...original, hooks: { ...original.hooks, PermissionRequest: [{ matcher: '*', hooks: [expected] }] } });
    if (HAS_POSIX_MODES) expect(statSync(join(home, '.claude', 'settings.json')).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json.habblaud-backup-20261008-093000'), 'utf8'))).toEqual(original);
    // Account without settings.json: creates one with hook only (no backup, nothing existed).
    expect(read('.claude-conta2')).toEqual({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [expected] }] } });
    expect(readdirSync(join(home, '.claude-conta2')).some((f) => f.includes('backup'))).toBe(false);
    expect(out.join('\n')).toContain('Done.');

    out = [];
    expect(await exec('install')).toBe(0);
    expect(out.join('\n')).toContain('already installed');
    expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('backup'))).toHaveLength(1);
  });

  it('status (with Habblaud up or down) and uninstall restore everything', async () => {
    await exec('install', { port: 4851 });
    out = [];
    await exec('status', { port: 4851 }, { permissions: true });
    const text = out.join('\n');
    // Path in single quotes when containing `\` (Windows): see quotePath.
    expect(text).toMatch(/\.claude \(.*\): installed \(.*permission-hook\.mjs["'] --port 4851; timeout 330 s\)/);
    expect(text).toContain('Habblaud at http://127.0.0.1:4851: handling permission requests');
    out = [];
    await exec('status', { port: 4851 });
    expect(out.join('\n')).toContain('down');
    out = [];
    await exec('status', { port: 4851 }, { permissions: false });
    expect(out.join('\n')).toContain('off');
    expect(await exec('uninstall')).toBe(0);
    expect(read('.claude')).toEqual(original);
    expect(read('.claude-conta2')).toEqual({});
    out = [];
    await exec('uninstall');
    expect(out.join('\n')).toContain("wasn't installed");
  });

  it('status of old install (scripts/permission-hook.mjs, now a symlink): warns and asks to reinstall', async () => {
    const legacy = hookEntry(hookCommand(process.execPath, LEGACY_HOOK_SCRIPT, OPTS), OPTS);
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [legacy] }] } }));
    await exec('status');
    expect(out.join('\n')).toContain(`the hook points to ${LEGACY_HOOK_SCRIPT}; run npm run hooks:install to update`);
    out = [];
    expect(await exec('install')).toBe(0);
    expect(read('.claude').hooks.PermissionRequest).toEqual([{ matcher: '*', hooks: [expected] }]);
    expect(out.join('\n')).toContain('updated');
  });

  it('status of hook from legacy name (mod/codetown-permissoes/, which disappeared): explains file no longer exists', async () => {
    const gone = join(tmp.dir, 'codetown', 'mod', 'codetown-permissoes', 'hooks', 'permission-hook.mjs');
    const old = hookEntry(hookCommand(process.execPath, gone, OPTS), OPTS);
    const settings = { ...original, hooks: { ...original.hooks, PermissionRequest: [{ matcher: '*', hooks: [old] }] } };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
    await exec('status');
    expect(out.join('\n')).toContain(`the hook points to ${gone} (that file no longer exists: the hook fails and only the terminal counts); run npm run hooks:install to update`);
    out = [];
    expect(await exec('install')).toBe(0);
    expect(read('.claude').hooks.PermissionRequest).toEqual([{ matcher: '*', hooks: [expected] }]);
    expect(out.join('\n')).toContain('updated');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
    expect(await exec('uninstall')).toBe(0);
    expect(read('.claude')).toEqual(original);
  });

  it('--dry-run does not write; invalid JSON is never overwritten', async () => {
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    await exec('install', { dryRun: true });
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(home, '.claude-conta2', 'settings.json'))).toBe(false);
    expect(out.join('\n')).toContain('dry run');
    writeFileSync(join(home, '.claude-conta2', 'settings.json'), '{ broken');
    expect(await exec('install')).toBe(1);
    expect(readFileSync(join(home, '.claude-conta2', 'settings.json'), 'utf8')).toBe('{ broken');
    expect(out.join('\n')).toContain('invalid JSON');
  });

  it.skipIf(!SH)('installed command runs for real: with Habblaud down, exits quickly without decision', async () => {
    await exec('install', { port: 1 });
    const cmd: string = read('.claude').hooks.PermissionRequest[0].hooks[0].command;
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const t0 = Date.now();
    const r = spawnSync(SH!, ['-c', cmd], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
