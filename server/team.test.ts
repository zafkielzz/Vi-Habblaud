// The offices: each with one appointed boss (kept across restarts and resumes, or opened from the office and appointed
// before it shows up) and the accounts registered as its workers, all in team.json.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { officeSlug, parseTeam, seatSuffix, teamSeats, TeamService } from './team';
import { NameStore } from './model/names';
import type { HandoffPlan } from '../shared/types';
import { defaultRules } from '../shared/rules';
import { Office } from './model/office';

const T0 = 1_700_000_000_000;
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(profiles = ['acc1', 'acc2', 'acc3']) {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-team-'));
  dirs.push(dir);
  const office = new Office({ names: new NameStore(null), version: 'test', startedAt: T0, accounts: () => [], sources: () => [], accountName: () => undefined, now: () => T0 });
  const main = (id: string, sessionId: string, extra: { provider?: 'codex'; account?: string } = {}) =>
    office.addMain({ id, account: '.claude', sessionId, cwd: `/w/${id}`, role: 'Main agent', startedAt: T0, status: 'idle', ...extra });
  const file = join(dir, 'team.json');
  const legacyBossFile = join(dir, 'boss.json');
  const changes: string[][] = [];
  /** PIDs of Claude Code processes that exited (a pending boss with one of these is dropped). */
  const dead = new Set<number>();
  const deleted: string[] = [];
  /** Symlinks: path -> its real folder. */
  const links = new Map<string, string>();
  const plans = new Map<string, HandoffPlan>();
  const team = () =>
    new TeamService({
      office,
      file,
      legacyBossFile,
      profiles: () => profiles.map((acc) => ({ acc, account: `agy:${acc}` })),
      claudeAccounts: () => [{ worker: 'claude:.claude', account: '.claude' }, { worker: 'claude:.claude-w', account: '.claude-w' }],
      seed: () => profiles.filter((p) => p !== 'acc3'),
      onWorkers: (w) => void changes.push([...w]),
      now: () => T0,
      isAlive: (pid) => !dead.has(pid),
      isDir: (p) => p === '/' || p === '/w' || p.startsWith('/w/'),
      realpath: (p) => links.get(p) ?? p,
      workersRoom: (id, first) => (first ? '/w/agy-hub' : `/w/agy-hub@${id}`),
      onDeleteOffice: (id) => void deleted.push(id),
      folderPlan: (f) => plans.get(f),
    });
  const crowned = () => office.list().filter((a) => a.boss).map((a) => a.id);
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  return { office, main, file, legacyBossFile, team, crowned, saved, changes, dead, deleted, links, plans };
}

