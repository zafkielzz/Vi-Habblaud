// Office simulator for demo and development.
// Pure (no Node/DOM): runs on server (HABBLAUD_DEMO=1) and in browser (?mock=1).
//
// Generates fictional sessions with realistic lifecycles: prompt -> work -> (permission or question, with fictional
// request to answer from office) -> (subagents) -> (long foreground command) -> end of turn ->
// (waiting on background shell) -> pause -> ... and terminates sessions periodically to exercise arrival,
// departure, "lights out", and room removal animations.
//
// Some sessions belong to Codex (dedicated account, gpt-*-codex models, usage read "from Codex files", approval
// requests without "always allow", and queued session messages). The opening always features a room with
// Claude Code and Codex together. Codex assignment and usage come from a separate draw (hash of session id and
// `codexRng`), without extra draws from main RNG; still, the office for each seed changed relative to versions
// without Codex (session 2 changes room, and Codex agents do not draw cost). As always: same seed produces same office.
import type { AccountInfo, AccountUsage, Activity, AgentInfo, FeedItem, Notice, OfficeSnapshot, PermissionDecision, RoomInfo, ShellJob, TaskItem } from '../types';
import { describePrompt, describeShellJob, describeTool, SHELL_DONE_TOOL, SHELL_WAIT_TOOL, SPECIAL, type ActivityDescription, type ShellOutcome } from '../activity';
import { answerSummary, ASK_TOOL, checkAnswers } from '../answers';
import { describeGitHubEvent, GITHUB_TOOL, RoomEffects } from '../github';
import { hash32, mulberry32 } from '../hash';
import { describeMessage, MESSAGE_TOOL } from '../messages';
import { pickName } from '../names';
import { demoGitHubEvent } from './github';
import { demoCodexPermission, demoPermission, type DemoPermissionKind } from './permission';
import { tr } from '../i18n';

interface DemoProject {
  name: string;
  files: string[];
  prompts: string[];
  tasks: string[];
  queries: string[];
  commands: string[];
  greps: string[];
}

const ROOT = '/Users/dev/projetos';

const PROJECTS: DemoProject[] = [
  {
    name: 'loja-virtual',
    files: ['src/pages/Checkout.tsx', 'src/components/Cart.tsx', 'src/api/orders.ts', 'src/hooks/useCart.ts', 'src/styles/theme.css', 'tests/cart.test.ts', 'package.json'],
    prompts: [tr('Build the checkout page with an order summary'), tr("The cart total doesn't update when an item is removed"), tr('Add discount coupons to checkout'), tr("Improve the storefront's mobile layout")],
    tasks: [tr('Create checkout page'), tr('Validate address form'), tr('Integrate shipping calculation'), tr('Write cart tests'), tr('Adjust mobile layout')],
    queries: ['react checkout form validation', tr('shipping rate postal service api')],
    commands: ['npm test', 'npm run build', 'git status', 'git diff', 'npm run lint', 'git commit -m "feat: checkout"'],
    greps: ['useCart', 'calculateTotal', 'TODO'],
  },
  {
    name: 'api-pagamentos',
    files: ['src/routes/payments.ts', 'src/services/pix.ts', 'src/db/migrations/004_refunds.sql', 'src/middleware/auth.ts', 'tests/pix.test.ts', 'docker-compose.yml'],
    prompts: [tr('Implement refunds for instant payments'), tr('The webhooks are duplicating charges, look into it'), tr('Add rate limiting to public routes')],
    tasks: [tr('Map refund flow'), tr('Create refunds migration'), tr('Implement POST /refunds route'), tr('Webhook idempotency'), tr('Cover with tests')],
    queries: [tr('instant payment refund api'), 'idempotency key webhook best practices'],
    commands: ['npm test', 'docker compose up -d db', 'psql -c "select count(*) from payments"', 'git status', 'curl -s http://localhost:3000/health'],
    greps: ['webhook', 'idempotencyKey', 'refund'],
  },
  {
    name: 'app-mobile',
    files: ['app/screens/Home.tsx', 'app/screens/Profile.tsx', 'app/navigation/index.tsx', 'app/services/api.ts', 'app.json'],
    prompts: [tr('Build the profile screen with photo and editing'), tr('Navigation freezes when going back from the details screen'), tr('Add dark mode to the app')],
    tasks: [tr('Create profile screen'), tr('Photo upload'), tr('Fix navigation'), tr('Dark theme')],
    queries: ['react native navigation goBack freeze', 'expo image picker permissions'],
    commands: ['npx expo start', 'npm test', 'git status', 'npm install react-native-reanimated'],
    greps: ['navigation.goBack', 'useTheme'],
  },
  {
    name: 'data-pipeline',
    files: ['pipelines/ingest.py', 'pipelines/transform.py', 'dags/daily_report.py', 'requirements.txt', 'tests/test_transform.py'],
    prompts: [tr('The daily report is coming out with wrong dates'), tr('Add deduplication to ingestion'), tr('Optimize the slow transformation')],
    tasks: [tr('Investigate time zone'), tr('Fix date parsing'), tr('Deduplicate events'), tr('Regression tests')],
    queries: ['pandas tz_convert daylight saving', 'airflow dag catchup false'],
    commands: ['pytest -q', 'python pipelines/ingest.py --dry-run', 'pip install -r requirements.txt', 'git status'],
    greps: ['tz_localize', 'drop_duplicates'],
  },
  {
    name: 'site-institucional',
    files: ['src/pages/index.astro', 'src/components/Hero.astro', 'src/content/blog/lancamento.md', 'astro.config.mjs', 'public/robots.txt'],
    prompts: [tr('Build the testimonials section on the home page'), tr('Improve SEO on the blog pages'), tr('Add a contact form')],
    tasks: [tr('Testimonials section'), tr('Blog meta tags'), 'Sitemap', tr('Contact form')],
    queries: ['astro sitemap integration', 'schema.org organization json-ld'],
    commands: ['npm run build', 'npm run dev', 'git status', 'npx lighthouse http://localhost:4321'],
    greps: ['<meta', 'description'],
  },
  {
    name: 'chatbot-suporte',
    files: ['bot/handlers/faq.ts', 'bot/llm/prompt.ts', 'bot/integrations/zendesk.ts', 'bot/index.ts', 'tests/faq.test.ts'],
    prompts: [tr("The bot isn't handing off to a human"), tr('Add Zendesk integration'), tr('Improve the prompt for shorter replies')],
    tasks: [tr('Escalation rule'), tr('Zendesk client'), tr('Tweak prompt'), tr('Conversation tests')],
    queries: ['zendesk tickets api create', 'llm handoff to human patterns'],
    commands: ['npm test', 'npm run dev', 'git status', 'git push'],
    greps: ['handoff', 'escalate'],
  },
];

