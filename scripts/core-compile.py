"""Compile each tier's core.json (the record) into its .opencode/opencode.json.

    uv run python scripts/core-compile.py            # write both opencode.json
    uv run python scripts/core-compile.py --check    # exit 1 if either drifted
    uv run python scripts/core-compile.py --sign tier1/core.json

The record is the agent: identity, inference, agents, catalog role,
connections, permissions, guards, approvals, audit channel, home. OpenCode
only needs part of it, so that part is generated — edit core.json and run
`make core`, never the output. tests/test_core.py recompiles and diffs, so a
hand edit to opencode.json fails the suite.

The signature (`--sign`) is sha256 over the record serialised with sorted
keys, (",", ":") separators and UTF-8; the TUI computes the same digest at
load (infra/tui/lib/env.ts) and shows its first 12 hex chars as `core <sig>`.

stdlib only, like brand-sync.py.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TIERS = {1: ROOT / "tier1", 2: ROOT / "tier2"}
SCHEMA = "sojourner/terminal-agent/1"

# Fixed for every terminal agent this compiler emits: the one theme, the two
# server plugins of the shared TUI (audit log, path guard) and the rules file.
THEME = "sojourner"
SERVER_PLUGINS = ["/opt/sojourner/tui/server/audit-log.ts", "/opt/sojourner/tui/server/path-guard.ts"]
INSTRUCTIONS = ["/workspace/AGENTS.md"]

REQUIRED = ("schema", "id", "tier", "name", "role", "version", "platform",
            "workspace", "inference", "agents", "default_agent", "catalog", "books",
            "documents", "connections", "permissions", "guards", "approvals", "audit", "home")


def load(path: Path) -> dict:
    rec = json.loads(path.read_text(encoding="utf-8"))
    missing = [k for k in REQUIRED if k not in rec]
    if missing:
        raise SystemExit(f"{path}: missing {', '.join(missing)}")
    if rec["schema"] != SCHEMA:
        raise SystemExit(f"{path}: schema {rec['schema']!r} != {SCHEMA!r}")
    if rec["default_agent"] not in {a["name"] for a in rec["agents"]}:
        raise SystemExit(f"{path}: default_agent {rec['default_agent']!r} is not in agents")
    return rec


def signature(rec: dict) -> str:
    canon = json.dumps(rec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def compile_record(rec: dict) -> dict:
    inf = rec["inference"]
    prov = inf["provider"]
    return {
        "$schema": "https://opencode.ai/config.json",
        "theme": THEME,
        "model": inf["default"],
        "default_agent": rec["default_agent"],
        "autoupdate": False,
        "share": "disabled",
        "disabled_providers": ["opencode"],
        "plugin": SERVER_PLUGINS,
        "provider": {
            prov["id"]: {
                "npm": prov["npm"],
                "name": prov["name"],
                "options": {"baseURL": "{env:%s}" % prov["base_url_env"]},
                "models": {mid: {"name": name} for mid, name in inf["models"].items()},
            }
        },
        "permission": rec["permissions"],
        "instructions": INSTRUCTIONS,
    }


# ---- the committed files' layout: 2-space indent, scalar lists on one line,
# ---- model entries as `{ "name": … }` on one line ------------------------------

def _scalar(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def _fmt(v, indent: int, path: tuple[str, ...]) -> str:
    pad, inner = "  " * indent, "  " * (indent + 1)
    if isinstance(v, dict):
        if len(path) == 4 and path[0] == "provider" and path[2] == "models":
            return "{ " + ", ".join(f"{_scalar(k)}: {_scalar(x)}" for k, x in v.items()) + " }"
        if not v:
            return "{}"
        items = [f"{inner}{_scalar(k)}: {_fmt(x, indent + 1, path + (k,))}" for k, x in v.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(v, list):
        if all(not isinstance(x, (dict, list)) for x in v):
            return "[" + ", ".join(_scalar(x) for x in v) + "]"
        items = [f"{inner}{_fmt(x, indent + 1, path)}" for x in v]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"
    return _scalar(v)


def render(rec: dict) -> str:
    return _fmt(compile_record(rec), 0, ()) + "\n"


def targets() -> list[tuple[Path, str]]:
    out = []
    for tier, root in TIERS.items():
        rec = load(root / "core.json")
        if rec["tier"] != tier:
            raise SystemExit(f"{root / 'core.json'}: tier {rec['tier']} in the tier-{tier} tree")
        out.append((root / ".opencode" / "opencode.json", render(rec)))
    return out


def main(argv: list[str]) -> int:
    if argv[:1] == ["--sign"]:
        for p in argv[1:] or [str(TIERS[1] / "core.json"), str(TIERS[2] / "core.json")]:
            sig = signature(load(Path(p)))
            print(f"{sig[:12]}  {sig}  {p}")
        return 0
    check = "--check" in argv
    drift = 0
    for path, text in targets():
        rel = path.relative_to(ROOT)
        if path.exists() and path.read_text(encoding="utf-8") == text:
            print(f"  ok       {rel}")
            continue
        drift += 1
        if check:
            print(f"  DRIFT    {rel}  (run: make core)")
        else:
            path.write_text(text, encoding="utf-8")
            print(f"  wrote    {rel}")
    return 1 if check and drift else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
