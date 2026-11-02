// The day's news feed (Board › News): what happened in the office today, from local sources only, no LLM: worker
// jobs finished or failed, quota hits, level-ups and badges (from the agy-ask log) and new commits in each room
// (`git log`). Items have stable ids, so re-reading a source after a restart rebuilds the same feed.
import { execFile } from 'node:child_process';
import type { NewsItem } from '../shared/types';

/** Most items kept (the newest). */
const MAX_ITEMS = 60;

/** Local midnight of the day of `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's items, newest first; yesterday's fall off at midnight. */
export class NewsFeed {
  private readonly items = new Map<string, NewsItem>();
  private rev = 0;

  /** Adds (or replaces, same id) an item; true when the feed changed. */
  add(item: NewsItem, now = Date.now()): boolean {
    if (item.at < startOfDay(now)) return false;
    const old = this.items.get(item.id);
    if (old && old.at === item.at && old.text === item.text && old.detail === item.detail) return false;
    this.items.set(item.id, item);
    this.rev++;
    return true;
  }

  /** Changes on every add that changed something (for the snapshot's change detection). */
  get version(): number {
    return this.rev;
  }

  view(now = Date.now()): NewsItem[] {
    const from = startOfDay(now);
    for (const [id, it] of this.items) if (it.at < from) this.items.delete(id);
    return [...this.items.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, MAX_ITEMS);
  }
}

export interface GitCommit {
  hash: string;
  at: number;
  author: string;
  subject: string;
}

const SEP = '\x1f';

/** Output of `git log --format=%H%x1f%ct%x1f%an%x1f%s`, one commit per line. */
export function parseGitLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of out.split('\n')) {
    const [hash, ct, author, ...rest] = line.split(SEP);
    const at = Number(ct) * 1000;
    if (!hash || !Number.isFinite(at) || !rest.length) continue;
    commits.push({ hash, at, author: author ?? '', subject: rest.join(SEP).trim() });
  }
  return commits;
}

/** Commits since `since` (epoch ms) on the current branch of `dir`; [] when it is not a repository or git fails. */
export function gitCommitsSince(dir: string, since: number, timeoutMs = 5_000): Promise<GitCommit[]> {
  const args = ['-C', dir, 'log', `--since=@${Math.floor(since / 1000)}`, '-n', '30', `--format=%H${SEP}%ct${SEP}%an${SEP}%s`];
  return new Promise((resolve) => {
    execFile('git', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? [] : parseGitLog(stdout)));
  });
}