describe('TeamService: the boss', () => {
  it('nobody is the boss until appointed; appointing another moves the crown, null steps down', () => {
    const t = setup();
    t.main('.claude:1', 's1');
    t.main('.claude:2', 's2');
    const b = t.team();
    b.sync();
    expect(t.crowned()).toEqual([]);
    expect(b.appoint(undefined, '.claude:1')).toEqual({ ok: true });
    expect(t.crowned()).toEqual(['.claude:1']);
    expect(t.office.get('.claude:1')?.parts).toMatchObject({ topStyle: 'shirt_tie' });
    b.appoint(undefined, '.claude:2');
    expect(t.crowned()).toEqual(['.claude:2']);
    b.appoint(undefined, null);
    expect(t.crowned()).toEqual([]);
    expect(t.saved().offices[0].boss).toBeUndefined();
  });

  it('only an open Claude Code main session; a new session does not take the crown', () => {
    const t = setup();
    t.main('.claude:1', 's1');
    t.main('codex:9', 's9', { provider: 'codex' });
    const b = t.team();
    expect(b.appoint(undefined, 'nope')).toMatchObject({ ok: false, status: 404 });
    expect(b.appoint(undefined, 'codex:9')).toMatchObject({ ok: false, status: 400 });
    b.appoint(undefined, '.claude:1');
    t.main('.claude:3', 's3');
    b.sync();
    expect(t.crowned()).toEqual(['.claude:1']);
  });

  it('kept in team.json (with the pid agy-ask checks); found again after a resume; waits while closed', () => {
    const t = setup();
    t.main('.claude:41', 's1');
    t.team().appoint(undefined, '.claude:41');
    expect(t.saved().offices[0].boss).toMatchObject({ kind: 'claude', id: '.claude:41', account: '.claude', sessionId: 's1', pid: 41 });
    t.office.closeMain('.claude:41');
    const restarted = t.team();
    restarted.sync();
    expect(t.crowned()).toEqual([]);
    // the page says who holds the crown while its session is closed
    expect(t.office.commit().snapshot.team?.waitingBoss).toBe(t.saved().offices[0].boss.name);
    // `claude --resume`: same session, another process
    t.main('.claude:77', 's1');
    restarted.sync();
    expect(t.crowned()).toEqual(['.claude:77']);
    expect(t.saved().offices[0].boss).toMatchObject({ id: '.claude:77', sessionId: 's1', pid: 77 });
  });

  it('the coronation: a party in its room and a line in the feed', () => {
    const t = setup();
    t.main('.claude:1', 's1');
    t.office.commit();
    t.team().appoint(undefined, '.claude:1');
    const { snapshot, notices } = t.office.commit();
    expect(snapshot.rooms.find((r) => r.id === '/w/.claude:1')?.effect).toMatchObject({ kind: 'party' });
    expect(notices.some((n) => n.text.startsWith('👑'))).toBe(true);
  });

  it('"＋ Boss" whose Claude Code exits before showing up: no boss (not "opening…" forever)', () => {
    const t = setup();
    const b = t.team();
    expect(b.appoint(undefined, '.claude:60', { account: '.claude' })).toEqual({ ok: true });
    b.sync();
    expect(t.office.commit().snapshot.team?.pendingBoss).toBe('.claude:60');
    t.dead.add(60);
    b.sync();
    const team = t.office.commit().snapshot.team;
    expect(team?.pendingBoss).toBeUndefined();
    expect(team?.bossAccount).toBeUndefined();
    expect(t.saved().offices[0].boss).toBeUndefined();
  });

  it('"＋ Boss": appointed before it shows up (pending), crowned with a party when it walks in; the old boss steps down', () => {
    const t = setup();
    t.main('.claude:1', 's1');
    const b = t.team();
    b.appoint(undefined, '.claude:1');
    // the account must match the agent id; unknown agents need `pending`
    expect(b.appoint(undefined, '.claude:50', { account: '.claude-work' })).toMatchObject({ ok: false, status: 404 });
    expect(b.appoint(undefined, '.claude:50')).toMatchObject({ ok: false, status: 404 });
    expect(b.appoint(undefined, '.claude:50', { account: '.claude' })).toEqual({ ok: true });
    expect(t.crowned()).toEqual([]);
    expect(t.office.commit().snapshot.team?.pendingBoss).toBe('.claude:50');
    expect(t.saved().offices[0].boss).toMatchObject({ id: '.claude:50', sessionId: '', pid: 50 });
    t.main('.claude:50', 's50');
    b.sync();
    expect(t.crowned()).toEqual(['.claude:50']);
    const { snapshot, notices } = t.office.commit();
    expect(snapshot.team?.pendingBoss).toBeUndefined();
    expect(snapshot.rooms.find((r) => r.id === '/w/.claude:50')?.effect).toMatchObject({ kind: 'party' });
    expect(notices.some((n) => n.text.startsWith('👑'))).toBe(true);
    expect(t.saved().offices[0].boss).toMatchObject({ id: '.claude:50', sessionId: 's50' });
    // later ticks do not throw another party
    b.sync();
    expect(t.office.commit().notices.some((n) => n.text.startsWith('👑'))).toBe(false);
  });

  it('first run: the old boss.json becomes the boss of the new team.json', () => {
    const t = setup();
    writeFileSync(t.legacyBossFile, JSON.stringify({ id: '.claude:41', account: '.claude', sessionId: 's1', name: 'Thiago', at: 5 }));
    const b = t.team();
    expect(t.saved()).toEqual({ offices: [{ id: 'main', name: 'Office', folder: '', boss: { kind: 'claude', id: '.claude:41', account: '.claude', sessionId: 's1', pid: 41, name: 'Thiago', at: 5 }, workers: ['acc1', 'acc2'] }] });
    t.main('.claude:41', 's1');
    b.sync();
    expect(t.crowned()).toEqual(['.claude:41']);
    // the name follows the session's name in the office
    expect(t.saved().offices[0].boss.name).toBe(t.office.get('.claude:41')?.name);
  });
});

