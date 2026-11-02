// The rules log: appended lines only, trimmed on start, an office's lines dropped.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseViolation, RulesLog } from './rules-log';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = () => {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-rules-'));
  dirs.push(d);
  return join(d, 'rules-log.jsonl');
};
const v = (at: number, office = 'main', kind = 'cwd') => JSON.stringify({ at, office, who: 'acc1', kind, detail: '/etc  x', by: 'ask' });

describe('rules log', () => {
  it('parses a line; malformed ones are dropped', () => {
    expect(parseViolation(v(1))).toEqual({ at: 1, office: 'main', who: 'acc1', kind: 'cwd', detail: '/etc x', by: 'ask' });
    expect(parseViolation('{"at":1,"office":"m","kind":"nope"}')).toBeUndefined();
    expect(parseViolation('not json')).toBeUndefined();
  });

  it('trims old lines on start, then returns only appended whole lines', () => {
    const f = file();
    writeFileSync(f, `${v(NOW - 9 * DAY)}\n${v(NOW - DAY)}\n`);
    const log = new RulesLog(f, () => NOW);
    expect(log.of('main')).toHaveLength(1);
    expect(readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(log.poll()).toEqual([]);
    appendFileSync(f, `${v(NOW, 'o2', 'quota')}\n{"at":`);
    expect(log.poll().map((x) => x.office)).toEqual(['o2']);
    appendFileSync(f, `${NOW + 1},"office":"main","who":"boss","kind":"command","detail":"git push","by":"hook"}\n`);
    expect(log.poll().map((x) => x.detail)).toEqual(['git push']);
    expect(log.of('main').map((x) => x.at)).toEqual([NOW + 1, NOW - DAY]);
  });

  it('dropping an office rewrites the file without its lines; a missing file is empty', () => {
    const f = file();
    const log = new RulesLog(f, () => NOW);
    expect(log.of('main')).toEqual([]);
    writeFileSync(f, `${v(NOW)}\n${v(NOW, 'o2')}\n`);
    expect(log.poll()).toHaveLength(2);
    log.dropOffice('o2');
    expect(readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(log.poll()).toEqual([]);
    expect(log.of('o2')).toEqual([]);
  });
});
