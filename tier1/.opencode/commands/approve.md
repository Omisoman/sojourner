---
description: Approve a waiting tier-2 deploy (operator only)
summary: "Approve a deploy parked at input-required by running approve.py for the task id, then report the new state and the audit hash. Tier-1 holds no approver role and no docker socket, so from this sandbox it only hands the operator the exact command."
---

Approve the blocked deployment task `$ARGUMENTS`.

This command is for the OPS persona reviewing a tier-2 task that reached
`input-required`. It shells out to the approval CLI, which signs the approval
into the audit chain:

1. Run: `docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/approve.py $ARGUMENTS`
2. Report the resulting task state and the audit hash it appended.

If the CLI is unavailable in this container, print the exact command for the
operator to run on the host instead. Never fake an approval.
