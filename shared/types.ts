// Protocol shared between the server (Node) and the client (browser).
// Pure code: no Node or DOM APIs.
//
// Evolution rule: changes here must be ADDITIVE (new optional fields).
// Renaming/removing fields breaks server, world, and UI simultaneously.

import type { OfficeRules, RuleViolation } from './rules';
import type { AppearanceParts } from './appearance';
import type { WorldMeta } from './world/api';

export type AgentKind = 'main' | 'sub';

/**
 * Which tool the agent (or account, source, session, request) comes from. In protocol types the `provider`
 * field is optional and ABSENT means 'claude' (everything prior to Codex remains unchanged).
 * - claude: Claude Code;
 * - codex: OpenAI Codex (`codex` CLI and desktop app, both writing to the same CODEX_HOME).
 */
export type Provider = 'claude' | 'codex' | 'agy';

/**
 * High-level state of an agent — drives character behavior.
 * - working: processing a turn (busy). Sits at desk typing.
 * - waiting: needs the user (permission, question, dialog). Sits at desk with hand raised.
 * - idle: turn finished, waiting for next instruction. Walks around office (coffee, water cooler...).
 * - shell: turn finished, but shell(s) running in background (see `shells`); waiting for shell
 *   to finish. Sits at desk watching terminal. (Claude Code records "shell" when session is idle
 *   with background shells.)
 * - done: subagent completed. Delivers result to main agent and leaves.
 * - offline: session closed. Leaves (if last in room, turns off the lights).
 */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'shell' | 'done' | 'offline';

/** A shell command the agent is waiting to finish. */
export interface ShellJob {
  /** Background task ID (e.g.: "bo0ov3q3l") or foreground tool_use ID. */
  id: string;
  /** Short text: Bash description or command summary (secrets masked). */
  label: string;
  /** Full command (masked, up to ~300 characters), if any. */
  command?: string;
  /** Epoch ms when command started. */
  startedAt: number;
  /** true = run_in_background (agent finished turn and waits for notification); false = foreground pending result. */
  background: boolean;
  /** 'monitor' = Monitor tool (tracks a process); 'shell' = Bash. */
  kind: 'shell' | 'monitor';
}

export type ActivityKind =
  | 'prompt' // received new user instruction
  | 'think' // thinking (thinking block)
  | 'respond' // writing text response
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'run' // terminal command
  | 'test'
  | 'git'
  | 'web'
  | 'browser'
  | 'plan' // tasks / planning
  | 'delegate' // spawned subagent(s)
  | 'communicate' // message to another agent / notice
  | 'ask' // question to user
  | 'mcp'
  | 'skill'
  | 'wait'
  | 'error'
  | 'compact' // context compaction
  | 'done' // finished turn
  | 'other';

export interface Activity {
  /** Unique per activity (e.g.: entry uuid + block index). */
  id: string;
  kind: ActivityKind;
  /** Emoji representing the activity. */
  icon: string;
  /** Short text (up to ~46 characters). E.g.: "Editing App.tsx". */
  text: string;
  /** Optional detail (full command, path, query...), up to ~300 characters. */
  detail?: string;
  /** Raw tool name, if any. */
  tool?: string;
  /** Epoch ms. */
  at: number;
  durationMs?: number;
  error?: boolean;
  /** Full questions from AskUserQuestion (kind 'ask'), for office to display options. */
  questions?: AskQuestion[];
}

/**
 * An AskUserQuestion question, masked and trimmed. With office request (PermissionRequestInfo.questions),
 * can be answered there; otherwise answer is given in Claude Code.
 */
export interface AskQuestion {
  /** Question position in `tool_input.questions` (invalid entries skipped, so there may be gaps). */
  index: number;
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** `index` = option position in original `options`: returned in answer (PermissionAnswer). */
  options: Array<{ index: number; label: string; description?: string }>;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  /** Gerund form ("Writing tests"), when available. */
  activeForm?: string;
}

export interface AgentStats {
  toolCalls: number;
  /** input + cache read + cache creation. */
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** Total subagents spawned by this agent. */
  subagents: number;
  /** Context in use: input + cache read + cache creation of the latest assistant message (shared/overload.ts). */
  contextTokens?: number;
  /** Times the session was compacted. */
  compacts?: number;
}

/** Achievement of an Antigravity worker (server/sources/agy/progress.ts). */
export interface WorkerBadge {
  id: string;
  icon: string;
  name: string;
  desc: string;
  /** When earned (epoch ms). */
  at: number;
}

