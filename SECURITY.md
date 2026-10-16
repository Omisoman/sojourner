# Security — threat model of the Sojourner tier sandbox

Scope: the tier-1 developer sandbox, the tier-2 ops agent with its operator console, and
the staging copy of the app they deploy. The app itself (its chat agent, read-only
database role, document intake) is new-horizons — its threat model is in
[that repository's SECURITY.md](https://github.com/Omisoman/new-horizons/blob/main/SECURITY.md).

## Threat model

Adversary: a compromised or misbehaving coding agent inside a tier container
(prompt-injected instructions, a hostile file in the workspace, plain model error) — and
the code it writes, once that code runs on staging. Goals it must NOT achieve: reach the
internet, reach credentials it was not issued, alter its own governance or the gate that
judges it, tamper with the audit trail, deploy without a human.

## Enforced (by the container runtime / network, not by prompts)

| Control | Mechanism |
|---|---|
| No internet egress | `tier-net`, `ops-net` and `horizons-db` are `internal: true`. Only `llm-proxy` and the opt-in `litellm` sit on the NAT network `llm-egress`; only `caddy` sits on `staging-view` and publishes a port (`:8080`). `tests/test_compose.py` reads the compose file and fails if any other service gains a route out or a port |
| Agent-written code runs walled too | `staging` runs the deployed tree — code the agent wrote — so it sits on `ops-net` + `horizons-db` only, read-only rootfs, unprivileged; caddy fronts it |
| tier-1 reaches only tier-2 and the model | tier-1 is on `tier-net` alone: no route to Gitea, ntfy, staging or Postgres (`make demo2-verify` proves the Postgres one) |
| Model access without egress | a single-purpose socat `llm-proxy` bridges to the model endpoint and nothing else. On the `rented` lane its upstream is a GPU box; on the `claude` lane LiteLLM holds the API key. The tiers have zero routes out in every lane — but a remote lane's gateway does egress: say "one controlled egress point to our inference endpoint", never "nothing leaves the machine" |
| Non-root, no privilege gain | `user: agent` (uid 1001), `cap_drop: [ALL]`, `no-new-privileges` on tier-1, tier-2 and staging |
| Immutable rootfs | `read_only: true`; writable: `/workspace` (volume), `/tmp` and `$HOME` (tmpfs), staging's `/srv/farm` + `/srv/staging-run`. tmpfs carries `exec` (OpenCode's TUI extracts a native render lib) — `nosuid`/`nodev` remain, and the egress block caps what a dropped executable could do |
| Immutable governance | both tiers' `.opencode/`, `AGENTS.md`, `core.json`, `docs/` and the TUI plugin (`/opt/sojourner/tui`) are bind-mounted read-only, not owned by `agent`. The baked baseline (`/opt/sojourner/horizons`) is on the read-only rootfs |
| No dependency arrives unreviewed | uv in the sandbox is offline, frozen and never syncs; `/opt/venv` is root-owned. tier-2's build gate fails any patch whose lock would need a package or version the image does not hold |
| Credentials by container | per-service `env_file`: `tier1.env` holds only the model URL and its A2A JWT (role `tier1-dev`); `staging.env` holds the database DSNs and the model URL — no Gitea, A2A or deploy secret; only `tier2.env` carries ops credentials |
| Code crosses tiers as DATA, not access | `a2a_delegate` sends `git format-patch sojourner-base..HEAD` + its sha256 over the authenticated A2A call; tier-2 rebuilds from the baked baseline and replays it in server code — never in a model prompt. A sha mismatch is refused and audited; every replay starts from the baseline |
| The gate cannot be edited by the change it judges | tier-2's server imports the BAKED baseline; the evaluation threshold, question set and grader are read from it. The patched checkout is only on the tools' `PYTHONPATH` |
| Only the reviewed commit ships | `deploy_staging` exports `git archive HEAD` — untracked or ignored workspace files never reach staging |
| Deploy approval | `deploy_staging` is `approval_required` in rules.yaml; the task parks `input-required` until a human runs `approve.py` with an admin JWT (CLI or the tier-2 console, which asks first). The deploy event's `approved_by` comes from that JWT, written by the server — never by a model or a tool |
| Identity on every A2A call | HS256 JWT `role` field validated server-side; no token → task rejected with an access error, audited |
| Audit integrity | one hash-chained `audit_log` in New Horizons' Postgres (tier-2 and the app append to the same chain) + JSONL mirrors on dedicated volumes; `audit_verify.py` and New Horizons' tests re-walk it |

