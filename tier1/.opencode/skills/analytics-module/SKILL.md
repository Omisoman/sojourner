---
name: analytics-module
description: Add or change a computed finding — analytics module, artifact, resolver and its ground truth
summary: "Compute in app/analytics/ and write data/analytics/<name>.json; screens, tools and resolvers read that artifact. A known question is an intents.yaml entry plus a metrics.py resolver; expected figures come from the generator — one commit carries module, resolver, test and page."
---

# analytics-module

Changing what the Farm app computes. Detection is deterministic code; the
model only explains it.

1. **The module.** Computation lives in `src/new_horizons/app/analytics/`
   (`recon.py`, `drift.py`, `patterns.py` are the pattern): read the database
   through `analytics/dataio.py`, write one artifact under
   `data/analytics/<name>.json` (`dataio.OUT`), and run as
   `uv run python -m new_horizons.app.analytics.<name>`.
2. **Citations.** A finding that names a rule cites a key from
   `app/ingest/kb_synthetic/citations.yaml` (`dataio.cite(key)`), never a file
   name typed in code.
3. **The agent.** A farm tool reads the artifact and is registered in
   `app/analytics/agent_tools.py` — the harness (`shared/`) never imports it.
4. **A known question.** Add an intent to
   `app/agents/analytics/intents.yaml` (standalone paraphrases in EN and AR,
   `not:` examples, `cite`, `screen`) and its resolver to
   `analytics/metrics.py` (a pure read returning `figures`, `template_en`,
   `template_ar`, `citation`; listed in `RESOLVERS`). Never put figures,
   dates or schema into `agents/analytics/SYSTEM.md`.
5. **Ground truth.** Expected figures come from the generator
   (`app/mock/generate.py` → `ingest/validation/expected-results.json`), pinned
   by `tests/test_validation.py`. Change the generator and regenerate; never
   edit the expected file by hand.
6. **Tests.** Unit-test the computation on a small frame; the database-backed
   tests skip here without a database route — they run in tier-2's pipeline.
7. **Done** = `uv run pytest -q` green + `/arch-check` clean, then ONE commit
   carrying module + resolver + test + the page that shows it. The question
   set (`docs/question-set.yaml`) is the deploy gate: a broken resolver or
   citation fails there.