/** Level and achievements of an Antigravity worker, extracted from agy-ask logs. */
export interface WorkerProgress {
  level: number;
  /** Rank by level ("Intern", "Junior"...). */
  rank: string;
  xp: number;
  /** XP at start of current level and next level (bar runs from one to the other). */
  levelXp: number;
  nextXp: number;
  /** Completed jobs. */
  jobs: number;
  badges: WorkerBadge[];
}

/** A hung worker: its job shows no progress ('stalled'), or its agy is alive with no job ('no-job'). */
export interface AgentGhost {
  reason: 'stalled' | 'no-job';
  /** Last sign of life (epoch ms). */
  since: number;
  pid?: number;
}

export interface AgentInfo {
  /**
   * Stable while agent exists. Claude Code: main "<account>:<pid>", sub "<sessionId>:<agentId>".
   * Codex: main and sub "<account>:<threadId>" (sub with `parentId`).
   */
  id: string;
  /** The office (OfficeInfo.id) whose building this character is drawn in; absent = the first office's building. */
  office?: string;
  kind: AgentKind;
  /** Agent tool; absent = 'claude'. */
  provider?: Provider;
  /** For subagents: id of the agent that spawned it. */
  parentId?: string;
  roomId: string;
  /** Unique human name in the office. E.g.: "Marina". */
  name: string;
  /** Name presentation hint (used by art to vary look). */
  look: 'f' | 'm';
  /** Role. Main: "Main agent". Sub: subagent type ("Explore", "Plan", "fork"...). */
  role: string;
  /** Session title (main) or task description (sub). */
  title?: string;
  sessionId: string;
  /** Source account = AccountInfo.id (config dir basename, e.g.: ".claude", ".claude-account2"). */
  account: string;
  status: AgentStatus;
  /** Reason when status === 'waiting'. E.g.: "approve permission". */
  waitingFor?: string;
  /** Current (or most recent) activity. */
  activity?: Activity;
  /** Recent activities, oldest to newest (max ~30). */
  recent: Activity[];
  tasks: TaskItem[];
  /** Running shells the agent waits for: background ones and foreground command still pending result. */
  shells?: ShellJob[];
  model?: string;
  /**
   * Context window of the session's model in tokens, as Claude Code's status line reports it (sent by the Habblaud
   * mod); missing without the mod, then shared/overload.ts guesses it from `model`.
   */
  contextWindow?: number;
  /** Reasoning effort in use: Claude Code from the transcript, Antigravity from the agy log. */
  effort?: string;
  gitBranch?: string;
  permissionMode?: string;
  startedAt: number;
  lastEventAt: number;
  /** When status last changed (epoch ms). */
  statusSince: number;
  stats: AgentStats;
  /** 32-bit seed for deterministic character appearance. */
  seed: number;
  /** Parts chosen in character editor, applied over `seed` appearance (see shared/appearance.ts). */
  parts?: AppearanceParts;
  /** Uses character chosen for project (the room): panel offers "Reset to random". */
  custom?: true;
  /** Subagent running in background. */
  background?: boolean;
  /**
   * Permission request answerable via Habblaud (hook PermissionRequest; oldest if multiple).
   * While active, agent appears as 'waiting'. See PermissionRequestInfo.
   */
  permission?: PermissionRequestInfo;
  /**
   * Can send message to this agent via Habblaud (main agents only): session has habblaud-mensagens plugin
   * and checked inbox recently. See POST /api/messages.
   */
  canMessage?: boolean;
  /** Antigravity worker: level, XP, and achievements (provider 'agy' only). */
  progress?: WorkerProgress;
  /** Antigravity worker: mode and effort for jobs that do not say (~/.agy_profiles/defaults.json). */
  agyDefaults?: { mode?: string; effort?: string };
  /** The worker looks hung: drawn as a faint ghost on its seat (server/workers/ghosts.ts). Nothing is stopped by it. */
  ghost?: AgentGhost;
  /** The boss: Claude Code requesting work from Antigravity workers (crown, BOSS badge, and suit). */
  boss?: boolean;
}

