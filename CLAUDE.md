# sojourner — operating rules

Two-tier governed developer harness ("Sojourner"): an OpenCode developer sandbox (tier 1)
and an A2A ops agent with its operator console (tier 2), plus the staging copy of the app
they ship. The workspace project is **new-horizons** (the farm analytics app, sibling
checkout `../new-horizons`). Offline, one MacBook Pro, 16 GB. MIT, synthetic.

## Run

- Pre-flight in New Horizons: `make -C ../new-horizons db-up mock kb` — the image bakes that
  checkout AND its generated `data/` (`demo2-build` refuses to run without it).
- `make demo2-build && make demo2-reset && make demo2-up` → `make demo2-verify` →
  `make demo2-attach` (tier-1 developer, tmux `sojourner`) and `make demo2-ops` (tier-2
  operator console, tmux `sojourner-ops`); staging (the deployed app) on
  http://localhost:8080. `make demo2-down` closes both sessions and the stack.
- `demo2-up` runs New Horizons' `db-up` first: New Horizons' compose owns the Postgres container, its
  volume and the INTERNAL `horizons-db` network tier-2 and staging join (external here). One
  database, one hash-chained audit chain for the app and the harness. Then `gitea-init.sh`
  creates the ops user and makes Gitea's `main` + tag `sojourner-base` follow the baked
  baseline (force-pushed when a rebuild changed it — that branch is only ever the baseline).
- `demo2-reset` after EVERY `demo2-build`: `tier-entrypoint.sh` marks a seeded workspace
  done, so a rebuilt image never reaches an existing volume — without the reset the stack
  runs the old baseline and tier-1's patches stop applying on tier-2. It clears the tier
  workspaces and staging (tree, run state, data); Gitea and New Horizons' chain survive.
- `make demo2-verify` (`infra/scripts/verify-walls.sh`) is the sandbox proof: egress blocked
  three ways (HTTPS, DNS, git) in tier-1, tier-2 and staging; tier-1 rootfs read-only, no
  Gitea/DB/JWT secret, no route to Postgres; agents + the four skills discoverable from
  `/workspace/project`; a headless `SANDBOX-OK` round-trip through `llm-proxy`; the offline
  suite inside tier-1; A2A hello (bearer → completed, no token → rejected).
- Tier-1 workspace = a `git clone` of the baked New Horizons checkout (`/opt/sojourner/horizons`, one
  commit with fixed dates, tag `sojourner-base`, identical SHA across builds). Tier-2 holds
  its own clone of the same commit. No git remote, credentials or shared volume crosses.
- Python in the sandbox: ONE environment, `/opt/venv`, installed from this repo's lock —
  New Horizons' exact pins + the A2A server's packages (`tests/test_lock.py` keeps them equal; if
  a fresh resolve drifts: `cp ../new-horizons/uv.lock uv.lock && uv lock`). It never
  contains New Horizons itself; `PYTHONPATH` decides which New Horizons runs: tier-1 → the workspace
  (`/workspace/project/src`), tier-2's server → the BAKED baseline, tier-2's tools → the
  patched checkout, staging → the deployed tree. uv in the sandbox is offline, frozen and
  never syncs (`UV_OFFLINE`/`UV_FROZEN`/`UV_NO_SYNC`, `UV_PROJECT_ENVIRONMENT=/opt/venv`):
  `uv run pytest -q` and `uv run lint-imports` work; a new dependency cannot arrive.
- Data home: New Horizons' `HORIZONS_DATA` moves only generated data (analytics, KB, samples, UI
  settings, audit mirror) — tier-2 `/workspace/farm/data`, staging `/srv/farm/data`, both
  seeded from the bake (`/opt/sojourner/farm-data`). Never `HORIZONS_HOME` for that: it moves
  the repo root with it (docs/, the logo under assets/).

## The tiers

