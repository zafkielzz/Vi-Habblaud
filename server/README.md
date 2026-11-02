# Habblaud Server

Pure Node (no runtime dependencies). Observes **open** Claude Code sessions across all accounts on the machine,
maintains the office model, and streams everything via SSE.

```
npm run dev      # server + Vite (middleware, HMR) at http://127.0.0.1:4747
npm run build && npm start   # production: serves dist/client
```

## Data sources (read-only)

| What | Where |
| --- | --- |
| Open sessions and status (busy/idle/waiting) | `<config>/sessions/<pid>.json` (+ live PID, outside Docker) |
| Activities, tasks, title, counts | `<config>/projects/<cwd>/<sessionId>.jsonl` (reads last ~1 MB on boot; start in background) |
| Subagents (including workflows) | `<config>/projects/<cwd>/<sessionId>/subagents/**/agent-*.jsonl` + `.meta.json` |
| Account (email, organization) and usage cache | `~/.claude.json` (default account) or `<config>/.claude.json` — only these fields |
| Live usage (5h and weekly) | `~/.habblaud/usage/<conta>.json`, written by Habblaud mod (`npm run mod:install`) or `scripts/statusline-tap.mjs` (`npm run usage:install`) |
| Account shortcut (`c`, `d`...) | `alias x='... claude ...'` lines from `~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.bash_profile` |

**Forks** (subagents inheriting parent context): the transcript begins with a `fork-context-ref` line, the copy of the
parent `Agent` call (same `tool_use` id as `.meta.json`) and its result ("Fork started…") along with the fork
instruction. The parser ignores this copy — otherwise the inherited result looks like the subagent ended and the fork
never enters the office — and uses the text after `</fork-boilerplate>` as its prompt.

## Waiting on shell

The `shell` status (see `shared/types.ts`) is an agent that ended its turn with command(s) running in the background.
Comes from the record (`"status": "shell"`, Claude Code 2.1.292+, which does not count monitors); in versions that do
not record `shell`, an `idle` record + background Bash without notification under 12 h becomes `shell`.

`sources/shells.ts` tracks, per session (primary and subagents), `ShellJob` entries published in `AgentInfo.shells`:
Bash with `run_in_background` (the id becomes the `backgroundTaskId` from the tool_result), foreground Bash still
without result (`background: false`; disappears from place while the session awaits approval), and `Monitor` (`kind:
'monitor'`). Termination: `<task-notification>` (`queue-operation`/`enqueue` line, user message, or attachment) matching
`task-id` or `tool-use-id`; `TaskStop`/`KillShell`/`KillBash`; turn end/interruption (foreground); `/clear` or
terminated session; jobs predating the current process (resumed session) or older than 24 h. The end of a background
shell becomes the activity `tool: 'ShellDone'` (`error` = failed/interrupted; the world celebrates or laments) and a
notice; while the status is `shell`, the balloon is "⏳ Waiting on shell: <label>" (`tool: 'ShellWait'`).

## GitHub in the office

`sources/github.ts` finds GitHub events in transcripts, tokenless and without network (works in Docker): the parser
keeps calls of interest (Bash with `git push`/`gh pr create|merge|checks`/`gh run watch|view`/`gh release create`,
without heredocs and with separated chains, and GitHub MCP server tools) and reads their outcome:

- **preferred source:** `toolUseResult.gitOperation`, recorded by Claude Code itself (`{pr: {number, url, action:
  'created'|'merged'}, push: {branch}}`);
- **command output:** URL `…/pull/<n>` from `gh pr create`; `gh pr merge` without error or failure signal (and without
  `--auto`); lines `abc..def  main -> main` / `* [new branch]` after `To <remote>`; header `✓|X <branch> <workflow> ·
  <id>` or `completed with '<conclusion>'` from `gh run watch|view`, `--json`/`--jq` with the conclusion, `gh pr checks`
  (tabs, summary or `--json`; pending does not count); URL `…/releases/tag/<tag>` from `gh release create` (drafts do
  not count); MCP JSON;
- **exit code:** `gh run watch --exit-status` or `gh pr checks` as the last command, unpiped (otherwise exit code
  belongs to another program) — in foreground ("Exit code N") or background (`<task-notification>` summary). ≥ 128
  (killed) and 8 (pending `gh pr checks`) do not count.

Commands with errors, blocked, or interrupted do not produce an event (only red CI uses the error). The `github` signal
becomes `Office.githubEvent`: activity `tool: 'GitHub'` (`shared/github.ts`) and, live only (never on initial load or
for lines older than 2 min), a notice and room effect, published in `RoomInfo.effect` (`{kind: 'party'|'alarm', text,
at, until, agentId}`): party (PR opened/merged, release) for 12 s; alarm (red CI) until green CI in the room (which
turns into a party) or 10 min. Push only notifies. The same CI seen again within 2 min does not repeat the notice.

## API