export interface RoomInfo {
  /** Stable key: normalized project cwd. */
  id: string;
  /** The office (OfficeInfo.id) whose building holds this room; absent = the first office's building. */
  office?: string;
  /** Display name (cwd basename, disambiguated if repeated). */
  name: string;
  /** Full project path. */
  path: string;
  /**
   * Room arrival order, assigned by server and stable while room exists (freed slot reused only after
   * a cooldown). Client uses only for ordering: in building, each room takes first free slot and when a
   * slot frees up between rooms, the farthest moves into it (client/src/world/sim/sim.ts, compact).
   * Client slot: column = floor(slot / 2); even = north side of hallway, odd = south side.
   */
  slot: number;
  /** Seed for deterministic colors/decoration. */
  seed: number;
  createdAt: number;
  /** Temporary visual effect in room (GitHub events detected in transcripts; see shared/github.ts). */
  effect?: RoomEffect;
  /** Antigravity workers room job board (server/sources/agy/source.ts). */
  board?: JobBoard;
  /** "Next steps" of the project's HANDOFF*.md (Board › Tasks; server/sources/handoff.ts). */
  plan?: HandoffPlan;
}

/** A job on the board: who does it, role, request, and status. */
export interface JobBoardItem {
  /** Unique (worker + agy PID). */
  id: string;
  agentId: string;
  worker: string;
  role?: string;
  /** Request prefix (up to ~140 characters). */
  text: string;
  status: 'working' | 'done' | 'failed' | 'cancelled';
  /** Who requested: boss (Claude), you (office), or a script. */
  by: 'boss' | 'you' | 'script';
  at: number;
  endedAt?: number;
  tokens?: number;
  /** Of `tokens` when the worker reports them: served from the prompt cache, and written to it. */
  cacheRead?: number;
  cacheWrite?: number;
  /** WorkerJob.id when the job ran through the worker's terminal (server/workers): it can be cancelled. */
  job?: string;
  /** Worker id (TeamInfo.workers) of that job. */
  workerId?: string;
  /** OfficeInfo.id of the office that gave it (absent = before offices, or a script). */
  office?: string;
}

/** The board: last order given to boss and recent jobs (newest first). */
export interface JobBoard {
  order?: { text: string; at: number; boss: string };
  items: JobBoardItem[];
}

/** The "next steps" section of a project's handoff file (server/sources/handoff.ts). */
export interface HandoffPlan {
  /** File name, relative to the room folder ("HANDOFF.md"). */
  file: string;
  mtime: number;
  /** Section heading, without a trailing "(...)". */
  heading: string;
  items: Array<{ text: string; done?: true }>;
}

/** Something that happened today (Board › News; server/news.ts). Stable `id`: re-reading a source gives the same. */
export interface NewsItem {
  id: string;
  at: number;
  kind: 'done' | 'failed' | 'quota' | 'level' | 'badge' | 'commit' | 'rule' | 'ghost';
  icon: string;
  text: string;
  detail?: string;
  roomId?: string;
}

/**
 * Temporary effect in a project room, triggered by a live GitHub event:
 * - party: celebration (PR opened or merged, release, green CI after alarm); lasts ~12 s;
 * - alarm: red CI; lasts until green CI in that room or expires in ~10 min.
 */
export interface RoomEffect {
  kind: 'party' | 'alarm';
  /** Short banner text. E.g.: "PR #12 merged!", "CI failed (feat/x)". */
  text: string;
  /** Start (epoch ms, server clock): a new effect has a different `at`. */
  at: number;
  /** Scheduled end (epoch ms, server clock). */
  until: number;
  /** Responsible agent: opener/merger (party) or observer of CI failure (alarm, "!" bubble). */
  agentId?: string;
}

/**
 * Update check: server checks the latest GitHub repository release (server/updates/checker.ts)
 * and compares it to current version.
 */
export interface UpdateStatus {
  /**
   * - off: check disabled (HABBLAUD_UPDATE_CHECK=0 or package.json without GitHub repository);
   * - pending: not checked yet;
   * - ok: checked (with or without published release);
   * - error: last attempt failed (no internet, GitHub rate limit...).
   */
  state: 'off' | 'pending' | 'ok' | 'error';
  /** Checked repository, "owner/name". */
  repo?: string;
  /** Last successful check (epoch ms). */
  checkedAt?: number;
  /** Latest release version, without "v" (absent: no published release). */
  latest?: string;
  /** Latest release page on GitHub. */
  url?: string;
  /** Latest release publication (epoch ms). */
  publishedAt?: number;
  /** Latest release is newer than current version. */
  available: boolean;
  /** Failure reason (state "error"). */
  error?: string;
}

export interface SourceInfo {
  /** Account label (config dir basename). */
  label: string;
  /** Source tool; absent = 'claude'. */
  provider?: Provider;
  path: string;
  /** Open sessions detected in this source. */
  sessions: number;
  ok: boolean;
  error?: string;
}

/** Plan usage limit window (e.g.: 5h session, weekly). */
export interface UsageWindow {
  /** Percentage used, 0–100. */
  utilization: number;
  /** When window resets (epoch ms). */
  resetsAt?: number;
}

