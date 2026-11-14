---
name: agy-orchestrator
description: Give jobs to worker agents with `agy-ask` (Antigravity accounts acc1..acc6) and `claude-ask` (Claude Code accounts), within the team the user set in Habblaud. Use when the user asks to delegate/giao việc/chia việc to other agents, check what a worker returned, or run work in parallel across accounts.
---

# agy orchestrator

You plan; workers execute. Hard or judgement-heavy work, merging results and the final check stay with you; workers get
heavy-but-routine work (reading many files, bulk edits, code or tests from a clear spec, running tools). Trivial
one-liners: do them yourself.

## Giving jobs
```bash
agy-ask acc2 "<prompt>" --role <label> --mode <plan|accept-edits|default> --effort <low|medium|high> [--cwd DIR] [--max 2000] [--timeout 900]
claude-ask .claude-work "<prompt>" --role <label> --mode <default|plan|accept-edits> --effort <low..max> [--model sonnet] [--full] [--cwd DIR] [--max 2000] [--timeout 900]
```
- Both print only the worker's final answer (capped at `--max` chars). Each call is a fresh conversation; it blocks
  30s-3min, so run it with `run_in_background`, several in parallel on different workers.
- Never run bare `agy`: it uses the machine's real account. `agy-ask` / `agy-as` give each account its own HOME,
  D-Bus and keyring.
- A worker id ending in `#2`, `#3` (`acc2#2`, `claude:.claude#3`) is a clone: one more session of that account, own
  terminal and BUSY, shared quota. Name workers exactly as `agy-ask team` lists them.
- With the office running (Habblaud) the job goes into the worker's own terminal and the command waits on the server;
  never read or type into a worker's terminal. Without it, the same command runs headless. Same answers, same exit codes.
- Killing the command or `--timeout` cancels the job. Always pass `--role` (`impl`, `qa`, `review`, `research`...).
- Jobs are logged with tokens in `~/.agy_profiles/agy-ask.log.jsonl`: read it to see what a job really cost.

| Exit | Meaning | What you do |
| --- | --- | --- |
| 0 | done | check the answer, use it |
| 1 | failed / timeout | read stderr; retry once or do it yourself |
| 2 | refused by the team rule or the office rules | do not retry or work around it (office rules: skill `office-rules`) |
| 3 | BUSY | give it to another worker or wait |
| 4 | the user cancelled it | do not resend unasked; tell the user |

## Team rule: only a boss gives jobs, only to its office's workers
Offices are set by the user in Habblaud (`~/.agy_profiles/team.json`, never edit it). Run `agy-ask team` before
delegating: it marks the office you are boss of (`<- you are its boss`). Give jobs only to that office's workers. If you
are not a boss, do not delegate: do the work yourself or tell the user they can type `/boss`. Never set
`AGY_ASK_FROM_OFFICE` or `AGY_OFFICE`. The user changes workers with `/workers add | clone | rm` and checks quota with
`/quota` (never run these yourself). A worker near its quota leaves the office (exit 2): use another account.

## The split: the boss is the brain, workers implement (user rule, 14/11)
Your subagents and same-account `claude-ask` spend the same Claude quota as you; Antigravity is a separate pool that
usually sits idle (12/11: Claude at 92% of its 5-hour limit while acc1..acc6 sat at 0-1%). So:
1. **You** plan, decide, coordinate and review: split the work, write each spec, read the diffs/screenshots, accept or
   send back. You do not implement anything over a few lines.
2. **Antigravity workers implement**, by default all of it: code from your spec, tests, content, bulk edits, docs,
   running tools and suites, read-only surveys. One file (or file set) per worker, in parallel.
3. **A spec is a contract**: goal, exact files and line ranges, the shape of the code (signatures, data layout, where it
   hooks in), what not to touch, done criteria that a command checks (tsc, a named test, a screenshot path), answer
   length. Vague spec = vague code; the spec is where your quality goes.
4. **Claude subagents are the exception**, and you say so when you use one: a worker failed the same job twice, or the
   job is mostly judgement (visual tuning by eye, a subtle bug hunt, a design with many edge cases). A fresh subagent
   beats a long back-and-forth with you.
5. **Keep your own turns few**: every boss turn re-sends the whole conversation, so batch (one wave of specs, one review
   pass), let workers run the checks and report, and do not ping-pong small fixes; send one consolidated fix list.
   Under a few lines: just do it yourself.
- `claude-ask` costs ~8k tokens of start-up per job on the worker's account; it pays off for big-read jobs on another
  account. Workers start lean (Bash, Read, Edit, Write, WebFetch, WebSearch); `--full` only when the job needs MCP or
  skills. The worker must trust `--cwd` (else it fails in ~15 s saying so: ask the user to open claude there once).

## Mode and effort (you choose, every call)
Antigravity workers run Gemini 3.8 Flash only: never pass `--model`.

| Job | `--mode` | `--effort` |
| --- | --- | --- |
| Lookup in named files, grep/count, format conversion, simple labelling | `plan` (read) or `accept-edits` (writes) | `low` |
| Summarise several files, code or tests from a clear spec, bulk edits | `plan` / `accept-edits` | `medium` |
| Review, audit, root-cause debugging, multi-file plan | `plan` | `high` |
| Batch labelling with the data inside the prompt | `default` (plan mode drafts a plan instead) | `low`/`medium` |

`plan` = read-only; `accept-edits` = may edit inside `--cwd`; `auto` is not available. If a `low` job comes back
shallow, rerun at `medium`, not `high`.

## What drives worker cost (measured)
- Fixed overhead ~9.8k tokens per job (agy's own tools and rules); the office wrapper adds ~1% (14/11).
- Steps, not mode: each step re-sends the whole context, so read-only jobs run 50-300k tokens and edit jobs far more.
  The cheapest lever is naming exact files, line ranges or pasting the snippet so the worker does not explore.

## Pitfalls
- A prompt that contains `${...}`, backticks or `$(...)` (code snippets!) breaks inside a double-quoted shell argument
  ("bad substitution", job never starts). Write the prompt with a quoted heredoc (`cat > p.txt <<'EOF'`) and pass
  `"$(cat p.txt)"`.
- `--cwd` must be the directory the worker writes to; say "only write inside DIR" (writing outside hung 14 min).
- A worker that exits at once with `jetski: no output produced ... auto-denied` lacks `permissions.allow` in its
  profile settings: give the user the command, do not edit those settings yourself.
- Never let two workers edit the same file; have each write its own fragment and merge yourself.
- Batch scripts must call `agy-as accN`, never `agy` with only HOME changed (all "accounts" then ran on one).
- Kill runners by explicit PID; `pkill -f` matches your own shell too.
- Flash is reliable on mechanical work and over-claims on judgement (in one audit ~1/4 of "High" findings were false):
  re-check every important finding yourself or with a second worker.
- Worker-to-worker: never direct; worker A writes a file, you then give worker B a job that reads it.

## Prompts
Self-contained (workers share no context): goal, exact files/dirs, constraints, definition of done, answer length
("reply in <= 25 lines"). Write prompts and ask for answers in English (Vietnamese costs 30-50% more); files meant for
people stay in the user's language; quotes stay verbatim.
