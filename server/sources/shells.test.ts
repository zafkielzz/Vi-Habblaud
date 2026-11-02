import { describe, expect, it } from 'vitest';
import { notificationOutcome, SHELL_MAX_AGE_MS, ShellTracker, toShellJob, type ShellStart } from './shells';

const T0 = Date.parse('2026-10-07T08:50:00Z');

const bash = (toolUseId: string, at: number, extra: Partial<ShellStart> = {}): ShellStart => ({
  toolUseId,
  label: 'Run full test suite',
  command: 'vendor/bin/phpunit',
  background: true,
  kind: 'shell',
  at,
  ...extra,
});

describe('notificationOutcome', () => {
  it('Claude Code status and, without it, summary', () => {
    expect(notificationOutcome('shell', 'completed', 'Background command "x" completed (exit code 0)')).toBe('ok');
    expect(notificationOutcome('shell', 'completed', 'Background command "x" completed (exit code 2)')).toBe('failed');
    expect(notificationOutcome('shell', 'failed', undefined)).toBe('failed');
    expect(notificationOutcome('shell', 'killed', undefined)).toBe('killed');
    expect(notificationOutcome('shell', undefined, 'Background command "x" failed with exit code 1')).toBe('failed');
    expect(notificationOutcome('shell', undefined, undefined)).toBe('ok');
    // Monitor: each event is a notification; only terminal status closes.
    expect(notificationOutcome('monitor', undefined, 'log line')).toBeUndefined();
    expect(notificationOutcome('monitor', 'running', undefined)).toBeUndefined();
    expect(notificationOutcome('monitor', 'completed', undefined)).toBe('ok');
  });
});

describe('ShellTracker', () => {
  it('background: launch replaces id with task id; notification closes only once', () => {
    const s = new ShellTracker();
    s.start('main', bash('toolu_1', T0));
    expect(s.list().map(toShellJob)).toEqual([
      { id: 'toolu_1', label: 'Run full test suite', command: 'vendor/bin/phpunit', startedAt: T0, background: true, kind: 'shell' },
    ]);
    // The command actually starts on launch (after possible approval).
    s.result('toolu_1', { taskId: 'bo0ov3q3l', error: false, at: T0 + 4_000 });
    expect(s.list().map(toShellJob)[0]).toMatchObject({ id: 'bo0ov3q3l', startedAt: T0 + 4_000 });
    expect(s.hasBackgroundShell(T0 + 60_000)).toBe(true);
    const fin = s.notify({ taskId: 'bo0ov3q3l', status: 'completed', summary: 'ok (exit code 0)', at: T0 + 480_000 });
    expect(fin).toMatchObject({ outcome: 'ok', at: T0 + 480_000, job: { owner: 'main', label: 'Run full test suite' } });
    expect(s.list()).toEqual([]);
    // Same notification delivered again (queue -> message) does not close again.
    expect(s.notify({ taskId: 'bo0ov3q3l', toolUseId: 'toolu_1', status: 'completed', at: T0 + 481_000 })).toBeUndefined();
    expect(s.reportedRecently({ toolUseId: 'toolu_1' }, T0 + 481_000)).toBe(true);
    // Re-reading transcript does not revive job.
    s.start('main', bash('toolu_1', T0));
    expect(s.size).toBe(0);
  });

  it('foreground: exits on result; sent to background becomes background without losing start time', () => {
    const s = new ShellTracker();
    s.start('main', bash('fg1', T0, { background: false }));
    s.start('main', bash('fg2', T0 + 1_000, { background: false }));
    expect(s.list().map((j) => [j.toolUseId, j.background])).toEqual([
      ['fg1', false],
      ['fg2', false],
    ]);
    expect(s.hasBackgroundShell(T0 + 2_000)).toBe(false);
    s.result('fg1', { error: false, at: T0 + 30_000 });
    s.result('fg2', { taskId: 'bmanual1', error: false, at: T0 + 40_000 });
    expect(s.list().map(toShellJob)).toEqual([expect.objectContaining({ id: 'bmanual1', background: true, startedAt: T0 + 1_000 })]);
  });

  it('error in tool_result, turn end, and interrupt close without notification', () => {
    const s = new ShellTracker();
    s.start('main', bash('b1', T0));
    s.result('b1', { taskId: 'bx', error: true, at: T0 + 1 });
    s.start('main', bash('f1', T0, { background: false }));
    s.start('sub', bash('f2', T0, { background: false }));
    s.endForeground('main', T0 + 2);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['f2']);
  });

  it('TaskStop/KillShell kills by task id', () => {
    const s = new ShellTracker();
    s.start('main', bash('b1', T0));
    s.result('b1', { taskId: 'bkill', error: false, at: T0 });
    expect(s.stop('bkill', T0 + 9_000)).toMatchObject({ outcome: 'killed', job: { toolUseId: 'b1' } });
    expect(s.size).toBe(0);
    // Subsequent "killed" notification is ignored.
    expect(s.notify({ taskId: 'bkill', status: 'killed', at: T0 + 9_500 })).toBeUndefined();
  });

  it('discards what cannot be running: prior to process, older than 24h, expired monitor', () => {
    const s = new ShellTracker();
    s.start('main', bash('velho', T0 - 60_000));
    s.start('main', bash('novo', T0 + 1_000));
    s.start('main', bash('mon', T0 + 1_000, { kind: 'monitor', timeoutMs: 60_000 }));
    expect(s.prune(T0 + 2_000, T0)).toBe(true);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['mon', 'novo']);
    s.prune(T0 + 1_000 + 60_000 + 61_000);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['novo']);
    s.prune(T0 + 1_000 + SHELL_MAX_AGE_MS + 1);
    expect(s.size).toBe(0);
  });

  it('pending approval hides foreground command and resets its timer', () => {
    const s = new ShellTracker();
    s.start('main', bash('f1', T0, { background: false }));
    s.holdForeground(true, T0 + 60_000);
    expect(s.list()).toEqual([]);
    s.holdForeground(false, T0 + 61_000);
    expect(s.list()[0]).toMatchObject({ toolUseId: 'f1', startedAt: T0 + 60_000 });
  });

  it('merges head of file without reviving what window already saw finish', () => {
    const s = new ShellTracker();
    // Tail window: completion of shell whose start was at head of file, and launch of another.
    s.notify({ toolUseId: 'antigo', taskId: 'bant', status: 'completed', at: T0 + 10 });
    s.result('rodando', { taskId: 'brod', error: false, at: T0 + 5 });
    const older = new ShellTracker();
    older.start('main', bash('antigo', T0));
    older.start('main', bash('rodando', T0));
    older.start('main', bash('fg', T0, { background: false }));
    expect(s.merge(older.openBackground())).toBe(true);
    expect(s.list().map(toShellJob)).toEqual([expect.objectContaining({ id: 'brod', startedAt: T0 + 5 })]);
    expect(s.notify({ taskId: 'brod', status: 'failed', at: T0 + 20 })).toMatchObject({ outcome: 'failed' });
  });
});
