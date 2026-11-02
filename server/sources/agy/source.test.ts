// Antigravity source: temporary profiles on disk, a fake /proc, the AccountsService and the Office.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { agyDetected, discoverAgyProfiles, emailFromCliLog, emailFromLogs, parseNamesConf, parseRolesConf, workerName } from './profiles';
import { scanAgyProcs, type ProcReader } from './procs';
import { AgySource, END_WAIT_MS } from './source';
import type { NewsItem } from '../../../shared/types';
import { parseAgyUsage } from './usage';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

interface FakeProc {
  comm: string;
  ppid: number;
  home?: string;
  args?: string[];
  cwd?: string;
  /** Start, in seconds after boot. */
  start?: number;
}

const BOOT_MS = 1_800_000_000_000;

/** Fake /proc: processes by PID; boot at BOOT_MS. */
function fakeProc(procs: Map<number, FakeProc>): ProcReader {
  return {
    list: () => [...procs.keys()],
    comm: (pid) => procs.get(pid)?.comm,
    environ: (pid) => (procs.get(pid)?.home ? [`HOME=${procs.get(pid)!.home}`, 'PATH=/bin'] : ['PATH=/bin']),
    cmdline: (pid) => procs.get(pid)?.args ?? [procs.get(pid)?.comm ?? ''],
    cwd: (pid) => procs.get(pid)?.cwd,
    stat: (pid) => (procs.has(pid) ? { ppid: procs.get(pid)!.ppid, startTicks: (procs.get(pid)!.start ?? 0) * 100 } : undefined),
    bootMs: () => BOOT_MS,
  };
}