export interface AccountUsage {
  /** 5-hour session. */
  fiveHour?: UsageWindow;
  /** Weekly limit (all models). */
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  /**
   * Numbers origin (all are local files written by the tool itself):
   * - 'statusline': captured live and written to ~/.habblaud/usage/<account>.json by Habblaud mod
   *   (mod/habblaud, recommended) or scripts/statusline-tap.mjs (statusline rate_limits field);
   * - 'cache': `cachedUsageUtilization` written by Claude Code itself (updates when someone runs /usage);
   * - 'codex': `rate_limits` from Codex session files (only renews while a session runs);
   * - 'agy': Antigravity CLI `/usage`, run periodically by its source (local command, no model).
   */
  source: 'cache' | 'statusline' | 'codex' | 'agy';
  /** Who wrote live file ('statusline'): Habblaud mod in Claude Code or statusline tap. */
  via?: 'mod' | 'tap';
  /**
   * Account without quota or credits to use right now (Codex: `rate_limits.primary` null, e.g.: exhausted
   * workspace credits). Not "0% used": windows are absent.
   */
  noQuota?: boolean;
  /** The plan has no 5-hour window, only the weekly one (Antigravity account without Pro). */
  noFiveHour?: boolean;
  /** When numbers were fetched at origin (epoch ms). */
  fetchedAt: number;
}

/** A Claude account (a config dir: ~/.claude, ~/.claude-account2, ...) or Codex (a CODEX_HOME: ~/.codex). */
export interface AccountInfo {
  /** = AgentInfo.account (config dir basename, e.g.: ".claude"); unique across accounts of all tools. */
  id: string;
  /** Account tool; absent = 'claude'. */
  provider?: Provider;
  /** Very short label (1–3 characters), e.g.: "C" and "D" — shell shortcuts detected — or derived. */
  short: string;
  /** Friendly name. E.g.: "Account C". */
  name: string;
  email?: string;
  organization?: string;
  /** Plan, when known (e.g.: "Max", "Pro"). */
  plan?: string;
  /** Account identification color (hex). */
  color: string;
  configDir: string;
  /** Sessions currently open in this account. */
  sessions: number;
  usage?: AccountUsage;
  /**
   * - ok: recent numbers;
   * - stale: old numbers (e.g.: /usage cache from hours ago);
   * - disabled: no numbers (statusline tap not installed and no /usage cache).
   */
  usageStatus: 'ok' | 'stale' | 'disabled';
}

/** The team (server/team.ts, ~/.agy_profiles/team.json): who may give jobs and who gets them. */
/**
 * Worker id: an Antigravity profile ("acc2", agy-ask) or a Claude Code account ("claude:<AccountInfo.id>", e.g.
 * "claude:.claude-work", claude-ask; its config dir is ~/<id>).
 */
export type WorkerId = string;
export type WorkerKind = 'agy' | 'claude';

/** A job given to a worker through its terminal (server/workers): one fresh conversation per job. */
export interface WorkerJob {
  id: string;
  worker: WorkerId;
  /** OfficeInfo.id of the office that gave it (the caller's boss, or the office selected on the page). */
  office?: string;
  /** The request, first ~300 characters, secrets masked. */
  prompt: string;
  role?: string;
  mode?: string;
  effort?: string;
  by: 'boss' | 'you' | 'script';
  /**
   * queued: waiting for the worker; working: running in its terminal; done/failed/cancelled: over.
   */
  status: 'queued' | 'working' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  /** Final answer only (never the screen), up to the caller's limit. */
  answer?: string;
  error?: string;
  tokens?: number;
}

/** A registered worker's terminal session (server/workers). */
export interface WorkerSession {
  worker: WorkerId;
  kind: WorkerKind;
  /** Its character in the first office that has it (stable while it is a worker). */
  agentId: string;
  /**
   * Its character in each office that has it (OfficeInfo.id -> AgentInfo.id): one character per office (named "… (2)",
   * "… (3)" after the first), all sharing the account's usage; a job shows on the character of the office that gave it.
   */
  agentIds?: Record<string, string>;
  /** AccountInfo.id. */
  account: string;
  /** Its terminal (PtyInfo.id), while running. */
  ptyId?: string;
  /** The current job (WorkerJob.id), if any. */
  job?: string;
}

/**
 * An office: one team working in ONE project folder (unique per office): its boss, its workers, its to-do list (the
 * HANDOFF file of the folder) and its jobs. Workers may belong to several offices (jobs go through agy-ask /
 * claude-ask, a busy worker answers BUSY); a boss belongs to one office (an Antigravity boss account to one only).
 */
