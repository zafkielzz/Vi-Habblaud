---
description: List the open offices (and the ended ones a resume brings back), or close one with "rm <office>"
argument-hint: "[rm <office | ended session id>]"
allowed-tools: Bash(office-boss:*)
---
!`office-boss --soft offices $ARGUMENTS 2>&1`

The user ran /offices: the lines above are the result. Show them to the user as they are (a short list), add nothing
else, and do not start any work.
