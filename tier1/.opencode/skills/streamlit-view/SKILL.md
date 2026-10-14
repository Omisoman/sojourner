---
name: streamlit-view
description: Add or change a page in app/views/ following the Agentization Core design system
summary: "Change a page under app/views/ through ui_common (page_header, chip, section, card): every string tr(English, Arabic), the Synthetic data chip on data screens, st.page_link navigation, one-panel clicks inside an st.fragment. A new page joins U.NAV, the import contract and tests/test_views.py."
---

# streamlit-view

Adding or changing a page of the Farm app.

1. Pages live in `src/new_horizons/app/views/<name>.py` — never
   `pages/` (Streamlit's old multipage mode would run a deep-linked page
   without `app.py`: no CSS, no sidebar).
2. Build the page from `app/ui_common.py` (imported as `U`):
   `U.page_header(title, subtitle, chips)`, `U.chip`, `U.section`, `U.card`,
   `U.alert`. Read figures from the analytics artifacts
   (`U.load_json(U.AN_DIR / "<name>.json")`), never a fresh query of the same
   thing.
3. Every UI string is `tr("English", "العربية")` where it is used. Data keeps
   its own language (unit codes, record numbers, figures).
4. A screen with operational data carries
   `U.chip(tr("Synthetic data", "بيانات تركيبية"))` in its header.
5. Navigation is `st.page_link`. A click that changes one panel is a callback
   inside an `@st.fragment`, never `st.rerun()`. Colours only from
   `app/design/tokens.json`; no `cursor` rules, no new JS.
6. Decisions go through `U.approval_bar` / `U.audit_link` — audit events,
   never session state.
7. A NEW page: add it to `U.NAV` (key, label, material icon, file) and
   `U.NAV_AR`, and add its module to the `views never import each other`
   contract in `pyproject.toml`. Never import another view — shared pieces
   move into `ui_common.py`.
8. Tests: extend `tests/test_views.py` (`AppTest`, both languages; it skips
   here without the database — write it anyway).
9. Done = `uv run pytest -q` green + `/arch-check` clean.