export interface OfficeInfo {
  id: string;
  name: string;
  /** Absolute project folder; '' = not declared yet (an office carried over from the old team file). */
  folder: string;
  /** Room of the folder (RoomInfo.id), while someone works there. */
  roomId?: string;
  /** The workers' room of this office's building (RoomInfo.id). */
  workersRoomId?: string;
  workers: WorkerId[];
  /** The boss's account (AccountInfo.id); absent = no boss. */
  bossAccount?: string;
  bossKind?: WorkerKind;
  /** The boss's character (AgentInfo.id), while it is open. */
  bossAgentId?: string;
  /** Agent id of a boss opened from the office ("＋ Boss") that has not shown up yet. */
  pendingBoss?: string;
  /** The appointed boss's name, when its session is closed (the crown and the CLI rule wait for it). */
  waitingBoss?: string;
  /** The office rules ("Nội quy", shared/rules.ts); absent = an older server. */
  rules?: OfficeRules;
  /** Its refusals of the last days (newest first, at most 50; shared/rules.ts RuleViolation). */
  violations?: RuleViolation[];
  /** "Next steps" of the HANDOFF file in its folder, read even while nobody works there (no room yet). */
  plan?: HandoffPlan;
}

export interface TeamInfo {
  /** Every office, in creation order (the first one = the old single team). */
  offices?: OfficeInfo[];
  /** @deprecated the first office's workers (before offices); use offices[]. */
  workers: WorkerId[];
  /** Every logged-in Antigravity profile, registered or not: its profile name and account id (AccountInfo.id). */
  agy: Array<{ acc: string; account: string }>;
  /** Every Claude Code account that can be a worker: its WorkerId ("claude:<id>") and account id. */
  claude?: Array<{ worker: WorkerId; account: string }>;
  /** The boss's account (AccountInfo.id): it cannot be a worker; absent = no boss. */
  bossAccount?: string;
  /** The boss's kind ('claude' session or 'agy' terminal). */
  bossKind?: WorkerKind;
  /** Agent id of a boss opened from the office ("＋ Boss") that has not shown up yet. */
  pendingBoss?: string;
  /** The appointed boss's name, when its session is closed: the crown waits for it, and agy-ask still refuses others. */
  waitingBoss?: string;
  /** Terminal sessions of the registered workers (server/workers). */
  sessions?: WorkerSession[];
  /** Recent terminal jobs, newest first (up to ~30). */
  jobs?: WorkerJob[];
}

export interface OfficeSnapshot {
  /** Increments on each change. */
  rev: number;
  serverTime: number;
  rooms: RoomInfo[];
  agents: AgentInfo[];
  /** Interactive terminals opened by Habblaud (Claude Code running inside the browser). */
  ptys?: PtyInfo[];
  /** Today's news, newest first (Board › News; server/board.ts). */
  news?: NewsItem[];
  /** The team: registered workers (absent = no team service, e.g. demo). */
  team?: TeamInfo;
  /** Detected Claude accounts (with 5h/weekly usage when available). */
  accounts: AccountInfo[];
  meta: {
    demo: boolean;
    sources: SourceInfo[];
    startedAt: number;
    version: string;
    /**
     * Build identifier of client being served by server (bundle name, e.g.: "main-BFqheOCa").
     * A page opened with another build is outdated and should reload. Absent in dev mode.
     */
    build?: string;
    /**
     * Terminal (GET /api/agents/:id/terminal) available: only when Habblaud is not exposed
     * beyond localhost (local bind). Absent/false = feature disabled.
     */
    terminal?: boolean;
    /**
     * Messages via office enabled (POST /api/messages): same terminal guard and HABBLAUD_MENSAGENS not
     * disabled. Recipient currently indicated by AgentInfo.canMessage. Absent/false = feature disabled.
     */
    messages?: boolean;
    /**
     * Interactive terminal (open/take over sessions and exit agents via office): only outside Docker,
     * with node-pty and local access. Absent = feature disabled.
     */
    pty?: PtyStatus;
    /** GitHub new version check (absent in tests and timelapse). */
    updates?: UpdateStatus;
    /**
     * Habblaud World (server/world/): `enabled` = section appears (HABBLAUD_WORLD is not 0 and world server was
     * accepted: default server.habblaud.com or valid HABBLAUD_WORLD_URL; rejected, feature disabled and nothing
     * from World appears); `configured` = world server accepted; `state` = account on this machine; `building`
     * (additive, only with approved account and created character) = building summary in world: connected,
     * paused, floors and agents from last payload and its timestamp, whether left world and if world server stopped
     * it (without reason, which only goes in status). Nothing else from account (snapshot also goes to mobile
     * and timeline). Absent in tests and timelapse.
     */
    world?: WorldMeta;
  };
}

