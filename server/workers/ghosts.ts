// Workers that look hung, drawn as a faint ghost on their seat. Nothing here stops anything: the office only shows it and
// tells the Board once, and you decide. No tokens: only /proc and file times.
//
// A candidate is a process or job that should be showing signs of life: a headless agy, an agy with nobody left to
// talk to (orphan, or its job already ended; sources/agy) or a job in a worker terminal (workers/service.ts). Interactive
// agy waiting at its prompt (herdr, a worker terminal between jobs) is not a candidate: that is what it is for.
import type { AgentGhost, NewsItem } from '../../shared/types';
import { formatDuration } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';

/**
 * Silence before a worker counts as hung. In 20,726 step gaps of the real transcripts on this machine (8,823
 * conversations, tool runs included) the longest was 273 s, so 10 minutes is over twice anything a healthy job did. It is
 * also under agy-ask's 15-minute --timeout and the 30-minute terminal job limit, so the ghost shows before the job dies.
 */
export const GHOST_SILENCE_MS = 10 * 60_000;
/** How often the candidates are read. */
export const GHOST_POLL_MS = 15_000;

export interface GhostCandidate {
  /** Its character. */
  agentId: string;
  name: string;
  pid: number;
  /** Last sign of life (epoch ms): the process start, or the newest write to its logs or conversation. */
  lastSign: number;
  /** Alive with no job: its parent is gone or its job already ended. */
  jobless?: boolean;
}

/** The ghost a candidate is now, if any. */
export function ghostOf(c: GhostCandidate, now: number): AgentGhost | undefined {
  if (now - c.lastSign < GHOST_SILENCE_MS) return undefined;
  return { reason: c.jobless ? 'no-job' : 'stalled', since: c.lastSign, pid: c.pid };
}

export interface GhostWatchOptions {
  office: Pick<Office, 'setGhost'>;
  candidates: () => GhostCandidate[];
  news: (item: NewsItem) => void;
  now?: () => number;
}

export class GhostWatch {
  /** Characters drawn as ghosts now. */
  private readonly ghosts = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: GhostWatchOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (err) {
        log.warnOnce(`ghosts:${errMsg(err)}`, tr('Checking for hung workers failed: {0}', [errMsg(err)]));
      }
    }, GHOST_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Flags who turned into a ghost (one Board line each) and clears who showed signs of life again or left. */
  check(): void {
    const now = this.now();
    const found = new Map<string, GhostCandidate & { ghost: AgentGhost }>();
    for (const c of this.opts.candidates()) {
      const ghost = ghostOf(c, now);
      if (ghost && !found.has(c.agentId)) found.set(c.agentId, { ...c, ghost });
    }
    for (const [agentId, c] of found) {
      this.opts.office.setGhost(agentId, c.ghost);
      if (this.ghosts.has(agentId)) continue;
      this.ghosts.add(agentId);
      this.opts.news(ghostNews(c, c.ghost, now));
    }
    for (const agentId of [...this.ghosts]) {
      if (found.has(agentId)) continue;
      this.ghosts.delete(agentId);
      this.opts.office.setGhost(agentId, undefined);
    }
  }
}

/** One id per process: a restart of the server, or the same hung process coming back, does not add another line. */
function ghostNews(c: GhostCandidate, g: AgentGhost, now: number): NewsItem {
  return {
    id: `ghost:${c.agentId}:${c.pid}`,
    at: now,
    kind: 'ghost',
    icon: '👻',
    text: g.reason === 'no-job' ? tr('{0}: agy is still alive with no job', [c.name]) : tr('{0} looks hung', [c.name]),
    detail: tr('silent for {0} · PID {1} · nothing was stopped', [formatDuration(now - g.since), c.pid]),
  };
}
