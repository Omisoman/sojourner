---
name: kb-document
description: Add or change a knowledge-base document and the citation keys code relies on
summary: "Write the Farm's rules as numbered sections in app/ingest/kb_synthetic/<name>.md (synthetic front matter, the Farm, EN+AR titles), register every section code cites in citations.yaml with must_contain terms, then rebuild with make kb. A renumbered section is a broken citation."
---

# kb-document

The knowledge base is GENERIC for any farm: rules, SOPs and the data
dictionary the agent cites. It says "the Farm" — no real company, place or
person.

1. Documents live in `src/new_horizons/app/ingest/kb_synthetic/<name>.md`
   with front matter (`synthetic: true`, `source: <name>.md`, `lang`,
   `title`) and a "**SYNTHETIC demo document.**" line.
2. Number the sections (`## 3. …`, `### 3.1 …`): the section number is the
   citation. Renumbering a section breaks every key that points at it.
3. Every section code or an alert cites gets a key in
   `kb_synthetic/citations.yaml`: `source`, `section`, and `must_contain`
   terms that must appear in that section's text. Code cites by KEY only.
4. Local rules for one market go in `ingest/kb_market/<name>/` with their own
   `citations.yaml`, switched on in `profile.yaml -> market.kb_overlays` — not
   in the generic corpus.
5. Rebuild: `make kb` (bge-m3 embeddings through the model endpoint, about
   5 s). `tests/test_kb.py` checks every key resolves with its terms and that
   the corpus stays generic.
6. A figure in a document that the analytics also compute (a band, a
   threshold, a response time) must match the code that applies it — change
   both in one commit.
7. Done = `uv run pytest -q` green, then commit document + citations together.
