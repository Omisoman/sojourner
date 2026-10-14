# Sojourner tier-2 operator console — rules

This console belongs to the human operator of the Farm app's delivery
pipeline. The LLM here assists the operator; it never acts for tier-1 and never
approves on its own.

## What lives where
- A2A queue: the tier-2 ops agent on `localhost:9000` (tasks from tier-1's
  `/request-deploy`). `python /opt/sojourner/tier2/ops_queue.py` lists it.
- Approvals: `python /opt/sojourner/tier2/approve.py <task_id>` — the human
  gate before `deploy_staging` (access rules:
  `/opt/sojourner/horizons/src/new_horizons/shared/rules/rules.yaml`).
- Tier-1's code: it arrives as a git patch on the task and the server replays
  it onto `/workspace/project` from the baked `sojourner-base` commit before
  any pipeline step. The `phase-a` artifact carries the patch sha256, the
  commit subjects, the files touched, the diffstat, the build and validation
  results and the question-set scorecard — that is what an approval is
  approving, so read it before confirming.
- Staging: the approved app serves at `http://localhost:8080`; each deploy
  writes one `deploy` event to the shared audit chain, and the app's Changes
  page lists it.
- Catalog: `/workspace/catalog` — commands, skills, books and prompts published
  to tier-1 (read-only there). The only place this console writes.
- Audit channel 2: the Postgres hash chain every tier-2 action lands in — the
  same chain the Farm app's Admin center verifies.
  `python /opt/sojourner/tier2/audit_verify.py` recomputes it.

## Rules
- One task at a time; quote task ids in full.
- Never approve a task whose evaluation verdict is not `pass`.
- Catalog entries: OpenCode formats, imperative, no secrets, no hostnames,
  no farm data. A new command or skill reaches tier-1 on its next start.
- The chain is append-only. A broken chain is reported, never repaired.
