"""Core records: one core.json per tier is the agent; opencode.json is
compiled from it (scripts/core-compile.py) and the TUI reads nothing else."""

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
TUI = ROOT / "infra" / "tui"
RECORD = {1: ROOT / "tier1" / "core.json", 2: ROOT / "tier2" / "core.json"}

_spec = importlib.util.spec_from_file_location("core_compile", ROOT / "scripts" / "core-compile.py")
cc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cc)

KEYS = {"schema", "id", "tier", "name", "role", "version", "platform", "workspace",
        "inference", "agents", "default_agent", "catalog", "books", "documents", "connections",
        "permissions", "guards", "approvals", "audit", "home"}


def _rec(tier: int) -> dict:
    return json.loads(RECORD[tier].read_text(encoding="utf-8"))


@pytest.mark.parametrize("tier", [1, 2])
def test_record_carries_every_key_of_the_schema(tier):
    rec = _rec(tier)
    assert KEYS <= set(rec), KEYS - set(rec)
    assert rec["schema"] == "sojourner/terminal-agent/1"
    assert rec["tier"] == tier
    assert "client" not in rec                       # no client: the platform is the brand
    assert rec["platform"] == "AGENTIZATION-CORE DEV"
    assert {"dir", "write_root", "kind"} <= set(rec["workspace"])
    assert {"default", "provider", "models", "residency", "local_always"} <= set(rec["inference"])
    assert rec["default_agent"] in {a["name"] for a in rec["agents"]}
    assert {"placeholders", "quick_actions"} <= set(rec["home"])
    for q in rec["home"]["quick_actions"]:
        assert q["action"]["type"] in {"view", "settings", "prompt", "none"}, q


@pytest.mark.parametrize("tier", [1, 2])
def test_compiled_config_is_the_committed_one(tier, tmp_path):
    """Drift gate: opencode.json is output. Edit core.json and run `make core`."""
    committed = (ROOT / f"tier{tier}" / ".opencode" / "opencode.json").read_text(encoding="utf-8")
    out = tmp_path / "opencode.json"
    out.write_text(cc.render(cc.load(RECORD[tier])), encoding="utf-8")
    assert out.read_text(encoding="utf-8") == committed


@pytest.mark.skipif(not shutil.which("bun"), reason="bun not installed")
@pytest.mark.parametrize("tier", [1, 2])
def test_python_and_tui_sign_the_record_the_same(tier):
    r = subprocess.run(["bun", "-e", "const e = await import('./lib/env.ts'); console.log(e.SIGNATURE)"],
                       cwd=TUI, capture_output=True, text=True, timeout=60,
                       env={**os.environ, "SOJOURNER_CORE": str(RECORD[tier])})
    assert r.returncode == 0, r.stderr[-1500:]
    assert r.stdout.strip() == cc.signature(cc.load(RECORD[tier]))


@pytest.mark.parametrize("tier", [1, 2])
def test_no_subagent_handoff_and_no_web(tier):
    perms = _rec(tier)["permissions"]
    assert perms["task"] == "deny"
    assert perms["webfetch"] == "deny"


def test_tier_roles_are_inverse():
    t1, t2 = _rec(1), _rec(2)
    assert t1["catalog"]["role"] == "consumer" and t1["approvals"]["can_approve"] is False
    assert t1["approvals"]["can_request"] is True
    assert t2["catalog"]["role"] == "curator" and t2["approvals"]["can_approve"] is True
    assert t2["approvals"]["can_request"] is False
    assert t1["catalog"]["adds"] == ["prompt"]
    assert set(t2["catalog"]["publishes"]) == {"command", "skill", "book", "prompt"}


def test_both_tiers_read_the_rules_the_server_enforces():
    """The TUI shows the rules file the A2A server checks — the baked baseline's."""
    for tier in (1, 2):
        path = _rec(tier)["approvals"]["rules"]
        assert path == "/opt/sojourner/horizons/src/new_horizons/shared/rules/rules.yaml"


def test_tier1_rule_count_is_what_the_permissions_screen_shows():
    perms = _rec(1)["permissions"]
    rules = sum(len(v) if isinstance(v, dict) else 1 for v in perms.values())
    assert rules == 36  # 10 edit + 24 bash + task + webfetch


def test_tier1_can_test_and_commit_but_never_reach_out():
    bash = _rec(1)["permissions"]["bash"]
    assert bash["*"] == "deny"
    for allowed in ("uv run *", "git commit*", "git format-patch*", "make test*"):
        assert bash[allowed] == "allow"
    assert not any(k.startswith(("curl", "wget", "git push", "pip", "uv add", "uv sync")) for k in bash)


def test_signature_is_stable_under_key_order():
    rec = _rec(1)
    shuffled = json.loads(json.dumps(dict(reversed(list(rec.items())))))
    assert cc.signature(shuffled) == cc.signature(rec)
    rec["version"] = "9.9.9"
    assert cc.signature(rec) != cc.signature(_rec(1))
