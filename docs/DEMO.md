# Sojourner demo — governed dev tiers on new-horizons (6 min)

One MacBook, 16 GB. Never run new-horizons' `make demo1` and this stack
together; Postgres alone is shared (New Horizons' container, volume and audit chain).

## Pre-flight (before the room)

```sh
# in ../new-horizons — the farm data the image bakes and the gate reads
make db-up mock kb
# here
make demo2-build && make demo2-reset && make demo2-up   # reset is NOT optional after a build
make demo2-verify                                        # walls + wiring, ~1 min, must say "all checks passed"
ollama run qwen3:8b "مرحبا"                              # warm it; it idles out after 10 min
open http://localhost:8080                               # staging: the baked baseline until the first deploy
```

`demo2-reset` clears the tier workspaces and staging — a rebuilt image never
reaches an existing volume, so without it the demo silently runs the OLD
baseline (and tier-1's patches stop applying on tier-2). Gitea and New Horizons'
audit chain survive; `demo2-up` re-points Gitea's `main` at the new baseline.

`make demo2-verify` is the whole sandbox story in one command: egress blocked
three ways (HTTPS, DNS, git) in tier-1, tier-2 and staging; tier-1's rootfs
read-only, no credentials, no route to the database; the agents and the four
skills discoverable from `/workspace/project`; a headless OpenCode round-trip
answering `SANDBOX-OK` through `llm-proxy`; the offline suite inside tier-1
(`uv run pytest -q`: 298 passed, 78 skipped — the skips need a database tier-1
cannot reach); A2A hello — tier-1's bearer gets a completed task, no token gets
rejected.

## The walk

| min | action | say |
|---|---|---|
| 0–1 | `make demo2-attach` — Terminal 1: the AC mark, the prompt with **PROJECT new-horizons · MODEL · SETTINGS**, footer **AGENT · PLUGIN · AUDIT CH-1 · ALERTS** | "A developer agent in a sealed container: no internet, no credentials, read-only governance files, audit on every tool call. Its project is a real app — the farm analytics app next door." |
| 1–2 | **SETTINGS → Identity** (`core …` signature) → **Books** → **Permissions** (36 rules) → **Connections** (tier-2's A2A card) | "Compiled from one record, `tier1/core.json`. The conventions are books it reads; the permissions are rules, not promises." |
| 2–3 | Ask for the change (see *Authoring*). In the shell (`ctrl-b t`): `git show --stat HEAD`. Then `/request-deploy` | "Judge an agent by its diff. It has no way to deploy — it hands a hash-identified patch to ops over A2A." |
| 3–4 | `make demo2-ops` — Terminal 2: **ALERTS → Approvals**: the card shows the commit, the file and six gates (patch · build · validate · eval, then deploy · smoke after approval); `s` writes a brief → `enter` → Confirm | "Build is the lock plus the suite. Validate is the import contracts, the knowledge base and every page rendered on the real data. Eval is the bilingual question set on a second model. A human approves what they can see." |
| 4–5 | Browser: reload `localhost:8080` → **Patterns**: the new title. Then **Changes**: the deploy, its approver, its evaluation | "Staging runs exactly the approved commit. And the app itself lists what shipped — read from the same hash-chained log as every decision in it." |
| 5–6 | Terminal 2: **SETTINGS → Audit → Verify hash chain** | "One chain for the app and the harness. `audit_verify.py` re-walks it." |

Measured (2026-10-14, qwen3:8b drives both tiers, the gate scores on
llama3.1:8b): **87 s** from request to the approval gate — Gitea PR 1.5 s,
build 7 s, validate 9 s, the 26-question scorecard 44 s (96 %, bar 75 %), the
rest the ops agent's own model calls — and **54 s** from approval to staging
serving the new commit (`deploy_staging` itself 4 s). The deploy then appears
on new-horizons' Changes page, on staging and on the host app alike.

## Authoring — what is honest at 8B

OpenCode's own system prompt and tool schemas take ~6.9 k of the 8,192-token
context. A whole-file read of an 11 KB view overflows it and Ollama keeps the
tail — the instruction is gone, and the agent summarises the file and asks what
to do (observed). So:

- **Name the file and the lines.** "Read `views/patterns.py` with offset 28 and
  limit 4, then edit `oldString` → `newString`, then commit" worked first time,
  in 98 s, with no truncation.
- **Say "do it now".** The 8B model defaults to handing steps back;
  `/request-deploy` tells it to do every step itself, in the turn.
- **Show `git show --stat HEAD` every time** — narration is not evidence.
- **For live authoring you can trust, change the lane**: `make llm-target
  MODE=rented URL=… MODEL=…` puts a 30B-class model behind the same walls, one
  URL, no code change.

## The strongest beat: the gate refusing a change the sandbox can't see

Commit, in tier-1's shell, a subtitle that "counts the units from the data":

```python
tr(f"{meta['grow_units']} grow units, five farm systems, one agent — …",
```

Tier-1 is green — its page tests skip, because tier-1 has no route to the
database. `/request-deploy` → the operator console shows the task **failed in
phase A (81 s)**, never reaching input-required: build ok, eval **pass**,
**validate ✗** — every page test errors with `KeyError: 'grow_units'` the
moment the app renders on the real farm data. Nobody was asked to approve it.

Say: "The sandbox passed it, the model-graded evaluation passed it. The
deterministic gate rendered every page on the real data and stopped it — before
any human was asked."

(Afterwards the 8B agent narrated invented causes — missing templates that do
not exist. The gate's record, not the narration, is the evidence.)

## Recovery

- **Model stalls / slow first token**: `ollama ps` — if two 8B models are
  loaded, `ollama stop <other>`; re-ask.
- **tier-2 task stuck**: `docker logs sojourner-tier2 --tail 20`; a restart
  loses in-memory tasks — re-run `/request-deploy` (the audit chain persists).
- **Staging blank after a deploy**: `docker logs sojourner-staging --tail 20` —
  the supervisor restarts it on every new stamp; `/srv/staging/.prev/app` holds
  the previous tree.
- **Patch refused as "does not apply"**: the tier workspaces predate the image —
  `make demo2-reset && make demo2-up`.
- **Memory pressure**: New Horizons' `make demo1` must be fully stopped; one 8B model
  resident.
