import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { accountIds, codexDirsRefused, discoverClaudeDirs, detectAccounts, isClaudeDir, isCodexHome, parseClaudeAliases, shortcutsByDir } from './detect';
import { AccountsService } from './service';
import { rollover, STALE_AFTER_MS, usageFromCache, usageFromWindows, UsageStore } from './usage';

setQuiet(true);

// Absolute root also on Windows (resolve adds drive letter there).
const H = resolve('/Users/fulano');

describe('shell aliases', () => {
  it('only alias lines invoking claude; CLAUDE_CONFIG_DIR expanded', () => {
    const rc = [
      'export OPENAI_API_KEY="sk-segredo"',
      "alias ll='ls -la'",
      "alias claude2='CLAUDE_CONFIG_DIR=\"$HOME/.claude-conta2\" claude --permission-mode auto'",
      "alias c='claude --permission-mode auto'",
      "alias f='claude --permission-mode auto --agent frinus'",
      "alias d='CLAUDE_CONFIG_DIR=\"$HOME/.claude-conta2\" claude --permission-mode auto'",
      'alias e="CLAUDE_CONFIG_DIR=~/.claude-trabalho/ claude"',
      "alias sq='claude-squad'",
      "  # alias x='claude'",
      "alias w='cd ~/.claude && ls'",
    ].join('\n');
    expect(parseClaudeAliases(rc, H)).toEqual([
      { name: 'claude2', configDir: join(H, '.claude-conta2') },
      { name: 'c' },
      { name: 'f' },
      { name: 'd', configDir: join(H, '.claude-conta2') },
      { name: 'e', configDir: join(H, '.claude-trabalho') },
    ]);
  });

  it('prefers shortest alias (tie-breaker: first) and uses uppercase', () => {
    const m = shortcutsByDir(
      [{ name: 'claude2', configDir: join(H, '.claude-conta2') }, { name: 'c' }, { name: 'f' }, { name: 'd', configDir: join(H, '.claude-conta2') }],
      H,
    );
    expect(m.get(join(H, '.claude'))).toBe('C');
    expect(m.get(join(H, '.claude-conta2'))).toBe('D');
  });

  it('disambiguated IDs when two dirs share the same basename', () => {
    expect(accountIds(['/a/.claude', '/b/.claude', '/c/.claude-x'])).toEqual(['.claude', '.claude~2', '.claude-x']);
  });
});