/** Demo projects (fictional "My day" history uses all of them, not just currently open rooms). */
export const DEMO_PROJECT_NAMES: readonly string[] = PROJECTS.map((p) => p.name);

const SUB_TYPES = ['Explore', 'general-purpose', 'Plan', 'code-reviewer', 'test-runner'];
const SUB_TASKS = [
  tr('Map affected files'),
  tr('Review existing code'),
  tr('Research documentation'),
  tr('Run test suite'),
  tr("Find the bug's root cause"),
  tr('Propose an implementation plan'),
  tr('Check test coverage'),
  tr('Analyze error logs'),
];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];
/** Codex session models. */
const CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-mini'];
/** Codex subagent roles (the `agent_role` of agents dispatched by Codex). */
const CODEX_SUB_ROLES = ['explorer', 'worker', 'reviewer'];
/** Share of new sessions opened in Codex (determined by session id hash). */
const CODEX_SHARE = 30;

/** Commands agents leave running in background (and finish turn waiting for them). */
const BACKGROUND_JOBS: Array<{ description: string; command: string }> = [
  { description: tr('Run the test suite'), command: 'npm test -- --runInBand' },
  { description: tr('Production build'), command: 'npm run build -- --mode production' },
  { description: tr('Database migration'), command: 'npm run db:migrate && npm run db:seed' },
  { description: tr('Run the integration tests'), command: 'pytest -q tests/integration' },
  { description: tr('Generate the full report'), command: 'python pipelines/report.py --full' },
  { description: tr('Start the containers'), command: 'docker compose up --build --wait' },
  { description: tr('End-to-end tests'), command: 'npx playwright test' },
  { description: tr('Performance audit'), command: 'npx lighthouse http://localhost:4321 --quiet' },
];
/** Long foreground commands (agent stays idle waiting for result). */
const FOREGROUND_JOBS: Array<{ description: string; command: string }> = [
  { description: tr('Install the dependencies'), command: 'npm ci' },
  { description: tr('Run the module tests'), command: 'npm test -- src/api' },
  { description: tr('Compile the project'), command: 'npm run build' },
  { description: tr('Pull the database image'), command: 'docker pull postgres:17' },
];
/** Chance of leaving a background shell running at the end of a turn. */
const SHELL_CHANCE = 0.35;
/** Chance on each action to run a long foreground command (at most one per turn). */
const FOREGROUND_CHANCE = 0.07;
/** Chance of a background shell failing. */
const SHELL_FAIL_CHANCE = 0.15;

type DemoAccount = Omit<AccountInfo, 'sessions' | 'usage' | 'usageStatus'>;

// In ?mock=1 accounts mimic real scenario (C and D in Claude Code, plus one in Codex). Mixed with real data
// on server (idPrefix), demo uses its own accounts, distinct from real ones.
const DEMO_ACCOUNTS: DemoAccount[] = [
  { id: '.claude', short: 'C', name: 'Conta C', email: 'dev@empresa.example', organization: tr('Company'), plan: 'Max', color: '#f08a3c', configDir: '~/.claude' },
  { id: '.claude-conta2', short: 'D', name: 'Conta D', email: 'dev@pessoal.example', plan: 'Max', color: '#4aa8e8', configDir: '~/.claude-conta2' },
];
/** Codex account (a CODEX_HOME): no email (Habblaud reads no credentials), with plan from `rate_limits`. */
const DEMO_CODEX_ACCOUNT: DemoAccount = { id: '.codex', provider: 'codex', short: 'X', name: 'Codex', plan: 'Team', color: '#a77bf3', configDir: '~/.codex' };
const MERGED_ACCOUNTS: Array<Pick<DemoAccount, 'short' | 'name' | 'color'>> = [
  { short: 'X', name: 'Demo X', color: '#5cc97b' },
  { short: 'Y', name: 'Demo Y', color: '#a77bf3' },
];
const MERGED_CODEX_ACCOUNT: Pick<DemoAccount, 'short' | 'name' | 'color'> = { short: 'Z', name: 'Demo Codex', color: '#f06fa0' };
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Codex usage older than 30 min (no active session) appears as stale, as on the server. */
const CODEX_STALE_MS = 30 * MINUTE;
/** Message for an idle Codex session: owner polls queue every ~10 s (queued between 2 and 8 s, in demo). */
const CODEX_QUEUE_MIN_MS = 2_000;
const CODEX_QUEUE_SPREAD_MS = 6_000;

type Phase = 'working' | 'waiting' | 'idle' | 'delegating' | 'shell' | 'leaving';

interface SimAgent {
  info: AgentInfo;
  project: DemoProject;
  rng: () => number;
  phase: Phase;
  phaseUntil: number;
  nextActionAt: number;
  actionsLeft: number;
  children: string[];
  closeAt: number;
  removeAt?: number;
  taskCursor: number;
  /** End (and outcome) of each running background shell, by job id. */
  shellEnds: Map<string, { at: number; outcome: ShellOutcome }>;
  /** Foreground command running until this timestamp. */
  foregroundUntil?: number;
  /** Already spawned background shell or long foreground command in this turn. */
  shelledThisTurn: boolean;
  foregroundThisTurn: boolean;
  /** Codex: queued session messages (delivered when it becomes idle) and earliest delivery time. */
  inbox?: string[];
  inboxAt?: number;
}

export interface DemoTickResult {
  changed: boolean;
  feed: FeedItem[];
  notices: Notice[];
}

export interface DemoOptions {
  seed?: number;
  /** Speed multiplier (2 = everything happens 2x faster). */
  speed?: number;
  /** How many main sessions to keep open (approx.). */
  sessions?: number;
  /** Id prefix (server uses "demo:" to avoid colliding with real data). */
  idPrefix?: string;
  /** Codex account always "no quota" (screenshots and tests); otherwise, runs out of quota only occasionally. */
  codexNoQuota?: boolean;
}

const SLOT_COOLDOWN_MS = 30_000;
const OFFLINE_GRACE_MS = 20_000;
const DONE_GRACE_MS = 25_000;

