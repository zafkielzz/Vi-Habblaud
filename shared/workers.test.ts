// Worker ids: an account, or a clone of one ("<account>#N": one more session of it).
import { describe, expect, it } from 'vitest';
import { cloneId, cloneSuffix, nextWorkerId, splitWorker, workerBase } from './workers';

describe('worker ids', () => {
  it('a clone is its account and a session number; the plain id is session 1', () => {
    expect(splitWorker('acc2')).toEqual({ account: 'acc2', n: 1 });
    expect(splitWorker('acc2#2')).toEqual({ account: 'acc2', n: 2 });
    expect(splitWorker('claude:.claude#13')).toEqual({ account: 'claude:.claude', n: 13 });
    expect(splitWorker('claude:.claude-work')).toEqual({ account: 'claude:.claude-work', n: 1 });
    expect(workerBase('acc2#3')).toBe('acc2');
    expect(workerBase('claude:.claude')).toBe('claude:.claude');
  });

  it('not clones: "#1", "#0", leading zeros, no number, no account (the same cases as office_rules.py)', () => {
    for (const id of ['acc2#1', 'acc2#0', 'acc2#02', 'acc2#', '#2', 'acc2#x']) expect(splitWorker(id)).toEqual({ account: id, n: 1 });
  });

  it('the id of a session, and what tells clones apart in a name', () => {
    expect([cloneId('acc2', 1), cloneId('acc2', 2), cloneId('claude:.claude', 10)]).toEqual(['acc2', 'acc2#2', 'claude:.claude#10']);
    expect([cloneSuffix('acc2'), cloneSuffix('acc2#2'), cloneSuffix('claude:.claude#3')]).toEqual(['', ' #2', ' #3']);
    for (const id of ['acc2', 'acc2#2', 'claude:.claude#10']) expect(cloneId(splitWorker(id).account, splitWorker(id).n)).toBe(id);
  });

  it('adding an account: itself when it is not there, else its first free clone; the boss\'s own starts at #2', () => {
    expect(nextWorkerId([], 'acc2')).toBe('acc2');
    expect(nextWorkerId(['acc1'], 'acc2')).toBe('acc2');
    expect(nextWorkerId(['acc2'], 'acc2')).toBe('acc2#2');
    expect(nextWorkerId(['acc2', 'acc2#2', 'acc2#4'], 'acc2')).toBe('acc2#3');
    expect(nextWorkerId(['acc2#2'], 'acc2')).toBe('acc2'); // the plain one was removed: it is free again
    expect(nextWorkerId([], 'claude:.claude', true)).toBe('claude:.claude#2');
    expect(nextWorkerId(['claude:.claude#2', 'claude:.claude#3'], 'claude:.claude', true)).toBe('claude:.claude#4');
  });
});