describe('account detection', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  beforeEach(() => {
    tmp = tempDir();
    home = tmp.dir;
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-conta2', 'sessions'), { recursive: true });
    mkdirSync(join(home, '.claude-vazio'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), '{}');
    writeFileSync(
      join(home, '.zshrc'),
      "alias c='claude'\nalias d='CLAUDE_CONFIG_DIR=\"$HOME/.claude-conta2\" claude'\nexport TOKEN=nao-leia\n",
    );
  });
  afterEach(() => tmp.cleanup());

  it('discovers $HOME/.claude* with projects/ or sessions/, default first', () => {
    expect(discoverClaudeDirs({}, home)).toEqual([join(home, '.claude'), join(home, '.claude-conta2')]);
    const extra = join(home, 'outra');
    mkdirSync(extra);
    expect(discoverClaudeDirs({ CLAUDE_CONFIG_DIR: extra }, home)).toContain(extra);
    expect(discoverClaudeDirs({ HABBLAUD_CLAUDE_DIRS: ' /x/a , ~/b ' }, home)).toEqual([resolve('/x/a'), join(home, 'b')]);
  });

  it('Codex folder (CODEX_HOME) does not become a Claude Code account via any path', () => {
    // Synthetic CODEX_HOME: sessions/YYYY/MM/DD (rollouts), locks, config.toml and auth.json (never opened).
    const codex = join(home, '.codex');
    mkdirSync(join(codex, 'sessions', '2026', '10', '09'), { recursive: true });
    mkdirSync(join(codex, 'thread-writer-locks'), { recursive: true });
    writeFileSync(join(codex, 'config.toml'), 'model = "x"\n');
    writeFileSync(join(codex, 'auth.json'), '{}');
    // CODEX_HOME with a name picked up by $HOME scan (.claude*): only with sessions/YYYY/.
    const disfarcado = join(home, '.claude-codex');
    mkdirSync(join(disfarcado, 'sessions', '2026'), { recursive: true });
    for (const marca of ['thread-writer-locks', 'archived_sessions', 'config.toml', 'auth.json', 'sessions/2026']) {
      const p = join(home, `codex-${marca.replace('/', '-')}`);
      if (marca.includes('.')) {
        mkdirSync(join(p, 'sessions'), { recursive: true });
        writeFileSync(join(p, marca), '');
      } else mkdirSync(join(p, marca), { recursive: true });
      expect(isCodexHome(p), marca).toBe(true);
      expect(isClaudeDir(p), marca).toBe(false);
    }
    // Claude Code accounts remain valid: empty sessions/ or with <pid>.json, and projects/ always takes precedence.
    writeFileSync(join(home, '.claude-conta2', 'sessions', '123.json'), '{}');
    for (const p of [join(home, '.claude'), join(home, '.claude-conta2')]) expect(isClaudeDir(p)).toBe(true);
    const misto = join(home, '.claude-misto');
    mkdirSync(join(misto, 'projects'), { recursive: true });
    writeFileSync(join(misto, 'config.toml'), '');
    expect(isCodexHome(misto)).toBe(false);
    expect(isCodexHome(join(home, 'nao-existe'))).toBe(false);
    expect(isCodexHome(join(home, '.claude-vazio'))).toBe(false);

    expect(discoverClaudeDirs({}, home)).toEqual([join(home, '.claude'), join(home, '.claude-conta2'), misto]);
    expect(codexDirsRefused({}, home)).toEqual([disfarcado]);
    // CLAUDE_CONFIG_DIR and HABBLAUD_CLAUDE_DIRS pointing to Codex: excluded (rest of list unchanged).
    expect(discoverClaudeDirs({ CLAUDE_CONFIG_DIR: codex }, home)).not.toContain(codex);
    expect(codexDirsRefused({ CLAUDE_CONFIG_DIR: codex }, home)).toEqual([disfarcado, codex]);
    expect(discoverClaudeDirs({ HABBLAUD_CLAUDE_DIRS: `~/.claude,~/.codex,/x/a` }, home)).toEqual([join(home, '.claude'), resolve('/x/a')]);
    expect(codexDirsRefused({ HABBLAUD_CLAUDE_DIRS: `~/.claude,~/.codex,/x/a` }, home)).toEqual([codex]);
    const env = { HABBLAUD_ACCOUNTS: JSON.stringify([{ id: '.codex', mountDir: codex }]) };
    expect(discoverClaudeDirs(env, home)).not.toContain(codex);
  });

  it('reads only allowed fields from .claude.json, shortcuts and colors', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@empresa.com', organizationName: 'Company', displayName: 'A', billingType: 'x', accountUuid: 'nao' },
        mcpServers: { s: { env: { SECRET: 'nao-pode-vazar' } } },
      }),
    );
    writeFileSync(
      join(home, '.claude-conta2', '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'b@pessoal.com' },
        cachedUsageUtilization: { fetchedAtMs: 1000, utilization: { five_hour: { utilization: 10, resets_at: null } } },
      }),
    );
    const accs = detectAccounts([join(home, '.claude'), join(home, '.claude-conta2'), join(home, '.claude-vazio')], { home, env: {} });
    expect(accs).toEqual([
      { id: '.claude', configDir: join(home, '.claude'), short: 'C', name: 'a (Claude)', color: '#f08a3c', email: 'a@empresa.com', organization: 'Company' },
      {
        id: '.claude-conta2',
        configDir: join(home, '.claude-conta2'),
        short: 'D',
        name: 'b (Claude)',
        color: '#4aa8e8',
        email: 'b@pessoal.com',
        cachedUsage: { fetchedAtMs: 1000, utilization: { five_hour: { utilization: 10, resets_at: null } } },
      },
      { id: '.claude-vazio', configDir: join(home, '.claude-vazio'), short: 'A', name: 'Account A', color: '#5cc97b' },
    ]);
    expect(JSON.stringify(accs)).not.toContain('nao-pode-vazar');
  });

  it('HABBLAUD_ACCOUNTS (Docker) overrides metadata matching by id or mountDir', () => {
    const env = {
      HABBLAUD_ACCOUNTS: JSON.stringify([
        { id: '.claude', configDir: '/Users/x/.claude', mountDir: join(home, '.claude'), short: 'C', email: 'host@x.com', plan: 'Max', color: '#000000' },
        { mountDir: join(home, '.claude-conta2'), configDir: '/Users/x/.claude-conta2', short: 'D', name: 'Personal', cachedUsage: { fetchedAtMs: 5 } },
      ]),
    };
    const accs = detectAccounts([join(home, '.claude'), join(home, '.claude-conta2')], { home: '/nenhum', env });
    expect(accs[0]).toMatchObject({ id: '.claude', configDir: '/Users/x/.claude', short: 'C', name: 'host (Claude)', email: 'host@x.com', plan: 'Max', color: '#000000' });
    expect(accs[1]).toMatchObject({ id: '.claude-conta2', configDir: '/Users/x/.claude-conta2', short: 'D', name: 'Personal', cachedUsage: { fetchedAtMs: 5 } });
  });
});

