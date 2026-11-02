// Mod installer (scripts/mod-install.ts): pure functions and full command against FAKE Claude
// Code CLI, with FAKE HOME and accounts in temp folders (never calls real claude or touches ~/.claude*).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modHint } from '../../scripts/docker-up';
import { hookCommand, hookEntry } from '../../scripts/hooks-install';
import {
  accountEnv,
  cliMessage,
  cliSteps,
  describeStatus,
  LEGACY_PLUGINS,
  MESSAGES_HINT,
  MESSAGES_PLUGIN,
  MOD_PLUGIN,
  parseArgs,
  parseJsonOutput,
  parseMarketplaceList,
  parsePluginList,
  parseVersion,
  PERMISSIONS_PLUGIN,
  planInstall,
  planMigration,
  planUninstall,
  planUpdate,
  run,
  updateInstalledMods,
  verifyInstall,
  versionAtLeast,
  type AccountState,
  type ClaudeResult,
  type ClaudeRunner,
  type HealthInfo,
  type PluginInfo,
  type RunOptions,
} from '../../scripts/mod-install';
import { wrapCommand } from '../../scripts/statusline-install';
import { tempDir } from './fixtures';

const ROOT = '/repo/habblaud';
const same = (a: string, b: string) => a === b;
const plugin = (id: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({ id, version: '0.2.0', scope: 'user', enabled: true, errors: [], ...extra });
const stateOf = (plugins: PluginInfo[] = [], path: string | null = ROOT, legacyPath?: string): AccountState => ({
  marketplace: path ? { name: 'habblaud', source: 'directory', path } : undefined,
  legacyMarketplace: legacyPath ? { name: 'codetown', source: 'directory', path: legacyPath } : undefined,
  plugins,
});
// What 0.3 mod:install (legacy name, CodeTown) left behind: codetown marketplace in this folder and the two plugins.
const OLD_MOD = 'codetown@codetown';
const OLD_PERM = 'codetown-permissoes@codetown';
const legacyState = (plugins: PluginInfo[] = [], path: string | null = null) =>
  stateOf([plugin(OLD_MOD, { version: '0.3.2' }), plugin(OLD_PERM, { version: '0.3.2' }), ...plugins], path, ROOT);
const argsOf = (plan: ReturnType<typeof planInstall>) => cliSteps(plan).map((s) => s.args.join(' '));

// Real output of `claude plugin list --json` and `claude plugin marketplace list --json` (Claude Code 2.1.293),
// copied from a temporary CLAUDE_CONFIG_DIR with a toy marketplace.
const REAL_PLUGIN_LIST = `[
  {
    "id": "habblaud@habblaud",
    "version": "0.2.0",
    "scope": "user",
    "enabled": true,
    "installPath": "/tmp/t/cfg/plugins/cache/habblaud/habblaud/0.2.0",
    "readFromFolder": "/tmp/t/mkt/mod/habblaud",
    "folderVersion": "0.3.0",
    "installedAt": "2026-10-08T10:36:58.924Z",
    "lastUpdated": "2026-10-08T10:36:58.924Z",
    "projectEnabled": false
  },
  {
    "id": "habblaud-permissoes@habblaud",
    "version": "0.2.0",
    "scope": "user",
    "enabled": false,
    "installPath": "/tmp/t/cfg/plugins/cache/habblaud/habblaud-permissoes/0.2.0",
    "errors": ["Marketplace habblaud failed to load: cache-miss"],
    "errorDetails": [{ "type": "marketplace-load-failed", "marketplace": "habblaud" }],
    "projectEnabled": false
  }
]`;
const REAL_MARKETPLACE_LIST = `[
  {
    "name": "habblaud",
    "source": "directory",
    "path": "/tmp/t/mkt",
    "installLocation": "/tmp/t/mkt"
  }
]`;

describe('mod-install.ts (pure functions)', () => {
  it('Claude Code version: reads "2.1.293 (Claude Code)" and compares with minimum', () => {
    expect(parseVersion('2.1.293 (Claude Code)')).toEqual([2, 1, 293]);
    expect(parseVersion('Claude Code')).toBeUndefined();
    expect(versionAtLeast('2.1.293', '2.1.287')).toBe(true);
    expect(versionAtLeast('2.1.287', '2.1.287')).toBe(true);
    expect(versionAtLeast('2.1.286', '2.1.287')).toBe(false);
    expect(versionAtLeast('2.0.999', '2.1.287')).toBe(false);
    expect(versionAtLeast('2.2.0', '2.1.287')).toBe(true);
    expect(versionAtLeast('3.0.0', '2.1.287')).toBe(true);
    expect(versionAtLeast('x', '2.1.287')).toBe(false);
  });

  it('CLI output JSON, tolerant to leading warnings and trailing result line', () => {
    expect(parseJsonOutput('[1, 2]\n')).toEqual([1, 2]);
    expect(parseJsonOutput('Warning: something\n[\n  {"id": "a"}\n]')).toEqual([{ id: 'a' }]);
    expect(parseJsonOutput('Installing…\n{"command":"install","outcome":"ok"}')).toEqual({ command: 'install', outcome: 'ok' });
    expect(parseJsonOutput('\x1b[32m[]\x1b[0m')).toEqual([]);
    expect(parseJsonOutput('nothing here')).toBeUndefined();
    expect(parseJsonOutput('')).toBeUndefined();
  });

  it('plugin and marketplace lists in real CLI format', () => {
    expect(parsePluginList(REAL_PLUGIN_LIST)).toEqual([
      { id: MOD_PLUGIN, version: '0.2.0', scope: 'user', enabled: true, readFromFolder: '/tmp/t/mkt/mod/habblaud', folderVersion: '0.3.0', errors: [] },
      { id: PERMISSIONS_PLUGIN, version: '0.2.0', scope: 'user', enabled: false, readFromFolder: undefined, folderVersion: undefined, errors: ['Marketplace habblaud failed to load: cache-miss'] },
    ]);
    // `--available` returns an object; items without id are ignored; garbage = undefined (not "nothing installed").
    expect(parsePluginList(JSON.stringify({ installed: [{ id: 'x@y' }, { version: '1' }], available: [] }))).toEqual([
      { id: 'x@y', version: undefined, scope: undefined, enabled: true, readFromFolder: undefined, folderVersion: undefined, errors: [] },
    ]);
    expect(parsePluginList('[]')).toEqual([]);
    expect(parsePluginList('No plugins installed.')).toBeUndefined();
    expect(parseMarketplaceList(REAL_MARKETPLACE_LIST)).toEqual([{ name: 'habblaud', source: 'directory', path: '/tmp/t/mkt' }]);
    expect(parseMarketplaceList('[{"name":"official","source":"github","repo":"a/b","installLocation":"/x"}]')).toEqual([{ name: 'official', source: 'github' }]);
    expect(parseMarketplaceList('{}')).toBeUndefined();
  });

  it('per-account environment: default runs without CLAUDE_CONFIG_DIR (even if inherited); others with their folder', () => {
    const env = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-conta2' };
    expect(accountEnv(env, '/h/.claude', '/h')).toEqual({ PATH: '/bin' });
    expect(accountEnv(env, '/h/.claude-conta2', '/h')).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-conta2' });
    expect(accountEnv({ PATH: '/bin' }, '/h/.claude-x', '/h')).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-x' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/h/.claude-conta2');
  });

  it('install: from scratch adds marketplace and three plugins (user scope); --sem-permissoes and --sem-mensagens exclude theirs', () => {
    const base = { root: ROOT, version: '0.2.0', sameDir: same };
    const all = planInstall(stateOf([], null), { ...base, permissions: true, messages: true });
    expect(argsOf(all)).toEqual([
      `plugin marketplace add ${ROOT}`,
      `plugin install ${MOD_PLUGIN} --scope user`,
      `plugin install ${PERMISSIONS_PLUGIN} --scope user`,
      `plugin install ${MESSAGES_PLUGIN} --scope user`,
    ]);
    expect(all.plugins).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN]);
    expect(cliSteps(all)[3].message).toBe('habblaud-mensagens: installed');
    const solo = planInstall(stateOf([], null), { ...base, permissions: false, messages: false });
    expect(argsOf(solo)).toEqual([`plugin marketplace add ${ROOT}`, `plugin install ${MOD_PLUGIN} --scope user`]);
    expect(solo.notes).toEqual([]);
    expect(argsOf(planInstall(stateOf([], null), { ...base, permissions: true, messages: false })).slice(1)).toEqual([
      `plugin install ${MOD_PLUGIN} --scope user`,
      `plugin install ${PERMISSIONS_PLUGIN} --scope user`,
    ]);
    expect(argsOf(planInstall(stateOf([], null), { ...base, permissions: false, messages: true })).slice(1)).toEqual([
      `plugin install ${MOD_PLUGIN} --scope user`,
      `plugin install ${MESSAGES_PLUGIN} --scope user`,
    ]);
  });

  it('install: already installed re-reads catalog and nothing else; disabled re-enables; different version updates; missing installs', () => {
    const base = { root: ROOT, version: '0.2.0', permissions: true, messages: true, sameDir: same };
    const ok = planInstall(stateOf([plugin(MOD_PLUGIN), plugin(PERMISSIONS_PLUGIN), plugin(MESSAGES_PLUGIN)]), base);
    expect(argsOf(ok)).toEqual(['plugin marketplace update habblaud']);
    expect(ok.items.filter((i) => 'unchanged' in i)).toEqual([
      { unchanged: 'habblaud: already installed at version 0.2.0' },
      { unchanged: 'habblaud-permissoes: already installed at version 0.2.0' },
      { unchanged: 'habblaud-mensagens: already installed at version 0.2.0' },
    ]);
    // Installed before messages plugin: standard mod:install adds it.
    const mixed = planInstall(stateOf([plugin(MOD_PLUGIN, { enabled: false }), plugin(PERMISSIONS_PLUGIN, { version: '0.1.0' })]), base);
    expect(argsOf(mixed)).toEqual([
      'plugin marketplace update habblaud',
      `plugin enable ${MOD_PLUGIN} --scope user`,
      `plugin update ${PERMISSIONS_PLUGIN} --scope user`,
      `plugin install ${MESSAGES_PLUGIN} --scope user`,
    ]);
    expect(cliSteps(mixed)[2].message).toBe('habblaud-permissoes: updated from 0.1.0 to 0.2.0');
    // Installed only in project scope: user scope is still missing.
    expect(argsOf(planInstall(stateOf([plugin(MOD_PLUGIN, { scope: 'project' })]), { ...base, permissions: false }))).toContain(`plugin install ${MOD_PLUGIN} --scope user`);
  });

  it('install: marketplace from another folder points to this one; --sem-permissoes and --sem-mensagens keep (and update) existing', () => {
    const moved = planInstall(stateOf([plugin(MOD_PLUGIN)], '/antigo/habblaud'), { root: ROOT, version: '0.2.0', permissions: false, messages: false, sameDir: same });
    expect(argsOf(moved)).toEqual([`plugin marketplace add ${ROOT}`]);
    expect(cliSteps(moved)[0].message).toContain('before: /antigo/habblaud');
    const keep = planInstall(stateOf([plugin(MOD_PLUGIN, { version: '0.3.0' }), plugin(PERMISSIONS_PLUGIN)]), { root: ROOT, version: '0.3.0', permissions: false, messages: false, sameDir: same });
    expect(argsOf(keep)).toEqual(['plugin marketplace update habblaud', `plugin update ${PERMISSIONS_PLUGIN} --scope user`]);
    expect(keep.plugins).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN]);
    expect(keep.notes[0]).toMatch(/stays.*claude plugin uninstall habblaud-permissoes@habblaud/);
    const keepMsg = planInstall(stateOf([plugin(MOD_PLUGIN, { version: '0.3.0' }), plugin(MESSAGES_PLUGIN)]), { root: ROOT, version: '0.3.0', permissions: true, messages: false, sameDir: same });
    expect(argsOf(keepMsg)).toEqual(['plugin marketplace update habblaud', `plugin install ${PERMISSIONS_PLUGIN} --scope user`, `plugin update ${MESSAGES_PLUGIN} --scope user`]);
    expect(keepMsg.plugins).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN]);
    expect(keepMsg.notes).toEqual(["habblaud-mensagens was already installed and stays (--sem-mensagens doesn't remove it; to remove it: claude plugin uninstall habblaud-mensagens@habblaud)"]);
  });

  it('uninstall: removes only what exists, in order plugins → marketplace', () => {
    expect(argsOf(planUninstall(stateOf([plugin(MOD_PLUGIN), plugin(PERMISSIONS_PLUGIN), plugin(MESSAGES_PLUGIN)])))).toEqual([
      `plugin uninstall ${MOD_PLUGIN} --scope user`,
      `plugin uninstall ${PERMISSIONS_PLUGIN} --scope user`,
      `plugin uninstall ${MESSAGES_PLUGIN} --scope user`,
      'plugin marketplace remove habblaud',
    ]);
    const none = planUninstall(stateOf([], null));
    expect(cliSteps(none)).toEqual([]);
    expect(none.items).toHaveLength(4);
  });

  describe('legacy name (codetown, up to 0.3.2)', () => {
    it('legacy records derive from legacy name', () => {
      expect(LEGACY_PLUGINS).toEqual([OLD_MOD, OLD_PERM]);
    });

    it('install: removes legacy plugins and codetown marketplace BEFORE adding habblaud (same folder)', () => {
      const plan = planInstall(legacyState(), { root: ROOT, version: '0.4.0', permissions: true, messages: true, sameDir: same });
      expect(argsOf(plan)).toEqual([
        `plugin uninstall ${OLD_MOD} --scope user`,
        `plugin uninstall ${OLD_PERM} --scope user`,
        'plugin marketplace remove codetown',
        `plugin marketplace add ${ROOT}`,
        `plugin install ${MOD_PLUGIN} --scope user`,
        `plugin install ${PERMISSIONS_PLUGIN} --scope user`,
        `plugin install ${MESSAGES_PLUGIN} --scope user`,
      ]);
      const steps = cliSteps(plan);
      expect(steps.slice(0, 3).map((s) => s.message)).toEqual(['codetown (old name): removed', 'codetown-permissoes (old name): removed', 'marketplace codetown (old name): removed']);
      // Legacy plugin that fails to uninstall does not block install (marketplace removes it); marketplace blocks.
      expect(steps.slice(0, 3).map((s) => !!s.keepGoing)).toEqual([true, true, false]);
      expect(steps.slice(0, 3).some((s) => s.plugin)).toBe(false);
      expect(plan.plugins).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN]);
      // Only marketplace left (or another folder, from an old clone): removed same way. Legacy plugin in project
      // scope is not managed by this script.
      expect(argsOf(planInstall(stateOf([plugin(OLD_MOD, { scope: 'project' })], null, '/clone/antigo'), { root: ROOT, version: '0.4.0', permissions: false, messages: false, sameDir: same }))).toEqual([
        'plugin marketplace remove codetown',
        `plugin marketplace add ${ROOT}`,
        `plugin install ${MOD_PLUGIN} --scope user`,
      ]);
      // Halfway migration (habblaud already installed, legacy plugin still there): removes legacy and proceeds.
      expect(argsOf(planInstall(stateOf([plugin(MOD_PLUGIN, { version: '0.4.0' }), plugin(OLD_MOD)]), { root: ROOT, version: '0.4.0', permissions: false, messages: false, sameDir: same }))).toEqual([
        `plugin uninstall ${OLD_MOD} --scope user`,
        'plugin marketplace update habblaud',
      ]);
    });

    it('uninstall: also removes legacy leftovers; without them, nothing changes', () => {
      expect(argsOf(planUninstall(legacyState([plugin(MOD_PLUGIN)], ROOT)))).toEqual([
        `plugin uninstall ${OLD_MOD} --scope user`,
        `plugin uninstall ${OLD_PERM} --scope user`,
        'plugin marketplace remove codetown',
        `plugin uninstall ${MOD_PLUGIN} --scope user`,
        'plugin marketplace remove habblaud',
      ]);
      const onlyOld = planUninstall(legacyState());
      expect(argsOf(onlyOld)).toEqual([`plugin uninstall ${OLD_MOD} --scope user`, `plugin uninstall ${OLD_PERM} --scope user`, 'plugin marketplace remove codetown']);
      expect(onlyOld.items.filter((i) => 'unchanged' in i)).toHaveLength(4);
    });

    it('docker:up: with legacy leftovers only warns (never migrates on its own) and counts as installed', () => {
      const o = { root: ROOT, version: '0.4.0', sameDir: same };
      const warn = planUpdate(legacyState(), o);
      expect(warn).toEqual({
        action: 'warn',
        message: "still under the old name (marketplace codetown, codetown@codetown 0.3.2, codetown-permissoes@codetown 0.3.2); docker:up doesn't switch it on its own: run npm run mod:install",
      });
      // Even with habblaud up to date, or only legacy marketplace: warning, no steps.
      expect(planUpdate(stateOf([plugin(MOD_PLUGIN, { version: '0.4.0' })], ROOT, ROOT), o)).toEqual({
        action: 'warn',
        message: "still under the old name (marketplace codetown); docker:up doesn't switch it on its own: run npm run mod:install",
      });
      expect(modHint({ installed: true, unavailable: false })).toEqual([]);
    });

    it('status: shows legacy leftovers and directs to run npm run mod:install', () => {
      const lines = describeStatus(legacyState(), {}, { root: ROOT, version: '0.4.0', home: '/h', sameDir: same });
      expect(lines).toEqual([
        'marketplace habblaud: not added',
        'habblaud: not installed',
        'habblaud-permissoes: not installed',
        'habblaud-mensagens: not installed',
        '! old name still registered: marketplace codetown (this folder), codetown@codetown 0.3.2, codetown-permissoes@codetown 0.3.2; npm run mod:install replaces it with habblaud',
      ]);
      const elsewhere = describeStatus(stateOf([], null, '/h/clone/codetown'), {}, { root: ROOT, version: '0.4.0', home: '/h', sameDir: same });
      expect(elsewhere[4]).toBe('! old name still registered: marketplace codetown (~/clone/codetown); npm run mod:install replaces it with habblaud');
      expect(describeStatus(stateOf([]), {}, { root: ROOT, version: '0.4.0', home: '/h', sameDir: same }).join('\n')).not.toContain('old name');
    });

    it('legacy method migration: hook and tap from a folder with legacy name are also recognized', () => {
      const tap = wrapCommand('node', '/x/codetown/scripts/statusline-tap.mjs', 'ccstatusline');
      const hook = hookEntry(hookCommand('node', '/x/codetown/mod/codetown-permissoes/hooks/permission-hook.mjs', { port: 4747, timeoutS: 300 }), { port: 4747, timeoutS: 300 });
      const m = planMigration({ statusLine: { type: 'command', command: tap }, hooks: { PermissionRequest: [{ matcher: '*', hooks: [hook] }] } }, { modInstalled: true, permissionsInstalled: true, permissions: true });
      expect(m.settings).toEqual({ statusLine: { type: 'command', command: 'ccstatusline' } });
      expect(m.done).toHaveLength(2);
    });
  });

  describe('legacy method migration', () => {
    const tap = wrapCommand('node', '/repo/habblaud/scripts/statusline-tap.mjs', 'npx -y ccstatusline');
    const hook = hookEntry(hookCommand('node', '/repo/habblaud/scripts/permission-hook.mjs', { port: 4747, timeoutS: 300 }), { port: 4747, timeoutS: 300 });
    const mine = { type: 'command', command: 'meu-hook' };
    const settings = {
      model: 'opus',
      statusLine: { type: 'command', command: tap, padding: 0 },
      hooks: { PermissionRequest: [{ matcher: '*', hooks: [mine, hook] }], Stop: [{ hooks: [mine] }] },
      enabledPlugins: { [MOD_PLUGIN]: true },
    };

    it('with both plugins installed: restores original statusline and removes only Habblaud hook, in one write', () => {
      const m = planMigration(settings, { modInstalled: true, permissionsInstalled: true, permissions: true });
      expect(m.settings).toEqual({
        model: 'opus',
        statusLine: { type: 'command', command: 'npx -y ccstatusline', padding: 0 },
        hooks: { PermissionRequest: [{ matcher: '*', hooks: [mine] }], Stop: [{ hooks: [mine] }] },
        enabledPlugins: { [MOD_PLUGIN]: true },
      });
      expect(m.done).toHaveLength(2);
      expect(m.done[0]).toContain('restaurado: npx -y ccstatusline');
    });

    it('--sem-permissoes keeps hook; uninstalled plugin does not remove old one', () => {
      const semPerm = planMigration(settings, { modInstalled: true, permissionsInstalled: false, permissions: false });
      expect((semPerm.settings?.hooks as Record<string, unknown>).PermissionRequest).toEqual(settings.hooks.PermissionRequest);
      expect(semPerm.kept).toEqual(['old permission hook kept (--sem-permissoes)']);
      const falhou = planMigration(settings, { modInstalled: false, permissionsInstalled: false, permissions: true });
      expect(falhou.settings).toBeUndefined();
      expect(falhou.kept).toHaveLength(2);
      // Nothing from old way: nothing to do.
      expect(planMigration({ model: 'opus' }, { modInstalled: true, permissionsInstalled: true, permissions: true })).toEqual({ done: [], kept: [], warnings: [] });
    });

    it('unexpected format: warns and does not touch', () => {
      const m = planMigration({ statusLine: { type: 'command', command: 'echo statusline-tap.mjs quebrado' } }, { modInstalled: true, permissionsInstalled: true, permissions: true });
      expect(m.settings).toBeUndefined();
      expect(m.warnings[0]).toMatch(/usage:uninstall/);
    });
  });

  it('docker:up: updates only what is already installed and only from this folder', () => {
    const o = { root: ROOT, version: '0.3.0', sameDir: same };
    expect(planUpdate(stateOf([]), o)).toEqual({ action: 'none', installed: false });
    expect(planUpdate(stateOf([plugin(MOD_PLUGIN, { version: '0.3.0' }), plugin(MESSAGES_PLUGIN, { version: '0.3.0' })]), o)).toEqual({ action: 'none', installed: true });
    // Mod without messages plugin (installed before it): nothing to install, only tip.
    expect(planUpdate(stateOf([plugin(MOD_PLUGIN, { version: '0.3.0' })]), o)).toEqual({ action: 'none', installed: true, hint: MESSAGES_HINT });
    expect(MESSAGES_HINT).toBe('run npm run mod:install to send messages from the office (plugin habblaud-mensagens)');
    const up = planUpdate(stateOf([plugin(MOD_PLUGIN), plugin(PERMISSIONS_PLUGIN, { version: '0.3.0' })]), o);
    expect(up.action === 'update' && up.steps.map((s) => s.args.join(' '))).toEqual(['plugin marketplace update habblaud', `plugin update ${MOD_PLUGIN} --scope user`]);
    expect(up.action === 'update' && up.hint).toBe(MESSAGES_HINT);
    // Messages plugin installed follows version like the others; without mod, no tip.
    const msg = planUpdate(stateOf([plugin(MOD_PLUGIN, { version: '0.3.0' }), plugin(MESSAGES_PLUGIN)]), o);
    expect(msg).toEqual({ action: 'update', steps: [expect.objectContaining({ args: ['plugin', 'marketplace', 'update', 'habblaud'] }), expect.objectContaining({ args: ['plugin', 'update', MESSAGES_PLUGIN, '--scope', 'user'], plugin: MESSAGES_PLUGIN })] });
    expect(planUpdate(stateOf([plugin(PERMISSIONS_PLUGIN, { version: '0.3.0' })]), o)).toEqual({ action: 'none', installed: true });
    const elsewhere = planUpdate(stateOf([plugin(MOD_PLUGIN)], '/outro/clone'), o);
    expect(elsewhere.action === 'warn' && elsewhere.message).toMatch(/another folder \(\/outro\/clone\).*npm run mod:install/);
    expect(planUpdate(stateOf([plugin(MOD_PLUGIN)], null), o).action).toBe('warn');
    // docker:up tip only appears when nothing is installed.
    expect(modHint({ installed: false, unavailable: false }).join('\n')).toMatch(/npm run mod:install.*2\.1\.287\+[\s\S]*usage:install and npm run hooks:install/);
    expect(modHint({ installed: true, unavailable: false })).toEqual([]);
    expect(modHint({ installed: false, unavailable: true })).toEqual([]);
  });

  it('check after install, CLI failure message and status', () => {
    const after = stateOf([plugin(MOD_PLUGIN, { version: '0.1.0' }), plugin(PERMISSIONS_PLUGIN, { enabled: false, errors: ['boom'] })]);
    expect(verifyInstall(after, [MOD_PLUGIN, PERMISSIONS_PLUGIN, 'outro@habblaud'], '0.2.0')).toEqual([
      'habblaud: Claude Code records version 0.1.0, not 0.2.0 (does the manifest in mod/ have a different version?)',
      `habblaud-permissoes: installed, but disabled (claude plugin enable ${PERMISSIONS_PLUGIN})`,
      'habblaud-permissoes: boom',
      "outro: doesn't show as installed in the Claude Code list",
    ]);
    expect(cliMessage({ code: 1, stdout: 'Installing…\n', stderr: '\x1b[31m✘ Failed to install plugin "x": not found\x1b[0m\n' })).toBe('Installing… · Failed to install plugin "x": not found');
    expect(cliMessage({ code: null, stdout: '', stderr: '', error: 'no claude' })).toBe('no claude');
    expect(cliMessage({ code: 2, stdout: '', stderr: '' })).toBe('exited with code 2');

    const tap = wrapCommand('node', '/r/scripts/statusline-tap.mjs', 'ccstatusline');
    const lines = describeStatus(stateOf([plugin(MOD_PLUGIN, { version: '0.1.0', folderVersion: '0.2.0', readFromFolder: '/h/x' })]), { statusLine: { command: tap }, disableAllHooks: true }, { root: ROOT, version: '0.2.0', home: '/h', sameDir: same });
    expect(lines).toEqual([
      'marketplace habblaud: this folder',
      'habblaud: installed, enabled, version 0.1.0 (this folder: 0.2.0; npm run mod:install or npm run docker:up updates it), loads 0.2.0 from ~/x',
      'habblaud-permissoes: not installed',
      'habblaud-mensagens: not installed',
      '! old statusline tap still installed alongside the mod: npm run mod:install removes it (or npm run usage:uninstall)',
      "! disableAllHooks is on in this account's settings.json: no mod (or hook) runs",
    ]);
  });

  it('parseArgs', () => {
    expect(parseArgs(['install'])).toEqual({ command: 'install', dryRun: false, permissions: true, messages: true, accounts: [], claudeCmd: undefined });
    expect(parseArgs(['install', '--sem-mensagens'])).toMatchObject({ permissions: true, messages: false });
    expect(parseArgs(['install', '--sem-permissoes', '--sem-mensagens', '--conta', '~/.claude-conta2', '--conta', '/x', '--dry-run', '--claude', '/opt/claude'])).toEqual({
      command: 'install',
      dryRun: true,
      permissions: false,
      messages: false,
      accounts: ['~/.claude-conta2', '/x'],
      claudeCmd: '/opt/claude',
    });
    expect(parseArgs(['-h'])).toBe('help');
    expect(() => parseArgs([])).toThrow(/install, uninstall or status/);
    expect(() => parseArgs(['install', '--conta'])).toThrow(/--conta/);
    expect(() => parseArgs(['install', '--xyz'])).toThrow(/unknown option/);
  });
});

