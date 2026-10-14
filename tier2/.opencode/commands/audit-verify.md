---
description: Verify the audit hash chain (channel 2)
summary: "Recompute the channel-2 hash chain with audit_verify.py and quote its verdict verbatim. A broken chain is reported with the row it breaks at, never repaired."
---

Run `python /opt/sojourner/tier2/audit_verify.py` and quote its one-line
verdict verbatim. If the chain is broken, name the row it breaks at and stop —
do not attempt any repair; the chain is append-only by design.