describe('usage (5h and weekly)', () => {
  const NOW = Date.parse('2026-10-06T12:00:00Z');
  const windows = {
    five_hour: { utilization: 42.5, resets_at: '2026-10-06T14:00:00.123+00:00' },
    seven_day: { utilization: 15, resets_at: '2026-10-09T23:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3, resets_at: null },
    extra_usage: { is_enabled: false },
  };

  it('normalizes windows to Claude Code format', () => {
    expect(usageFromWindows(windows, 'cache', NOW)).toEqual({
      source: 'cache',
      fetchedAt: NOW,
      fiveHour: { utilization: 42.5, resetsAt: Date.parse('2026-10-06T14:00:00.123Z') },
      sevenDay: { utilization: 15, resetsAt: Date.parse('2026-10-09T23:00:00Z') },
      sevenDaySonnet: { utilization: 3 },
    });
    expect(usageFromWindows({}, 'cache', NOW)).toBeUndefined();
  });

  it('cache: fetchedAtMs becomes fetchedAt; old = stale; missing = disabled', () => {
    const store = new UsageStore();
    expect(store.view('x', NOW).status).toBe('disabled');
    store.set('x', usageFromCache({ fetchedAtMs: NOW - 5 * 60_000, utilization: windows })!);
    expect(store.view('x', NOW).status).toBe('ok');
    expect(store.view('x', NOW + STALE_AFTER_MS).status).toBe('stale');
  });

  it('windows whose reset time has passed have no data (never an invented 0%)', () => {
    const u = usageFromWindows(windows, 'cache', NOW)!;
    // Before weekly reset, but after 5h session reset.
    const r = rollover(u, Date.parse('2026-10-06T15:00:00Z'));
    expect(r.fiveHour).toBeUndefined();
    expect(r.sevenDay).toEqual({ utilization: 15, resetsAt: Date.parse('2026-10-09T23:00:00Z') });
    // Without reset time: remains valid.
    expect(r.sevenDaySonnet).toEqual({ utilization: 3 });
    const later = rollover(u, Date.parse('2026-10-10T00:00:00Z'));
    expect(later.fiveHour).toBeUndefined();
    expect(later.sevenDay).toBeUndefined();
    expect(later).toMatchObject({ source: 'cache', fetchedAt: NOW });
    // Original is not modified.
    expect(u.fiveHour?.utilization).toBe(42.5);
  });

  it('source with newer numbers takes precedence; clearing one source restores the other', () => {
    const store = new UsageStore();
    store.set('x', usageFromWindows(windows, 'cache', NOW - 3_600_000)!);
    store.set('x', usageFromWindows({ ...windows, five_hour: { utilization: 77, resets_at: null } }, 'statusline', NOW - 60_000)!);
    expect(store.view('x', NOW)).toMatchObject({ status: 'ok', usage: { source: 'statusline', fiveHour: { utilization: 77 } } });
    expect(store.clear('x', 'statusline')).toBe(true);
    expect(store.view('x', NOW)).toMatchObject({ status: 'stale', usage: { source: 'cache' } });
  });

  it('AccountsService: accounts from another tool (external list), unique IDs, and pushed usage', () => {
    const tmp = tempDir();
    try {
      const dir = join(tmp.dir, '.claude');
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      let changes = 0;
      let now = NOW;
      const svc = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => changes++, now: () => now });
      const det = (id: string) => ({ id, configDir: `/Users/x/${id}`, short: 'X', name: 'Codex', color: '#10a37f' });
      changes = 0;
      const set = svc.setProviderAccounts('codex', [
        { dir: join(tmp.dir, '.codex'), detected: det('.codex') },
        { dir: join(tmp.dir, 'b', '.codex'), detected: det('.codex') },
        // Same ID as Claude Code account: disambiguated.
        { dir: join(tmp.dir, 'c', '.claude'), detected: det('.claude') },
      ]);
      expect(set.map((e) => [e.id, e.provider, e.detected.id, e.detected.provider])).toEqual([
        ['.codex', 'codex', '.codex', 'codex'],
        ['.codex~2', 'codex', '.codex~2', 'codex'],
        ['.claude~2', 'codex', '.claude~2', 'codex'],
      ]);
      expect(changes).toBe(1);
      // Same list again: same IDs, no change notification.
      expect(svc.setProviderAccounts('codex', set.map((e) => ({ dir: e.dir, detected: det(basename(e.dir)) }))).map((e) => e.id)).toEqual([
        '.codex',
        '.codex~2',
        '.claude~2',
      ]);
      expect(changes).toBe(1);
      // entries() = Claude Code only (watcher, history, and statusline); others see all.
      expect(svc.entries().map((e) => [e.id, e.provider])).toEqual([['.claude', 'claude']]);
      expect(svc.entriesOf('codex').map((e) => e.id)).toEqual(['.codex', '.codex~2', '.claude~2']);
      expect(svc.allEntries().map((e) => e.id)).toEqual(['.claude', '.codex', '.codex~2', '.claude~2']);
      expect(svc.find('.codex~2')?.dir).toBe(join(tmp.dir, 'b', '.codex'));
      expect(svc.idForDir(join(tmp.dir, '.codex'))).toBe('.codex');
      const infos = svc.list(new Map([['.codex', 2]]));
      expect(infos[0]).not.toHaveProperty('provider');
      expect(infos[1]).toMatchObject({ id: '.codex', provider: 'codex', sessions: 2, usageStatus: 'disabled', configDir: '/Users/x/.codex' });

      // Usage pushed by source (origin 'codex'), with noQuota account.
      changes = 0;
      expect(svc.setUsage('.codex', { source: 'codex', fetchedAt: NOW - 60_000, fiveHour: { utilization: 12.5, resetsAt: NOW + 3_600_000 } })).toBe(true);
      expect(changes).toBe(1);
      expect(svc.setUsage('.codex', { source: 'codex', fetchedAt: NOW - 60_000, fiveHour: { utilization: 12.5, resetsAt: NOW + 3_600_000 } })).toBe(false);
      expect(changes).toBe(1);
      svc.setUsage('.codex~2', { source: 'codex', fetchedAt: NOW, noQuota: true });
      expect(svc.list(new Map()).find((a) => a.id === '.codex')).toMatchObject({ usageStatus: 'ok', usage: { source: 'codex', fiveHour: { utilization: 12.5 } } });
      expect(svc.list(new Map()).find((a) => a.id === '.codex~2')?.usage).toEqual({ source: 'codex', fetchedAt: NOW, noQuota: true });
      // Ages like other origins (periodic refresh detects and notifies).
      now = NOW + STALE_AFTER_MS;
      changes = 0;
      svc.refresh();
      expect(changes).toBe(1);
      expect(svc.usageView('.codex').status).toBe('stale');
      expect(svc.clearUsage('.codex', 'codex')).toBe(true);
      expect(svc.usageView('.codex').status).toBe('disabled');

      // Removed account loses saved usage; empty list removes tool.
      svc.setProviderAccounts('codex', [{ dir: join(tmp.dir, '.codex'), detected: det('.codex') }]);
      expect(svc.usageView('.codex~2').status).toBe('disabled');
      svc.setProviderAccounts('codex', []);
      expect(svc.allEntries().map((e) => e.id)).toEqual(['.claude']);
      expect(svc.list(new Map()).map((a) => a.id)).toEqual(['.claude']);
    } finally {
      tmp.cleanup();
    }
  });

  it('AccountsService.addDir watches an account added at run time (once)', () => {
    const tmp = tempDir();
    try {
      const a = join(tmp.dir, '.claude');
      const b = join(tmp.dir, '.claude-nova');
      mkdirSync(join(a, 'projects'), { recursive: true });
      mkdirSync(join(b, 'projects'), { recursive: true });
      let changes = 0;
      const svc = new AccountsService({ dirs: [a], home: tmp.dir, env: {}, onChange: () => changes++, now: () => NOW });
      changes = 0;
      expect(svc.addDir(b)).toBe('.claude-nova');
      expect(svc.entries().map((e) => e.id)).toEqual(['.claude', '.claude-nova']);
      expect(changes).toBe(1);
      expect(svc.addDir(b)).toBe('.claude-nova');
      expect(svc.entries()).toHaveLength(2);
    } finally {
      tmp.cleanup();
    }
  });

  it('AccountsService reads /usage cache from account .claude.json', () => {
    const tmp = tempDir();
    try {
      const dir = join(tmp.dir, '.claude-conta2');
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      let changes = 0;
      const svc = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => changes++, now: () => NOW });
      expect(svc.list(new Map())[0].usageStatus).toBe('disabled');
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: NOW - 60_000, utilization: windows } }));
      svc.refresh();
      const info = svc.list(new Map([['.claude-conta2', 3]]))[0];
      expect(info).toMatchObject({ id: '.claude-conta2', sessions: 3, usageStatus: 'ok', usage: { source: 'cache', fiveHour: { utilization: 42.5 } } });
      expect(changes).toBeGreaterThan(0);
    } finally {
      tmp.cleanup();
    }
  });
});
