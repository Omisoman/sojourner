---
title: Coding standards
subtitle: new-horizons
summary: "Python 3.12, type hints at module boundaries, package imports only, paths from new_horizons.paths. Pytest per concern, behaviour not markup; a bug fix starts with the failing test. Every UI string is tr(English, Arabic) where it is used; the data keeps its own language."
owner: platform
version: "1.0"
---

# Coding standards — new-horizons

## Python
- Python 3.12, `from __future__ import annotations`, type hints on every
  function that crosses a module boundary.
- Package imports only (`from new_horizons.app.analytics import recon`);
  never `sys.path` tricks. Paths hang off `new_horizons.paths`
  (`ROOT`, `DATA`, `APP`) — never a hard-coded checkout path.
- Match the file you are in: its comment density, naming and idiom. Module
  docstrings say what the module is for and what it writes.
- Every LLM call stays on the OpenAI-compatible endpoint
  (`shared/llm/client.py`); never call a provider SDK directly.

## Testing
- pytest; one file per concern under `tests/` (`test_recon.py`,
  `test_views.py`, …). Test behaviour and edge cases (zero, empty, boundary),
  never markup snapshots.
- A bug fix starts with the failing test that reproduces it.
- Tests that need the database or the generated data skip when it is absent
  (`skipif` on a connection probe, `@pytest.mark.domain`); tests that call a
  live model are `@pytest.mark.model`.
- Views are tested with Streamlit's `AppTest` in `tests/test_views.py`, in
  both languages.

## Arabic / RTL
- Every UI string is written `tr("English", "العربية")` where it is used —
  never an Arabic twin kept beside the English one.
- The whole app flips with the language (`--ac-dir`, logical CSS properties).
  Data keeps its own language: unit codes, record numbers and figures stay
  as stored.
- Never split or reverse Arabic strings programmatically (ligatures and bidi
  break); treat them as opaque.

## UI
- Colours only from `app/design/tokens.json`; no `cursor` rules; the only JS
  is `design/ac-lens.js`.
- Navigation is `st.page_link`; a click that changes one panel is a callback
  inside an `st.fragment`, not `st.rerun()`.
- Every screen with operational data carries the "Synthetic data" chip.

## Commits & reviews
- Conventional commits, imperative, ≤ 72-char subject.
- One concern per PR when possible; note any new dependency in the PR body
  with a one-line justification.
- `uv run pytest -q` and `/arch-check` green before review.
