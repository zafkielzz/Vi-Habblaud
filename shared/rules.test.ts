// Office rules: parsing, the scope checks (shared cases with agy-hub's Python: rules.vectors.json) and the text agents read.
import { describe, expect, it } from 'vitest';
import { checkCommand, checkPath, defaultRules, parseRules, rulesText, RULES_MAX } from './rules';
import vectors from './rules.vectors.json';

const rules = parseRules({ scope: vectors.scope });

describe('office rules', () => {
  it.each(vectors.paths)('path $path ($mode)', (c) => {
    const r = checkPath(rules, { folder: vectors.folder, home: vectors.home, cwd: (c as { cwd?: string }).cwd }, c.path, c.mode as 'read' | 'write');
    expect(r.ok).toBe(c.ok);
    if (!c.ok) expect(r.kind).toBe((c as { kind?: string }).kind);
  });

  it.each(vectors.commands)('command $cmd', (c) => {
    expect(checkCommand(rules, c.cmd) ?? null).toBe(c.hit);
  });

  it('parses: absent = defaults, junk dropped, caps and unique ids', () => {
    expect(parseRules(undefined)).toEqual(defaultRules());
    const r = parseRules({
      scope: { write: ['relative/x', '/abs', '/abs'], deny: [], commands: [' git   push '] },
      items: [{ id: 'a', text: '  Be  short ', for: 'boss' }, { id: 'a', text: 'Two' }, { text: '' }, { text: 'x'.repeat(500), for: 'nobody', on: false }],
      limits: { maxJobs: 0, quotaStop: 80 },
      rev: 3,
    });
    expect(r.scope).toEqual({ write: ['/abs'], deny: [], commands: ['git push'] });
    expect(r.items.map((i) => [i.id, i.text.length, i.for, i.on])).toEqual([['a', 8, 'boss', true], ['r2', 3, 'all', true], ['r4', RULES_MAX.text, 'all', false]]);
    expect(r.limits).toEqual({ quotaStop: 80 });
    expect(r.rev).toBe(3);
  });

  it('a folder-less office: only deny applies', () => {
    expect(checkPath(rules, { folder: '', home: '/home/u' }, '/etc/x', 'write').ok).toBe(true);
    expect(checkPath(rules, { folder: '', home: '/home/u' }, '/home/u/.ssh/x', 'write').kind).toBe('deny');
  });

  it('text: only the rules for that side, limits and how to propose for the boss', () => {
    const r = parseRules({ ...defaultRules(), items: [{ text: 'W only', for: 'workers' }, { text: 'B only', for: 'boss' }, { text: 'Off', on: false }], limits: { maxJobs: 2 } });
    const w = rulesText({ name: 'A', folder: '/p' }, r, 'workers');
    expect(w).toContain('Edit files only inside: /p.');
    expect(w).toContain('W only');
    expect(w).not.toMatch(/B only|- Off|propose|At most/);
    const b = rulesText({ name: 'A', folder: '/p' }, r, 'boss');
    expect(b).toMatch(/B only[\s\S]*At most 2 jobs[\s\S]*agy-ask rules propose/);
  });
});