describe('TeamService: workers', () => {
  it('a brand-new team.json gets the seed; then the file wins', () => {
    const t = setup();
    expect(t.team().workers).toEqual(['acc1', 'acc2']);
    writeFileSync(t.file, JSON.stringify({ workers: ['acc3'] }));
    // (a file from before offices becomes the first office)
    expect(t.team().workers).toEqual(['acc3']);
  });

  it('registering and removing: saved, reported to the source, shown in the snapshot', () => {
    const t = setup(['acc1', 'acc2', 'acc3', 'acc10']);
    const b = t.team();
    expect(b.setWorker(undefined, 'acc10', true)).toEqual({ ok: true });
    expect(b.setWorker(undefined, 'acc3', true)).toEqual({ ok: true });
    expect(b.setWorker(undefined, 'acc3', true)).toEqual({ ok: true });
    expect(b.setWorker(undefined, 'acc1', false)).toEqual({ ok: true });
    expect(b.setWorker(undefined, 'acc1', false)).toEqual({ ok: true });
    expect(b.setWorker(undefined, 'acc9', true)).toMatchObject({ ok: false, status: 404 });
    expect(t.saved().offices[0].workers).toEqual(['acc2', 'acc3', 'acc10']);
    // acc10 was already in the seed: no change
    expect(t.changes).toEqual([
      ['acc1', 'acc2', 'acc3', 'acc10'],
      ['acc2', 'acc3', 'acc10'],
    ]);
    expect(t.office.commit().snapshot.team).toEqual({
      offices: [{ id: 'main', name: 'Office', folder: '', workers: ['acc2', 'acc3', 'acc10'], workersRoomId: '/w/agy-hub', rules: defaultRules() }],
      workers: ['acc2', 'acc3', 'acc10'],
      agy: ['acc1', 'acc2', 'acc3', 'acc10'].map((acc) => ({ acc, account: `agy:${acc}` })),
      claude: [
        { worker: 'claude:.claude', account: '.claude' },
        { worker: 'claude:.claude-w', account: '.claude-w' },
      ],
    });
  });

  it('parseTeam drops what is malformed', () => {
    expect(parseTeam('{"workers":["acc1",3,"a b"],"boss":{"id":7}}')).toEqual({ offices: [{ id: 'main', name: 'Office', folder: '', workers: ['acc1'] }] });
    expect(parseTeam('{"boss":{"id":".claude:9","account":".claude"}}').offices[0].boss).toEqual({ kind: 'claude', id: '.claude:9', account: '.claude', sessionId: '', pid: 9, name: '', at: 0 });
    expect(parseTeam('{"offices":[{"id":"Bad Id"},{"id":"a","folder":"rel/path","workers":["acc1"]},{"id":"a"}]}')).toEqual({ offices: [{ id: 'a', name: 'a', folder: '', workers: ['acc1'] }] });
  });
});