function profiles(names: string[], roles = '') {
  const root = mkdtempSync(join(tmpdir(), 'habblaud-agy-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const n of names) {
    // signed in: agy's log names the Google account
    mkdirSync(join(root, n, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(root, n, '.gemini', 'antigravity-cli', 'cli.log'), `I1026 1 server_oauth.go:229] OAuth: authenticated as ${n}@example.com\n`);
  }
  if (roles) writeFileSync(join(root, 'roles.conf'), roles);
  return root;
}

describe('Antigravity profiles', () => {
  it('reads roles.conf (account, role; comments left out)', () => {
    const r = parseRolesConf('# acc role mode\nacc1 architect plan\n\nacc2   impl  accept-edits # code\njunk\n');
    expect([...r]).toEqual([
      ['acc1', 'architect'],
      ['acc2', 'impl'],
    ]);
  });

  it('takes the e-mail from the last OAuth line of cli.log', () => {
    const log = [
      'I1026 10:25:53.89 1 server_oauth.go:229] OAuth: authenticated as old@gmail.com',
      'I1026 10:26:00.00 1 http_helpers.go:349] URL: https://x.googleapis.com/v1',
      'I1026 11:54:49.89 1 server_oauth.go:229] OAuth: authenticated as new.name@gmail.com',
    ].join('\n');
    expect(emailFromCliLog(log)).toBe('new.name@gmail.com');
    expect(emailFromCliLog('nothing here')).toBeUndefined();
  });

  it('finds the profiles in natural order, with role, and skips _backup and folders without agy', () => {
    const root = profiles(['acc10', 'acc2', 'acc1', '_backup'], 'acc2 impl accept-edits\n');
    mkdirSync(join(root, 'empty'));
    const found = discoverAgyProfiles(root);
    expect(found.map((p) => p.acc)).toEqual(['acc1', 'acc2', 'acc10']);
    expect(found.map((p) => p.role)).toEqual([undefined, 'impl', undefined]);
  });

  it('name: names.conf, else the e-mail user up to the first dot, else the account', () => {
    expect([...parseNamesConf('# conta nome\nacc2 Bob Tran  \nacc3\n')]).toEqual([['acc2', 'Bob Tran']]);
    expect(workerName({ acc: 'acc2', email: 'x@gmail.com', name: 'Bob' })).toBe('Bob');
    expect(workerName({ acc: 'acc2', email: 'alice.nguyen@gmail.com' })).toBe('alice');
    expect(workerName({ acc: 'acc2' })).toBe('acc2');
    const root = profiles(['acc1', 'acc2']);
    writeFileSync(join(root, 'acc1', '.gemini', 'antigravity-cli', 'cli.log'), 'I1 server_oauth.go:229] OAuth: authenticated successfully as alice@gmail.com\n');
    writeFileSync(join(root, 'names.conf'), 'acc2 Carol\n');
    expect(discoverAgyProfiles(root).map(workerName)).toEqual(['alice', 'Carol']);
  });

  it('letter = account number; color outside the ones in use', () => {
    const [p] = discoverAgyProfiles(profiles(['acc12']));
    const d = agyDetected(p, 0, ['#f08a3c']);
    expect(d.short).toBe('12');
    expect(d.id).toBe('agy:acc12');
    expect(d.color).not.toBe('#f08a3c');
    expect(d.name).toBe('acc12 (Agy)');
  });

  it('e-mail: cli.log of a run that just started has none yet, so the newest older log in log/ gives it', () => {
    const root = profiles(['acc1']);
    const state = join(root, 'acc1', '.gemini', 'antigravity-cli');
    mkdirSync(join(state, 'log'));
    writeFileSync(join(state, 'cli.log'), 'I1027 starting\n');
    writeFileSync(join(state, 'log', 'cli-20261026_100000.log'), 'I server_oauth.go:229] OAuth: authenticated successfully as old@x.com\n');
    writeFileSync(join(state, 'log', 'cli-20261027_100000.log'), 'I server_oauth.go:229] OAuth: authenticated successfully as new.name@x.com\n');
    expect(emailFromLogs(state)).toBe('new.name@x.com');
    expect(workerName(discoverAgyProfiles(root)[0])).toBe('new');
  });

  it('an account with role "off" in roles.conf is still an account (the team decides who works)', () => {
    const root = profiles(['acc1', 'acc2', 'acc3'], 'acc1 architect plan\nacc3 off # vacant\n');
    expect(discoverAgyProfiles(root).map((p) => [p.acc, p.role])).toEqual([
      ['acc1', 'architect'],
      ['acc2', undefined],
      ['acc3', 'off'],
    ]);
  });
});

describe('parseAgyUsage', () => {
  it('turns what is left into how much was used, Gemini only', () => {
    const text = [
      'Gemini Models\tWeekly Limit Remaining\t97%\t2026-10-31T09:52:49Z',
      'Gemini Models\tFive Hour Limit Remaining\t96%\t2026-10-26T08:26:06Z',
      'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-02T04:54:53Z',
    ].join('\n');
    const u = parseAgyUsage(text, 1000)!;
    expect(u.source).toBe('agy');
    expect(u.sevenDay).toEqual({ utilization: 3, resetsAt: Date.parse('2026-10-31T09:52:49Z') });
    expect(u.fiveHour?.utilization).toBe(4);
    expect(u.noFiveHour).toBeUndefined();
  });

  it('account without Pro: only the weekly line, flagged as having no 5-hour window', () => {
    const text = [
      'Gemini Models\tWeekly Limit Remaining\t94%\t2026-10-31T08:44:52Z',
      'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-02T13:32:44Z',
    ].join('\n');
    const u = parseAgyUsage(text, 1)!;
    expect(u.sevenDay?.utilization).toBe(6);
    expect(u.fiveHour).toBeUndefined();
    expect(u.noFiveHour).toBe(true);
  });

  it('"disabled" = week used up; without the 5 h window only the week remains; nothing = undefined', () => {
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Remaining\tdisabled\t', 1)?.sevenDay).toEqual({ utilization: 100 });
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Remaining\t96%\t2026-10-31T08:44:52Z', 1)?.fiveHour).toBeUndefined();
    expect(parseAgyUsage('agy: not logged in', 1)).toBeUndefined();
  });
});

describe('scanAgyProcs', () => {
  it('finds the accounts\' agy by HOME, tells headless from interactive and finds the Claude above', () => {
    const root = '/h/.agy_profiles';
    const procs = new Map<number, FakeProc>([
      [10, { comm: 'claude', ppid: 1 }],
      [20, { comm: 'python3', ppid: 10 }],
      [30, { comm: 'agy', ppid: 20, home: `${root}/acc2`, args: ['agy', '-p', 'Read x.py\nand y', '--mode', 'plan'], cwd: '/w/proj', start: 5 }],
      [31, { comm: 'agy', ppid: 30, home: `${root}/acc2`, args: ['agy', 'language-server'] }],
      [40, { comm: 'agy', ppid: 1, home: `${root}/acc3`, args: ['agy'], start: 2 }],
      [50, { comm: 'agy', ppid: 1, home: `${root}/acc4`, args: ['agy', '-p', '/usage'] }],
      [60, { comm: 'agy', ppid: 1, home: '/home/eu', args: ['agy', '-p', 'oi'] }],
      [70, { comm: 'agy', ppid: 1, home: `${root}/acc5/sub`, args: ['agy', '-p', 'oi'] }],
    ]);
    const found = scanAgyProcs(root, fakeProc(procs));
    expect(found).toEqual([
      { pid: 40, acc: 'acc3', headless: false, startedAt: BOOT_MS + 2_000, ppid: 1, orphan: true },
      { pid: 30, acc: 'acc2', headless: true, prompt: 'Read x.py\nand y', cwd: '/w/proj', startedAt: BOOT_MS + 5_000, ppid: 20, claudePid: 10 },
    ]);
  });
});

describe('scanAgyProcs: orphans', () => {
  it('an agy whose parent died was reparented to init or systemd --user', () => {
    const root = '/h/.agy_profiles';
    const procs = new Map<number, FakeProc>([
      [5, { comm: 'systemd', ppid: 1 }],
      [6, { comm: 'herdr', ppid: 5 }],
      [30, { comm: 'agy', ppid: 5, home: `${root}/acc2`, args: ['agy', '-p', 'hi'] }],
      [31, { comm: 'agy', ppid: 6, home: `${root}/acc4`, args: ['agy'] }],
    ]);
    const found = scanAgyProcs(root, fakeProc(procs));
    expect(found.find((p) => p.pid === 30)?.orphan).toBe(true);
    expect(found.find((p) => p.pid === 31)?.orphan).toBeUndefined();
  });
});

function setup(names = ['acc2', 'acc3'], roles = 'acc2 impl accept-edits\nacc3 qa accept-edits\n') {
  const root = profiles(names, roles);
  let clock = BOOT_MS + 100_000;
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: root, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'test',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const procs = new Map<number, FakeProc>([[10, { comm: 'claude', ppid: 1, cwd: '/w/Habblaud' }]]);
  let herdr = new Map<number, 'working' | 'blocked' | 'idle'>();
  const killed: Array<[number, string]> = [];
  const source = new AgySource({
    accounts,
    office,
    root,
    room: '/w/agy-hub',
    home: root,
    procs: fakeProc(procs),
    herdr: async () => herdr,
    kill: (pid, sig) => void killed.push([pid, sig]),
    usage: async (acc) => (acc === 'acc2' ? 'Gemini Models\tWeekly Limit Remaining\t90%\t2030-10-31T09:52:49Z\n' : ''),
    now,
  });
  cleanups.unshift(() => source.stop());
  return {
    root,
    killed,
    accounts,
    office,
    source,
    procs,
    setHerdr(m: Map<number, 'working' | 'blocked' | 'idle'>) {
      herdr = m;
    },
    advance(ms: number) {
      clock += ms;
    },
    agent(acc: string) {
      return office.commit().snapshot.agents.find((a) => a.id === `agy:${acc}`);
    },
    job(pid: number, acc: string, prompt: string, start = 99) {
      procs.set(pid - 1, { comm: 'python3', ppid: 10 });
      procs.set(pid, { comm: 'agy', ppid: pid - 1, home: join(root, acc), args: ['agy', '-p', prompt], cwd: '/w/proj', start });
    },
    start(pid: number, acc: string, line: Record<string, unknown>) {
      appendFileSync(join(root, 'agy-ask.log.jsonl'), `${JSON.stringify({ event: 'start', acc, pid: pid - 1, ts: clock / 1000, ...line })}\n`);
    },
    end(pid: number, acc: string, line: Record<string, unknown>) {
      procs.delete(pid);
      procs.delete(pid - 1);
      appendFileSync(join(root, 'agy-ask.log.jsonl'), `${JSON.stringify({ event: 'end', acc, pid: pid - 1, ts: clock / 1000, ...line })}\n`);
    },
  };
}

describe('AgySource', () => {
  it('each account is a fixed worker, idle and "free", in the workers room', () => {
    const t = setup();
    t.source.start();
    const a = t.agent('acc2')!;
    expect(a).toMatchObject({ kind: 'main', provider: 'agy', name: 'acc2 (Agy)', status: 'idle', roomId: '/w/agy-hub', account: 'agy:acc2' });
    expect(a.title).toBe('free');
    expect(t.source.sources().map((s) => s.label)).toEqual(['acc2', 'acc3']);
  });

  it('headless call = working with the prompt; at the end, "Done" with the agy-ask tokens', () => {
    const t = setup();
    t.source.start();
    t.job(31, 'acc2', 'Summarize GROUND_TRUTH_PLAN_V7.md in 5 bullets');
    t.source.poll();
    let a = t.agent('acc2')!;
    expect(a.status).toBe('working');
    expect(a.activity).toMatchObject({ kind: 'prompt', icon: '📋', text: 'Summarize GROUND_TRUTH_PLAN_V7.md in 5…' });
    expect(t.office.detail('agy:acc2')?.history.at(-1)?.detail).toContain('Habblaud');

    t.advance(12_000);
    t.end(31, 'acc2', { status: 'SUCCESS', sec: 12, usage: { total_tokens: 8_269 } });
    t.source.poll();
    a = t.agent('acc2')!;
    expect(a.status).toBe('idle');
    expect(a.activity).toMatchObject({ kind: 'done', icon: '✅' });
    expect(a.activity?.text).toMatch(/8\.3k tokens$/);
  });

  it('without the agy-ask line (batch script), "Done" comes after the wait, without tokens', () => {
    const t = setup();
    t.source.start();
    t.job(41, 'acc3', 'batch 7');
    t.source.poll();
    t.procs.delete(41);
    t.source.poll();
    expect(t.agent('acc3')).toMatchObject({ status: 'working', activity: { kind: 'prompt' } });
    t.advance(END_WAIT_MS + 1);
    t.source.poll();
    expect(t.agent('acc3')).toMatchObject({ status: 'idle', activity: { kind: 'done', icon: '✅' } });
    expect(t.agent('acc3')?.activity?.text).not.toMatch(/tokens/);
  });

  it('agy-ask TIMEOUT becomes an error activity', () => {
    const t = setup();
    t.source.start();
    t.job(51, 'acc2', 'long job');
    t.source.poll();
    t.end(51, 'acc2', { status: 'TIMEOUT', sec: 900 });
    t.source.poll();
    expect(t.agent('acc2')?.activity).toMatchObject({ kind: 'done', icon: '⚠️', error: true, text: 'Failed: TIMEOUT' });
    expect(t.agent('acc2')?.status).toBe('idle');
  });

  it('ghost check: a headless agy is watched, by its start until a write shows up in the account', () => {
    const t = setup();
    t.source.start();
    t.job(31, 'acc2', 'long');
    t.source.poll();
    const started = BOOT_MS + 99_000;
    expect(t.source.ghostCandidates()).toEqual([{ agentId: 'agy:acc2', name: 'acc2', pid: 31, lastSign: started }]);
    const conv = join(t.root, 'acc2', '.gemini', 'antigravity-cli', 'conversations');
    mkdirSync(conv);
    writeFileSync(join(conv, 'a.db-wal'), 'x');
    const later = started + 3_600_000;
    utimesSync(join(conv, 'a.db-wal'), later / 1000, later / 1000);
    expect(t.source.ghostCandidates()[0].lastSign).toBe(later);
  });

  it('ghost check: no job left when the agy-ask end line is written or the parent is gone', () => {
    const t = setup();
    t.source.start();
    t.job(31, 'acc2', 'answered, then hung');
    t.start(31, 'acc2', { role: 'qa' });
    t.source.poll();
    expect(t.source.ghostCandidates()[0].jobless).toBeUndefined();
    appendFileSync(join(t.root, 'agy-ask.log.jsonl'), `${JSON.stringify({ event: 'end', acc: 'acc2', pid: 30, ts: 1, status: 'SUCCESS' })}\n`);
    t.source.poll();
    expect(t.source.ghostCandidates()[0].jobless).toBe(true);
    t.procs.set(41, { comm: 'agy', ppid: 1, home: join(t.root, 'acc3'), args: ['agy', '-p', 'orphan'] });
    t.source.poll();
    expect(t.source.ghostCandidates().find((c) => c.pid === 41)?.jobless).toBe(true);
  });

  it('ghost check: an interactive agy under a live terminal is left alone, an orphan one is not', () => {
    const t = setup();
    t.source.start();
    t.procs.set(20, { comm: 'herdr', ppid: 10 });
    t.procs.set(21, { comm: 'agy', ppid: 20, home: join(t.root, 'acc2'), args: ['agy'] });
    expect(t.source.ghostCandidates()).toEqual([]);
    t.procs.set(21, { comm: 'agy', ppid: 1, home: join(t.root, 'acc2'), args: ['agy'] });
    expect(t.source.ghostCandidates()).toMatchObject([{ pid: 21, jobless: true }]);
  });

  it('ghost check: a profile with no character is not watched', () => {
    const t = setup();
    t.source.setTeam(['acc2']);
    t.source.start();
    t.job(31, 'acc3', 'not a worker');
    expect(t.source.ghostCandidates()).toEqual([]);
  });

  it('herdr pane blocked = needs you; working = working', async () => {
    const t = setup();
    t.source.start();
    t.procs.set(60, { comm: 'agy', ppid: 1, home: join(t.root, 'acc3'), args: ['agy'] });
    t.setHerdr(new Map([[60, 'blocked']]));
    await (t.source as unknown as { pollHerdr(): Promise<void> }).pollHerdr();
    t.source.poll();
    expect(t.agent('acc3')).toMatchObject({ status: 'waiting' });
    t.setHerdr(new Map([[60, 'working']]));
    await (t.source as unknown as { pollHerdr(): Promise<void> }).pollHerdr();
    t.source.poll();
    expect(t.agent('acc3')?.status).toBe('working');
  });

  it('no /usage while the account\'s agy is running (one agy per profile)', async () => {
    const t = setup();
    t.source.start();
    t.procs.set(77, { comm: 'agy', ppid: 1, home: join(t.root, 'acc2'), args: ['agy'] });
    await t.source.refreshUsage();
    expect(t.accounts.list(new Map()).find((a) => a.id === 'agy:acc2')?.usage).toBeUndefined();
  });

  it('each account\'s /usage becomes the account usage (no answer, no usage)', async () => {
    const t = setup();
    t.source.start();
    await t.source.refreshUsage();
    const acc = t.accounts.list(new Map()).find((a) => a.id === 'agy:acc2')!;
    expect(acc.provider).toBe('agy');
    expect(acc.usage?.sevenDay?.utilization).toBe(10);
    expect(t.accounts.list(new Map()).find((a) => a.id === 'agy:acc3')?.usage).toBeUndefined();
  });

  it('the request role is the title only while working (without --role, the roles.conf one); today\'s tokens add up', () => {
    const t = setup();
    t.source.start();
    t.start(31, 'acc2', { role: 'review', mode: 'plan' });
    t.job(31, 'acc2', 'Review the diff');
    t.source.poll();
    expect(t.agent('acc2')).toMatchObject({ title: 'review', permissionMode: 'plan' });
    t.end(31, 'acc2', { status: 'SUCCESS', usage: { input_tokens: 7_000, output_tokens: 200, thinking_tokens: 100, total_tokens: 7_300 } });
    t.source.poll();
    expect(t.agent('acc2')?.title).toBe('free');
    expect(t.agent('acc2')?.stats).toMatchObject({ tokensIn: 7_000, tokensOut: 300 });

    t.job(41, 'acc2', 'Implement it');
    t.source.poll();
    expect(t.agent('acc2')?.title).toBe('impl');
  });

  it('boot sums today\'s tokens already in the log (and ignores yesterday\'s)', () => {
    const t = setup();
    const day = 86_400;
    appendFileSync(join(t.root, 'agy-ask.log.jsonl'), [
      JSON.stringify({ event: 'end', acc: 'acc3', pid: 1, ts: (BOOT_MS + 100_000) / 1000 - 2 * day, usage: { input_tokens: 999, output_tokens: 9 } }),
      JSON.stringify({ event: 'end', acc: 'acc3', pid: 2, ts: (BOOT_MS + 100_000) / 1000 - 1, usage: { input_tokens: 50, output_tokens: 5 } }),
    ].join('\n') + '\n');
    t.source.start();
    expect(t.agent('acc3')?.stats).toMatchObject({ tokensIn: 50, tokensOut: 5 });
  });

  it('sending a job validates the worker, mode, role and prompt (no jobsDir = off)', () => {
    const t = setup();
    t.source.start();
    expect(t.source.assign('agy:nada', { prompt: 'x', mode: 'plan' })).toMatchObject({ ok: false, status: 404 });
    expect(t.source.assign('agy:acc2', { prompt: 'x', mode: 'plan' })).toMatchObject({ ok: false, status: 400 });
  });

  it('stop kills the job\'s agy-ask (which takes agy with it); without agy-ask, agy itself; never another PID', () => {
    const t = setup();
    t.source.start();
    t.start(31, 'acc2', { role: 'qa' });
    t.job(31, 'acc2', 'via agy-ask');
    t.job(51, 'acc2', 'script em lote');
    t.source.poll();
    expect(t.source.stopJobs('agy:acc2')).toBe(2);
    expect(t.killed).toEqual([
      [30, 'SIGTERM'],
      [51, 'SIGTERM'],
    ]);
    expect(t.source.stopJobs('agy:acc3')).toBe(0);
  });

  it('a badge earned live throws a party and notifies; what was already in the log at boot is only state', () => {
    const t = setup();
    appendFileSync(join(t.root, 'agy-ask.log.jsonl'), `${JSON.stringify({ event: 'end', acc: 'acc3', pid: 1, ts: 1, status: 'SUCCESS', sec: 30, usage: { total_tokens: 10 } })}\n`);
    t.source.start();
    t.office.commit();
    expect(t.agent('acc3')?.progress).toMatchObject({ level: 1, jobs: 1, badges: [{ id: 'first' }] });
    t.job(31, 'acc2', 'quick one');
    t.source.poll();
    t.advance(5_000);
    t.end(31, 'acc2', { status: 'SUCCESS', sec: 5, usage: { total_tokens: 100 } });
    t.source.poll();
    const { snapshot, notices } = t.office.commit();
    expect(snapshot.agents.find((a) => a.id === 'agy:acc2')?.progress?.badges.map((b) => b.id)).toEqual(['first', 'flash']);
    expect(notices.filter((n) => n.text.startsWith('🏆')).length).toBe(2);
    expect(snapshot.rooms.find((r) => r.id === '/w/agy-hub')?.effect).toMatchObject({ kind: 'party' });
  });

  it('mode and effort: what agy applied (its log) while working, the defaults (defaults.json) when idle', () => {
    const t = setup();
    t.source.start();
    expect(t.source.setDefaults('agy:acc2', { mode: 'accept-edits', effort: 'low' })).toEqual({ ok: true });
    expect(t.source.setDefaults('agy:acc2', { effort: 'max' })).toMatchObject({ ok: false, error: 'unknown effort' });
    t.source.poll();
    expect(t.agent('acc2')).toMatchObject({ model: 'gemini-3.8-flash', effort: 'low', permissionMode: 'accept-edits', agyDefaults: { mode: 'accept-edits', effort: 'low' } });
    // A job asked for high in plan mode; until agy's log says otherwise, that is what shows.
    t.start(41, 'acc2', { mode: 'plan', effort: 'high' });
    t.job(41, 'acc2', 'Review it');
    t.source.poll();
    expect(t.agent('acc2')).toMatchObject({ effort: 'high', permissionMode: 'plan' });
    const log = join(t.root, 'acc2', '.gemini', 'antigravity-cli', 'log');
    mkdirSync(log, { recursive: true });
    writeFileSync(
      join(log, 'cli-20261027_231228.log'),
      'I1 server.go:1836] Starting language server process with pid 41\nI1 printmode.go:857] Print mode: applying agent mode plan\nI1 x.go:1] Propagating selected model override to backend: label="Gemini 3.8 Flash (Medium)"\n',
    );
    t.source.poll();
    expect(t.agent('acc2')).toMatchObject({ model: 'gemini-3.8-flash', effort: 'medium', permissionMode: 'plan' });
  });

  it('job effort is validated: only the Gemini 3.8 Flash levels', () => {
    const t = setup();
    t.source.start();
    (t.source as unknown as { opts: { jobsDir?: string } }).opts.jobsDir = join(t.root, 'jobs');
    expect(t.source.assign('agy:acc2', { prompt: 'x', mode: 'plan', effort: 'max' })).toMatchObject({ ok: false, error: 'unknown effort' });
  });

  it('the room board shows the jobs (requester, role, outcome) and the latest order given to the boss', () => {
    const t = setup();
    t.office.addMain({ id: '.claude:10', account: '.claude', sessionId: 's10', cwd: '/w/Habblaud', role: 'Main agent', startedAt: BOOT_MS, status: 'working' });
    t.office.setBoss('.claude:10', true);
    t.source.start();
    t.office.addActivity('.claude:10', { id: 'p1', kind: 'prompt', icon: '💬', text: 'Split the review', detail: 'Split the PR review among the workers', at: BOOT_MS + 100_000 }, true);
    t.start(31, 'acc2', { role: 'review', claude_pid: 10 });
    t.job(31, 'acc2', 'Review   the\nPR diff');
    t.source.poll();
    let board = t.office.commit().snapshot.rooms.find((r) => r.id === '/w/agy-hub')?.board;
    expect(board?.order).toMatchObject({ text: 'Split the PR review among the workers', boss: expect.any(String) });
    expect(board?.items).toEqual([expect.objectContaining({ worker: 'acc2', role: 'review', text: 'Review the PR diff', status: 'working', by: 'boss' })]);
    t.end(31, 'acc2', { status: 'SUCCESS', usage: { total_tokens: 4_200 } });
    t.source.poll();
    board = t.office.commit().snapshot.rooms.find((r) => r.id === '/w/agy-hub')?.board;
    expect(board?.items[0]).toMatchObject({ status: 'done', tokens: 4_200 });
  });

  it('the board is rebuilt from the agy-ask log at boot; a job gone without an end line is failed', () => {
    const t = setup();
    const at = (BOOT_MS + 50_000) / 1000;
    const log = [
      { event: 'start', acc: 'acc2', pid: 7, ts: at, role: 'review', claude_pid: 10, prompt: 'Review the diff', office: 'o1' },
      { event: 'end', acc: 'acc2', pid: 7, ts: at + 30, status: 'SUCCESS', sec: 30, usage: { total_tokens: 1_500 } },
      { event: 'start', acc: 'acc3', pid: 8, ts: at + 40, prompt: 'Killed hard' },
    ];
    appendFileSync(join(t.root, 'agy-ask.log.jsonl'), log.map((l) => `${JSON.stringify(l)}\n`).join(''));
    t.source.start();
    const board = t.office.commit().snapshot.rooms.find((r) => r.id === '/w/agy-hub')?.board;
    expect(board?.items).toEqual([
      expect.objectContaining({ id: 'agy:acc3#8', text: 'Killed hard', status: 'failed', by: 'script' }),
      expect.objectContaining({ id: 'agy:acc2#7', text: 'Review the diff', role: 'review', status: 'done', by: 'boss', tokens: 1_500, office: 'o1' }),
    ]);
  });

  it('news: jobs finished or failed, quota hits (429 in the end line), level-ups', () => {
    const t = setup();
    const news: NewsItem[] = [];
    (t.source as unknown as { opts: { news?: (i: NewsItem) => void } }).opts.news = (i) => void news.push(i);
    t.source.start();
    t.start(31, 'acc2', { role: 'qa', prompt: 'Run the tests' });
    t.job(31, 'acc2', 'Run the tests');
    t.source.poll();
    t.end(31, 'acc2', { status: 'SUCCESS', sec: 75, usage: { total_tokens: 300_000 } });
    t.source.poll();
    t.start(41, 'acc3', {});
    t.end(41, 'acc3', { status: 'ERROR', sec: 3, error: 'Error: 429 Individual quota reached' });
    t.start(51, 'acc3', {});
    t.end(51, 'acc3', { status: 'TIMEOUT', sec: 900 });
    t.start(61, 'acc2', { role: 'scout', prompt: 'Read the code' });
    t.end(61, 'acc2', { status: 'ERROR', sec: 81, error: 'tor: plan model not specified\nAGY_ERROR: {"short_error":"failed to construct executor: plan model not specified; you must specify a valid model","status":"UNKNOWN"}' });
    t.source.poll();
    expect(news.map((n) => [n.kind, n.icon, n.text])).toEqual([
      ['done', '✅', 'acc2 finished a job'],
      ['level', '⭐', 'acc2 reached level 2 (Intern)'],
      ['badge', '🐣', 'acc2 earned the achievement First job'],
      ['quota', '🪫', 'acc3 is out of quota'],
      ['failed', '⚠️', 'acc3: job failed (TIMEOUT)'],
      ['failed', '⚠️', 'acc2: job failed (ERROR)'],
    ]);
    expect(news[0].detail).toBe('qa · 1min 15s · 300k tokens · Run the tests');
    expect(news[5].detail).toBe('scout · 1min 21s · plan model not specified; you must specify a valid model · Read the code');
  });

  it('team: only registered workers get a character; "off" accounts are accounts but not seeded', () => {
    const t = setup(['acc2', 'acc3', 'acc4'], 'acc2 impl accept-edits\nacc4 off\n');
    expect(t.source.seed()).toEqual(['acc2', 'acc3']);
    expect(t.source.profiles()).toEqual([
      { acc: 'acc2', account: 'agy:acc2' },
      { acc: 'acc3', account: 'agy:acc3' },
      { acc: 'acc4', account: 'agy:acc4' },
    ]);
    t.source.setTeam(['acc2']);
    t.source.start();
    expect(t.agent('acc2')?.status).toBe('idle');
    expect(t.agent('acc3')).toBeUndefined();
    // every profile stays an account (usage, login terminal)
    expect(t.accounts.list(new Map()).map((a) => a.id)).toEqual(['agy:acc2', 'agy:acc3', 'agy:acc4']);
    expect(t.source.worker('agy:acc4')).toEqual({ acc: 'acc4', account: 'agy:acc4' });
    // a job of an unregistered account is not watched
    t.job(31, 'acc3', 'Hello');
    t.source.poll();
    expect(t.agent('acc3')).toBeUndefined();
  });

  it('setTeam: a new worker walks in right away, a removed one leaves (and can come back)', () => {
    const t = setup();
    t.source.start();
    expect(t.agent('acc3')?.status).toBe('idle');
    t.source.setTeam(['acc2']);
    expect(t.agent('acc3')?.status).toBe('offline');
    // gone after the grace period, then registered again
    t.advance(60_000);
    t.office.tick();
    expect(t.agent('acc3')).toBeUndefined();
    t.source.setTeam(['acc2', 'acc3']);
    expect(t.agent('acc3')).toMatchObject({ status: 'idle', name: 'acc3 (Agy)', roomId: '/w/agy-hub' });
    // back during the grace period: the same character returns
    t.source.setTeam(['acc2']);
    t.source.setTeam(['acc2', 'acc3']);
    expect(t.agent('acc3')?.status).toBe('idle');
  });

  it('rescan: an account logged in later becomes an account (and a worker once registered); one removed leaves', () => {
    const t = setup();
    t.source.start();
    mkdirSync(join(t.root, 'acc5', '.gemini', 'antigravity-cli'), { recursive: true });
    // agy made the folder but the account is not signed in yet: not an account
    (t.source as unknown as { rescan(): void }).rescan();
    expect(t.source.profiles().map((p) => p.acc)).toEqual(['acc2', 'acc3']);
    writeFileSync(join(t.root, 'acc5', '.gemini', 'antigravity-cli', 'cli.log'), 'I1 server_oauth.go:1] OAuth: authenticated as five@example.com\n');
    (t.source as unknown as { rescan(): void }).rescan();
    expect(t.source.profiles().map((p) => p.acc)).toEqual(['acc2', 'acc3', 'acc5']);
    expect(t.accounts.list(new Map()).find((a) => a.id === 'agy:acc5')).toBeTruthy();
    // colors stay put across rescans
    const colors = t.accounts.list(new Map()).map((a) => a.color);
    (t.source as unknown as { rescan(): void }).rescan();
    expect(t.accounts.list(new Map()).map((a) => a.color)).toEqual(colors);
    t.source.setTeam(['acc2', 'acc3', 'acc5']);
    expect(t.agent('acc5')?.status).toBe('idle');
    rmSync(join(t.root, 'acc3'), { recursive: true, force: true });
    (t.source as unknown as { rescan(): void; syncCharacters(): void }).rescan();
    (t.source as unknown as { syncCharacters(): void }).syncCharacters();
    expect(t.agent('acc3')?.status).toBe('offline');
    expect(t.source.profiles().map((p) => p.acc)).toEqual(['acc2', 'acc5']);
  });

  it('seats: one character per office (named "(2)" after the first) in each office\'s room; a terminal job shows on its office\'s seat', () => {
    const t = setup();
    let busyOffice: string | undefined;
    t.source.setExternal((acc, office) => ({ busy: acc === 'acc2' && office === busyOffice, driving: false }));
    t.source.setTeam(['acc2'], [], [
      { acc: 'acc2', agentId: 'agy:acc2', name: 'two (Agy)', room: '/w/agy-hub', office: 'main' },
      { acc: 'acc2', agentId: 'agy:acc2@fin', name: 'two (Agy) (2)', room: '/w/agy-hub@fin', office: 'fin' },
    ]);
    t.source.start();
    expect(t.agent('acc2')).toMatchObject({ name: 'two (Agy)', roomId: '/w/agy-hub', status: 'idle' });
    const second = () => t.office.commit().snapshot.agents.find((a) => a.id === 'agy:acc2@fin');
    expect(second()).toMatchObject({ name: 'two (Agy) (2)', roomId: '/w/agy-hub@fin', status: 'idle', provider: 'agy' });
    busyOffice = 'fin';
    t.source.poll();
    expect(second()?.status).toBe('working');
    expect(t.agent('acc2')?.status).toBe('idle');
    // the office leaves: its seat goes away, the first one stays
    t.source.setTeam(['acc2'], [], [{ acc: 'acc2', agentId: 'agy:acc2', name: 'two (Agy)', room: '/w/agy-hub', office: 'main' }]);
    expect(second()?.status).toBe('offline');
    expect(t.agent('acc2')?.status).not.toBe('offline');
  });
});