/**
 * What THIS page can do (GET /api/access): local port allows everything via local Host; remote port with login
 * (server/http/remote.ts) only what HABBLAUD_REMOTE_ALLOW permits. `local` = opened from computer itself (edit
 * character and rename rooms, which never apply via remote port).
 */
export interface AccessInfo {
  remote: boolean;
  local: boolean;
  permissions: boolean;
  messages: boolean;
  terminal: boolean;
  /** Can spawn new agents in Claude app (POST /api/spawn). */
  spawn: boolean;
  /**
   * Can use Habblaud World account (/api/world/*): feature enabled (HABBLAUD_WORLD), terminal guard, and
   * local port with local Host. Absent in older servers.
   */
  world?: boolean;
}

export interface FeedItem {
  id: string;
  agentId: string;
  roomId: string;
  agentName: string;
  roomName: string;
  /** Agent account (= AccountInfo.id). */
  account?: string;
  activity: Activity;
}

export type NoticeLevel = 'info' | 'success' | 'warn' | 'alert';

export interface Notice {
  id: string;
  level: NoticeLevel;
  text: string;
  agentId?: string;
  roomId?: string;
  at: number;
}

/**
 * Server messages via SSE in GET /api/stream.
 * Each message arrives as a named SSE event (`event: snapshot|feed|notice`) whose `data` is JSON of `data`.
 * Upon connecting, server sends a full `snapshot` and a `feed` with recent items.
 */
export type ServerMessage =
  | { type: 'snapshot'; data: OfficeSnapshot }
  | { type: 'feed'; data: FeedItem[] }
  | { type: 'notice'; data: Notice };

/** Response of GET /api/agents/:id */
export interface AgentDetail {
  agent: AgentInfo;
  /** Longer history (max ~200), oldest to newest. */
  history: Activity[];
}

// ------------------------------------------------------------------ Claude Code mod

/**
 * Response of GET /api/mod/summary: minimal data Claude Code mod (mod/habblaud) needs for the
 * "needs you" line below prompt and /habblaud command. Only real agents (demo excluded) and
 * present agents (excluding closed or delivered); with `?session=` (and `?account=`), excluding
 * caller's own session: its main agent and subagents.
 */
export interface ModSummary {
  /** Habblaud version in use. */
  version: string;
  /** Present agents and how many are working. */
  agents: number;
  working: number;
  /** Who needs you, ordered by longest waiting to shortest waiting. */
  waiting: ModWaitingAgent[];
}

export interface ModWaitingAgent {
  /** = AgentInfo.id. */
  id: string;
  name: string;
  /** Displayed room (project) name. */
  room: string;
  /** = AccountInfo.id. */
  account: string;
  /** Reason (AgentInfo.waitingFor), e.g.: "approve permission". */
  waitingFor: string;
  /** Waiting since (epoch ms). */
  since?: number;
  /** Has permission request answerable via office (AgentInfo.permission). */
  answerable: boolean;
}

// ------------------------------------------------------------------ terminal

/**
 * How to display the `input` of a tool call:
 * - command: shell command; diff: "- old" / "+ new" lines (Edit/Write); json: raw args; text: plain text.
 */
export type TerminalInputKind = 'command' | 'diff' | 'json' | 'text';

/**
 * A terminal entry: session conversation reconstructed from JSONL transcript,
 * in the format Claude Code displays it. All text is masked and truncated.
 * Entries are only appended (never edited): tool result arrives later in a
 * 'result' entry pointing to 'tool' via `toolUseId`.
 */
export type TerminalEntry =
  /** User prompt or slash command (e.g.: "/model"). */
  | { kind: 'user'; id: string; at: number; text: string }
  /** Agent response text (markdown). */
  | { kind: 'assistant'; id: string; at: number; text: string }
  /** Thinking block; `text` absent when transcript only stores signature. */
  | { kind: 'thinking'; id: string; at: number; text?: string }
  /**
   * Tool call. `id` = tool_use id. `title` in Claude Code style: "Bash(npm test)",
   * "Read(server/index.ts)". `input` = relevant arguments (command, diff...), if any.
   */
  | { kind: 'tool'; id: string; at: number; tool: string; title: string; input?: string; inputKind?: TerminalInputKind }
  /** Tool result. `truncated` = text was truncated (result too long). */
  | { kind: 'result'; id: string; at: number; toolUseId: string; text: string; error?: boolean; truncated?: boolean }
  /** Session event: compact, interrupt, background result, API error... */
  | { kind: 'system'; id: string; at: number; text: string; detail?: string; level?: 'info' | 'warn' | 'error' };

