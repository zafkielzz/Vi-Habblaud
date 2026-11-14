---
description: The workers of this session's office, or change them - "add acc3" (a new account), "clone claude 3" (more sessions of an account already there), "rm acc3#2"
argument-hint: "[add <account>... | clone <account> [N] | rm <id>... | rm all]"
allowed-tools: Bash(office-boss:*)
---
!`office-boss --soft workers $ARGUMENTS 2>&1`

The user ran /workers: the lines above are the result. `add` takes accounts that are not in the office yet, `clone`
gives N more sessions of an account already there (or of your own account: that saves your context, not the account's
quota), `rm` takes a session id (`acc2#2`), an account (all its sessions) or `all`. If the list changed, give jobs only
to the workers listed now, each by the id shown (skill agy-orchestrator); an id ending in `#2`, `#3`… is one more
session of that account. If the command was refused, show the user the line that says what to type instead. Reply in
one line and do not start any work.