| Route | Description |
| --- | --- |
| `GET /api/stream` | SSE: events `snapshot`, `feed`, `notice` (see `shared/types.ts`); ping every 15 s |
| `GET /api/snapshot` | Current `OfficeSnapshot` |
| `GET /api/agents/:id` | `AgentDetail` (history of up to 200 activities) |
| `GET /api/agents/:id/terminal` | Terminal SSE: `init` and `append` events (`TerminalMessage`); local bind only (see below) |
| `PUT /api/agents/:id/character` | Project character: `{name, seed, parts}` (see below); `200 {ok}`, `400`, `404` (not the primary of an open session), `409` (name in use); local access only |
| `DELETE /api/agents/:id/character` | "Back to random": removes character from room; `200 {ok}` or `404`; local access only |
| `GET /api/sessions/recent` | `RecentSessionsResponse`: sessions from last 7 days across all accounts (up to 150); same terminal lock |
| `GET /api/sessions/:conta/:sessionId/terminal` | SSE of conversation for a historical session (same terminal protocol); same lock |
| `GET /api/stats?day=AAAA-MM-DD&tz=<IANA>&source=real\|demo` | `DayStatsResponse` of "My day" (see below); defaults: today, server timezone, demo if enabled and day is today |
| `GET /api/stats/days?tz=<IANA>` | `StatsDaysResponse`: days with real data (and demo, if enabled), most recent first |
| `GET /api/timeline/days` | `{recording, days:[{day, bytes, from, to}]}`: days recorded for timelapse, most recent to oldest |
| `GET /api/timeline/:dia` | Day file (`AAAA-MM-DD`) in JSONL (`application/x-ndjson`, gzip if accepted); 400 for invalid day, 404 without recording |
| `GET /api/health` | `{ok, version, demo, docker, terminal, permissions, messages, updates:{state, latest, available}, sources, accounts:[{id, usageStatus}]}` |
| `POST /api/demo` | `{enabled: boolean}` enables/disables simulated agents (mixed with real ones) |
| `GET /api/mod/summary?account=&session=` | `ModSummary` for Claude Code mod: `{version, agents, working, waiting:[{id, name, room, account, waitingFor, since, answerable}]}`, without demo and excluding caller session (see below) |
| `GET /api/updates` | `{version, ...UpdateStatus}`: running version and result of new version check (see below) |
| `POST /api/updates/check` | "Check now": queries GitHub (at most once every 30 s) and returns `{version, ...UpdateStatus}` |
| `/api/world/*` | Habblaud World (account, character and building; enabled by default, `HABBLAUD_WORLD=0` disables): local port with local `Host` only; see below |
| `POST /api/permissions` | (hook) registers a permission request: `201 {id, expiresAt}` or `200 {skip}`; local bind only (see below) |
| `GET /api/permissions/:id/wait` | (hook) long-poll up to 25 s (`?timeout=` in seconds): `{status: 'pending' \| 'decided' \| 'released', ...}` |
| `GET /api/permissions/:id` | (page) request detail with arguments (`PermissionRequestInfo` with `input`) |
| `POST /api/permissions/:id/decision` | (page) `PermissionDecision`: `{behavior: 'allow' \| 'deny' \| 'terminal' \| 'answer', message?, interrupt?, suggestion?, answers?}` |
| `POST /api/messages` | (page) `{agentId, text}`: sends a message to a primary agent; `201 OutboxMessage`; local bind only (see below) |
| `GET /api/messages/:id` | (page) message status (`OutboxMessage`: `queued` \| `sent` \| `delivered` \| `failed`) |
| `POST /api/mod/inbox` | (`habblaud-mensagens` plugin) `{session, account?}`: records session presence and delivers `{messages: InboxMessage[]}` |
| `POST /api/mod/inbox/ack` | (plugin) `{session, results: [{id, ok, error?}]}`: acknowledges each delivered message (or failure) |

The snapshot (SSE and `GET /api/snapshot`) carries only the last 8 activities of each agent in `recent`; history of up
to 200 (including the beginning of long transcripts, read in background) comes from `GET /api/agents/:id`.

Edge (`http/guard.ts`, applies to API, statics, and Vite): `Host` must be `localhost`/`*.localhost`, an IP, or a name
from `HABBLAUD_ALLOWED_HOSTS` (against DNS rebinding) → otherwise 403; `POST` on `/api/*` requires `Content-Type:
application/json` (415) and same-origin or local `Origin` (403), against CSRF. JSON responses are sent with `nosniff`
and `Cross-Origin-Resource-Policy: same-origin`, no CORS.

## New version

`updates/checker.ts` queries `GET https://api.github.com/repos/<owner>/<name>/releases/latest`, without token, 5 s after
startup and every 6 h thereafter (1 h after a failure). The repository comes from the `repository` field of
`package.json` (a fork only needs to change that field). The query sends `If-None-Match` with the previous ETag, since a
304 response does not consume the 60 queries/hour limit without token. The result (`repo`, `checkedAt`, `etag`,
`latest`, `url`, `publishedAt`) is saved in `<dataDir>/updates.json`, so a restart does not repeat queries prematurely.
The tag must follow semver (`v1.2.3` or `1.2.3-beta.1`) and is compared against the `package.json` version. Responses:
404 = no release (`ok` without `latest`); 403/429 = GitHub limit (`error`). On failure, the last known release remains
valid. Status goes in the snapshot under `meta.updates` (`UpdateStatus` in `shared/types.ts`) and is republished when it
changes. The release link is only passed if from the repository itself on GitHub. A newly found version is logged once.
`HABBLAUD_UPDATE_CHECK=0` disables it (`state: 'off'`, no queries).

Each version has its section in `CHANGELOG.md`; a test fails if the `package.json` version lacks a section, and `npm run
release` (`scripts/release.ts`) creates the tag and release using its section text as release notes.

## Terminal

