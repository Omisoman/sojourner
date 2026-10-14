# Sojourner tier-1 sandbox — architecture rules

You are a developer agent inside Sojourner's tier-1 sandbox. Workspace:
`/workspace/project` — a git clone of new-horizons at `sojourner-base`
(Python 3.12 + uv, Streamlit + LangGraph, the Farm's analytics agent).
Everything else is read-only. No network egress; the model endpoint is the
only external call and it is host-local. There is no database route from here.

## Shape

```
src/new_horizons/shared   the harness: llm/ harness/ audit/ rules/ db/ text/ kb/ patch/
src/new_horizons/app      the Farm app: app.py ui_common.py views/ analytics/
                                agents/ ingest/ intake/ mock/ design/ static/
src/new_horizons/host     the app-agent host (one shell for every app agent)
tests/                          pytest — one file per concern
```

## Boundaries (enforced by import-linter — `/arch-check`)
- `shared` never imports `app` or `host`. The app plugs into the harness
  (`app/analytics/agent_tools.py` registers its tools and metrics); the
  harness never reaches up.
- Views never import each other (`app/views/*.py`). What two pages share goes
  into `app/ui_common.py` or an `app/analytics/` module.
- No new runtime dependencies without a reviewer note in the PR body — the
  sandbox is offline and the lock file is frozen.

## Data layer
- Five read-only farm systems in Postgres (`telemetry`, `controller`,
  `maintenance`, `harvest`, `supplies`). The agent queries through the
  read-only role; the schema in the model's prompt is generated
  (`shared/db/introspect.py`) — never write schema, dates or figures into
  `agents/analytics/SYSTEM.md`.
- Screens read the analytics artifacts (`data/analytics/*.json`) that
  `analytics/{recon,drift,patterns}.py` write; chat's known questions read the
  same artifacts through `analytics/metrics.py` resolvers. One source of
  figures, so screens, chat and tests cannot disagree.
- The generator (`app/mock/generate.py`, seed 2019, scale in
  `app/profile.yaml`) writes `ingest/validation/expected-results.json`. Never
  type an expected figure by hand; change the generator and regenerate.
- Governance is audit events (`shared/audit/audit.py`), never UI state or a
  side table.

## Working rules
- **Do the work yourself. Never hand the task to a subagent.** The `explore`
  subagent is read-only: its edits never reach disk, so the job looks done and
  nothing is committed. Edit the files in this workspace directly.
- Every UI string is `tr("English", "العربية")` where it is used. Pages live in
  `app/views/` (never `pages/`); navigation is `st.page_link`; a click that
  changes one panel is a callback inside an `st.fragment`, never `st.rerun()`.
- Every screen with operational data carries the "Synthetic data" chip.
- Every change ships with a test. Tests that need the database skip here —
  write them anyway; tier-2 and the host run them.
- Run `uv run pytest -q` and `/arch-check` before requesting review or deploy.
- Conventional commits (`feat:`, `fix:`, `chore:`); imperative subject.

## Escalation
- You cannot deploy. Commit your work, then use `/request-deploy` — it
  delegates to the tier-2 ops agent over A2A, sending a patch of your commits
  since `sojourner-base`. A dirty work tree is refused: commit first.
- Deploys block on human approval by the access rules.
- You have no Gitea credentials by design. PRs are opened by tier-2.
- If a task needs anything outside `/workspace/project`, stop and say so.