export class DemoSimulator {
  private rng: () => number;
  private speed: number;
  private target: number;
  private prefix: string;
  /** Tag for this instance: agent/activity/notice ids do not repeat upon restarting demo. */
  private tag: string;
  private accounts: DemoAccount[];
  private agents = new Map<string, SimAgent>();
  private rooms = new Map<string, RoomInfo>();
  private slotFreedAt = new Map<number, number>();
  private rev = 0;
  private dirty = true;
  private seq = 0;
  private nextSpawnAt = 0;
  private startedAt: number;
  private pendingFeed: FeedItem[] = [];
  private pendingNotices: Notice[] = [];
  private usage = new Map<string, { five: number; week: number; fiveReset: number; weekReset: number }>();
  /** Fictional GitHub events (celebration/alarm in rooms): separate RNG, without affecting remainder. */
  private ghRng: () => number;
  private effects = new RoomEffects();
  private nextGitHubAt: number;
  private prSeq: number;
  /** Codex account (placed after Claude Code accounts in snapshot). */
  private codexAccount: DemoAccount;
  /** Dedicated Codex RNG (usage, "no quota"): does not affect remainder sequence. */
  private codexRng: () => number;
  /** When Codex usage was last "fetched": last activity of a Codex session. */
  private codexFetchedAt: number;
  /** Codex "no quota": always (option) or periodically in windows of a few minutes. */
  private codexNoQuotaAlways: boolean;
  private noQuotaFrom: number;
  private noQuotaUntil: number;
  /** Last read of Codex usage returned "no quota". */
  private codexReadNoQuota: boolean;
  /** Main sessions spawned so far (2nd at startup is Codex sharing room of the 1st). */
  private mainsSpawned = 0;

  constructor(opts: DemoOptions = {}, now = Date.now()) {
    this.rng = mulberry32(opts.seed ?? hash32(String(now)));
    this.speed = opts.speed ?? 1;
    // first GitHub event arrives soon (for screenshots), subsequent ones every 35–80 s
    this.ghRng = mulberry32(((opts.seed ?? hash32(String(now))) ^ 0x6a09e667) >>> 0);
    this.nextGitHubAt = now + (10_000 + this.ghRng() * 10_000) / this.speed;
    this.prSeq = 12 + Math.floor(this.ghRng() * 80);
    this.codexRng = mulberry32(((opts.seed ?? hash32(String(now))) ^ 0x3c6ef372) >>> 0);
    this.target = opts.sessions ?? 4;
    this.prefix = opts.idPrefix ?? '';
    this.tag = now.toString(36);
    this.accounts = this.prefix
      ? DEMO_ACCOUNTS.map((acc, i) => ({ ...acc, ...MERGED_ACCOUNTS[i], id: `${this.prefix}${acc.id}`, configDir: tr('(demo)') }))
      : DEMO_ACCOUNTS;
    this.codexAccount = this.prefix
      ? { ...DEMO_CODEX_ACCOUNT, ...MERGED_CODEX_ACCOUNT, id: `${this.prefix}${DEMO_CODEX_ACCOUNT.id}`, configDir: tr('(demo)') }
      : DEMO_CODEX_ACCOUNT;
    this.startedAt = now;
    this.accounts.forEach((acc, i) =>
      this.usage.set(acc.id, {
        five: 12 + this.rng() * 30,
        week: 20 + this.rng() * 35,
        fiveReset: now + (1.5 + i * 1.7) * HOUR,
        weekReset: now + (2 + i * 2.5) * 24 * HOUR,
      }),
    );
    // Codex: numbers from before office opened (last session ran a few minutes ago).
    this.usage.set(this.codexAccount.id, {
      five: 30 + this.codexRng() * 40,
      week: 25 + this.codexRng() * 45,
      fiveReset: now + (0.8 + this.codexRng() * 3) * HOUR,
      weekReset: now + (1 + this.codexRng() * 5) * 24 * HOUR,
    });
    this.codexFetchedAt = now - (4 + this.codexRng() * 20) * MINUTE;
    this.codexNoQuotaAlways = !!opts.codexNoQuota;
    this.noQuotaFrom = now + (6 + this.codexRng() * 6) * MINUTE / this.speed;
    this.noQuotaUntil = this.noQuotaFrom + (2 + this.codexRng() * 2) * MINUTE / this.speed;
    this.codexReadNoQuota = this.codexNoQuotaAlways;
    // Starts with office already busy — and someone waiting on a shell (wait takes minutes;
    // without this, the first wait would only appear after the first full turn).
    for (let i = 0; i < this.target - 1; i++) this.spawnSession(now, true);
    const first = [...this.agents.values()].find((a) => a.info.kind === 'main');
    if (first) this.startBackgroundShells(first, now, true);
    this.nextSpawnAt = now + this.ms(20_000, 40_000);
    // Discard initial feed/notices.
    this.pendingFeed = [];
    this.pendingNotices = [];
  }

  /** Changes how many main sessions to keep open (timelapse generator varies this throughout day). */
  setSessions(n: number): void {
    this.target = Math.max(0, Math.floor(n));
  }

  /**
   * Message sent from office to a main agent (fictional: nothing reaches a real session): creates
   * "Message via Habblaud" activity and, if idle, next turn starts shortly as if replying.
   * false = unknown agent, subagent, or already departed.
   */
  receiveMessage(agentId: string, text: string, now = Date.now()): boolean {
    const a = this.agents.get(agentId);
    if (!a || a.info.kind !== 'main' || a.removeAt !== undefined || a.phase === 'leaving') return false;
    if (a.info.provider === 'codex') {
      // Codex (`codex queue`): message enters session queue and only becomes a prompt once it becomes idle.
      (a.inbox ??= []).push(text);
      a.inboxAt = Math.max(a.inboxAt ?? 0, now + (CODEX_QUEUE_MIN_MS + (hash32(`${agentId}:${text}:${now}`) % CODEX_QUEUE_SPREAD_MS)) / this.speed);
      return true;
    }
    this.activity(a, now, describeMessage(text));
    if (a.phase === 'idle') a.phaseUntil = Math.min(a.phaseUntil, now + this.ms(1_500, 3_000));
    return true;
  }