## Promised (defense-in-depth, bypassable by a determined agent)

| Control | Why it is soft |
|---|---|
| OpenCode `permission` block (edit paths, bash allowlist, `task`/`webfetch` deny) | config-level; `uv run *` is allowed and runs arbitrary Python inside the sandbox — the ro rootfs and the network are the real walls |
| `path-guard.ts` server plugin | in-process, same trust domain as the agent loop. Write root per tier (`SOJOURNER_WRITE_ROOT`: tier-1 `/workspace/project`, tier-2 `/workspace/catalog`) |
| Operator console's agent: edits only the catalog, `approve.py` behind an `ask` | OpenCode `permission` block — config-level, like tier-1's |
| Prompt rules in AGENTS.md / SYSTEM.md / the books | advisory by definition |
| LLM review in `evaluate_run` | a signal for the approver, never a gate — the gates are the lock, the suite, the import contracts, the KB dry run, the truth and page tests, and the scorecard threshold |

## Known trade-offs (deliberate, demo-scoped)

- **Demo secrets in env files**: the HS256 A2A secret, a static tier-1 JWT, the Gitea
  basic-auth password and the database password are committed demo values. Production:
  short-lived tokens from an IdP, secrets in a vault, a scoped Git token.
- **The operator console lives inside tier-2**, which holds the A2A secret the server
  needs. The approval stays human (`ask` permission + on-screen confirm), but a production
  console runs outside tier-2 and authenticates the human through the IdP.
- **One audit chain shared with the app**: tier-2's ops events appear in New Horizons' Admin
  center trail next to the app's decisions — by design (the Changes page reads it), but a
  production deployment would scope who may read which events.
- **tier-2 and staging can write to the app's database** (`DATABASE_URL` is the owner
  role): tier-2 to append audit events, staging because the deployed app records decisions.
  Neither holds a route anywhere else; production would give each a narrower role.
- **In-memory A2A task store** — task state does not survive a tier-2 restart (the audit
  chain does); re-run `/request-deploy`.
- **tmpfs `exec`** for OpenCode's native render library (see Enforced).
- **An 8 GB image**: New Horizons' lock includes torch (via surya-ocr), whose linux/aarch64 wheels
  pull CUDA libraries. They are kept because the build gate checks the image against the
  exact lock; a CPU-only lock would need its own review.
- **Staging is seeded from data baked at build time** (`make mock kb` in new-horizons) and is an
  unauthenticated view of synthetic data on `localhost:8080`; in production staging sits
  behind the operator's own access control.
- **Host Ollama is reachable through `llm-proxy`** from both tiers and staging: a hostile
  agent could burn GPU time. Rate limiting belongs to a production gateway.

## Verification hooks

- `make demo2-verify` — against the running stack: egress blocked three ways (HTTPS, DNS,
  git) in tier-1, tier-2 and staging; tier-1 read-only, credential-free, no route to
  Postgres; the headless model round-trip; the offline suite in tier-1; A2A with and
  without a bearer.
- `tests/test_compose.py` — internal networks, who may route out or publish, the walls on
  every agent-code service, credentials per env file, the tier-1 JWT's role.
- `tests/test_core.py` — the records, the compiled `opencode.json`, `task`/`webfetch` denied,
  no push/fetch/install in tier-1's bash allowlist.
- `tests/test_tier2_tools.py` — the gate reads its bar from the baseline; only the commit
  ships; a new dependency fails the build.
- `docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/audit_verify.py`
  — re-walks the hash chain.
