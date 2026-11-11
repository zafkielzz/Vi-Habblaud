---
description: Every worker's quota use now (5 hours, week); in a boss session, workers near their limit leave the office
allowed-tools: Bash(office-boss:*)
---
!`office-boss --soft quota 2>&1`

The user ran /quota: the lines above are the result. Show the table to the user as it is and add nothing else; give
jobs only to the workers of the office listed at the end. Do not start any work.