  /** Advances simulation to `now`. */
  tick(now: number): DemoTickResult {
    if (now >= this.nextSpawnAt) {
      const open = [...this.agents.values()].filter((a) => a.info.kind === 'main' && a.phase !== 'leaving').length;
      if (open < this.target) this.spawnSession(now, false);
      this.nextSpawnAt = now + this.ms(25_000, 70_000);
    }
    for (const a of [...this.agents.values()]) this.step(a, now);
    if (now >= this.nextGitHubAt) {
      this.nextGitHubAt = now + (35_000 + this.ghRng() * 45_000) / this.speed;
      this.gitHubEvent(now);
    }
    if (this.effects.prune(now)) this.dirty = true;
    this.gc(now);
    const changed = this.dirty;
    if (changed) this.rev++;
    this.dirty = false;
    const feed = this.pendingFeed;
    const notices = this.pendingNotices;
    this.pendingFeed = [];
    this.pendingNotices = [];
    return { changed, feed, notices };
  }

  snapshot(now = Date.now()): OfficeSnapshot {
    return {
      rev: this.rev,
      serverTime: now,
      rooms: [...this.rooms.values()].map((r) => {
        const effect = this.effects.get(r.id, now);
        return effect ? { ...r, effect: { ...effect } } : { ...r };
      }),
      agents: [...this.agents.values()].map((a) => structuredCloneAgent(a.info)),
      accounts: [
        ...this.accounts.map((acc) => {
          const u = this.usage.get(acc.id)!;
          return {
            ...acc,
            sessions: this.sessionsOf(acc.id),
            usage: {
              fiveHour: { utilization: Math.round(u.five), resetsAt: u.fiveReset },
              sevenDay: { utilization: Math.round(u.week), resetsAt: u.weekReset },
              source: 'statusline' as const,
              fetchedAt: now,
            },
            usageStatus: 'ok' as const,
          };
        }),
        this.codexAccountInfo(now),
      ],
      meta: { demo: true, sources: [], startedAt: this.startedAt, version: 'demo' },
    };
  }

  private sessionsOf(accountId: string): number {
    return [...this.agents.values()].filter((a) => a.info.kind === 'main' && a.info.account === accountId && a.info.status !== 'offline').length;
  }

  /**
   * Codex account: usage comes "from Codex files", read at last activity of its session (without running
   * session, numbers become stale); "no quota" = no windows, never 0%.
   */
  private codexAccountInfo(now: number): AccountInfo {
    const acc = this.codexAccount;
    const u = this.usage.get(acc.id)!;
    const fetchedAt = this.codexFetchedAt;
    const usage: AccountUsage = this.codexReadNoQuota
      ? { source: 'codex', noQuota: true, fetchedAt }
      : {
          fiveHour: { utilization: Math.round(u.five), resetsAt: u.fiveReset },
          sevenDay: { utilization: Math.round(u.week), resetsAt: u.weekReset },
          source: 'codex',
          fetchedAt,
        };
    return { ...acc, sessions: this.sessionsOf(acc.id), usage, usageStatus: now - fetchedAt > CODEX_STALE_MS ? 'stale' : 'ok' };
  }

  /** No quota right now: always (option) or in a recurring window of a few minutes. */
  private codexNoQuota(now: number): boolean {
    if (now >= this.noQuotaUntil) {
      this.noQuotaFrom = now + ((12 + this.codexRng() * 8) * MINUTE) / this.speed;
      this.noQuotaUntil = this.noQuotaFrom + ((2 + this.codexRng() * 2) * MINUTE) / this.speed;
    }
    return this.codexNoQuotaAlways || now >= this.noQuotaFrom;
  }

  // ---------------------------------------------------------------- permission requests (fictional)

  /**
   * Response to a fictional request from the office: approving, denying, or answering question resumes
   * work immediately; "answer in terminal" only removes request from office (agent keeps waiting
   * briefly). false = unknown request (already answered or another instance) or invalid answer
   * (questions can only be answered with answers validated as on server).
   */
  decidePermission(requestId: string, d: PermissionDecision, now = Date.now()): boolean {
    const a = [...this.agents.values()].find((x) => x.info.permission?.id === requestId);
    if (!a || a.phase !== 'waiting') return false;
    const p = a.info.permission!;
    // Codex (as on server): no answers, no "always allow" or interrupt, and denials require a reason.
    if (p.provider === 'codex' && (d.behavior === 'answer' || d.suggestion !== undefined || d.interrupt || (d.behavior === 'deny' && !d.message?.trim()))) return false;
    const ask = p.tool === ASK_TOOL;
    const answers = d.behavior === 'answer' && ask ? checkAnswers(p.questions ?? [], d.answers) : undefined;
    if ((d.behavior === 'answer' && !answers) || (d.behavior === 'allow' && ask)) return false;
    const title = p.title;
    delete a.info.permission;
    this.dirty = true;
    if (d.behavior === 'terminal') {
      a.phaseUntil = Math.min(a.phaseUntil, now + this.ms(3_000, 8_000));
      return true;
    }
    if (answers) {
      this.activity(a, now, { kind: 'other', icon: '💬', text: tr('Answered in Habblaud'), detail: answerSummary(p.questions ?? [], answers), tool: 'PermissionRequest' });
    } else if (d.behavior === 'allow') {
      this.activity(a, now, { kind: 'other', icon: '✅', text: d.suggestion !== undefined ? tr('Approved in Habblaud (always allow)') : tr('Approved in Habblaud'), detail: title, tool: 'PermissionRequest' });
    } else {
      this.activity(a, now, { kind: 'wait', icon: '🚫', text: tr('Denied in Habblaud'), detail: d.message ? `${title} — ${d.message}` : title, tool: 'PermissionRequest' });
    }
    this.resumeFromWaiting(a, now);
    return true;
  }

  /**
   * Forces a working main agent (or if none, idle or waiting on shell) to request permission
   * now (`kind` forces a permission or AskUserQuestion question; otherwise random). For tests
   * and screenshots; returns agent id. `provider` picks agent tool (default: Claude Code);
   * in Codex request is always an approval (does not ask questions via office).
   */
  forcePermission(now = Date.now(), kind?: DemoPermissionKind, provider: 'claude' | 'codex' = 'claude'): string | undefined {
    const mains = [...this.agents.values()].filter((a) => a.info.kind === 'main' && a.removeAt === undefined && (a.info.provider ?? 'claude') === provider);
    const a = mains.find((x) => x.phase === 'working') ?? mains.find((x) => x.phase === 'idle') ?? mains.find((x) => x.phase === 'shell');
    if (!a) return undefined;
    if (a.phase !== 'working') {
      a.phase = 'working';
      a.actionsLeft = 3;
      this.setStatus(a, 'working', now);
    }
    this.askPermission(a, now, kind);
    return a.info.id;
  }