// ---------------------------------------------------------------------------------------------
// Fake CLI: stores marketplace and plugins per CLAUDE_CONFIG_DIR, like the real one
// ---------------------------------------------------------------------------------------------

interface FakeAccount {
  /** Marketplaces by name → folder. */
  marketplaces: Map<string, string>;
  plugins: Map<string, { version: string; enabled: boolean }>;
}

class FakeClaude {
  version = '2.1.293 (Claude Code)';
  /** Manifest version in mod/ (what install/update record). */
  folderVersion = '0.2.0';
  missing = false;
  fail?: (args: string[]) => boolean;
  calls: Array<{ args: string[]; configDir: string }> = [];
  accounts = new Map<string, FakeAccount>();

  constructor(private home: string) {}

  account(configDir: string): FakeAccount {
    let a = this.accounts.get(configDir);
    if (!a) this.accounts.set(configDir, (a = { marketplaces: new Map(), plugins: new Map() }));
    return a;
  }

  get mutating(): string[] {
    return this.calls.filter((c) => !c.args.includes('--json') && c.args[0] !== '--version').map((c) => c.args.join(' '));
  }

  runner: ClaudeRunner = (args, env): ClaudeResult => {
    const configDir = env.CLAUDE_CONFIG_DIR ?? join(this.home, '.claude');
    this.calls.push({ args, configDir });
    if (this.missing) return { code: null, stdout: '', stderr: '', error: 'the "claude" command wasn\'t found in PATH' };
    if (this.fail?.(args)) return { code: 1, stdout: '', stderr: '✘ Failed: boom\n' };
    const ok = (stdout = 'ok\n'): ClaudeResult => ({ code: 0, stdout, stderr: '' });
    const no = (stderr: string): ClaudeResult => ({ code: 1, stdout: '', stderr });
    const a = this.account(configDir);
    const cmd = args.join(' ');
    if (cmd === '--version') return ok(`${this.version}\n`);
    if (cmd === 'plugin marketplace list --json') {
      return ok(JSON.stringify([...a.marketplaces].map(([name, path]) => ({ name, source: 'directory', path, installLocation: path }))));
    }
    if (cmd === 'plugin list --json') {
      return ok(
        JSON.stringify(
          [...a.plugins].map(([id, p]) => ({ id, version: p.version, scope: 'user', enabled: p.enabled, installPath: '/cache', readFromFolder: `${a.marketplaces.get(id.split('@')[1])}/mod`, folderVersion: this.folderVersion })),
        ),
      );
    }
    const [, sub, third, fourth] = args;
    if (sub === 'marketplace') {
      if (third === 'add') {
        // Like the real one: name comes from folder manifest (same name only changes origin).
        let name: string | undefined;
        try {
          name = (JSON.parse(readFileSync(join(fourth, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name?: string }).name;
        } catch {
          name = undefined;
        }
        if (!name) return no(`✘ No marketplace.json in ${fourth}\n`);
        a.marketplaces.set(name, fourth);
        return ok(`✔ Successfully added marketplace: ${name}\n`);
      }
      if (!a.marketplaces.has(fourth)) return no(`✘ Marketplace '${fourth}' not found\n`);
      if (third === 'update') return ok();
      if (third === 'remove') {
        // Removing marketplace takes with it plugins from it.
        a.marketplaces.delete(fourth);
        for (const id of [...a.plugins.keys()]) if (id.endsWith(`@${fourth}`)) a.plugins.delete(id);
        return ok();
      }
    }
    if (sub === 'install') {
      if (!a.marketplaces.has(third.split('@')[1])) return no(`✘ Plugin "${third}" not found in any marketplace\n`);
      a.plugins.set(third, { version: this.folderVersion, enabled: true });
      return ok();
    }
    const p = a.plugins.get(third);
    if (!p) return no(`✘ Plugin "${third}" not found in installed plugins\n`);
    if (sub === 'enable') p.enabled = true;
    else if (sub === 'update') p.version = this.folderVersion;
    else if (sub === 'uninstall') a.plugins.delete(third);
    else return no(`unknown command: ${cmd}`);
    return ok();
  };
}

describe('mod-install.ts (fake CLI, fake HOME)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let root: string;
  let usageDir: string;
  let out: string[];
  let fake: FakeClaude;
  const tap = wrapCommand('node', '/x/habblaud/scripts/statusline-tap.mjs', 'npx -y ccstatusline');
  const hook = hookEntry(hookCommand('node', '/x/habblaud/scripts/permission-hook.mjs', { port: 4747, timeoutS: 300 }), { port: 4747, timeoutS: 300 });
  const original = {
    model: 'opus',
    statusLine: { type: 'command', command: tap },
    hooks: { PermissionRequest: [{ matcher: '*', hooks: [hook] }], Stop: [{ hooks: [{ type: 'command', command: 'say pronto' }] }] },
  };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    root = join(tmp.dir, 'habblaud');
    usageDir = join(tmp.dir, 'usage');
    out = [];
    fake = new FakeClaude(home);
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-conta2', 'sessions'), { recursive: true });
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), '{"name":"habblaud","plugins":[]}');
    writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(original, null, 2)}\n`);
  });
  afterEach(() => tmp.cleanup());

  // Inherited CLAUDE_CONFIG_DIR, as when command runs from inside account 2 session.
  const exec = (command: RunOptions['command'], extra: Partial<RunOptions> = {}, health?: HealthInfo, env: NodeJS.ProcessEnv = {}) =>
    run(
      { command, dryRun: false, permissions: true, messages: true, accounts: [], ...extra },
      {
        env: { HOME: home, PATH: '/usr/bin', HABBLAUD_USAGE_DIR: usageDir, CLAUDE_CONFIG_DIR: join(home, '.claude-conta2'), ...env },
        home,
        now: new Date(2026, 9, 8, 9, 30, 0),
        root,
        version: '0.2.0',
        claude: fake.runner,
        out: (l) => out.push(l),
        // Never queries the real port.
        health: async () => health,
      },
    );
  const read = (acc: string) => JSON.parse(readFileSync(join(home, acc, 'settings.json'), 'utf8'));
  const installed = (acc: string) => Object.fromEntries(fake.account(join(home, acc)).plugins);

  it('install: both accounts, each with its folder; migrates tap and hook with backup; repeat = nothing to do', async () => {
    expect(await exec('install')).toBe(0);
    for (const acc of ['.claude', '.claude-conta2']) {
      expect(Object.fromEntries(fake.account(join(home, acc)).marketplaces)).toEqual({ habblaud: root });
      expect(installed(acc)).toEqual({
        [MOD_PLUGIN]: { version: '0.2.0', enabled: true },
        [PERMISSIONS_PLUGIN]: { version: '0.2.0', enabled: true },
        [MESSAGES_PLUGIN]: { version: '0.2.0', enabled: true },
      });
    }
    // Default account never gets inherited CLAUDE_CONFIG_DIR from the other.
    expect(fake.accounts.size).toBe(2);
    expect(fake.calls.filter((c) => c.args[1] === 'install' && c.args[2] === MOD_PLUGIN).map((c) => c.configDir)).toEqual([join(home, '.claude'), join(home, '.claude-conta2')]);
    expect(read('.claude')).toEqual({ model: 'opus', statusLine: { type: 'command', command: 'npx -y ccstatusline' }, hooks: { Stop: original.hooks.Stop } });
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json.habblaud-backup-20261008-093000'), 'utf8'))).toEqual(original);
    // Account with nothing from legacy way: settings.json is not even created.
    expect(existsSync(join(home, '.claude-conta2', 'settings.json'))).toBe(false);
    expect(existsSync(usageDir)).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('old statusline tap removed');
    expect(text).toContain('old permission hook removed');
    expect(text).toContain('/reload-plugins');

    out = [];
    fake.calls = [];
    expect(await exec('install')).toBe(0);
    expect(fake.mutating).toEqual(['plugin marketplace update habblaud', 'plugin marketplace update habblaud']);
    expect(out.join('\n')).toContain('habblaud: already installed at version 0.2.0');
    expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('backup'))).toHaveLength(1);
  });

  it('--sem-permissoes and --sem-mensagens: mod only; old hook remains; --conta limits to one account', async () => {
    expect(await exec('install', { permissions: false, messages: false, accounts: [join(home, '.claude')] })).toBe(0);
    expect(installed('.claude')).toEqual({ [MOD_PLUGIN]: { version: '0.2.0', enabled: true } });
    expect(fake.calls.filter((c) => c.args[0] === 'plugin' && c.configDir === join(home, '.claude-conta2'))).toEqual([]);
    const s = read('.claude');
    expect(s.statusLine).toEqual({ type: 'command', command: 'npx -y ccstatusline' });
    expect(s.hooks.PermissionRequest).toEqual(original.hooks.PermissionRequest);
    expect(out.join('\n')).toContain('old permission hook kept (--sem-permissoes)');
    await expect(exec('install', { accounts: [join(home, 'nao-existe')] })).rejects.toThrow(/folder not found/);
  });

  it('legacy Claude Code: explains, suggests legacy way and touches nothing', async () => {
    fake.version = '2.1.286 (Claude Code)';
    expect(await exec('install')).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('The mod requires Claude Code 2.1.287 or newer, and this one is 2.1.286');
    expect(text).toContain('npm run usage:install');
    expect(text).toContain('npm run hooks:install');
    expect(fake.mutating).toEqual([]);
    expect(read('.claude')).toEqual(original);
    expect(existsSync(usageDir)).toBe(false);
  });

  it('without claude in PATH, or without marketplace in this folder: clear error, nothing changed', async () => {
    fake.missing = true;
    expect(await exec('install')).toBe(1);
    expect(out.join('\n')).toContain("wasn't found in PATH");
    fake.missing = false;
    out = [];
    fake.calls = [];
    rmSync(join(root, '.claude-plugin', 'marketplace.json'));
    expect(await exec('install')).toBe(1);
    expect(out.join('\n')).toContain(join('.claude-plugin', 'marketplace.json'));
    expect(fake.calls).toEqual([]);
    expect(read('.claude')).toEqual(original);
  });

  it('--dry-run: queries only (lists), does not install, write or create usage folder', async () => {
    expect(await exec('install', { dryRun: true })).toBe(0);
    expect(fake.mutating).toEqual([]);
    expect(read('.claude')).toEqual(original);
    expect(existsSync(usageDir)).toBe(false);
    const text = out.join('\n');
    expect(text).toContain(`~ marketplace habblaud: added (this folder) (dry run: claude plugin marketplace add ${root})`);
    expect(text).toContain('~ old statusline tap removed');
  });

  it('CLI failure: account stops there, exits with error and legacy way remains (neither is lost)', async () => {
    fake.fail = (args) => args[1] === 'install' && args[2] === MOD_PLUGIN;
    expect(await exec('install', { accounts: [join(home, '.claude')] })).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('✗ habblaud: failed (Failed: boom)');
    expect(fake.mutating).toEqual([`plugin marketplace add ${root}`, `plugin install ${MOD_PLUGIN} --scope user`]);
    expect(read('.claude')).toEqual(original);
    expect(text).toContain('old statusline tap kept');
    expect(text).not.toContain('Done.');
  });

  it('status and uninstall', async () => {
    await exec('install', { permissions: false });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(original));
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(join(usageDir, '.claude.json'), JSON.stringify({ fetchedAt: new Date(2026, 9, 8, 9, 25, 0).getTime(), source: 'mod' }));
    out = [];
    expect(await exec('status')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Claude Code 2.1.293 · Habblaud 0.2.0');
    expect(text).toMatch(
      /• \.claude \(~\/\.claude\)\n {4}marketplace habblaud: this folder\n {4}habblaud: installed, enabled, version 0.2.0\n {4}habblaud-permissoes: not installed\n {4}habblaud-mensagens: installed, enabled, version 0.2.0\n/,
    );
    expect(text).toContain('! old statusline tap still installed alongside the mod');
    expect(text).toContain('old permission hook installed (old way');
    expect(text).toContain('last usage captured 5 min ago (via the mod)');
    expect(text).toContain('Habblaud at http://127.0.0.1:4747: down');
    expect(text).not.toContain('Messages from the office');
    out = [];
    await exec('status', {}, { permissions: true, messages: true });
    expect(out.join('\n')).toContain('Habblaud at http://127.0.0.1:4747: up and handling permission requests (with a page open).');
    expect(out.join('\n')).toContain('Messages from the office: on (they reach open sessions with the habblaud-mensagens plugin).');
    out = [];
    await exec('status', {}, { permissions: true, messages: false });
    expect(out.at(-1)).toBe('Messages from the office: off in Habblaud (port exposed on the network, HABBLAUD_TERMINAL=0 or HABBLAUD_MENSAGENS=0).');
    // Habblaud from before messages (without field in /api/health): nothing about them.
    out = [];
    await exec('status', {}, { permissions: true });
    expect(out.join('\n')).not.toContain('Messages from the office');
    const installs = [`plugin marketplace add ${root}`, `plugin install ${MOD_PLUGIN} --scope user`, `plugin install ${MESSAGES_PLUGIN} --scope user`];
    expect(fake.mutating).toEqual([...installs, ...installs]);

    out = [];
    fake.calls = [];
    expect(await exec('uninstall')).toBe(0);
    const removes = [`plugin uninstall ${MOD_PLUGIN} --scope user`, `plugin uninstall ${MESSAGES_PLUGIN} --scope user`, 'plugin marketplace remove habblaud'];
    expect(fake.mutating).toEqual([...removes, ...removes]);
    expect(installed('.claude')).toEqual({});
    expect(fake.account(join(home, '.claude')).marketplaces.size).toBe(0);
    // Uninstaller does not touch settings.json (old tap and hook belong to usage/hooks:uninstall).
    expect(read('.claude')).toEqual(original);
    expect(out.join('\n')).toContain('npm run usage:install and npm run hooks:install');
    out = [];
    expect(await exec('uninstall')).toBe(0);
    expect(out.join('\n')).toContain("= marketplace habblaud: wasn't added");
  });

  describe('legacy name (codetown): what 0.3 mod:install left behind', () => {
    const oldHook = hookEntry(hookCommand('node', '/x/codetown/mod/codetown-permissoes/hooks/permission-hook.mjs', { port: 4747, timeoutS: 300 }), { port: 4747, timeoutS: 300 });
    const oldSettings = { model: 'opus', hooks: { PermissionRequest: [{ matcher: '*', hooks: [oldHook] }] } };
    const OLD = ['plugin uninstall codetown@codetown --scope user', 'plugin uninstall codetown-permissoes@codetown --scope user', 'plugin marketplace remove codetown'];

    beforeEach(() => {
      // Default account: codetown marketplace in THIS folder, two legacy plugins, settings hook from legacy
      // path (0.3 hooks:install) and usage in ~/.codetown. Account 2 has nothing.
      const acc = fake.account(join(home, '.claude'));
      acc.marketplaces.set('codetown', root);
      acc.plugins.set('codetown@codetown', { version: '0.3.2', enabled: true });
      acc.plugins.set('codetown-permissoes@codetown', { version: '0.3.2', enabled: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(oldSettings));
      mkdirSync(join(home, '.codetown', 'usage'), { recursive: true });
      writeFileSync(join(home, '.codetown', 'usage', '.claude.json'), '{"source":"mod"}');
    });

    it('install: removes legacy BEFORE adding habblaud, moves ~/.codetown to ~/.habblaud and removes old hook', async () => {
      expect(await exec('install')).toBe(0);
      expect(fake.mutating).toEqual([
        ...OLD,
        `plugin marketplace add ${root}`,
        `plugin install ${MOD_PLUGIN} --scope user`,
        `plugin install ${PERMISSIONS_PLUGIN} --scope user`,
        `plugin install ${MESSAGES_PLUGIN} --scope user`,
        // Account 2, no leftovers.
        `plugin marketplace add ${root}`,
        `plugin install ${MOD_PLUGIN} --scope user`,
        `plugin install ${PERMISSIONS_PLUGIN} --scope user`,
        `plugin install ${MESSAGES_PLUGIN} --scope user`,
      ]);
      expect(Object.fromEntries(fake.account(join(home, '.claude')).marketplaces)).toEqual({ habblaud: root });
      expect(Object.keys(installed('.claude'))).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN]);
      expect(read('.claude')).toEqual({ model: 'opus' });
      // State folder is renamed even with HABBLAUD_USAGE_DIR elsewhere (created separately).
      expect(existsSync(join(home, '.codetown'))).toBe(false);
      expect(readFileSync(join(home, '.habblaud', 'usage', '.claude.json'), 'utf8')).toBe('{"source":"mod"}');
      expect(existsSync(usageDir)).toBe(true);
      const text = out.join('\n');
      expect(text.split('\n')[0]).toBe('✓ ~/.codetown (old name) is now ~/.habblaud.');
      expect(text).toContain(
        [
          '.claude (~/.claude):',
          '  ✓ codetown (old name): removed',
          '  ✓ codetown-permissoes (old name): removed',
          '  ✓ marketplace codetown (old name): removed',
          '  ✓ marketplace habblaud: added (this folder)',
          '  ✓ habblaud: installed',
          '  ✓ habblaud-permissoes: installed',
          '  ✓ habblaud-mensagens: installed',
          '  ✓ old permission hook removed: the habblaud-permissoes plugin answers in its place',
        ].join('\n'),
      );
      expect(text).not.toContain('still registered');
      expect(text).toContain('Done.');

      // Repeat: nothing from legacy name remains.
      out = [];
      fake.calls = [];
      expect(await exec('install')).toBe(0);
      expect(fake.mutating).toEqual(['plugin marketplace update habblaud', 'plugin marketplace update habblaud']);
      expect(out.join('\n')).not.toContain('old name');
    });

    it('without HABBLAUD_USAGE_DIR: legacy usage becomes usage folder; with existing ~/.habblaud, only missing items move', async () => {
      mkdirSync(join(home, '.habblaud'), { recursive: true });
      writeFileSync(join(home, '.habblaud', 'names.json'), '{}');
      expect(await exec('install', { accounts: [join(home, '.claude')] }, undefined, { HABBLAUD_USAGE_DIR: undefined })).toBe(0);
      expect(readFileSync(join(home, '.habblaud', 'usage', '.claude.json'), 'utf8')).toBe('{"source":"mod"}');
      expect(readFileSync(join(home, '.habblaud', 'names.json'), 'utf8')).toBe('{}');
      expect(existsSync(join(home, '.codetown'))).toBe(false);
      const text = out.join('\n');
      expect(text).toContain('✓ from ~/.codetown (old name) to ~/.habblaud: usage.');
      expect(text).not.toContain('usage folder created');
    });

    it('legacy plugin that fails to uninstall does not block install: codetown marketplace removes it (but failure counts)', async () => {
      fake.fail = (args) => args[1] === 'uninstall' && args[2] === 'codetown@codetown';
      expect(await exec('install', { accounts: [join(home, '.claude')] })).toBe(1);
      expect(fake.mutating).toEqual([
        ...OLD,
        `plugin marketplace add ${root}`,
        `plugin install ${MOD_PLUGIN} --scope user`,
        `plugin install ${PERMISSIONS_PLUGIN} --scope user`,
        `plugin install ${MESSAGES_PLUGIN} --scope user`,
      ]);
      expect(Object.keys(installed('.claude'))).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN]);
      expect(read('.claude')).toEqual({ model: 'opus' });
      const text = out.join('\n');
      expect(text).toContain('  ✗ codetown (old name): failed (Failed: boom)');
      expect(text).not.toContain('still registered');
      expect(text).not.toContain('Done.');
    });

    it('codetown marketplace failing to uninstall: stops there (never two names for same folder), warns and old hook remains', async () => {
      fake.fail = (args) => args.join(' ') === 'plugin marketplace remove codetown';
      expect(await exec('install', { accounts: [join(home, '.claude')] })).toBe(1);
      expect(fake.mutating).toEqual(OLD);
      expect(Object.fromEntries(fake.account(join(home, '.claude')).marketplaces)).toEqual({ codetown: root });
      expect(read('.claude')).toEqual(oldSettings);
      const text = out.join('\n');
      expect(text).toContain('  ✗ marketplace codetown (old name): failed (Failed: boom)');
      expect(text).toContain('  ! old name still registered: marketplace codetown; run npm run mod:install again');
      expect(text).toContain("old permission hook kept (the permissions plugin didn't get installed)");
    });

    it('--dry-run: shows cleanup and folder that would change, without touching anything', async () => {
      expect(await exec('install', { dryRun: true, accounts: [join(home, '.claude')] })).toBe(0);
      expect(fake.mutating).toEqual([]);
      expect(existsSync(join(home, '.codetown', 'usage', '.claude.json'))).toBe(true);
      expect(existsSync(join(home, '.habblaud'))).toBe(false);
      expect(read('.claude')).toEqual(oldSettings);
      const text = out.join('\n');
      expect(text).toContain('~ ~/.codetown (old name) goes to ~/.habblaud (dry run: nothing moved)');
      expect(text).toContain('  ~ codetown (old name): removed (dry run: claude plugin uninstall codetown@codetown --scope user)');
      expect(text).toContain('  ~ marketplace codetown (old name): removed (dry run: claude plugin marketplace remove codetown)');
    });

    it('status shows legacy leftovers; uninstall removes them too (and does not touch state folder)', async () => {
      expect(await exec('status', { accounts: [join(home, '.claude')] })).toBe(0);
      let text = out.join('\n');
      expect(text).toContain('    ! old name still registered: marketplace codetown (this folder), codetown@codetown 0.3.2, codetown-permissoes@codetown 0.3.2; npm run mod:install replaces it with habblaud');
      expect(text).toContain('    old permission hook installed (old way');
      expect(fake.mutating).toEqual([]);

      out = [];
      expect(await exec('uninstall', { accounts: [join(home, '.claude')] })).toBe(0);
      expect(fake.mutating).toEqual(OLD);
      expect(fake.account(join(home, '.claude')).marketplaces.size).toBe(0);
      expect(installed('.claude')).toEqual({});
      text = out.join('\n');
      expect(text).toContain('  ✓ marketplace codetown (old name): removed');
      expect(text).toContain("  = habblaud: wasn't installed");
      expect(text).toContain('Done.');
      expect(existsSync(join(home, '.codetown', 'usage', '.claude.json'))).toBe(true);
    });

    it('docker:up: only warns, does not change anything on its own and does not show fresh install tip', () => {
      const accounts = [
        { dir: join(home, '.claude'), label: 'Conta C' },
        { dir: join(home, '.claude-conta2'), label: 'Conta D' },
      ];
      const res = updateInstalledMods(accounts, { env: { HOME: home }, home, root, version: '0.4.0', claude: fake.runner });
      expect(res).toEqual({
        installed: true,
        unavailable: false,
        lines: [
          {
            level: 'warn',
            text: "mod on Conta C: still under the old name (marketplace codetown, codetown@codetown 0.3.2, codetown-permissoes@codetown 0.3.2); docker:up doesn't switch it on its own: run npm run mod:install",
          },
        ],
      });
      expect(fake.mutating).toEqual([]);
      expect(modHint(res)).toEqual([]);
      expect(existsSync(join(home, '.codetown'))).toBe(true);
    });
  });

  it('docker:up: updates to new version only accounts with mod; never installs; never throws', async () => {
    const accounts = [
      { dir: join(home, '.claude'), label: 'Conta C' },
      { dir: join(home, '.claude-conta2'), label: 'Conta D' },
    ];
    const ctx = { env: { HOME: home }, home, root, claude: fake.runner };
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.2.0' })).toEqual({ installed: false, unavailable: false, lines: [] });
    expect(fake.mutating).toEqual([]);

    await exec('install', { accounts: [join(home, '.claude-conta2')] });
    fake.calls = [];
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.2.0' })).toEqual({ installed: true, unavailable: false, lines: [] });
    expect(fake.mutating).toEqual([]);

    // git pull: manifests in mod/ and package.json bump to 0.3.0.
    fake.folderVersion = '0.3.0';
    const res = updateInstalledMods(accounts, { ...ctx, version: '0.3.0' });
    expect(res.lines).toEqual([{ level: 'info', text: 'Mod updated to 0.3.0 on Conta D; open sessions: /reload-plugins' }]);
    expect(fake.mutating).toEqual([
      'plugin marketplace update habblaud',
      `plugin update ${MOD_PLUGIN} --scope user`,
      `plugin update ${PERMISSIONS_PLUGIN} --scope user`,
      `plugin update ${MESSAGES_PLUGIN} --scope user`,
    ]);
    expect(installed('.claude-conta2')[MOD_PLUGIN]).toEqual({ version: '0.3.0', enabled: true });
    expect(installed('.claude')).toEqual({});

    // Update "succeeds" but version does not change (outdated manifest): warning, not "updated".
    const stuck = updateInstalledMods(accounts, { ...ctx, version: '0.4.0' });
    expect(stuck.lines[0].level).toBe('warn');
    expect(stuck.lines[0].text).toMatch(/Conta D: habblaud: Claude Code records version 0.3.0, not 0.4.0/);

    // Without claude, or with runner throwing: single warning and no exception.
    fake.missing = true;
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.4.0' })).toEqual({
      installed: false,
      unavailable: true,
      lines: [{ level: 'warn', text: 'couldn\'t query Claude Code (the "claude" command wasn\'t found in PATH); the mod wasn\'t checked.' }],
    });
    const boom: ClaudeRunner = () => {
      throw new Error('exploded');
    };
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.4.0', claude: boom }).unavailable).toBe(true);
  });

  it('docker:up: account with mod and without messages plugin: installs nothing, only gives tip (also on update)', async () => {
    const accounts = [
      { dir: join(home, '.claude'), label: 'Conta C' },
      { dir: join(home, '.claude-conta2'), label: 'Conta D' },
    ];
    const ctx = { env: { HOME: home }, home, root, claude: fake.runner };
    // Installed with --sem-mensagens (or before plugin existed), only on account 2.
    await exec('install', { messages: false, accounts: [join(home, '.claude-conta2')] });
    fake.calls = [];
    const hint = { level: 'info', text: 'Tip for Conta D: run npm run mod:install to send messages from the office (plugin habblaud-mensagens)' };
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.2.0' })).toEqual({ installed: true, unavailable: false, lines: [hint] });
    expect(fake.mutating).toEqual([]);

    fake.folderVersion = '0.3.0';
    const res = updateInstalledMods(accounts, { ...ctx, version: '0.3.0' });
    expect(res.lines).toEqual([{ level: 'info', text: 'Mod updated to 0.3.0 on Conta D; open sessions: /reload-plugins' }, hint]);
    expect(fake.mutating).toEqual(['plugin marketplace update habblaud', `plugin update ${MOD_PLUGIN} --scope user`, `plugin update ${PERMISSIONS_PLUGIN} --scope user`]);
    expect(installed('.claude-conta2')[MESSAGES_PLUGIN]).toBeUndefined();
    expect(modHint(res)).toEqual([]);
  });
});
