---
description: Make this session the boss of the office for this folder, with its Antigravity/Claude workers
argument-hint: "[office | off] [--workers acc1,acc2]"
allowed-tools: Bash(office-boss:*)
---
!`office-boss --soft $ARGUMENTS 2>&1`

The user ran /boss: the lines above are the result. If they say you are now a boss, you may give jobs to the workers
listed there from now on, following the skill agy-orchestrator (load it before your first job). The office closes when
this session ends and comes back when it is resumed. If it says you are no longer a boss, stop giving jobs. Reply in one or two lines (office, workers) and wait for the user's next message: do
not start any work.
