// Claude Code plugins in the repository itself (.claude-plugin/marketplace.json + mod/): versions aligned
// with package.json and structure that Claude Code can load. The behavior of the mods themselves is
// tested by Claude Code (`claude plugin test` in mod/habblaud and mod/habblaud-mensagens); here vitest
// verifies what it can without Claude Code: files, versions, and the plugin's permission hook running for real.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookCommand, hookEntry, STATUS_MESSAGE } from '../../scripts/hooks-install';
import { MAX_TIMEOUT_MS } from '../permissions/registry';
import { posixShell } from './fixtures';

const ROOT = resolve(__dirname, '../..');
const SH = posixShell();
const PLUGINS = ['habblaud', 'habblaud-permissoes', 'habblaud-mensagens'];

type Rec = Record<string, unknown>;

function json(path: string): Rec {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Rec;
}

const pkg = json('package.json');
const market = json('.claude-plugin/marketplace.json');
const entries = (market.plugins as Rec[]) ?? [];

/** Settings hooks from a plugin hooks.json: {matcher, hooks:[{type, command, ...}]} per event. */
function settingsHooks(file: Rec): Array<{ event: string; matcher: unknown; hook: Rec }> {
  const out: Array<{ event: string; matcher: unknown; hook: Rec }> = [];
  for (const [event, groups] of Object.entries((file.hooks as Rec | undefined) ?? {})) {
    for (const g of groups as Rec[]) for (const hook of g.hooks as Rec[]) out.push({ event, matcher: g.matcher, hook });
  }
  return out;
}

/** Specifiers of `import ... from '...'`, `import '...'` and `export ... from '...'` in a file. */
function importsOf(path: string): string[] {
  const src = readFileSync(path, 'utf8');
  const imports = [...src.matchAll(/^\s*import\s+(?:[^'";]*?\s*from\s*)?['"]([^'"]+)['"]/gm)];
  const reexports = [...src.matchAll(/^\s*export\s+[^'";]*?\s*from\s*['"]([^'"]+)['"]/gm)];
  return [...imports, ...reexports].map((m) => m[1]);
}

describe('Claude Code marketplace and plugins', () => {
  it('marketplace and plugin.json versions match package.json version', () => {
    expect(typeof pkg.version).toBe('string');
    expect(market.version).toBe(pkg.version);
    for (const name of PLUGINS) {
      expect(json(`mod/${name}/.claude-plugin/plugin.json`).version, name).toBe(pkg.version);
      const entry = entries.find((e) => e.name === name);
      if (entry?.version !== undefined) expect(entry.version, `entry ${name}`).toBe(pkg.version);
    }
  });

  it('marketplace "habblaud" contains all three plugins, each in an existing directory with matching name', () => {
    expect(market.name).toBe('habblaud');
    expect(entries.map((e) => e.name)).toEqual(PLUGINS);
    for (const e of entries) {
      const source = String(e.source);
      expect(source.startsWith('./'), source).toBe(true);
      expect(source).not.toContain('..');
      const dir = join(ROOT, source);
      expect(statSync(dir).isDirectory(), source).toBe(true);
      expect(json(join(source, '.claude-plugin/plugin.json')).name).toBe(e.name);
      expect(existsSync(join(dir, 'hooks', 'hooks.json')), `${source}/hooks/hooks.json`).toBe(true);
    }
  });

  it('hooks.json: mod modules and permission hook script exist', () => {
    for (const e of entries) {
      const dir = join(ROOT, String(e.source));
      const hooksJson = join(dir, 'hooks', 'hooks.json');
      const file = JSON.parse(readFileSync(hooksJson, 'utf8')) as Rec;
      for (const m of (file.modules as string[] | undefined) ?? []) {
        expect(m.startsWith('./'), m).toBe(true);
        expect(existsSync(resolve(dirname(hooksJson), m)), m).toBe(true);
      }
      for (const { hook } of settingsHooks(file)) {
        const path = /\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"'\s]+)/.exec(String(hook.command))?.[1];
        expect(path, String(hook.command)).toBeDefined();
        expect(existsSync(join(dir, path!)), path).toBe(true);
      }
    }
    expect(json('mod/habblaud/hooks/hooks.json').modules).toEqual(['./register.ts']);
    expect(json('mod/habblaud-mensagens/hooks/hooks.json').modules).toEqual(['./register.ts']);
  });

  it('mods only import files from themselves and types from "claude-code" (Claude Code rule)', () => {
    for (const mod of ['habblaud', 'habblaud-mensagens']) {
      for (const spec of importsOf(join(ROOT, `mod/${mod}/hooks/register.ts`))) {
        expect(spec === 'claude-code' || spec.startsWith('./') || spec.startsWith('../'), `${mod}: ${spec}`).toBe(true);
      }
    }
  });
});

describe('habblaud-permissoes plugin', () => {
  const dir = join(ROOT, 'mod/habblaud-permissoes');
  const hooks = settingsHooks(json('mod/habblaud-permissoes/hooks/hooks.json'));

  // In the plugin the wait timeout comes from the environment (HABBLAUD_PERMISSION_TIMEOUT), not the command: Claude Code's
  // timeout must accommodate the longest wait the hook accepts, otherwise it kills the hook early (was 330s and cut off at 5m; timeout goes up to 24h).
  it('same hook as the installer: PermissionRequest, matcher "*", same message, and timeout accommodating max wait', () => {
    const installed = hookEntry(hookCommand('node', '/x/permission-hook.mjs', { port: 4747, timeoutS: MAX_TIMEOUT_MS / 1000 }), { port: 4747, timeoutS: MAX_TIMEOUT_MS / 1000 });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toEqual({
      event: 'PermissionRequest',
      matcher: '*',
      hook: { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs"', timeout: installed.timeout, statusMessage: 'Aguardando resposta no Habblaud' },
    });
  });

  it('script is pure Node (node:* only): Claude Code copies the plugin directory to cache on its own', () => {
    const specs = importsOf(join(dir, 'hooks/permission-hook.mjs'));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec.startsWith('node:'), spec).toBe(true);
  });

  it.skipIf(!SH)('plugin command runs for real: with Habblaud offline, exits quickly without a decision', () => {
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const t0 = Date.now();
    // Claude Code replaces ${CLAUDE_PLUGIN_ROOT} in command and also exports it; sh expands from env identically.
    const r = spawnSync(SH!, ['-c', String(hooks[0]?.hook.command)], {
      input,
      encoding: 'utf8',
      env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, CLAUDE_PLUGIN_ROOT: dir, HABBLAUD_PORT: '1' },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('legacy path (scripts/permission-hook.mjs, from installations up to 0.2) continues to work as shortcut', () => {
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'permission-hook.mjs')], {
      input,
      encoding: 'utf8',
      // With debug enabled the script logs what it did to stderr: proves the new script's main ran.
      env: { PATH: process.env.PATH ?? '', HABBLAUD_PORT: '1', HABBLAUD_HOOK_DEBUG: '1' },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/habblaud/i);
  });
});
