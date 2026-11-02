// The day's news feed (Board › News) and today's commits from git.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitCommitsSince, NewsFeed, parseGitLog, startOfDay } from './news';
import type { NewsItem } from '../shared/types';

const NOW = new Date(2026, 9, 27, 15, 0).getTime();

function item(id: string, at: number, text = id): NewsItem {
  return { id, at, kind: 'done', icon: '✅', text };
}

describe('NewsFeed', () => {
  it("today's items only, newest first; same id replaces; unchanged add is a no-op", () => {
    const feed = new NewsFeed();
    expect(feed.add(item('old', startOfDay(NOW) - 1), NOW)).toBe(false);
    expect(feed.add(item('a', NOW - 60_000), NOW)).toBe(true);
    expect(feed.add(item('b', NOW - 1_000), NOW)).toBe(true);
    const v = feed.version;
    expect(feed.add(item('a', NOW - 60_000), NOW)).toBe(false);
    expect(feed.version).toBe(v);
    expect(feed.add(item('a', NOW - 60_000, 'a, edited'), NOW)).toBe(true);
    expect(feed.view(NOW).map((i) => i.text)).toEqual(['b', 'a, edited']);
  });

  it('at midnight the previous day falls off', () => {
    const feed = new NewsFeed();
    feed.add(item('a', NOW), NOW);
    expect(feed.view(NOW + 24 * 3_600_000)).toEqual([]);
  });
});

describe('git', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('parseGitLog: hash, time, author and subject per line; junk lines are skipped', () => {
    expect(parseGitLog('abc\x1f1793000000\x1fNam\x1fFix: a\x1fb\nnoise\n')).toEqual([
      { hash: 'abc', at: 1_793_000_000_000, author: 'Nam', subject: 'Fix: a\x1fb' },
    ]);
  });

  it('gitCommitsSince: commits of a real repository; a folder without git gives []', async () => {
    dir = mkdtempSync(join(tmpdir(), 'news-git-'));
    expect(await gitCommitsSince(dir, 0)).toEqual([]);
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(dir, 'f'), 'x');
    git('add', 'f');
    git('-c', 'user.name=Tester', '-c', 'user.email=t@example.com', 'commit', '-qm', 'First commit');
    const commits = await gitCommitsSince(dir, Date.now() - 3_600_000);
    expect(commits).toMatchObject([{ author: 'Tester', subject: 'First commit' }]);
    expect(await gitCommitsSince(dir, Date.now() + 3_600_000)).toEqual([]);
  });
});