`GET /api/agents/:id/terminal` (`http/terminal.ts`) streams the session conversation — prompts, responses, tools and
results, as Claude Code displays them — assembled from the transcript by `sources/terminal.ts`, with masked secrets and
truncated text. Upon connecting (and on each reconnection) comes an `init` with the last 500 entries of the final ~4 MB
of the transcript (`truncated: true` if conversation was left out); afterwards, 400 ms polling sends `append` with new
entries. Truncated/replaced or swapped transcript (`/clear` in the same process) = `init` again; missing file = keeps
trying. Demo agents have no transcript: fictitious conversation comes from `shared/demo/terminal.ts` (updated every 500
ms). Ping every 15 s, at most 8 terminals simultaneously, client with over 8 MB accumulated is disconnected. What is
typed into the terminal footer is sent as a message (see [Messages from the office](#messages-from-the-office)); the
stream remains read-only.

This feature only exists with **local bind** (`config.ts`, `terminalOffReason`), since it reveals the full conversation:

- Node: loopback `HABBLAUD_HOST` (127.0.0.0/8, `::1`, `localhost`); `0.0.0.0`, `::` or network IP disables;
- Docker: process always listens on `0.0.0.0` inside container, so the published port on host applies, `HABBLAUD_BIND`
  (`docker-compose.yml` forwards the same value to the container): loopback enables; missing, empty, or any other
  disables;
- `HABBLAUD_TERMINAL=0` always disables; no variable enables the terminal with an exposed port.

In addition, each request requires a local `Host` (`localhost`, `*.localhost`, 127.x or `[::1]`): network IPs and names
from `HABBLAUD_ALLOWED_HOSTS` (proxies, tunnels) receive 403. Status appears in `meta.terminal` of the snapshot and in
`terminal` under `/api/health`. Errors before the stream respond with JSON `{error}`: 403 (disabled or non-local
access), 404 (unknown agent or transcript), 405 (method not `GET`), 429 (too many terminals), and 500 (unreadable
transcript).

## Timeline (timelapse)

`history/timeline.ts` records the office for client timelapse in `<HABBLAUD_DATA_DIR>/timeline/AAAA-MM-DD.jsonl` (server
local day; in Docker, `/data/timeline`). Format and reconstruction in `shared/timeline.ts`; one record per line:

- `{"t":"k", at, v, every, boot?, rooms, agents, accounts}`: **keyframe**, the full state. Opens each file, repeats
  every 5 min (`every`), and marks server boot;
- `{"t":"d", at, rooms?, agents?, accounts?}`: **delta**, only what changed (`[id, object | null]` for rooms and
  accounts; `[id, changed fields | null]` for agents, with `null` = removed field or agent);
- `{"t":"end", at, reason?}`: server stopped (`SIGTERM`/`SIGINT`) or the day reached its limit (`reason: "limit"`).

Every new snapshot from `Hub` (`hub.onSnapshot`, i.e., each `Office` commit with changes) enters, throttled to 1 s and
only when something the player renders changes. Per agent: id, kind, parentId, room, name, look, role, account, status
(with `statusSince`), waitingFor, activity (`kind`, `icon`, `text`, `at`, `tool`, `error`), seed, background, title, and
summarized shells (without command); demo mode agents, rooms, and accounts (`demo:`) have `demo: true`. Accounts lack
email, organization, and folder. No transcripts: same exposure as `/api/snapshot`, so routes work with any bind.

- **Limits:** above 20 MB in a day, delta every 15 s and keyframe every 15 min; above 30 MB, stops until midnight.
- **Retention:** last 7 days (including today); only `AAAA-MM-DD.jsonl` files are deleted.
- **Disk failures:** never crash the server: warning in log, retry in 1 min, restarting with keyframe.
- **Gaps:** without any record for more than ~1.5× `every` (or after `end`), player displays "no data".
- `HABBLAUD_TIMELINE=0` disables recording (routes continue serving recorded days).

The day in the URL is only accepted as `AAAA-MM-DD` of a valid date and the file path is built strictly from it (no
`..`, encoded slashes, or null bytes). `scripts/demo-timeline.ts` (`npm run demo:timeline`) uses the same recorder, with
simulated clock and `DemoSimulator`, to generate entire days with fictitious data.

## My day (day stats)

`history/daystats.ts` samples the office snapshot every 1 s and passes agents to the pure tracker in
`shared/daystats.ts`, which integrates, per agent, time elapsed since the previous sample in its current status
(`working`, `waiting`, `shell`, `idle`; `done` and `offline` do not count), splitting intervals at `statusSince`.
Intervals over 2 min between samples (stopped server, sleeping computer) do not count. Waits for you are episodes of
continuous `waiting` (those under 3 s are excluded from rankings); "wall clock time with someone waiting" unions
intervals across all agents.

- **Counts:** `AgentStats` is cumulative per agent, counting increments beyond the highest seen value (rereading
  rewritten transcript does not recount). Pre-existing agents (boot, `/resume`) become baseline during first 20 s (90 s
  on boot, while long transcript starts are read in background); subagents created during observation and new sessions
  (or `/clear`) count from zero. An impossible jump in a sample (over 60 tools or 5M tokens) is treated as a reread.
  Cost appearing on an old agent is total session cost: reference only. Prompts come from `prompt` activities after
  server startup; tasks from increases in completed count. Agents that disappear and return retain baseline for 6 h.
- **1-hour buckets aligned to UTC** (by room, account, and present participants: sessions and subagents), stored by file
  day in server timezone. Requested day is assembled on query, in browser `tz`: in Docker (UTC) the dashboard day still
  starts at user midnight.
- **Files:** `<dataDir>/stats/AAAA-MM-DD.json` (`StatsDayFile`, version 1), written every 30 s and on shutdown
  (temporary + `rename`); on boot loads yesterday and today, indexes others and deletes those older than 30 days (again
  at midnight rollover). Unreadable file becomes `.corrupt` and day restarts; disk errors only log a warning.
- **Demo:** agents with `demo:` id never enter real data. When demo is enabled, a separate in-memory-only bucket is
  seeded with fictitious history from yesterday to now (`shared/demo/daystats.ts`) and fed live.
- **Exposure:** only aggregated numbers and project, account, and agent names (same as `/api/snapshot`), so the route
  does not have the terminal's local bind lock. Errors: 400 (`day` not in `AAAA-MM-DD` format, nonexistent date, future
  day, repeated parameter, invalid `tz` or `source`), 404 (no data, past retention, or demo off), 405.

Statics (`http/static.ts`): `/bundle/*` (Vite output with hash, `build.assetsDir`) with 1-year `immutable` cache; the
rest (`index.html`, `client/public` under `/assets/*`) with `no-cache` + `ETag`/`Last-Modified` (304).

## Session history

`sources/history.ts` lists, on demand, top-level transcripts `<config>/projects/*/<sessionId>.jsonl` of each account
(UUID-formatted name; subagents excluded) modified in the last 7 days, up to 150 most recent. From each file it reads
only the first 64 KB (project = `cwd` of first line containing it, first activity, first prompt) and the last 64 KB
(title and last activity; without a title line there, searches last 512 KB), with async reading and a cache by valid
path as long as mtime and size do not change. The title follows agent rules (`custom-title`/`custom-title.json` >
`agent-name` > `ai-title` > `last-prompt`) and, if none exist, is the first prompt. An open session (primary agent of
account and `sessionId` in office) returns `open: true` and `agentId`; a closed session without timestamp lines is
omitted. The list is returned from most recent activity to oldest.

`GET /api/sessions/:conta/:sessionId/terminal` (`http/sessions.ts`) uses the same agent terminal reader
(`TerminalStreams.attachSession`: `init` with last 500 entries of final ~4 MB, then `append`, with 2 s polling in case
session is resumed) and counts toward the 8 terminals limit. Validation: account must be known (404), id must be UUID
format (400), and the file, with resolved links (`realpath`), must remain inside the account's `projects/` directory
(404); undecodable segments respond 400. Both routes require the same terminal lock (enabled feature and local `Host`,
otherwise 403) and only accept `GET` (the list also accepts `HEAD`; otherwise 405).

## Answering from the office

The Claude Code `PermissionRequest` hook (`mod/habblaud-permissoes/hooks/permission-hook.mjs`, with `matcher: "*"`: via
the `habblaud-permissoes` plugin in Claude Code 2.1.287+ or installed in `<conta>/settings.json` via `npm run
hooks:install`) runs **alongside** the terminal permission dialog: whichever answers first wins. In background
subagents, Claude Code runs the hook first and only shows the dialog after it finishes. The hook sends the request
(`session_id`, `agent_id`/`agent_type`, `cwd`, `tool_name`, `tool_input` with truncated text, `permission_suggestions`
and its own `timeout_ms`) and waits; upon `decided` it prints `hookSpecificOutput.decision` (`allow`, with
`updatedPermissions` = selected original suggestion, or `deny` with `message`/`interrupt`); on `released`, error, or
timeout it exits without printing (terminal wins).

Questions (`AskUserQuestion`) follow the same path. The request includes `questions` (masked and truncated, with the
original position of each question and option in `index`; also sent in snapshot) and the page responds with `{behavior:
'answer', answers: [{question, options?, other?}]}`, by position. The registry validates against the stored original
format (each question once; without `multiSelect`, a single option or freeform text; `other` up to 2,000 characters) and
delivers `{status: 'decided', behavior: 'answer', answers}`; the hook substitutes positions with the original stdin
texts and prints `allow` with `updatedInput` = original input plus `answers` (`{pergunta: "Label A, Label B, freeform
text"}`, as hook documentation specifies for responding to `AskUserQuestion`). A plain `allow` on a question is rejected
(400); `deny` is accepted. Questions the office cannot display completely (more than 4, or none valid) are not
intercepted (`unsupported-tool`).

`permissions/registry.ts` (`PermissionRegistry`):

- only accepts the request if a page is connected via local `Host` (`Hub.localSize`) and the session is known (primary
  by `session_id`; subagent by `<session_id>:<agent_id>`, or primary with `subagent` = type); otherwise `{skip:
  'no-viewers' | 'unknown-session' | 'unsupported-tool' | 'too-many'}` (max 32 open);
- publishes the oldest request for each agent in `AgentInfo.permission` (without `input`, only returned in detail;
  `queued` = how many waiting after) and sets agent to `waiting`; `PermissionRequest` activity in feed and notice
  "asking for permission" (dedupes with "needs you"); approvals/rejections also become activities;
- releases the hook (`released`) on: `terminal` in page, hook timeout + 5 s (`expired`), no hook waiting for 8 s
  (`orphan`), departed agent (`gone`), or response in terminal itself (`answered`): Claude Code does not terminate the
  hook when you answer in terminal, so the registry finds the call at transcript end (`permissions/transcript.ts`: name
  + argument signature, most recent without result) and waits for its `tool_result`; without the call, a primary that
  was `waiting` in session registry and left it 3 s ago;
- unretrieved decisions are kept for 30 s; demo requests (`demo:perm-…`) go to the simulator.

Routes (`permissions/http.ts`) follow the terminal lock: without `ServerConfig.terminal` → 403 on all; non-local `Host`
→ 403. Guard requires JSON and local `Origin` on `POST`. Errors: 400 (invalid body, suggestion, or answer), 404 (unknown
request, already delivered or expired), 405, 409 (already answered).

## Messages from the office

The page sends text to a primary agent (`POST /api/messages`, via agent drawer or terminal footer) and the session's
`habblaud-mensagens` plugin polls for it (`POST /api/mod/inbox`, every 2 s) and delivers it via `$.prompt.submit({ text,
asUser: true })`: the model reads it as if you typed it. It then acknowledges (`POST /api/mod/inbox/ack`). Plugin
details in [`mod/README.md`](../mod/README.md).

`messages/registry.ts` (`MessageRegistry`):

- **presence:** each plugin poll marks the session (the primary with that `sessionId`, matching `account` if provided);
  seen within 10 s, the agent appears in snapshot with `canMessage: true`. Snapshot only changes when presence changes;
- **queue:** up to 5 open messages per agent (429) and 20,000 characters per message; text is sent verbatim, never
  appears in responses to the page or logs, and is discarded when message resolves;
- **states:** `queued` → `sent` (plugin fetched it) → `delivered` or `failed`. `queued` without being fetched in 60 s,
  `sent` unacknowledged in 30 s, or departed agent = `failed`, with reason. `delivered` = entered session or its queue
  (if agent is busy, enters when it finishes turn). Resolved messages kept 10 min for `GET`;
- delivered: ✉️ "Message via Habblaud" activity on agent (detail masked and truncated); demo agents receive fictitious
  messages, delivered in ~1 s, without real session.

Routes (`messages/http.ts`) follow the terminal lock plus one flag: `ServerConfig.messages` = terminal enabled and
`HABBLAUD_MENSAGENS` not disabled (`0`, `false`, `off`, `no`). Disabled or non-local `Host` → 403 on all. Errors on
`POST /api/messages`: 400 (invalid body, empty or overly long text), 404 (unknown agent), 409 (agent cannot receive:
subagent, departed, or session without connected plugin), and 429. Status appears in `meta.messages` of snapshot and in
`messages` under `/api/health`.

Any local process can call these routes (like permissions): enabling messages accepts that a program on the machine can
type into sessions running the plugin.

## Project character

`PUT /api/agents/:id/character` (`http/app.ts`, rules in `Office.setCharacter`) sets the name and appearance of primary
agent `:id` and saves it as the character of its room (the normalized cwd), in `names.json` › `rooms`: `{name, look,
seed, parts?, owner?, at}`.

The body has three fields:

- `name`: 1 to 24 characters, in NFC, with collapsed consecutive spaces and without control characters;
- `seed`: integer from 0 to 4294967295;
- `parts`: parts from `shared/appearance.ts`, with enum styles and colors in `#rrggbb`. The client applies parts on top
  of `appearanceFromSeed(seed, {look})`.

Rules:

- When a primary agent enters a room that has a character, and the name is available, it spawns with `name`, `look`,
  `seed`, `parts`, and `custom: true`. Departing agents do not count, as they are usually the same reopened session. If
  the name is taken, the standard random draw applies.
- Characters have an owner (`owner`, the `sessionId` that received or saved it last; `/clear` transfers ownership to the
  new session): a non-owner session that already has a saved name keeps its own, ensuring a Habblaud restart neither
  swaps identities nor alters a session's character mid-run.
- Chosen names remain reserved: random draw will not assign them, case-insensitively. `PUT` returns `409` for a name of
  someone present (including demo) or from another room.
- `/clear` retains the character and does not record the chosen name as the new session's randomly drawn name.
- `DELETE` removes the room character, and the agent returns to the session's randomly drawn name and id seed.
- Lock: same as terminal (local bind and local `Host`). Without it, `403`. Subagent, demo, or unknown agent return
  `404`.
- Unused character after 60 days expires, like names.

## Codex

Agent sources (`sources/source.ts`): `SourceSet` combines Claude Code (`ClaudeWatcher`) and, when Codex directories
exist, Codex (`sources/codex/`); same for history (`HistorySet`). Codex agents, accounts, sources, and history sessions
carry `provider: 'codex'` (absent = Claude Code). IDs: `<conta>:<threadId>`, `sessionId` = threadId.

- **Accounts** (`sources/codex/accounts.ts`): `HABBLAUD_CODEX_DIRS` (replaces) or `CODEX_HOME` and `~/.codex*` looking
  like Codex (`isCodexHome`: `thread-writer-locks/`, `archived_sessions/`, `config.toml`, `auth.json`, or
  `sessions/AAAA/`, without `projects/`, which only Claude Code creates). A Codex directory never becomes a Claude Code
  account. `auth.json` and `config.toml` are never read; plan comes from `rate_limits.plan_type`.
- **Open sessions** (`sources/codex/files.ts`, `source.ts`): `thread-writer-locks/<threadId>.lock` existing for 3 s
  (quick maintenance locks excluded; the lock is never opened). Lock without rollout = open empty session: lock does not
  specify folder, so primary agent only joins when rollout (created on 1st prompt) or a hook reports the cwd. Lock and
  rollout idle for 12 h, without hook event = crash lock. Without locks folder: rollout modified in last 30 min. Hook
  event retains presence for 60 s.
- **Rollout** (`sources/codex/rollout.ts`): `sessions/AAAA/MM/DD/rollout-*-<threadId>.jsonl` (directory is creation
  date; resumed session continues in old file) and `archived_sessions/`, read with `FileTail`. "paginated" (default) and
  "legacy" formats; `.zst` is ignored with a warning. Status by `task_started`/`task_complete`/`turn_aborted`;
  activities by `item_completed` (`CommandExecution` like Bash, `FileChange`, `McpToolCall`, messages, and reasoning);
  tokens without recounting cache (in Codex it is already inside input); no cost; plan usage from
  `token_count.rate_limits` (window of 300 min = 5 h, 10080 = week; null `primary` with `rate_limit_reached_type` =
  `noQuota`), pushed with `accounts.setUsage`. Subagents = threads with `source.subagent.thread_spawn.parent_thread_id`;
  internal threads (guardian, review, compact, memory) are excluded.
- **Terminal and history** (`sources/codex/terminal.ts`, `history.ts`): terminal parser is chosen per agent
  (`SourceSet.parserFor`).
- **Hook events** (`POST /api/codex/events`, `codex/http.ts`; hook is `mod/habblaud-codex/hook.mjs`): local `Host` and
  loopback connection only (outside Docker). Forwarded to source's `CodexLive.applyHookEvent`: matched by account (via
  `codexHome` directory) and `agent_id ?? session_id` (in Codex, `session_id` is the ROOT thread). SessionStart makes
  agent appear, UserPromptSubmit/PreToolUse = working (with current activity), PermissionRequest = waiting ("approving a
  command"), Stop = idle, SessionEnd closes.
- **Approving from office** (`permissions/*`, `permissions/codex.ts`): same `POST /api/permissions` with `provider:
  'codex'`, `account`, and `codexHome`; no suggestions, no questions, no transcript search; `interrupt` or `suggestion`
  on a Codex request = 400. Hook waits up to `permissionTimeoutS` from `~/.habblaud/codex-hook.json` (default 25 s) and
  prints only `allow` or `deny` (+`message`). Codex only shows approval in terminal after hook finishes.
- **Messages** (`messages/*`, `messages/codex.ts`): for Codex agents, `codex queue --thread=<id> --message=<texto>` with
  `CODEX_HOME` = account folder (on host). Outside Docker the server runs the command (`HABBLAUD_CODEX_BIN` or `codex`
  in PATH); in Docker, the host bridge helper (`npm run codex:bridge`) polls `POST /api/codex/bridge/poll` and
  acknowledges at `/ack` (same messages lock). `canMessage` = deliverer present (binary found, or helper seen within 10
  s). Exit code 0 = queued in session (`delivered`); Codex consumes the queue every ~10 s when session becomes idle.

## Habblaud World

Enabled by default, pointing to `server.habblaud.com` (`DEFAULT_WORLD_URL` in `config.ts`); nothing leaves the computer
before the user creates an account and logs in, and `HABBLAUD_WORLD=0` disables everything (what leaves the computer:
`docs/world/privacidade.md`; how to contribute: `shared/world/README.md`). The protocol with the world server is
`shared/world/protocol.ts` (source of truth, with `schema.json`). On this side, `world/`:

- `settings.ts`: `<dataDir>/world.json` `{deviceId, token, email, access, player?, paused?, left?, updatedAt, theme?}`,
  mode 600 with atomic write. The device token only leaves here in `Authorization: Bearer` headers of world server calls
  and WebSocket `hello`: never in browser, snapshot, logs, or URLs. `theme` (Appearance choice, `auto` by default)
  persists even without a session (file becomes just `{theme}`); `paused` and `left` (left the world, always with
  `paused`) belong to session.
- `client.ts`: `/v1/*` routes with native `fetch` (15 s timeout, no redirect following, responses up to 256 KB copied
  field by field; data export up to 8 MB as-is). World server errors return `{status, code}` (maintenance is `503
  maintenance`); network, timeout, and malformed responses become `world_unreachable`, `world_timeout`, and
  `world_bad_response`.
- `altcha.ts`: anti-robot challenge for registration and email requests, solved here via brute force (SHA-256), in
  batches of 5,000 attempts yielding to the event loop.
- `service.ts`: the account (one operation at a time). `/v1/me` is re-read at most every 30 s (or with `?refresh=1`)
  and, on the waitlist, automatically every 30 min (`waitingPollMs`; unref'd timer), so approval reaches snapshot
  without manual clicking; a 401 from world server on authenticated route wipes local session (`lastError:
  session_expired`); logging in again revokes previous device; logout deletes `world.json` even without server response.
  `lastError` carries only known codes (`worldLastError` in `shared/world/api.ts`): network and timeout become
  `network`, unrecognized codes become `unknown`. Pause, resume, and leaving the world are queued to the world server
  (in order); unacknowledged resume (network, timeout, 429, 5xx) retries with uplink reconnect backoff (2 s to 60 s),
  until success or building is paused again. Account deletion (Phase 6): code comes from `POST /v1/me/delete`; once
  `POST /v1/me/delete/confirm` is accepted (or `goodbye: deleted`), closes uplink, waits, erases entire `world.json`
  (theme included, `store.erase`) and last packet, leaving status accountless with `lastError: account_deleted`. Data
  export (`GET /v1/me/export`) relays JSON directly.
- `uplink.ts`: the building in the world, via WebSocket (Node global `WebSocket`) at `<HABBLAUD_WORLD_URL>/v1/socket`
  (`wss://`; `ws://127.0.0.1` and `ws://host.docker.internal` in dev mode only). Connects only with approved account,
  created character, and terminal lock; paused or outside the world, connects only while World scene is open (viewer
  signals via `cityChanged`) and without uplink packets (not even `welcome` uplink): only `hello`, `ping`/`pong`, and
  scene commands. Sends `hello` (`{v, version, build: {commit, dirty}, locale, token}`) and, on each `welcome`, the full
  packet; afterwards, on every office change (`Office.onChange`) or every minute, projects
  (`shared/world/projection.ts`) and sends if changed: 3 s after first change, at most one payload every 5 s. `{t:
  'ping'}` every 30 s (no response for 75 s reconnects). Reconnect backoff 2 s to 60 s (doubles, ±25%). `goodbye`:
  `deploy` reconnects (during world maintenance, `deploy` on every `hello`: backoff grows to cap and only resets on
  `welcome`); `banned`, `suspended`, `update`, and `other-device` stop until resumed (or reopened); `waiting`,
  `no_player`, and `unauthorized` stop until session changes and notify account (`service.goodbye`); `deleted` stops and
  account clears session. From `welcome` it retains in memory only for status: account id (`me.id`, in appeal email
  subject) and "unverified" badge of building (`building.unverified`, also updated by scene `area`/`area.patch`).
  `uplink.ack {error: 'left'}` (account left the world, here or on another computer) and `left: true` from `/v1/me`
  record `left` and `paused` (`service.leftElsewhere`): no packets until rejoining (connection remains only with open
  scene). Last dispatch `{at, bytes, uplink, ack}` is kept in memory and in `<dataDir>/world-last-uplink.json` (mode
  600; same session only, deleted on logout). Notifies snapshot (`markDirty`) on connect, drop, pause, resume, and each
  ack. Tasks and compactions (`signals.ts`) are monitored by the same `Office.onChange`, at most once per second, with
  or without connection; during office boot (`Office.isBooting`) nothing is monitored or sent.
- `ids.ts`: world IDs, in memory only (`f_` + 10 hex per room, `a_` + 8 hex per agent, `crypto.randomBytes`), each with
  a lifespan of 24 h ± 6 h randomized per ID; agents that vanish and return (or restarted Habblaud) receive new IDs.
- `tokens.ts`: building tokens (in + out) for today and 7 rolling days, from "My day" with `real` source (demo never
  included), rounded to 2 significant figures; past days are cached, today is re-read every 15 s.
- `theme.ts`: selected theme resolved for payload (automatic follows office calendar via server local date: in Docker,
  UTC). `signals.ts`: completed tasks today per agent and new compactions (`/clear` excluded).
- `http.ts`: `/api/world/*` routes (list and formats in `shared/world/api.ts`). `http/app.ts` serves them only over
  local port with local `Host` (mobile port receives 403 `local_only`, even with login); everything except `status`
  requires terminal lock (403 `terminal_off`); rejected `HABBLAUD_WORLD_URL` gives 409 `not_configured`;
  `HABBLAUD_WORLD=0` gives 404. Errors: `{error: {code, message?, retryAfter?}}`, carrying status and code from world
  server when originating there. Building: `PUT /api/world/theme` `{theme}` (with or without account), `POST
  /api/world/pause` (stops transmission before replying, closing uplink if World scene is not open, and notifies `POST
  /v1/me/building/pause`), `POST /api/world/resume` (notifies `/resume` and reconnects, or sends full packet over scene
  connection), `POST /api/world/leave` ("Leave world": writes `left` and `paused`, stops transmission like pause, and
  responds after `DELETE /v1/me/building`; without valid response, stays paused and returns error), `POST
  /api/world/join` ("Rejoin world": `POST /v1/me/building/join` and, only on valid response, clears `left` and `paused`
  and reopens uplink; a 404 here does not count as success; `/resume` outside world goes through it and, without having
  left, acts as `/resume`), and `GET /api/world/last-uplink` (`{at, bytes, uplink, ack?}` or `{}`, without terminal
  lock, like status). `GET /api/world/status` includes `building` (approved account with character) and `theme`; without
  `?refresh=1` serves from memory and re-reads `/v1/me` in background when expired. Account (Phase 6): `POST
  /api/world/delete-account` (`202 {}`: code sent to email), `POST /api/world/delete-account/confirm` `{code}` (returns
  accountless status after closing building and deleting `world.json`), `GET /api/world/export` (JSON as attachment
  `habblaud-world-dados.json`; like the stream, only via origin page since it consumes daily quota; `HEAD` does not call
  world server), and optional `notifyInactivity` on `PUT /api/world/visibility`.

State is published in snapshot under `meta.world` (`{enabled, configured, state, building?, scene?}`, no account data;
`building` = `{connected, paused, floors, agents, lastUplinkAt?, left?, stopped?}`, with `connected` = lit and sending
(scene-only connection while paused does not count) and `stopped: true` without reason, which is only in status; `scene`
= `{available}` with approved account and character, `available` with terminal lock and not stopped by `banned`,
`suspended`, `update`, `other-device`, or `deleted`: World button on toolbar) and in `GET /api/access` (`world`). The
build writes `dist/build.json` (`{commit, dirty, builtAt}`, `scripts/build-info.mjs`; without git, `unknown`;
`HABBLAUD_BUILD_COMMIT`/`HABBLAUD_BUILD_DIRTY` override git), read by `readBuildInfo()` (`build.ts`) on each uplink
connection: `hello` carries only `{commit, dirty}`.

### World scene: stream and commands

The city (Phase 3) streams over the same building connection and only with World scene open in browser.
`world/viewer.ts` is the "viewer"; state and rules live in `shared/world/scene.ts` (pure, browser can use the same), and
geometry in `shared/world/city.ts` (source of truth; world server keeps exact copy).

- `GET /api/world/stream` (SSE, same locks as account routes, origin page only: cross-host `Origin` or
  cross-site/same-site `Sec-Fetch-Site` get 403 `local_only`). At most 4 open (429 `too_many_streams`). Events:
  `world.snapshot` (`WorldSceneSnapshot` in `shared/world/api.ts`: `{stream, connected, viewing, district?, me?, pos?,
  afk, chunks: [{chunk, rev, buildings}], players, minimap}`) on connect and on restart (connection opened or dropped,
  `view` again): browser replaces entire state; followed by `world` with each city message as received (`area`,
  `area.patch`, `players`, `player.join`, `player.leave`, `pos`, `minimap`, `afk`, `profile`, `notice`, `like.update`,
  `greeting`, `building`, `building.patch`), in order and without `rev` gaps; `: ping` every 15 s. Client accumulating >
  1 MB is disconnected (EventSource reconnects).
- The first stream (with accepted connection) sends `view`; the last closing stream sends `view.off`. On each `welcome`
  with an open stream, `view` again; on each disconnect, local city state is discarded and a snapshot with `connected:
  false` is emitted. Paused or outside the world, the connection only exists while scene is open: opening the first
  stream connects (`hello`, `view`) and closing the last sends `view.off` and closes; no uplink payloads are sent over
  it.
- State rules: `area` replaces chunk and `rev` (even if lower); `area.patch` requires `rev` = last + 1 (item with `lot`
  replaces building, without `lot` merges, `removed` deletes); gaps, unknown chunks, or partial building items not
  present locally request `resync {chunk}` (at most once every 5 s per chunk) and patch is dropped; only 3×3 chunks
  around local position are retained (last `pos`, own ID in `players`, or last `move`); `players` modifies only existing
  players (by ID); `player.join` replaces profile; `afk` lasts until movement, turning, `view`, or `profile`. All
  in-memory only, nothing in logs.
- `POST /api/world/cmd` `{stream, cmds}` → `202 {sent}`: 1 to 20 commands, only `move`, `profile`, `resync`, `view`,
  `view.off`, `enter`, `leave`, `like`, `unlike`, `greet`, `block`, `unblock`, and `report`, rebuilt field by field
  (`parseSceneCommand`; `hello`, `uplink`, and `ping` never: 400 `invalid`); from each batch only the last `move`. Up to
  5 batches per second per stream (bucket of 5, refill 5/s: one batch every 200 ms is never refused; 429 `rate_limited`
  with `Retry-After: 1`). Closed stream: 409 `no_stream`; disconnected: 409 `not_connected`. `view` and `view.off`
  indicate if that stream wants city data (viewer decides what goes to world; `view` with city open restarts
  everything).
- In browser, `client/src/net/world-stream.ts`: `createWorldStream({mock})` with `on`, `send` (queue and one batch every
  200 ms) and `close`; in demo mode, `FakeWorldStream` (20 buildings with local one in lot (3,1), 5 people walking on
  sidewalks and one sitting on a park bench, minimap, `afk` after 60 s; `?perf=N` fills N batches).

## Environment variables

| Variable | Default | Usage |
| --- | --- | --- |
| `HABBLAUD_PORT` | `4747` | HTTP port |
| `HABBLAUD_HOST` | `127.0.0.1` | Interface (Docker uses `0.0.0.0`); outside loopback, terminal (and permissions/messages) is disabled |
| `HABBLAUD_BIND` | — (Compose: `127.0.0.1`) | Docker only: host interface where port is published, passed to container; loopback only enables terminal |
| `HABBLAUD_TERMINAL` | — | `0` disables terminal, permissions, and office messages (will not enable on exposed port) |
| `HABBLAUD_CODEX` | enabled | `0` disables Codex source |
| `HABBLAUD_CODEX_DIRS` | — | Comma-separated Codex directories; overrides detection (`CODEX_HOME` and `~/.codex*`) |
| `HABBLAUD_CODEX_BIN` | `codex` in PATH | Codex binary for `codex queue` (Node mode and `npm run codex:bridge`) |
| `HABBLAUD_MENSAGENS` | enabled (with terminal) | `0`, `false`, `off`, or `no` disables office messages only |
| `HABBLAUD_CLAUDE_DIRS` | — | Comma-separated config dirs; overrides detection (`~/.claude*` with `projects/` or `sessions/` + `CLAUDE_CONFIG_DIR`) |
| `HABBLAUD_DATA_DIR` | `~/.habblaud` (Docker: `/data`) | Habblaud state (project names and characters persisted in `names.json`, timeline in `timeline/`, My day stats in `stats/`, last version check in `updates.json`) |
| `HABBLAUD_TIMELINE` | enabled | `0` disables timelapse timeline recording |
| `HABBLAUD_UPDATE_CHECK` | enabled | `0` disables new version checks (releases from `package.json` repo on GitHub, every 6 h) |
| `HABBLAUD_LANG` | system language (`LC_ALL`/`LANG`/Intl) | Language of server-assembled texts: `pt-BR` or `fr` (shared/i18n.ts) |
| `HABBLAUD_DEMO` | disabled | `1` enables demo mode on startup |
| `HABBLAUD_IN_DOCKER` | auto (`/.dockerenv`) | `1` = skip PID checks (they belong to host) |
| `HABBLAUD_ACCOUNTS` | — | JSON with account metadata from host (Docker): `[{id, configDir, mountDir, short, name, email, organization, plan, color, cachedUsage}]`, matched by `id`, `mountDir` or `configDir` |
| `HABBLAUD_USAGE_DIR` | `~/.habblaud/usage` (Docker: `/usage`) | Directory for usage captured by statusline tap or Claude Code mod, re-read every 5 s |
| `HABBLAUD_ALLOWED_HOSTS` | — | Extra allowed names in `Host`/`Origin` (comma-separated); `localhost`, `*.localhost` and IPs always allowed |
| `HABBLAUD_WORLD_URL` | `https://server.habblaud.com` | Habblaud World server: `https://` or `wss://` only, no path; `http://127.0.0.1:*` in dev mode only (rejected leaves World disabled). Building connects via WebSocket on same origin (`/v1/socket`) |
| `HABBLAUD_WORLD` | enabled | `0` (`false`, `off`, `no`) disables Habblaud World: routes 404, nothing in UI, nothing outbound |
| `HABBLAUD_WORLD_DEV` | disabled (`--dev` enables) | `1` accepts world server on `http://127.0.0.1` or `ws://127.0.0.1` |

In permission hook (Claude Code environment; installer arguments `--port`/`--timeout` take precedence): `HABBLAUD_PORT`
(Habblaud port, default `4747`), `HABBLAUD_PERMISSION_TIMEOUT` (seconds to wait for Habblaud response, default `300`,
between 5 and 1800), and `HABBLAUD_HOOK_DEBUG=1` (reports actions to stderr).

## Plan usage (5h and weekly)

Two sources, both local files (no credentials or network calls); source with freshest numbers (`fetchedAt`) takes
precedence:

- `statusline` (**recommended**, `accounts/statusline.ts`): Claude Code sends statusline command a JSON object with
  `rate_limits` (`five_hour`/`seven_day`: `used_percentage` and `resets_at` in seconds). `scripts/statusline-tap.mjs`,
  installed in front of each account's statusline via `npm run usage:install`, writes only these numbers to
  `~/.habblaud/usage/<conta>.json` (matched to account by `configDir`; otherwise by `accountId`). In Claude Code
  2.1.287+ the Habblaud mod writes the same file (see below);
- `cache`: `cachedUsageUtilization` that Claude Code itself writes when running `/usage`, re-read every 60 s.

Without either, the account is marked `disabled` ("no usage data"). Numbers older than 30 min appear as `stale`. A
window whose reset time has passed since collection is omitted (the UI shows "—") until new numbers arrive — never an
invented 0%.

## Claude Code mod

The repository is also a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, details in
[`mod/README.md`](../mod/README.md)). On the server side, the `habblaud` mod uses two things:

- **the usage file:** on each `session.start` and `session.measure` it writes `<HABBLAUD_USAGE_DIR>/<conta>.json` in tap
  format (`{accountId, configDir, fetchedAt, five_hour, seven_day}`, `resets_at` in seconds, from
  `$.session.usage().rateLimits`) plus `source: "mod"`, which the reader ignores: for the server it remains the
  `statusline` source. The mod writes using `$.fs.write`, which is not atomic; therefore `StatuslineUsageReader` ignores
  an empty or partial read, keeps the last known good record from that file, and re-reads it on the next cycle;
- **`GET /api/mod/summary`** (`modSummary` in `http/app.ts`), polled every 5 s per rendering session (30 s when Habblaud
  is down) and by the `/habblaud` command: counts and waiting agents only, assembled from current snapshot. Excluded are
  demo agents (living only in snapshot, not in `Office`), agents already finished or delivered, and, with `?session=`
  (and `?account=`, if present), the caller's session: primary with that `sessionId` and its subagents (their
  `sessionId` is that of the triggering session; as a precaution, also any agent with an ancestor in it). `answerable` =
  permission request pending response from office (`AgentInfo.permission`). Without parameters, nothing is excluded
  (what `/habblaud` uses, so numbers match the screen). `GET`/`HEAD` only (otherwise 405).

