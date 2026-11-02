# Worker scripts for the office

Habblaud shows a boss and its workers; these scripts are how the boss gives them jobs. `agy-ask` and `claude-ask` send a
job to an Antigravity (`agy`) or Claude Code account and print only the final answer, so the boss spends no tokens on a
worker's reasoning. Every job is a new conversation.

Needs Linux, Python 3, Claude Code, and for Antigravity workers the `agy` CLI, `dbus-daemon` and `gnome-keyring-daemon`.
`agy-up`, `agy-mode` and `agy-sync` also need `herdr`.

## Install

```bash
tools/agy/install.sh
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
