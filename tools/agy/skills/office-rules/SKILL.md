---
name: office-rules
description: Read, check and propose an office's rules ("Nội quy") in Habblaud, and handle a job or tool call the rules refused. Use when you are the boss of an office, before giving a job outside the office folder, when agy-ask / claude-ask exits 2 with "office rules", when a tool call is denied with "Office rule (…)", or when the user asks about the office rules / nội quy.
---

# Office rules

Each office in Habblaud has rules the **user** sets on the page (📜 on the toolbar): where files may be edited (the
office folder plus extra folders), paths nobody may read or edit (`~/.ssh`, `.env`…), commands that may not run
(`git push`, `sudo`…), short rules for the boss and/or the workers, and limits (jobs running at once, the quota % at
which a worker gets no more jobs). They live in `~/.agy_profiles/team.json`; no rules set = the defaults.

**You cannot change them, and you must not try**: never edit `team.json` or `rules-log.jsonl` (the hook blocks it and
logs it). You may only **propose** a rule; the user accepts or rejects it.

## Read and check

```bash
agy-ask rules                         # the rules of your office, as you (the boss) read them
agy-ask rules --who workers           # what every worker job starts with
agy-ask rules check <path> [--write]  # would reading (or editing) this path be allowed? exit 0 allowed, 2 refused
agy-ask rules check --cmd "<command>" # would this command be allowed?
agy-ask team                          # offices, folders, bosses, workers
```

Add `--office <id>` when you are not the boss of that office. Check before you plan work outside the office folder
or give a job with `--cwd` elsewhere.

## Propose a rule

```bash
agy-ask rules propose "<the rule, one short sentence>" --why "<what happened that makes it useful>" [--for workers|boss|all]
```

Goes to the office (Habblaud must be running; only Habblaud writes `team.json`). Propose when something keeps going
wrong (a worker touched files it should not, a command broke something), not for one-off preferences. One rule per
proposal, short, testable. Then tell the user in one line what you proposed and why; do not wait for the answer.

## When the rules refuse something

| You see | Meaning | Do |
| --- | --- | --- |
| `agy-ask`/`claude-ask` exit 2, "`--cwd … is refused`" | the job's folder is outside the office's write scope (or in a denied path) | give the job a folder inside the office, or do it yourself if it is the user's request; if the scope is wrong, propose a change / tell the user |
| exit 2, "already runs N job(s) (limit N)" | the office is at its job limit | wait for a running job to finish (`run_in_background` jobs notify you), then ask again |
| exit 2, "has used N% of its quota" | that worker is at the office's quota stop | give the job to another worker of the office, or do it yourself |
| a tool call denied, "Office rule (…)" | your own edit, read or command is against the rules | stop that approach; do not work around it (another tool, `bash -c`, a script, a copy elsewhere). Report to the user what you needed and why |
| a worker's answer says a rule blocked it | the worker stopped as told | decide: change the plan within the rules, or ask the user |

Every refusal is already logged (`rules-log.jsonl`) and shows on the Board as 📜 news: do not log it again.

## What the rules are not

They are guardrails against mistakes, not a sandbox: every agent runs as the same Unix user. Follow their intent, not
just their letter: if a rule would block something, the way around it is also against the rules.
