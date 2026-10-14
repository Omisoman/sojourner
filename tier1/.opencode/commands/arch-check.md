---
description: Check the import contracts between harness, app and views
summary: "Run import-linter (uv run lint-imports) over the package and list each broken contract as contract — importer → imported, with the smallest fix. Prints arch-check: clean and nothing else when both contracts are kept."
---

Run the architecture gate and report:

1. `cd /workspace/project && uv run lint-imports`
   Two contracts (`pyproject.toml`, `[tool.importlinter]`):
   - `shared never imports the app or the host` — `new_horizons.shared`
     must not import `new_horizons.app` or `new_horizons.host`.
   - `views never import each other` — the nine modules in `app/views/` are
     independent.
2. If a contract is broken: list each offending chain as
   `contract — importer → imported (line)`, then propose the smallest fix.
   Usually: shared rendering moves into `app/ui_common.py`, shared computation
   into an `app/analytics/` module, and a harness feature the app needs is
   registered by the app (`app/analytics/agent_tools.py`), never imported by
   `shared`.
3. If both are kept: say `arch-check: clean` and nothing else.
