# Worker scripts for the office

Habblaud shows a boss and its workers; these scripts are how the boss gives them jobs. `agy-ask` and `claude-ask` send a
job to an Antigravity (`agy`) or Claude Code account and print only the final answer, so the boss spends no tokens on a
worker's reasoning. Every job is a new conversation.

Needs Linux, Python 3, Claude Code, and for Antigravity workers the `agy` CLI, `dbus-daemon` and `gnome-keyring-daemon`.
`agy-up`, `agy-mode` and `agy-sync` also need `herdr`.

## Install

```bash
npm install
npm run mod:install    # Habblaud's Claude Code plugins: usage, messages and permissions from the page, boss rules
tools/agy/install.sh
npm run office         # builds and starts it in the background: open http://127.0.0.1:4747
```

It links everything from this folder into `~/.local/bin`, the Claude Code skills and each agy profile, so editing a file
here changes the installed one. Then, once per Antigravity account:

```bash
mkdir -p ~/.agy_profiles/acc1
agy-as acc1        # sign in with Google when asked
tools/agy/install.sh   # again, so the new profile gets the rules plugin
```

Never run a bare `agy`: it uses the machine's own account. Profiles hold sign-in tokens: keep `~/.agy_profiles` out of
any repository.

## What is here

| Path | What it does |
|---|---|
| `bin/agy-as` | Runs `agy` in one account's profile (own HOME, D-Bus, keyring) |
| `bin/worker-ask` | `agy-ask` and `claude-ask`: give a job, print its answer |
| `bin/office_rules.py` | Office rules, the Python twin of `shared/rules.ts` |
| `bin/rules-hook` | PreToolUse hook that enforces the office rules |
| `bin/agy-up`, `agy-mode`, `agy-sync` | Run workers in `herdr` panes, without the office |
| `bin/office-boss` | Appoint the calling Claude Code session the boss of the office for its folder (the deepest office holding it, else a new one with every signed-in worker; in `~`: the office "cli" with no folder limit), or of a named office; `off` steps down; `list` / `rm` manage the offices. A running office re-reads `team.json` within a second |
| `commands/boss.md` | The Claude Code command `/boss [office\|off]` (linked into `~/.claude/commands`): runs `office-boss` for the session you type it in, so you appoint a boss from the terminal |
| `commands/quota.md` | `/quota`: every worker's 5-hour and weekly use (agy `/usage`, no tokens; kept in `~/.habblaud/usage/agy:accN.json` for agy-ask's quota stop); in a boss session, workers near the limit leave the office and benched ones come back after their reset |
| `commands/workers.md` | `/workers [add\|rm <names>]`: the workers of this session's office (working now / free / not signed in) and the accounts that can be added |
| `commands/offices.md` | `/offices [rm <office>]`: the open offices and the ended ones a resume brings back (an office closes with its boss's session: `office_rules.tidy`, run by agy-ask, office-boss and `rules-hook boss` at every prompt) |
| `agy-plugin/` | `office-rules` (the hook inside agy) and `agy-boss` (loads the boss rules) |
| `boss/AGENTS.md` | Rules for an Antigravity boss |
| `worker-rules/GEMINI.md` | Rules for Antigravity workers |
| `skills/` | `agy-orchestrator` and `office-rules`, for a Claude Code boss |

## Using it

```bash
agy-ask team    # the offices, their folders, bosses and workers
agy-ask acc2 "<prompt>" --role impl --mode accept-edits --effort medium --cwd <project>
claude-ask .claude-work "<prompt>" --role review --mode plan --effort high --cwd <project>
agy-ask rules   # the office's rules
```

With Habblaud running the job goes to the worker's terminal in the office, which you can watch; otherwise it runs
headless. Exit codes: 0 done, 1 failed or timed out, 2 refused by the team or office rules, 3 worker busy, 4 cancelled
from the office.

Offices live in `~/.agy_profiles/team.json` and are edited in Habblaud. Optional `~/.agy_profiles/roles.conf` sets each
account's role and default mode (`acc2 impl accept-edits`; role `off` hides an account), and `names.conf` a display name
(`acc2 Alice`).

## Tests

```bash
python3 -m pytest tools/agy/tests
```

The rules run the same cases as the TypeScript code (`shared/rules.vectors.json`).
