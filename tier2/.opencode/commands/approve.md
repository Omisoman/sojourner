---
description: Approve a waiting deploy after one last look
summary: "Show what the task carries — patch sha256, commits, files, diffstat, scorecard — with ops_queue.py, then run approve.py for it. Stops if the task is not input-required; OpenCode asks the operator to confirm before anything runs."
---

Approve task `$ARGUMENTS`.

1. Run `python /opt/sojourner/tier2/ops_queue.py $ARGUMENTS` and show its
   state, summary and evaluation verdict (the question-set pass rate against
   its threshold).
2. Show what is actually being approved, from the same output: the patch
   sha256, the commit subjects, the files touched and the diffstat. An
   approval covers that code — not the summary line.
3. If it is not `input-required`, stop and say why — never retry around it.
4. Otherwise run `python /opt/sojourner/tier2/approve.py $ARGUMENTS` (OpenCode
   asks the operator to confirm) and report the final state, the staging URL
   and the hash of the deploy event it wrote to the audit chain.