  /** Stops mid-turn requesting permission or asking question (with fictional request to answer via office). */
  private askPermission(a: SimAgent, now: number, kind?: DemoPermissionKind): void {
    a.phase = 'waiting';
    // With answer card displayed, wait is longer (leaves time to click).
    a.phaseUntil = now + this.ms(25_000, 50_000);
    const id = `${this.prefix}perm-${this.tag}-${++this.seq}`;
    const codex = a.info.provider === 'codex';
    a.info.permission = codex ? demoCodexPermission(id, a.project, a.rng, now) : demoPermission(id, a.project, a.rng, now, kind);
    const reason = codex ? tr('approve a command') : a.info.permission.tool === ASK_TOOL ? tr('answer a question') : tr('approve a permission');
    a.info.waitingFor = reason;
    this.setStatus(a, 'waiting', now);
    this.activity(a, now, SPECIAL.waiting(reason));
    this.notice(now, 'alert', tr('✋ {0} needs you in {1}: {2}', [a.info.name, a.project.name, reason]), a.info.id, a.info.roomId);
  }

  private resumeFromWaiting(a: SimAgent, now: number): void {
    a.phase = 'working';
    a.info.waitingFor = undefined;
    delete a.info.permission;
    this.setStatus(a, 'working', now);
    a.nextActionAt = now + this.ms(800, 1_500);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- internals

  private ms(min: number, max: number): number {
    return (min + this.rng() * (max - min)) / this.speed;
  }

  private pick<T>(arr: readonly T[], rng = this.rng): T {
    return arr[Math.floor(rng() * arr.length)];
  }

  private usedNames(): Set<string> {
    return new Set([...this.agents.values()].map((a) => a.info.name));
  }

  private ensureRoom(project: DemoProject, now: number): RoomInfo {
    const id = `${this.prefix}${ROOT}/${project.name}`;
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const used = new Set([...this.rooms.values()].map((r) => r.slot));
    let slot = 0;
    while (used.has(slot) || now - (this.slotFreedAt.get(slot) ?? -Infinity) < SLOT_COOLDOWN_MS) slot++;
    const room: RoomInfo = { id, name: project.name, path: `${ROOT}/${project.name}`, slot, seed: hash32(id), createdAt: now };
    this.rooms.set(id, room);
    this.notice(now, 'info', tr('🏗️ New room: {0}', [project.name]), undefined, id);
    this.dirty = true;
    return room;
  }

  private spawnSession(now: number, warm: boolean): void {
    const k = this.mainsSpawned++;
    const activeRooms = new Set([...this.rooms.values()].map((r) => r.name));
    // 35% chance to reuse an existing room (2 sessions in same project).
    const reuse = activeRooms.size > 0 && this.rng() < 0.35;
    const candidates = PROJECTS.filter((p) => (reuse ? activeRooms.has(p.name) : !activeRooms.has(p.name)));
    let project = this.pick(candidates.length ? candidates : PROJECTS);
    // Startup: 2nd session is Codex and joins room of 1st (Claude Code and Codex sharing room). Room
    // draw still occurs (sequence of subsequent sessions remains unchanged); only result is swapped.
    const host = warm && k === 1 ? [...this.agents.values()].find((x) => x.info.kind === 'main') : undefined;
    if (host) project = host.project;
    const room = this.ensureRoom(project, now);
    const n = ++this.seq;
    const sessionId = `${this.prefix}sess-${this.tag}-${n}-${Math.floor(this.rng() * 1e9).toString(36)}`;
    const id = `${this.prefix || 'demo:'}${this.tag}-${n}`;
    // Codex: at startup, only 2nd; afterwards, ~30% of new sessions (via id hash, without spending RNG draw).
    const codex = !!host || (!warm && hash32(`codex:${sessionId}`) % 100 < CODEX_SHARE);
    const person = pickName(sessionId, this.usedNames());
    const rng = mulberry32(hash32(sessionId));
    const tasks: TaskItem[] = project.tasks
      .slice(0, 3 + Math.floor(rng() * 2))
      .map((title, i) => ({ id: String(i + 1), title, status: 'pending' }));
    const claudeAccount = this.rng() < 0.6 ? this.accounts[0].id : this.accounts[1].id;
    const info: AgentInfo = {
      id,
      kind: 'main',
      roomId: room.id,
      name: person.name,
      look: person.look,
      role: tr('Main agent'),
      title: this.pick(project.prompts, rng),
      sessionId,
      account: codex ? this.codexAccount.id : claudeAccount,
      status: 'idle',
      recent: [],
      tasks,
      model: this.pick(codex ? CODEX_MODELS : MODELS, rng),
      gitBranch: this.pick(['main', 'develop', 'feat/checkout', 'fix/webhooks'], rng),
      // Codex: approval policy (approval_policy) instead of Claude Code permission mode.
      permissionMode: codex ? 'on-request' : 'default',
      startedAt: now,
      lastEventAt: now,
      statusSince: now,
      // Codex does not record cost: tokens only.
      stats: codex
        ? { toolCalls: 0, tokensIn: 0, tokensOut: 0, linesAdded: 0, linesRemoved: 0, subagents: 0 }
        : { toolCalls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, linesAdded: 0, linesRemoved: 0, subagents: 0 },
      seed: hash32(id),
      // Fictional session "with message plugin" (in Codex, "with delivery agent"): allows sending messages via
      // office (receiveMessage).
      canMessage: true,
    };
    if (codex) info.provider = 'codex';
    const a: SimAgent = {
      info,
      project,
      rng,
      phase: 'idle',
      phaseUntil: now + (warm ? this.ms(0, 8_000) : this.ms(2_000, 5_000)),
      nextActionAt: now,
      actionsLeft: 0,
      children: [],
      closeAt: now + this.ms(150_000, 420_000),
      taskCursor: 0,
      shellEnds: new Map(),
      shelledThisTurn: false,
      foregroundThisTurn: false,
    };
    this.agents.set(id, a);
    const acc = this.accounts.find((x) => x.id === info.account);
    if (!warm) this.notice(now, 'info', tr('👋 {0} arrived in {1}{2}', [info.name, project.name, acc ? ` (${acc.name})` : '']), id, room.id);
    this.dirty = true;
  }

  private spawnSub(parent: SimAgent, now: number): void {
    const n = ++this.seq;
    const agentId = `a${Math.floor(this.rng() * 1e12).toString(16)}`;
    const id = `${parent.info.sessionId}:${agentId}`;
    const person = pickName(id, this.usedNames());
    const rng = mulberry32(hash32(id));
    const desc = this.pick(SUB_TASKS, rng);
    const info: AgentInfo = {
      id,
      kind: 'sub',
      parentId: parent.info.id,
      roomId: parent.info.roomId,
      name: person.name,
      look: person.look,
      role: this.pick(parent.info.provider === 'codex' ? CODEX_SUB_ROLES : SUB_TYPES, rng),
      title: desc,
      sessionId: parent.info.sessionId,
      account: parent.info.account,
      status: 'working',
      recent: [],
      tasks: [],
      model: parent.info.model,
      gitBranch: parent.info.gitBranch,
      startedAt: now,
      lastEventAt: now,
      statusSince: now,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: hash32(id),
      background: rng() < 0.3,
    };
    if (parent.info.provider === 'codex') info.provider = 'codex';
    const sub: SimAgent = {
      info,
      project: parent.project,
      rng,
      phase: 'working',
      phaseUntil: now + this.ms(18_000, 55_000),
      nextActionAt: now + this.ms(1_500, 3_000),
      actionsLeft: 99,
      children: [],
      closeAt: Infinity,
      taskCursor: n,
      shellEnds: new Map(),
      shelledThisTurn: true,
      foregroundThisTurn: true,
    };
    this.agents.set(id, sub);
    parent.children.push(id);
    parent.info.stats.subagents++;
    this.activity(sub, now, { kind: 'prompt', icon: '📨', text: tr('New task: “{0}”', [desc]), detail: desc });
    this.dirty = true;
  }

  private step(a: SimAgent, now: number): void {
    if (a.removeAt !== undefined) return;
    if (a.info.kind === 'sub') return this.stepSub(a, now);
    // Codex: queued messages arrive once session is idle (starting a turn shortly after).
    if (a.inbox?.length && a.phase === 'idle' && now >= (a.inboxAt ?? 0)) {
      for (const text of a.inbox.splice(0)) this.activity(a, now, describeMessage(text));
      a.phaseUntil = Math.min(a.phaseUntil, now + 1_500 / this.speed);
      a.closeAt = Math.max(a.closeAt, now + 30_000 / this.speed);
    }

    // Session termination (only while idle, like a user closing terminal).
    if (now >= a.closeAt && a.phase === 'idle') {
      a.phase = 'leaving';
      this.setStatus(a, 'offline', now);
      delete a.info.canMessage;
      a.removeAt = now + OFFLINE_GRACE_MS;
      this.notice(now, 'info', tr('🚪 {0} ended the session', [a.info.name]), a.info.id, a.info.roomId);
      return;
    }

    switch (a.phase) {
      case 'idle':
        if (now >= a.phaseUntil) {
          const prompt = this.pick(a.project.prompts, a.rng);
          a.info.title = prompt;
          a.phase = 'working';
          a.shelledThisTurn = false;
          a.foregroundThisTurn = false;
          a.actionsLeft = 5 + Math.floor(a.rng() * 9);
          a.nextActionAt = now + this.ms(1_200, 2_500);
          this.setStatus(a, 'working', now);
          this.activity(a, now, describePrompt(prompt));
          this.advanceTask(a, 'in_progress');
        }
        break;
      case 'waiting':
        // The "hook" gave up waiting (in Codex, within seconds): request leaves office and terminal takes over.
        if (a.info.permission && now >= a.info.permission.expiresAt) {
          delete a.info.permission;
          this.dirty = true;
        }
        if (now >= a.phaseUntil) {
          // Answered "in terminal": request disappears from office.
          this.resumeFromWaiting(a, now);
        }
        break;
      case 'delegating': {
        const pending = a.children.filter((c) => this.agents.get(c)?.info.status === 'working');
        if (pending.length === 0) {
          a.phase = 'working';
          a.children = [];
          this.activity(a, now, { kind: 'think', icon: '📥', text: tr("Gathering the team's results") });
          a.nextActionAt = now + this.ms(2_000, 4_000);
        }
        break;
      }
      case 'shell': {
        // Shell(s) finishing: notification wakes agent, which inspects result and works a bit more.
        const due = [...a.shellEnds].filter(([, e]) => e.at <= now).map(([id]) => id);
        if (!due.length) break;
        for (const id of due) this.finishShell(a, id, now);
        a.phase = 'working';
        a.actionsLeft = 1 + Math.floor(a.rng() * 3);
        a.nextActionAt = now + this.ms(2_000, 3_500);
        this.setStatus(a, 'working', now);
        break;
      }
      case 'working':
        if (now < a.nextActionAt) break;
        if (a.foregroundUntil !== undefined) this.endForeground(a);
        // Background shell finishing mid-turn: notification arrives and agent continues working.
        for (const [id, end] of [...a.shellEnds]) {
          if (end.at > now) continue;
          this.finishShell(a, id, now);
          a.actionsLeft = Math.max(a.actionsLeft, 1);
          a.nextActionAt = now + this.ms(2_000, 3_500);
        }
        if (now < a.nextActionAt) break;
        if (a.actionsLeft <= 0) {
          // Background shell still running (spawned earlier): resume waiting for it.
          if (a.shellEnds.size) {
            this.waitForShells(a, now, false);
            break;
          }
          if (!a.shelledThisTurn && a.rng() < SHELL_CHANCE) {
            this.startBackgroundShells(a, now, false);
            break;
          }
          a.phase = 'idle';
          a.phaseUntil = now + this.ms(20_000, 75_000);
          this.advanceTask(a, 'completed');
          this.activity(a, now, SPECIAL.turnDone(this.ms(40_000, 240_000) * this.speed));
          this.setStatus(a, 'idle', now);
          this.notice(now, 'success', tr('✅ {0} finished in {1}', [a.info.name, a.project.name]), a.info.id, a.info.roomId);
          break;
        }
        a.actionsLeft--;
        {
          const roll = a.rng();
          if (roll < 0.1) {
            this.askPermission(a, now);
          } else if (roll < 0.2 && a.children.length === 0) {
            const count = 2 + Math.floor(a.rng() * 3);
            this.activity(a, now, describeTool('Agent', { description: tr('{0} workstreams in parallel', [count]), subagent_type: 'general-purpose' }));
            for (let i = 0; i < count; i++) this.spawnSub(a, now);
            a.phase = 'delegating';
          } else if (roll < 0.2 + FOREGROUND_CHANCE && !a.foregroundThisTurn && a.actionsLeft > 0) {
            this.startForeground(a, now);
          } else {
            this.activity(a, now, this.randomTool(a));
            a.nextActionAt = now + this.ms(1_800, 5_500);
          }
        }
        break;
      case 'leaving':
        break;
    }
  }

  private stepSub(a: SimAgent, now: number): void {
    if (a.info.status !== 'working') return;
    if (now >= a.phaseUntil) {
      this.activity(a, now, SPECIAL.turnDone(now - a.info.startedAt));
      this.setStatus(a, 'done', now);
      a.removeAt = now + DONE_GRACE_MS;
      const parent = a.info.parentId ? this.agents.get(a.info.parentId) : undefined;
      this.notice(now, 'success', tr('📦 {0} delivered “{1}” to {2}', [a.info.name, a.info.title, parent?.info.name ?? tr('the agent')]), a.info.id, a.info.roomId);
      return;
    }
    if (now >= a.nextActionAt) {
      this.activity(a, now, this.randomTool(a));
      a.nextActionAt = now + this.ms(1_500, 4_500);
    }
  }

  // ---------------------------------------------------------------- shells

  /**
   * Leaves 1 (or 2) commands running in background and finishes turn waiting for them ('shell' status).
   * `warm` = office startup: shell has already been running for a while and no notice is posted.
   */
  private startBackgroundShells(a: SimAgent, now: number, warm: boolean): void {
    const count = a.rng() < 0.25 ? 2 : 1;
    const specs = BACKGROUND_JOBS.slice();
    const jobs: ShellJob[] = [];
    if (warm) {
      a.info.title = this.pick(a.project.prompts, a.rng);
      this.activity(a, now, describePrompt(a.info.title));
    }
    const base = warm ? now - this.ms(20_000, 150_000) : now;
    for (let i = 0; i < count; i++) {
      const spec = specs.splice(Math.floor(a.rng() * specs.length), 1)[0];
      const d = describeShellJob('Bash', spec);
      const id = `b${Math.floor(this.rng() * 2 ** 40).toString(36)}`;
      // One tool_use after another: first is oldest (determines wait duration).
      const job: ShellJob = { id, label: d.label, startedAt: base - (count - 1 - i) * 1_200, background: true, kind: 'shell' };
      if (d.command) job.command = d.command;
      jobs.push(job);
      a.shellEnds.set(id, { at: now + this.ms(40_000, 150_000), outcome: a.rng() < SHELL_FAIL_CHANCE ? 'failed' : 'ok' });
      this.activity(a, now, describeTool('Bash', { ...spec, run_in_background: true }));
    }
    a.info.shells = [...(a.info.shells ?? []), ...jobs].sort(byStart);
    a.shelledThisTurn = true;
    if (!warm) this.advanceTask(a, 'completed');
    this.waitForShells(a, now, !warm);
  }

  /** End of turn with running background shell(s): waits at the desk. */
  private waitForShells(a: SimAgent, now: number, notify: boolean): void {
    const jobs = (a.info.shells ?? []).filter((j) => j.background);
    const main = jobs[0];
    a.phase = 'shell';
    this.setStatus(a, 'shell', now);
    this.activity(a, now, SPECIAL.waitingShell(main?.label, jobs.length, main?.command));
    if (notify && main) this.notice(now, 'info', tr('⏳ {0} is waiting on the shell in {1}: {2}', [a.info.name, a.project.name, main.label]), a.info.id, a.info.roomId);
  }

  /** A background shell finished: 'ShellDone' activity (world celebrates or laments) and notice. */
  private finishShell(a: SimAgent, id: string, now: number): void {
    const end = a.shellEnds.get(id);
    a.shellEnds.delete(id);
    const job = a.info.shells?.find((j) => j.id === id);
    this.setShells(a, (a.info.shells ?? []).filter((j) => j.id !== id));
    if (!job || !end) return;
    this.activity(a, now, SPECIAL.shellDone(job.label, end.outcome, now - job.startedAt, job.command));
    if (end.outcome === 'ok') this.notice(now, 'success', tr('✅ {0}: shell finished in {1} — {2}', [a.info.name, a.project.name, job.label]), a.info.id, a.info.roomId);
    else this.notice(now, 'warn', tr('❌ {0}: shell failed in {1} — {2}', [a.info.name, a.project.name, job.label]), a.info.id, a.info.roomId);
  }

  /**
   * Fictional GitHub event (opened/merged PR, CI, release) on an active or idle main agent:
   * activity, notice, and celebration/alarm in room. Room with alarm tends to see CI pass again.
   */
  private gitHubEvent(now: number): void {
    const mains = [...this.agents.values()].filter((a) => a.info.kind === 'main' && (a.phase === 'working' || a.phase === 'idle'));
    if (!mains.length) return;
    const alarmed = mains.filter((a) => this.effects.get(a.info.roomId, now)?.kind === 'alarm');
    const pool = alarmed.length && this.ghRng() < 0.6 ? alarmed : mains;
    const a = pool[Math.floor(this.ghRng() * pool.length)];
    const alarm = this.effects.get(a.info.roomId, now)?.kind === 'alarm';
    const ev = demoGitHubEvent(this.ghRng, { branch: a.info.gitBranch, alarm, pr: this.prSeq });
    if (ev.kind === 'pr_opened') this.prSeq++;
    const d = describeGitHubEvent(ev, a.info.name, a.project.name);
    this.activity(a, now, d.activity);
    this.notice(now, d.level, d.notice, a.info.id, a.info.roomId);
    if (this.effects.apply(a.info.roomId, ev, now, a.info.id)) this.dirty = true;
  }

  /** Long foreground command: agent stays idle waiting for result (status remains 'working'). */
  private startForeground(a: SimAgent, now: number): void {
    const spec = this.pick(FOREGROUND_JOBS, a.rng);
    const d = describeShellJob('Bash', spec);
    const job: ShellJob = { id: `toolu_demo_${this.tag}_${++this.seq}`, label: d.label, startedAt: now, background: false, kind: 'shell' };
    if (d.command) job.command = d.command;
    this.setShells(a, [...(a.info.shells ?? []), job]);
    a.foregroundThisTurn = true;
    a.foregroundUntil = now + this.ms(15_000, 40_000);
    a.nextActionAt = a.foregroundUntil;
    this.activity(a, now, describeTool('Bash', spec));
  }

  /** Foreground command returned its result. */
  private endForeground(a: SimAgent): void {
    a.foregroundUntil = undefined;
    this.setShells(a, (a.info.shells ?? []).filter((j) => j.background));
  }

  private setShells(a: SimAgent, jobs: ShellJob[]): void {
    if (jobs.length) a.info.shells = jobs.sort(byStart);
    else delete a.info.shells;
    this.dirty = true;
  }

  private randomTool(a: SimAgent): ActivityDescription {
    const p = a.project;
    const r = a.rng();
    const file = this.pick(p.files, a.rng);
    if (r < 0.26) return describeTool('Read', { file_path: `${ROOT}/${p.name}/${file}` });
    if (r < 0.44) return describeTool('Edit', { file_path: `${ROOT}/${p.name}/${file}` });
    if (r < 0.5) return describeTool('Write', { file_path: `${ROOT}/${p.name}/${file}` });
    if (r < 0.62) return describeTool('Grep', { pattern: this.pick(p.greps, a.rng) });
    if (r < 0.66) return describeTool('Glob', { pattern: '**/*.ts' });
    if (r < 0.82) return describeTool('Bash', { command: this.pick(p.commands, a.rng) });
    if (r < 0.88) return describeTool('WebSearch', { query: this.pick(p.queries, a.rng) });
    if (r < 0.91) return describeTool('WebFetch', { url: 'https://developer.mozilla.org/pt-BR/docs/Web' });
    if (r < 0.95) return SPECIAL.think();
    return describeTool('TodoWrite', { todos: a.info.tasks.map((t) => ({ status: t.status })) });
  }

  private advanceTask(a: SimAgent, status: 'in_progress' | 'completed'): void {
    const tasks = a.info.tasks;
    if (!tasks.length) return;
    if (status === 'in_progress') {
      const next = tasks.find((t) => t.status === 'pending');
      if (next && !tasks.some((t) => t.status === 'in_progress')) next.status = 'in_progress';
    } else {
      const cur = tasks.find((t) => t.status === 'in_progress');
      if (cur) cur.status = 'completed';
    }
    this.dirty = true;
  }

  private setStatus(a: SimAgent, status: AgentInfo['status'], now: number): void {
    if (a.info.status !== status) {
      a.info.status = status;
      a.info.statusSince = now;
      this.dirty = true;
    }
  }

  private activity(a: SimAgent, now: number, d: ActivityDescription & { tool?: string; error?: boolean }): void {
    const act: Activity = { id: `${this.prefix}${this.tag}-a${++this.seq}`, at: now, ...d };
    a.info.activity = act;
    a.info.recent = [...a.info.recent, act].slice(-30);
    a.info.lastEventAt = now;
    const synthetic = d.tool === SHELL_DONE_TOOL || d.tool === SHELL_WAIT_TOOL || d.tool === GITHUB_TOOL || d.tool === MESSAGE_TOOL;
    if (!synthetic && d.kind !== 'prompt' && d.kind !== 'done' && d.kind !== 'wait' && d.kind !== 'think') {
      a.info.stats.toolCalls++;
    }
    // Codex: each session activity refreshes usage read (when files receive rate_limits).
    if (a.info.provider === 'codex') {
      this.codexFetchedAt = now;
      this.codexReadNoQuota = this.codexNoQuota(now);
    }
    const u = this.usage.get(a.info.account);
    if (u) {
      if (now > u.fiveReset) Object.assign(u, { five: 0, fiveReset: now + 5 * HOUR });
      u.five = Math.min(100, u.five + 0.01 + a.rng() * 0.02);
      u.week = Math.min(100, u.week + 0.001 + a.rng() * 0.002);
    }
    a.info.stats.tokensIn += Math.floor(2_000 + a.rng() * 12_000);
    a.info.stats.tokensOut += Math.floor(80 + a.rng() * 900);
    if (a.info.stats.costUSD !== undefined) a.info.stats.costUSD = +(a.info.stats.costUSD + a.rng() * 0.04).toFixed(4);
    if (d.kind === 'edit' || d.kind === 'write') {
      a.info.stats.linesAdded = (a.info.stats.linesAdded ?? 0) + Math.floor(a.rng() * 40);
      a.info.stats.linesRemoved = (a.info.stats.linesRemoved ?? 0) + Math.floor(a.rng() * 15);
    }
    const room = this.rooms.get(a.info.roomId);
    this.pendingFeed.push({
      id: act.id,
      agentId: a.info.id,
      roomId: a.info.roomId,
      agentName: a.info.name,
      roomName: room?.name ?? '',
      account: a.info.account,
      activity: act,
    });
    this.dirty = true;
  }

  private notice(now: number, level: Notice['level'], text: string, agentId?: string, roomId?: string): void {
    const n: Notice = { id: `${this.prefix}${this.tag}-n${++this.seq}`, level, text, at: now };
    if (agentId) n.agentId = agentId;
    if (roomId) n.roomId = roomId;
    this.pendingNotices.push(n);
  }

  private gc(now: number): void {
    for (const [id, a] of this.agents) {
      if (a.removeAt !== undefined && now >= a.removeAt) {
        this.agents.delete(id);
        this.dirty = true;
      }
    }
    const occupied = new Set([...this.agents.values()].map((a) => a.info.roomId));
    for (const [id, room] of this.rooms) {
      if (!occupied.has(id)) {
        this.rooms.delete(id);
        this.slotFreedAt.set(room.slot, now);
        this.dirty = true;
      }
    }
  }
}

const byStart = (x: ShellJob, y: ShellJob) => x.startedAt - y.startedAt || x.id.localeCompare(y.id);

function structuredCloneAgent(a: AgentInfo): AgentInfo {
  const c: AgentInfo = {
    ...a,
    recent: a.recent.slice(),
    tasks: a.tasks.map((t) => ({ ...t })),
    stats: { ...a.stats },
    activity: a.activity ? { ...a.activity } : undefined,
  };
  if (a.shells) c.shells = a.shells.map((j) => ({ ...j }));
  if (a.permission) {
    c.permission = { ...a.permission, suggestions: a.permission.suggestions?.map((s) => ({ ...s, rules: s.rules.slice() })) };
    if (a.permission.questions) c.permission.questions = a.permission.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) }));
  }
  return c;
}
