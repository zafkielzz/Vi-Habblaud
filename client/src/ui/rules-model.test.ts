// Office rules in the page: counts, today's violations, the scope line, checks before saving.
import { describe, expect, it } from 'vitest';
import type { OfficeInfo } from '../../../shared/types';
import { defaultRules, type RuleViolation } from '../../../shared/rules';
import { activeRules, draftOf, linesOf, newRuleId, rulesProblems, sameDraft, scopeLine, violationsToday } from './rules-model';

const office = (id: string, folder: string, extra: Partial<OfficeInfo> = {}): OfficeInfo => ({ id, name: id.toUpperCase(), folder, workers: [], ...extra });

describe('rules model', () => {
  it('counts the rules that are on; none without rules', () => {
    const r = defaultRules();
    r.items.push({ id: 'r2', text: 'x', for: 'all', on: false }, { id: 'r3', text: 'y', for: 'boss', on: true });
    expect(activeRules(r)).toBe(2);
    expect(activeRules(undefined)).toBe(0);
  });

  it("today's violations only", () => {
    const now = new Date(2026, 9, 28, 15, 0).getTime();
    const v = (at: number): RuleViolation => ({ at, office: 'a', who: 'acc1', kind: 'deny', detail: '~/.ssh', by: 'hook' });
    const list = [v(now - 60_000), v(new Date(2026, 9, 28, 0, 1).getTime()), v(new Date(2026, 9, 27, 23, 59).getTime())];
    expect(violationsToday(list, now)).toHaveLength(2);
    expect(violationsToday(undefined, now)).toEqual([]);
  });

  it('scope line: where it may edit, hidden paths, commands', () => {
    const rules = defaultRules();
    rules.scope.write = ['/tmp/out'];
    expect(scopeLine(office('a', '/home/me/p', { rules }))).toBe('✏️ ~/p, /tmp/out · 🚫 4 hidden · ⛔ git push, sudo');
    expect(scopeLine(office('a', '', { rules: { ...rules, scope: { write: [], deny: [], commands: [] } } }))).toBe('✏️ no folder yet');
    expect(scopeLine(office('a', '/p'))).toBe('');
  });

  it('checks an edited copy: paths, overlap with another office, limits, empty rules', () => {
    const offices = [office('a', '/w/a'), office('b', '/w/b')];
    const ok = draftOf(defaultRules());
    expect(rulesProblems(ok, offices[0], offices)).toEqual([]);
    const bad = draftOf(defaultRules());
    bad.scope.write = ['rel/x', '/w/b/docs', '/tmp/ok', '/', '~/'];
    bad.items.push({ id: 'r2', text: '  ', for: 'all', on: true });
    bad.limits = { maxJobs: 0, quotaStop: 101 };
    const p = rulesProblems(bad, offices[0], offices);
    expect(p).toHaveLength(7);
    expect(p[1]).toContain('B');
  });

  it('drafts: copies, compares, lines, new ids', () => {
    const r = defaultRules();
    const d = draftOf(r);
    expect(sameDraft(d, draftOf(r))).toBe(true);
    d.items[0].on = false;
    expect(r.items[0].on).toBe(true);
    expect(sameDraft(d, draftOf(r))).toBe(false);
    expect(linesOf(' a \n\nb\na\n')).toEqual(['a', 'b']);
    expect(newRuleId([{ id: 'r1' }, { id: 'r2' }])).toBe('r3');
    expect(newRuleId([{ id: 'r2' }])).toBe('r3');
  });
});