## Structure

- `config.ts`, `log.ts`, `index.ts` — configuration, short logs (never conversation contents), and entry point.
- `accounts/` — account detection (`detect.ts`, also used by `docker-up`), usage (`usage.ts`), statusline tap
  (`statusline.ts`), service (`service.ts`).
- `sources/` — session registry, incremental reading (`tail.ts`), transcript parser (activities in `transcript.ts`;
  terminal conversation in `terminal.ts`; GitHub events in `github.ts`), subagents, session history (`history.ts`), and
  orchestrator (`watcher.ts`).
- `model/` — office (`office.ts`), rooms/slots (`rooms.ts`), persisted names (`names.ts`).
- `http/` — edge guard (`guard.ts`), routes (`app.ts`), SSE (`sse.ts`), terminal (`terminal.ts`) and its history
  (`sessions.ts`), timelapse (`timeline.ts`), My day (`stats.ts`), statics (`static.ts`).
- `history/` — timelapse timeline recorder (`timeline.ts`) and My day statistics: sampling, persistence, and retention
  (`daystats.ts`; pure accumulator is in `shared/daystats.ts`).
- `permissions/` — answering from office (permissions and questions): request registry (`registry.ts`), routes
  (`http.ts`), and transcript call search (`transcript.ts`).
- `messages/` — messages from office: queue, session presence, and timeouts (`registry.ts`) and routes (`http.ts`).
- `updates/` — new version checks on GitHub releases (`checker.ts`).
- `world/` — Habblaud World: session in `world.json` (`settings.ts`), world server client (`client.ts`), ALTCHA
  (`altcha.ts`), account (`service.ts`), `/api/world/*` routes (`http.ts`), and building in world (`uplink.ts`, with
  `ids.ts`, `tokens.ts`, `theme.ts`, and `signals.ts`).

Tests: `npx vitest run server shared` (synthetic fixtures in `server/test/fixtures.ts`; host scripts — statusline tap,
permission hook (run as process against a test server), installers, and `docker-up` — are tested in `server/test/` with
mock HOME and config dirs).
