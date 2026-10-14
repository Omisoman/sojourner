---
description: Show the tier-2 queue and what waits for approval
summary: "List the tier-2 queue with ops_queue.py: tasks waiting for approval with their evaluation verdict, then anything failed or rejected since the last deploy. No advice unless asked."
---

Run `python /opt/sojourner/tier2/ops_queue.py` and report, in this order:

1. Tasks waiting for approval (`input-required`): id, summary, evaluation
   verdict — one line each.
2. Anything failed or rejected since the last deploy, with the reason.
3. Nothing else. No advice unless asked.