/** Terminal stream `init` event: recent conversation (replaces everything client has). */
export interface TerminalInit {
  agentId: string;
  /** Oldest to newest. */
  entries: TerminalEntry[];
  /** Previous conversation exists that was not loaded (transcript larger than read window). */
  truncated: boolean;
}

/**
 * Terminal stream (Server-Sent Events) at GET /api/agents/:id/terminal.
 * Upon connecting (and on each reconnection, or if transcript is truncated/replaced) an `init` arrives;
 * then `append` with new entries. Errors before stream respond with JSON `{error}`:
 * 403 (feature disabled or non-local access), 404 (unknown agent/transcript),
 * 429 (too many open terminals).
 */
export type TerminalMessage = { type: 'init'; data: TerminalInit } | { type: 'append'; data: TerminalEntry[] };

/**
 * A recent session (open or already closed) in terminal history, at
 * GET /api/sessions/recent. Conversation of a closed session is returned with same terminal
 * protocol (TerminalMessage) from GET /api/sessions/:account/:sessionId/terminal.
 */
export interface RecentSession {
  /** = AccountInfo.id. */
  account: string;
  /** Session tool; absent = 'claude'. */
  provider?: Provider;
  sessionId: string;
  /** Project path (`cwd` from transcript header lines); absent if undetectable. */
  project?: string;
  /** Project folder name in `projects/` (encoded cwd), fallback when `project` missing. */
  projectDir: string;
  /** Title like agent: /rename > agent name > auto title > last prompt (or first). */
  title?: string;
  /** First and last timestamped activity (epoch ms); `lastAt` falls back to file mtime if no end timestamp. */
  firstAt?: number;
  lastAt: number;
  /** Transcript size in bytes. */
  size: number;
  /** Session still open: `agentId` is its main agent in office. */
  open: boolean;
  agentId?: string;
}

// ------------------------------------------------------------------ deliveries

/** Delivery attachment kind, to choose viewer. */
export type DeliveryAttachmentKind = 'image' | 'pdf' | 'video' | 'page' | 'text' | 'file';

/** File delivered by agent (SendUserFile, response link) or screenshot captured at end of work. */
export interface DeliveryAttachment {
  /** Opaque id for GET /api/deliveries/file/:id (never the path). */
  id: string;
  name: string;
  kind: DeliveryAttachmentKind;
  /** Agent caption (SendUserFile) or "Captured screen". */
  caption?: string;
  /** Screenshot captured inside conversation (not a local disk file). */
  capture?: boolean;
}

/**
 * A delivery: completion of a request where agent worked (used tools) and responded. Built from transcript
 * (server/deliveries/deliveries.ts), formatted for a BA: headline, summary, request, and attachments.
 */
export interface DeliveryInfo {
  /** "<account>:<session>:<request entry>". */
  id: string;
  account: string;
  provider?: Provider;
  sessionId: string;
  /** Agent still in office (for avatar and "open terminal"). */
  agentId?: string;
  /** Agent name (from office) or session title. */
  agentName?: string;
  project?: string;
  /** What was requested (one line). */
  request: string;
  /** First sentence of response, without markdown. */
  headline: string;
  /** Plain language paragraph (last in response), when present. */
  summary?: string;
  /** Full response (markdown). */
  text: string;
  startedAt: number;
  finishedAt: number;
  /** Tools used and files modified in request. */
  tools: number;
  edited: number;
  attachments: DeliveryAttachment[];
}

export interface DeliveriesResponse {
  deliveries: DeliveryInfo[];
}

/** Response of GET /api/sessions/recent: newest to oldest activity. */
export interface RecentSessionsResponse {
  sessions: RecentSession[];
  /** Listing window (days) and max sessions. */
  days: number;
  limit: number;
}

// ------------------------------------------------------------------ answer from office

/** "Always allow" rule suggested by Claude Code for a request (hook permission_suggestions). */
export interface PermissionSuggestionInfo {
  /** Position in list received by hook: returned in decision (hook applies original suggestion). */
  index: number;
  /** Rules in Claude Code permission format, e.g.: "Bash(npm test:*)". */
  rules: string[];
  /** Where rule is stored: 'session', 'localSettings', 'projectSettings', or 'userSettings'. */
  destination: string;
}