- Tier-2 skills (A2A) → tools, ORDER fixed in server code, never model discretion. Phase A:
  `gitea_pr` (branch + PR with the real changed files) → `build_run` (`uv lock --check` +
  `uv sync --frozen --dry-run` that must be a no-op — a same-version re-link is not a
  change — + `pytest -m "not model"` with the database route removed) → `validate_run`
  (import-linter, `ingest.run --dry-run`, `tests/test_validation.py` AND `tests/test_views.py`
  on the shared DB — every page EN+AR; a skipped module counts as a fail) → `evaluate_run`
  (New Horizons' question-set scorecard on `evaluation.model`, pass ≥ `evaluation.min_pass_rate`)
  → `input-required`. The gate judges by the BAKED baseline: threshold from the server's own
  import of rules.yaml, question set and grader from `/opt/sojourner/horizons` — the patch is
  only on PYTHONPATH. Phase B after `approve.py` (admin JWT): `deploy_staging` → `notify`;
  then the SERVER (not a tool, not the model) writes ONE audit event `record_deploy(ref,
  approved_by=<role:sub from the JWT>, task_id, …)` → `{source: sojourner, kind: deploy}`,
  which New Horizons' Changes page lists. LLM review in evaluate is a signal, never a gate.
- Staging = the tier-2 image under `infra/scripts/staging-run.sh`, behind caddy (staging
  itself is internal-only — it runs agent-written code). `deploy_staging` ships
  `git archive HEAD` (the reviewed commit, nothing untracked) to `/srv/staging/app`, keeps
  the previous tree in `.prev/app`, writes the stamp; the supervisor restarts Streamlit on a
  new stamp and reports what it serves in `/srv/staging-run/serving`, which the deploy waits
  on before its health check. No docker socket anywhere near the agents.
- Agent config: OpenCode walks up only to the GIT WORKTREE ROOT, and tier-1 works inside one
  (`/workspace/project`) — so `/workspace/.opencode` is invisible from there. `.opencode` is
  mounted a SECOND time inside the worktree (read-only, in the clone's `.git/info/exclude`,
  so it never reaches a commit, patch or PR), and `tier-entrypoint.sh` tolerates that nested
  read-only mount. Verify with `opencode debug config` / `opencode debug skill`, always via
  `docker exec -w /workspace/project` (tier-1) or `-w /workspace` (tier-2) — `opencode` has
  no `-w` flag, and without the workdir you get the baked `/opt/sojourner` config.
  `default_agent` must name an agent that exists.
- Handoff: tier-1 COMMITS, then `a2a_delegate` sends `git format-patch sojourner-base..HEAD`
  + its sha256 over A2A (a dirty tree is refused; build/validate/evaluate/deploy need
  commits). Tier-2 rebuilds from `sojourner-base` and replays it in server code
  (`new_horizons.shared.patch.apply`) — never in a model prompt; a sha mismatch is
  refused and audited; every replay starts from the baseline.
- ONE RECORD per tier: `tier{1,2}/core.json` (schema `sojourner/terminal-agent/1`, no client
  block, platform `AGENTIZATION-CORE DEV`) — identity, inference, agents, catalog role,
  books, documents, connections, permissions, guards, approvals (`rules` = the baked
  rules.yaml), audit channel, home. Bind-mounted read-only at `/workspace/core.json`, baked
  at `/opt/sojourner/core.json`. `make core` compiles each `.opencode/opencode.json` from it
  — never hand-edit opencode.json; `tests/test_core.py` diffs it. The record's sha256
  (sorted keys, compact) is the `core <12 hex>` in the TUI; `core-compile.py --sign` prints it.
- TUI = one OpenCode plugin for both tiers: `infra/tui/` (mounted at `/opt/sojourner/tui`,
  loaded by path from each tier's `tui.json`). `lib/env.ts` loads the record
  (`SOJOURNER_CORE`, default `/workspace/core.json`; missing or invalid = hard error) and
  derives everything from it — no tier-number branching in `ui/`, `lib/` or
  `sojourner-ui.tsx` (a test greps). Keep solid-js out of `lib/`; `bun test` in `infra/tui`
  runs on the host. SETTINGS is the grouped console (AGENT · CATALOG · GOVERNANCE · MEMORY);
  NO DWELL INFERENCE — ABOUT shows authored `summary:` frontmatter (60–300 chars, YAML-quoted),
  a model brief only on `s`. The approval card shows the gates: patch · build · validate ·
  eval, then deploy · smoke. Books are braille covers (`make books`). Tier-2 publishes
  commands/skills/books/prompts into the `catalog` volume; tier-1 mounts it read-only.
- Lane inside the tiers: `make llm-target MODE=…` runs New Horizons' `scripts/llm-target.sh`, which
  rewrites New Horizons' `.env` and this repo's `tier1.env`, `tier2.env` and `staging.env`
  (`LLM_PROVIDER`, `LLM_LANE_URL`): inside a container `LLM_BASE_URL` is `llm-proxy` on every
  lane, so SETTINGS → Inference reads the lane from those. Restart the stack after a switch.
- Brand: `make brand` (`scripts/brand-sync.py`) writes the OpenCode theme `sojourner.json`
  (both tiers: tui-themes' `console` roles in AC design tokens) and the TUI's
  `brand/{tokens,mark,chips}.json`, SAMPLED from New Horizons' generated `ac-mark.svg` /
  `ac-wordmark.svg` onto braille dots. Never trace or hand-draw a mark.
- Tests/lint: `make test` (records, patch channel, tier-2 tools, compose walls, lock parity,
  TUI, brand; `stack`-marked tests need the stack, `model` needs Ollama); `make lint` = core
  + brand + books `--check` + `make client-free`. CI runs `pytest -m "not model"` + lint.

## Hard rules

- **Sequencing**: never run new-horizons' `make demo1` and this stack together (16 GB
  budget). Postgres alone is fine — it is the same container.
- **Never install vLLM locally** — no Metal backend. Every LLM call stays on the
  OpenAI-compatible endpoint; the Claude lane runs behind the LiteLLM gateway (`--profile
  claude`) so the key never enters a tier. **Never imply local inference on a remote lane.**
- **Memory budget**: one 8B chat model resident; `num_ctx` 8192 (`OLLAMA_CONTEXT_LENGTH`).
  OpenCode's own prompt is ~6.9k of it: a whole-file read of a large view truncates the
  instruction. Author at 8B by naming the file and the lines (narrow read, exact edit), say
  "do it now", and judge by `git show --stat HEAD`, never by the narration (`docs/DEMO.md`).
- **Tool calling**: JSON tool protocol only (`shared/harness/protocol.py`) — never
  `bind_tools`; the tier-2 graph runs identically on qwen3:8b, llama3.1:8b, deepseek-r1:8b.
- **Walls are topology, not prompts**: tier-net, ops-net and horizons-db stay `internal: true`;
  only llm-proxy/litellm route out and only caddy publishes a port (`tests/test_compose.py`).
  tier1.env never gets Gitea, database or deploy credentials.
- **OpenCode pinned to 1.18.30** (Dockerfile ARG + both `.opencode/package.json`): slot names
  and internals the TUI relies on are that version's.
- **Synthetic and client-free**: `make client-free` stays green; no real company, farm or
  person; never name competing products.
- **No Claude attribution** in commits, PRs or docs.
