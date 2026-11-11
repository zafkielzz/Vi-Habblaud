---
description: The workers of this session's office (who is working now), or add / remove some: "add acc3 acc4", "rm 2"
argument-hint: "[add|rm <acc3 or 3, claude:.claude-work>]"
allowed-tools: Bash(office-boss:*)
---
!`office-boss --soft workers $ARGUMENTS 2>&1`

The user ran /workers: the lines above are the result. If the list changed, give jobs only to the workers listed now
(skill agy-orchestrator). Reply in one line and do not start any work.
