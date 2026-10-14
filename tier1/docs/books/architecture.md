---
title: Architecture
subtitle: new-horizons
summary: "One package, two import laws: shared never imports the app, views never import each other. Screens and chat read the same analytics artifacts, known questions resolve in code, expected figures come from the generator — a change ships with its artifact, resolver and test."
owner: platform
version: "1.0"
---

# Architecture book — new-horizons

## Shape

One installable package, three layers, one boundary law each way:

```
shared/   the harness — llm, harness (LangGraph graph + JSON tool protocol),
          audit (hash chain), rules (RBAC), db, text, kb, patch
app/      the Farm — app.py, ui_common.py, views/, analytics/, agents/,
          ingest/ (the KB), intake/ (documents), mock/ (the generator)
host/     one Streamlit shell for every app agent in registry.yaml
```

One question, end to end:

```
Chat page → graph (shared/harness/graph.py) → intents.yaml match?
   yes → analytics/metrics.py resolver → figures + template + citation
   no  → free agent → JSON tool protocol → sql_query / kb_search / farm tools
→ figure gate + language check → answer with (source, section)
```

## Laws (import-linter enforces both)

1. `new_horizons.shared` never imports `new_horizons.app` or
   `new_horizons.host`. The app registers into the harness
   (`app/analytics/agent_tools.py` → `tools.register`,
   `graph.register_metrics`); the harness stays generic.
2. The nine page modules in `app/views/` are independent. Shared rendering
   moves DOWN into `app/ui_common.py`, shared computation into
   `app/analytics/` — never sideways into another view.

## Why views stay independent

A page is the unit of ownership, review and deletion. Streamlit runs each page
file on its own; a page that imports another runs that page's top level too —
its queries, its widgets, its keys. One file in, one file out.

## State

Streamlit session state for widget values only. Decisions, pause/resume and
deploys are audit events in the hash chain, read back by the pages that show
them — the Admin center and the Changes page render the chain itself. The
moment a page wants its own side table, stop and raise it: that is an
architectural decision, not a refactor.

## Where figures come from

- The generator (`app/mock/generate.py`, `profile.yaml` is the only file that
  knows scale, period and seed) loads the five farm schemas and writes
  `data/mock_meta.json` and `ingest/validation/expected-results.json`.
- `analytics/recon.py`, `drift.py`, `patterns.py` read the database and write
  `data/analytics/*.json`. Screens, the farm tools and the metrics resolvers
  read those artifacts — never their own query of the same thing.
- `tests/test_validation.py` pins the artifacts to the generator's ground
  truth. A figure that changes is a generator change, not a test edit.

## Correctness in code, not in the prompt

- Known questions: `agents/analytics/intents.yaml` → `analytics/metrics.py`.
  A missed question gets a paraphrase, a `not:` example or a resolver.
- Discrepancies are deterministic code (`analytics/recon.py`); the model only
  explains, citing `(source, section)` from `ingest/kb_synthetic/citations.yaml`.
- Tool calls go through the JSON protocol (`shared/harness/protocol.py`),
  never native tool binding: the graph runs the same on qwen3, llama3.1 and
  deepseek-r1.

## Staging

Tier-2 deploys the app to a second Streamlit behind caddy at
`http://localhost:8080`, against the same database and the same audit chain.
A deploy writes one `deploy` event; the app's Changes page lists it.