/**
 * Pending permission request answerable via Habblaud: Claude Code hook PermissionRequest
 * (mod/habblaud-permissoes/hooks/permission-hook.mjs) registers it and awaits decision. Only exists with
 * local bind (same terminal guard) and with an open Habblaud page.
 * Sent in snapshot without `input` (full args only returned via GET /api/permissions/:id, with
 * local access); demo mock requests include it.
 */
export interface PermissionRequestInfo {
  id: string;
  /** Tool of requester; absent = 'claude'. */
  provider?: Provider;
  /** Raw tool name (e.g.: "Bash", "Edit", "mcp__github__create_issue"). */
  tool: string;
  /** Title in Claude Code style: "Bash(npm test)", "Edit(src/app.ts)". Masked and trimmed. */
  title: string;
  /** Short summary (e.g.: "Running tests") and activity icon. */
  text: string;
  icon: string;
  /** Arguments (command, diff, JSON...), masked and truncated. */
  input?: string;
  inputKind?: TerminalInputKind;
  /** Request from a subagent not yet shown by Habblaud: its type (e.g.: "Explore"). */
  subagent?: string;
  /** "Always allow" rules applicable alongside approval. */
  suggestions?: PermissionSuggestionInfo[];
  /**
   * AskUserQuestion request: questions to answer via office (`answer` decision). Also included
   * in snapshot (without them card has nothing to show).
   */
  questions?: AskQuestion[];
  /** Other requests from same agent queued after this one. */
  queued?: number;
  createdAt: number;
  /** When hook stops waiting and request falls back to terminal only. */
  expiresAt: number;
}

/**
 * Response to an AskUserQuestion question, by POSITION (AskQuestion.index and option `index`): hook replaces
 * positions with original text received from Claude Code (page only sees masked/trimmed text).
 */
export interface PermissionAnswer {
  /** AskQuestion.index. */
  question: number;
  /** Positions of chosen options (single one without multiSelect). */
  options?: number[];
  /** Plain text ("Other"). Without multiSelect, substitutes an option. */
  other?: string;
}

/** Body of POST /api/permissions/:id/decision (from page). */
export interface PermissionDecision {
  /**
   * allow = approve; deny = reject; terminal = return request to terminal (hook exits without deciding);
   * answer = answer AskUserQuestion questions (`answers`).
   */
  behavior: 'allow' | 'deny' | 'terminal' | 'answer';
  /** Denial: message forwarded to agent. */
  message?: string;
  /** Denial: interrupt agent (stops and waits for you). */
  interrupt?: boolean;
  /** Approval: apply suggestion at this index (PermissionSuggestionInfo.index). */
  suggestion?: number;
  /** Response (`answer`): one per question in request. */
  answers?: PermissionAnswer[];
}

// ------------------------------------------------------------------ messages via office

/**
 * Status of message sent from page to an agent (GET /api/messages/:id):
 * queued = waiting for session fetch; sent = session fetched and delivering; delivered = entered session (or
 * its queue, if agent was busy); failed = delivery failed (`error` indicates reason).
 */
export type OutboxStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface OutboxMessage {
  id: string;
  /** Recipient AgentInfo.id (always a main agent). */
  agentId: string;
  status: OutboxStatus;
  error?: string;
  createdAt: number;
  /** Last status change. */
  updatedAt: number;
}

/** Interactive terminal state (OfficeSnapshot.meta.pty). */
export interface PtyStatus {
  enabled: boolean;
  /** Why it is disabled. */
  reason?: string;
}

/** Interactive terminal opened by Habblaud (node-pty on server, xterm.js in browser). */
export interface PtyInfo {
  id: string;
  /** Claude Code PID: corresponding agent is `${account}:${pid}` (= agentId). */
  pid: number;
  cwd: string;
  account: string;
  agentId: string;
  /** Resumed session (`claude --resume`), when terminal took over an existing session. */
  resumed?: string;
  /** Agent this terminal took over (old id of terminated process). */
  fromAgent?: string;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
}

/** Message delivered to habblaud-mensagens plugin (POST /api/mod/inbox). */
export interface InboxMessage {
  id: string;
  /** Text as typed: plugin delivers it to session as if typed directly. */
  text: string;
  /** Instead of the text: a slash command the plugin runs ($.command.run): model, effort or plan mode only. */
  command?: SessionCommand;
}

/** What the office may change in a Claude Code session (agent drawer): `/model`, `/effort`, `/plan`. */
export interface SessionCommand {
  name: 'model' | 'effort' | 'plan';
  args: string;
}