describe('TeamService: v2 (Antigravity boss, Claude workers)', () => {
  it('an Antigravity boss: crowned when its character is in, leaves the workers, saved with its profile', () => {
    const t = setup();
    const b = t.team();
    expect(b.appointAgy(undefined, 'acc9')).toMatchObject({ ok: false, status: 404 });
    expect(b.appointAgy(undefined, 'acc1')).toEqual({ ok: true });
    expect(b.workers).toEqual(['acc2']);
    expect(t.saved().offices[0].boss).toMatchObject({ kind: 'agy', id: 'agy:acc1', acc: 'acc1', account: 'agy:acc1', pid: 0 });
    t.office.addMain({ id: 'agy:acc1', provider: 'agy', account: 'agy:acc1', sessionId: 'agy-acc1', cwd: '/w/agy-hub', role: 'Worker', startedAt: T0, status: 'idle' });
    t.office.commit();
    b.sync();
    expect(t.crowned()).toEqual(['agy:acc1']);
    expect(t.office.commit().notices.some((n) => n.text.startsWith('👑'))).toBe(true);
    expect(t.office.commit().snapshot.team).toMatchObject({ bossAccount: 'agy:acc1', bossKind: 'agy' });
    // the boss's account cannot be a worker
    expect(b.setWorker(undefined, 'acc1', true)).toMatchObject({ ok: false, status: 409 });
    expect(parseTeam(readFileSync(t.file, 'utf8')).offices[0].boss?.kind).toBe('agy');
  });

  it('Claude accounts can be workers, but not the boss\'s account (appointing a boss drops it)', () => {
    const t = setup();
    t.main('.claude:1', 's1');
    const b = t.team();
    expect(b.setWorker(undefined, 'claude:.claude-w', true)).toEqual({ ok: true });
    expect(b.setWorker(undefined, 'claude:.claude', true)).toEqual({ ok: true });
    expect(b.setWorker(undefined, 'claude:.nope', true)).toMatchObject({ ok: false, status: 404 });
    b.appoint(undefined, '.claude:1');
    expect(b.workers).toEqual(['acc1', 'acc2', 'claude:.claude-w']);
    expect(b.setWorker(undefined, 'claude:.claude', true)).toMatchObject({ ok: false, status: 409 });
    expect(t.office.commit().snapshot.team).toMatchObject({ bossAccount: '.claude', bossKind: 'claude', claude: [{ worker: 'claude:.claude', account: '.claude' }, { worker: 'claude:.claude-w', account: '.claude-w' }] });
    // a worker's own character (no pid) is never the boss
    t.office.addMain({ id: 'claude-worker:.claude-w', account: '.claude-w', sessionId: 'x', cwd: '/w/agy-hub', role: 'Worker', startedAt: T0, status: 'idle' });
    expect(b.appoint(undefined, 'claude-worker:.claude-w')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('TeamService: offices', () => {
  it('folders: symlinks resolved (another office\'s folder through a link is refused), never the whole disk, never nested', () => {
    const t = setup();
    const b = t.team();
    t.links.set('/w/link-to-a', '/w/a');
    t.links.set('/w/link-to-root', '/');
    expect(b.createOffice('A', '/w/a')).toMatchObject({ ok: true });
    expect(b.createOffice('Link', '/w/link-to-a')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('A') });
    expect(b.createOffice('Root', '/')).toMatchObject({ ok: false, status: 400 });
    expect(b.createOffice('Root2', '/w/link-to-root')).toMatchObject({ ok: false, status: 400 });
    // a link to a free folder is kept as the real folder (Claude Code sessions report real paths)
    t.links.set('/w/link-to-b', '/w/b');
    expect(b.createOffice('B', '/w/link-to-b')).toMatchObject({ ok: true, office: { folder: '/w/b' } });
    expect(b.setFolder('b', '/w/link-to-a')).toMatchObject({ ok: false, status: 409 });
    // office folders never overlap
    expect(b.createOffice('Inner', '/w/a/inner')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('inside') });
    expect(b.createOffice('Outer', '/w')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('holds') });
    expect(b.createOffice('Apart', '/w/ab')).toMatchObject({ ok: true });
  });

  it("an office's to-do: the HANDOFF list of its folder, even with nobody working there", () => {
    const t = setup();
    const b = t.team();
    b.createOffice('A', '/w/a');
    const plan: HandoffPlan = { file: 'HANDOFF.md', mtime: 1, heading: 'Next', items: [{ text: 'one' }] };
    t.plans.set('/w/a', plan);
    b.publish();
    expect(t.office.commit().snapshot.team?.offices?.find((o) => o.id === 'a')?.plan).toEqual(plan);
    expect(t.office.commit().snapshot.team?.offices?.find((o) => o.id === 'main')?.plan).toBeUndefined();
  });

  it('create, rename, move and delete offices; folders are absolute, existing and never shared', () => {
    const t = setup();
    const b = t.team();
    expect(officeSlug('FinSTAR · Nhãn đợt 2')).toBe('finstar-nhan-dot-2');
    expect(b.createOffice('FinSTAR', '/w/finstar/')).toMatchObject({ ok: true, office: { id: 'finstar', name: 'FinSTAR', folder: '/w/finstar', workers: [] } });
    expect(b.createOffice('FinSTAR', '/w/other')).toMatchObject({ ok: true, office: { id: 'finstar-2' } });
    expect(b.createOffice('Dup', '/w/finstar')).toMatchObject({ ok: false, status: 409 });
    expect(b.createOffice('Rel', 'w/x')).toMatchObject({ ok: false, status: 400 });
    expect(b.createOffice('Gone', '/nope')).toMatchObject({ ok: false, status: 400 });
    expect(b.createOffice('  ', '/w/y')).toMatchObject({ ok: false, status: 400 });
    expect(b.renameOffice('finstar-2', 'Labels')).toEqual({ ok: true });
    expect(b.setFolder('main', '/w/finstar')).toMatchObject({ ok: false, status: 409 });
    expect(b.setFolder('main', '/w/habblaud')).toEqual({ ok: true });
    expect(t.saved().offices.map((o: { id: string; name: string; folder: string }) => [o.id, o.name, o.folder])).toEqual([
      ['main', 'Office', '/w/habblaud'],
      ['finstar', 'FinSTAR', '/w/finstar'],
      ['finstar-2', 'Labels', '/w/other'],
    ]);
    expect(b.deleteOffice('finstar-2')).toEqual({ ok: true });
    expect(t.deleted).toEqual(['finstar-2']);
    expect(b.deleteOffice('nope')).toMatchObject({ ok: false, status: 404 });
    b.deleteOffice('finstar');
    expect(b.deleteOffice('main')).toMatchObject({ ok: false, status: 409 });
  });

  it('a boss per office (crowns on every boss); one session leads one office; an agy account bosses one office only', () => {
    const t = setup();
    t.main('.claude:1', 's1');
    t.main('.claude:2', 's2');
    const b = t.team();
    b.createOffice('Two', '/w/two');
    expect(b.appoint(undefined, '.claude:1')).toEqual({ ok: true });
    expect(b.appoint('two', '.claude:1')).toMatchObject({ ok: false, status: 409 });
    expect(b.appoint('two', '.claude:2')).toEqual({ ok: true });
    expect(t.crowned().sort()).toEqual(['.claude:1', '.claude:2']);
    expect(b.appoint('nope', '.claude:2')).toMatchObject({ ok: false, status: 404 });
    b.createOffice('Three', '/w/three');
    expect(b.appointAgy('three', 'acc1')).toEqual({ ok: true });
    expect(b.appointAgy('two', 'acc1')).toMatchObject({ ok: false, status: 409 });
    expect(b.agyBosses).toEqual(['acc1']);
    const offices = t.office.commit().snapshot.team!.offices!;
    expect(offices.map((o) => [o.id, o.bossAccount, o.bossAgentId])).toEqual([
      ['main', '.claude', '.claude:1'],
      ['two', '.claude', '.claude:2'],
      ['three', 'agy:acc1', undefined],
    ]);
  });

  it('workers are shared between offices; an Antigravity boss is nobody\'s worker; jobs go to the first office that has the worker', () => {
    const t = setup();
    const b = t.team();
    b.createOffice('Two', '/w/two');
    expect(b.setWorker('two', 'acc1', true)).toEqual({ ok: true });
    expect(b.isWorker('acc1', 'two')).toBe(true);
    expect(b.isWorker('acc1', 'main')).toBe(true);
    expect(b.isWorker('acc3')).toBe(false);
    expect(b.officeOfWorker('acc1')).toBe('main');
    expect(b.setWorker('two', 'acc2', false)).toEqual({ ok: true });
    expect(b.officeOfWorker('acc2')).toBe('main');
    // acc2 becomes the Antigravity boss of "two": it leaves every office's workers
    b.appointAgy('two', 'acc2');
    expect(b.isWorker('acc2')).toBe(false);
    expect(b.setWorker('main', 'acc2', true)).toMatchObject({ ok: false, status: 409 });
    expect(b.workers).toEqual(['acc1']);
  });

  it('an office carried over without a folder learns it from its open boss', () => {
    const t = setup();
    t.main('.claude:5', 's5');
    const b = t.team();
    b.appoint(undefined, '.claude:5');
    expect(t.saved().offices[0].folder).toBe('/w/.claude:5');
    const info = t.office.commit().snapshot.team!.offices![0];
    expect(info).toMatchObject({ folder: '/w/.claude:5', roomId: '/w/.claude:5' });
    // a boss in the home folder: no folder learned (the page asks for one)
    const u = setup();
    u.office.addMain({ id: '.claude:6', account: '.claude', sessionId: 's6', cwd: '/home/me', role: 'Main agent', startedAt: T0, status: 'idle' });
    const c = new TeamService({ office: u.office, file: u.file, profiles: () => [], seed: () => [], home: '/home/me', isAlive: () => true });
    c.appoint(undefined, '.claude:6');
    expect(u.saved().offices[0].folder).toBe('');
  });
});

describe('TeamService: a profile signed in moments ago', () => {
  it('an unknown agy worker makes the profiles be re-read once before "account not found"', () => {
    const u = setup();
    const known = ['acc1'];
    let rescans = 0;
    const s = new TeamService({ office: u.office, file: u.file, profiles: () => known.map((acc) => ({ acc, account: `agy:${acc}` })), seed: () => [], rescanProfiles: () => void (rescans++, known.push('acc9')) });
    expect(s.setWorker(undefined, 'acc9', true)).toEqual({ ok: true });
    expect(rescans).toBe(1);
    expect(s.setWorker(undefined, 'acc7', true)).toMatchObject({ ok: false, status: 404 });
    expect(rescans).toBe(2);
    expect(s.setWorker(undefined, 'claude:.claude-x', true)).toMatchObject({ ok: false, status: 404 });
    expect(rescans).toBe(2); // Claude accounts are not agy profiles
  });
});

describe('TeamService: buildings', () => {
  it('seats: one character per office a worker belongs to; the first keeps the plain id, the next are "@office" and "(n)"', () => {
    const seats = teamSeats([
      { id: 'main', workers: ['acc1', 'claude:.c'] },
      { id: 'b', workers: ['acc1'] },
      { id: 'c', workers: ['acc1', 'acc2'] },
    ]);
    expect(seats.map((x) => [x.worker, x.office, x.n, x.agentId])).toEqual([
      ['acc1', 'main', 1, 'agy:acc1'],
      ['claude:.c', 'main', 1, 'claude-worker:.c'],
      ['acc1', 'b', 2, 'agy:acc1@b'],
      ['acc1', 'c', 3, 'agy:acc1@c'],
      ['acc2', 'c', 1, 'agy:acc2'],
    ]);
    expect([seatSuffix(1), seatSuffix(3)]).toEqual(['', ' (3)']);
  });

  it('placement: workers rooms, boss rooms and folders choose the building; characters follow (seats, bosses, rooms)', () => {
    const t = setup();
    const b = t.team();
    b.createOffice('Fin', '/w/fin');
    b.setWorker('fin', 'acc1', true);
    t.main('.claude:1', 's1'); // room /w/.claude:1: nobody's folder -> first building
    t.office.addMain({ id: '.claude:2', account: '.claude', sessionId: 's2', cwd: '/w/fin/sub', role: 'Main agent', startedAt: T0, status: 'idle' });
    t.office.addMain({ id: '.claude:3', account: '.claude', sessionId: 's3', cwd: '/w/elsewhere', role: 'Main agent', startedAt: T0, status: 'idle' });
    b.appoint('fin', '.claude:3'); // the boss of Fin sits outside its folder: its room goes to Fin's building
    t.office.addMain({ id: 'agy:acc1@fin', provider: 'agy', account: 'agy:acc1', sessionId: 'x', cwd: '/w/agy-hub@fin', role: 'Worker', startedAt: T0, status: 'idle' });
    b.sync();
    const snap = t.office.commit().snapshot;
    const room = (id: string) => snap.rooms.find((r) => r.id === id);
    expect([room('/w/fin/sub')?.office, room('/w/elsewhere')?.office, room('/w/agy-hub@fin')?.office, room('/w/agy-hub@fin')?.name]).toEqual(['fin', 'fin', 'fin', 'Workers']);
    expect(room('/w/.claude:1')?.office).toBeUndefined();
    const agent = (id: string) => snap.agents.find((a) => a.id === id)?.office;
    expect([agent('.claude:2'), agent('.claude:3'), agent('agy:acc1@fin'), agent('.claude:1')]).toEqual(['fin', 'fin', 'fin', undefined]);
    expect(snap.team?.offices?.map((o) => o.workersRoomId)).toEqual(['/w/agy-hub', '/w/agy-hub@fin']);
    expect(b.seats().map((x) => x.agentId)).toEqual(['agy:acc1', 'agy:acc2', 'agy:acc1@fin']);
  });
});

describe('TeamService: office rules', () => {
  it('defaults until changed; the user saves with the rev; an older rev is refused; saved in team.json', () => {
    const t = setup();
    const s = t.team();
    const id = s.offices[0].id;
    expect(s.rulesOf(id)).toMatchObject({ rev: 0, scope: { commands: ['git push', 'sudo'] } });
    expect(s.setRules(id, { scope: { write: ['/w/out'], deny: [], commands: ['rm -rf'] }, items: [{ text: 'Be short', for: 'workers' }] }, 0)).toEqual({ ok: true });
    expect(s.rulesOf(id)).toMatchObject({ rev: 1, scope: { write: ['/w/out'], commands: ['rm -rf'] }, items: [{ text: 'Be short', for: 'workers', on: true }] });
    expect(s.setRules(id, { items: [] }, 0)).toMatchObject({ ok: false, status: 409 });
    expect(t.saved().offices[0].rules).toMatchObject({ rev: 1, items: [{ text: 'Be short' }] });
    // read back after a restart
    expect(t.team().rulesOf(id)).toMatchObject({ rev: 1, scope: { write: ['/w/out'] } });
  });

  it('an extra write folder may not overlap another office, nor be the whole disk or home', () => {
    const t = setup();
    const s = t.team();
    const a = s.offices[0].id;
    s.setFolder(a, '/w/a');
    expect(s.createOffice('B', '/w/b')).toMatchObject({ ok: true });
    expect(s.setRules(a, { scope: { write: ['/w/b/out'] } }, 0)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('B') });
    expect(s.setRules(a, { scope: { write: ['/w'] } }, 0)).toMatchObject({ ok: false, status: 409 });
    expect(s.setRules(a, { scope: { write: ['/'] } }, 0)).toMatchObject({ ok: false, status: 400 });
    expect(s.setRules(a, { scope: { write: ['/w/c'] } }, 0)).toEqual({ ok: true });
  });

  it('a boss proposes (no duplicates, kept on save); the user accepts (a rule, on) or rejects', () => {
    const t = setup();
    const s = t.team();
    const id = s.offices[0].id;
    expect(s.proposeRule(id, { text: '  Run   tests before reporting ', why: 'flaky', by: 'Raul' })).toEqual({ ok: true });
    expect(s.proposeRule(id, { text: 'Run tests before reporting' })).toEqual({ ok: true });
    expect(s.proposeRule(id, { text: 'No force push', for: 'workers' })).toEqual({ ok: true });
    const r = s.rulesOf(id)!;
    expect(r.proposals.map((p) => [p.id, p.text, p.by, p.why])).toEqual([['p1', 'Run tests before reporting', 'Raul', 'flaky'], ['p2', 'No force push', 'boss', undefined]]);
    // the user's save keeps the proposals as they are on the server
    expect(s.setRules(id, { ...r, proposals: [] }, r.rev)).toEqual({ ok: true });
    expect(s.rulesOf(id)!.proposals).toHaveLength(2);
    expect(s.decideRule(id, 'p1', true)).toEqual({ ok: true });
    expect(s.decideRule(id, 'p2', false)).toEqual({ ok: true });
    expect(s.decideRule(id, 'p2', false)).toMatchObject({ ok: false, status: 404 });
    const after = s.rulesOf(id)!;
    expect(after.proposals).toEqual([]);
    expect(after.items.map((i) => [i.text, i.on])).toContainEqual(['Run tests before reporting', true]);
    expect(after.items.some((i) => i.text === 'No force push')).toBe(false);
  });

  it('the snapshot carries each office its rules and its violations', () => {
    const t = setup();
    const s = new (t.team().constructor as typeof TeamService)({ office: t.office, file: t.file, profiles: () => [], seed: () => [], violations: (id) => [{ at: T0, office: id, who: 'acc1', kind: 'cwd', detail: '/etc', by: 'ask' }] });
    s.publish();
    const o = t.office.commit().snapshot.team?.offices?.[0];
    expect(o?.rules?.rev).toBe(0);
    expect(o?.violations).toEqual([{ at: T0, office: o?.id, who: 'acc1', kind: 'cwd', detail: '/etc', by: 'ask' }]);
  });
});
