"""Tier-2's tools with farm semantics: what each gate checks and what a
deploy leaves behind. No stack needed — subprocesses and HTTP are faked."""

from __future__ import annotations

import importlib
import json
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).parents[1]
RULES = Path(__import__("new_horizons").__file__).parent / "shared" / "rules" / "rules.yaml"


def fresh(monkeypatch, **env):
    """Reload the workspace constants (read from env at import) and the tools."""
    for k, v in env.items():
        monkeypatch.setenv(k, str(v))
    import tools.workspace as ws
    importlib.reload(ws)
    mods = {}
    for name in ("build", "validate", "evaluate", "deploy"):
        mods[name] = importlib.reload(importlib.import_module(f"tools.{name}"))
    return ws, mods


# ---- deploy -------------------------------------------------------------------

def _project(tmp_path: Path, title: str) -> Path:
    """A committed checkout: deploy ships `git archive HEAD`, nothing else."""
    root = tmp_path / "project"
    app = root / "src" / "new_horizons" / "app"
    app.mkdir(parents=True, exist_ok=True)
    (app / "app.py").write_text(f"TITLE = {title!r}\n")
    (root / "assets").mkdir(exist_ok=True)
    (root / "assets" / "mark.svg").write_text("<svg/>")
    git = lambda *a: subprocess.run(["git", *a], cwd=root, check=True, capture_output=True)
    if not (root / ".git").exists():
        git("init", "-q", "-b", "main")
        git("config", "user.name", "t"), git("config", "user.email", "t@t")
    git("add", "-A"), git("commit", "-q", "-m", f"title {title}")
    return root


@pytest.fixture()
def deploy(tmp_path, monkeypatch):
    _, mods = fresh(monkeypatch, PROJECT_DIR=tmp_path / "project", STAGING_DIR=tmp_path / "staging",
                    STAGING_RUN_DIR=tmp_path / "run", STAGING_PUBLIC_URL="http://localhost:8080/",
                    STAGING_URL="http://staging:8501/")
    d = mods["deploy"]
    monkeypatch.setattr(d, "head", lambda: "a" * 40)
    monkeypatch.setattr(d, "changed_files", lambda: ["src/new_horizons/app/app.py"])
    monkeypatch.setattr(d, "_healthy", lambda stamp: {"ok": True, "serving": stamp})
    return d


def test_deploy_publishes_the_checkout_and_stamps_it(tmp_path, deploy):
    _project(tmp_path, "v1")

    res = deploy.deploy_staging()

    staging = tmp_path / "staging"
    assert res["ok"], res
    assert (staging / "app/src/new_horizons/app/app.py").read_text() == "TITLE = 'v1'\n"
    assert (staging / "app/assets/mark.svg").exists()        # the whole tree, logo included
    assert (staging / ".deployed").read_text().strip() == res["stamp"]
    assert res["stamp"].endswith("a" * 12) and res["ref"] == "a" * 40
    assert res["files"] == ["src/new_horizons/app/app.py"]


def test_redeploy_keeps_the_previous_source_for_rollback(tmp_path, deploy):
    _project(tmp_path, "v1")
    deploy.deploy_staging()
    _project(tmp_path, "v2")

    deploy.deploy_staging()

    staging = tmp_path / "staging"
    assert (staging / "app/src/new_horizons/app/app.py").read_text() == "TITLE = 'v2'\n"
    assert (staging / ".prev/app/src/new_horizons/app/app.py").read_text() == "TITLE = 'v1'\n"


def test_only_the_commit_ships_never_uncommitted_work(tmp_path, deploy):
    root = _project(tmp_path, "v1")
    (root / "src/new_horizons/app/app.py").write_text("TITLE = 'dirty'\n")
    (root / "scratch.txt").write_text("not reviewed\n")

    deploy.deploy_staging()

    staging = tmp_path / "staging" / "app"
    assert (staging / "src/new_horizons/app/app.py").read_text() == "TITLE = 'v1'\n"
    assert not (staging / "scratch.txt").exists()


def test_deploy_without_an_app_is_an_error_not_a_crash(tmp_path, deploy):
    (tmp_path / "project").mkdir()
    assert "error" in deploy.deploy_staging()


def test_deploy_reports_the_url_a_human_opens(tmp_path, deploy):
    """The internal name (staging:8501) is unreachable from the demo machine."""
    _project(tmp_path, "v1")
    assert deploy.deploy_staging()["staging_url"] == "http://localhost:8080/"


def test_deploy_waits_until_staging_serves_the_new_stamp(tmp_path, monkeypatch):
    """A health check that answers from the OLD process proves nothing: the
    smoke waits for the supervisor to report the new stamp first."""
    _, mods = fresh(monkeypatch, STAGING_RUN_DIR=tmp_path / "run", STAGING_WAIT_S=6,
                    STAGING_URL="http://staging:8501/")
    d = mods["deploy"]
    (tmp_path / "run").mkdir()
    (tmp_path / "run" / "serving").write_text("old-stamp\n")
    calls = []

    class Resp:
        status_code, text = 200, "ok"

    def fake_get(url, timeout):
        calls.append(url)
        return Resp()

    monkeypatch.setattr(d.httpx, "get", fake_get)
    monkeypatch.setattr(d.time, "sleep", lambda s: (tmp_path / "run" / "serving").write_text("new\n"))

    res = d._healthy("new")

    assert res["ok"] and res["serving"] == "new"
    assert calls and calls[0].endswith("/_stcore/health")


def test_a_deploy_that_never_comes_up_fails(tmp_path, monkeypatch):
    _, mods = fresh(monkeypatch, STAGING_RUN_DIR=tmp_path / "run", STAGING_WAIT_S=0)
    assert mods["deploy"]._healthy("never")["ok"] is False


# ---- build ----------------------------------------------------------------------

def _fake_run(outputs):
    def run(cmd, **_kw):
        for key, out in outputs.items():
            if key in " ".join(cmd):
                return out
        raise AssertionError(cmd)
    return run


def test_build_passes_when_the_lock_is_installed_and_the_suite_is_green(monkeypatch):
    _, mods = fresh(monkeypatch)
    b = mods["build"]
    monkeypatch.setattr(b, "head", lambda: "b" * 40)
    monkeypatch.setattr(b, "run", _fake_run({
        "lock --check": (0, "Resolved 181 packages"),
        "sync --frozen": (0, "Would make no changes"),
        "pytest": (0, "372 passed, 30 skipped in 20.1s"),
    }))
    res = b.build_run()
    assert res["ok"] and res["tests"]["summary"] == "372 passed, 30 skipped in 20.1s"


def test_build_fails_a_patch_that_needs_a_new_dependency(monkeypatch):
    """The sandbox has no network: anything the frozen sync would still have
    to install is something nobody reviewed — the build gate says so."""
    _, mods = fresh(monkeypatch)
    b = mods["build"]
    monkeypatch.setattr(b, "head", lambda: "")
    monkeypatch.setattr(b, "run", _fake_run({
        "lock --check": (0, ""),
        "sync --frozen": (0, "Would download 1 package\nWould install 1 package\n + leftpad==1.0"),
        "pytest": (0, "372 passed"),
    }))
    res = b.build_run()
    assert res["ok"] is False and res["sync"]["ok"] is False
    assert "+ leftpad==1.0" in res["sync"]["pending"]


def test_a_same_version_reinstall_is_not_a_dependency_change(monkeypatch):
    """uv may re-link one wheel (`- x==1` then `+ x==1`): nothing new arrives."""
    _, mods = fresh(monkeypatch)
    dry = ("Would uninstall 1 package\nWould install 2 packages\n"
           " - nvidia-cusparselt-cu13==0.8.1\n + nvidia-cusparselt-cu13==0.8.1\n + leftpad==1.0\n")
    assert mods["build"].pending_changes(dry) == ["+ leftpad==1.0"]
    assert mods["build"].pending_changes("Would make no changes\n") == []


def test_build_fails_on_a_red_suite(monkeypatch):
    _, mods = fresh(monkeypatch)
    b = mods["build"]
    monkeypatch.setattr(b, "head", lambda: "")
    monkeypatch.setattr(b, "run", _fake_run({
        "lock --check": (0, ""), "sync --frozen": (0, "Would make no changes"),
        "pytest": (1, "FAILED tests/test_views.py::test_overview\n1 failed, 371 passed")}))
    res = b.build_run()
    assert res["ok"] is False and res["tests"]["summary"] == "1 failed, 371 passed"


def test_the_build_runs_without_a_database_route(monkeypatch):
    ws, _ = fresh(monkeypatch, DATABASE_URL="postgresql://horizons:horizons@horizons-postgres:5432/horizons")
    env = ws.code_env()
    assert env["DATABASE_URL"] == env["DATABASE_URL_RO"] == ws.NO_DB
    assert ws.code_env(database=True)["DATABASE_URL"].endswith("@horizons-postgres:5432/horizons")
    assert env["PYTHONPATH"] == str(ws.PROJECT / "src")


# ---- validate -------------------------------------------------------------------

def test_validate_is_contracts_plus_kb_dry_run_plus_business_truth(monkeypatch):
    _, mods = fresh(monkeypatch, DATABASE_URL="postgresql://horizons:horizons@horizons-postgres:5432/horizons")
    v = mods["validate"]
    seen = []

    def run(cmd, env=None, **_kw):
        seen.append((" ".join(cmd), env.get("DATABASE_URL", "")))
        return (0, "ok") if "pytest" not in cmd else (0, "12 passed in 3.1s")

    monkeypatch.setattr(v, "run", run)
    res = v.validate_run()
    assert res["ok"] and res["business_truth"]["summary"] == "12 passed in 3.1s"
    joined = [c for c, _ in seen]
    assert joined[0].endswith("lint-imports")
    assert "ingest.run --dry-run" in joined[1]
    assert joined[2].endswith("tests/test_validation.py") and joined[3].endswith("tests/test_views.py")
    # only the truth and page tests get the database (the shared one)
    assert [db.startswith("postgresql://nobody") for _, db in seen] == [True, True, False, False]


def test_a_skipped_truth_suite_is_not_a_pass(monkeypatch):
    """No database or no data means the module skips — that proves nothing."""
    _, mods = fresh(monkeypatch)
    v = mods["validate"]
    monkeypatch.setattr(v, "run", lambda cmd, **_kw: (0, "ss  [100%]\n2 skipped in 0.4s")
                        if "pytest" in cmd else (0, ""))
    res = v.validate_run()
    assert res["ok"] is False and res["pages"]["ok"] is False


def test_one_failing_check_fails_validate(monkeypatch):
    _, mods = fresh(monkeypatch)
    v = mods["validate"]
    monkeypatch.setattr(v, "run", lambda cmd, **_kw: (1, "Contracts: 1 kept, 1 broken.")
                        if cmd[0].endswith("lint-imports") else (0, ""))
    res = v.validate_run()
    assert res["ok"] is False and res["import_contracts"]["ok"] is False


# ---- evaluate ---------------------------------------------------------------------

def test_the_gate_reads_its_bar_from_the_access_rules(monkeypatch):
    _, mods = fresh(monkeypatch)
    rules = yaml.safe_load(RULES.read_text())["evaluation"]
    assert mods["evaluate"].gate() == (rules["model"], rules["min_pass_rate"])


def test_the_gate_grades_with_the_baked_set_and_grader_not_the_patch(tmp_path, monkeypatch):
    """A patch could edit the question set or the grader to pass itself; the
    gate uses the baseline's copies and only points PYTHONPATH at the patch."""
    _, mods = fresh(monkeypatch, PROJECT_DIR=tmp_path / "project", BASELINE_DIR=tmp_path / "base",
                    BUILD_OUT=tmp_path / "out")
    ev = mods["evaluate"]
    seen = {}

    def run(cmd, env=None, **_kw):
        seen["cmd"], seen["env"] = cmd, env
        out = Path(cmd[cmd.index("--out") + 1])
        out.write_text(json.dumps({"passed": 20, "pass_rate": 0.7692, "results": [
            {"id": "S01", "lang_ok": True, "figures_ok": True, "citation_ok": True},
            {"id": "S02", "lang_ok": True, "figures_ok": False, "citation_ok": True}]}))
        return 0, "pass rate 20/26"

    monkeypatch.setattr(ev, "run", run)
    monkeypatch.setattr(ev, "_llm_review", lambda *a: "Low risk. Ship.")
    res = ev.evaluate_run("feat(overview): rename the page")

    assert seen["cmd"][1] == str(tmp_path / "base" / "scripts" / "question-bank.py")
    assert seen["cmd"][seen["cmd"].index("--set") + 1] == str(tmp_path / "base" / "docs" / "question-set.yaml")
    assert seen["env"]["PYTHONPATH"] == str(tmp_path / "project" / "src")
    assert res["verdict"] == "pass" and res["pass_rate"] == 0.7692 and res["misses"] == ["S02"]


def test_below_the_bar_fails_and_a_crashed_scorecard_fails(tmp_path, monkeypatch):
    _, mods = fresh(monkeypatch, BUILD_OUT=tmp_path / "out")
    ev = mods["evaluate"]
    monkeypatch.setattr(ev, "_llm_review", lambda *a: "")
    monkeypatch.setattr(ev, "scorecard", lambda model: ({"pass_rate": 0.5, "results": []}, ""))
    assert ev.evaluate_run()["verdict"] == "fail"
    monkeypatch.setattr(ev, "scorecard", lambda model: (None, "Traceback …"))
    res = ev.evaluate_run()
    assert res["verdict"] == "fail" and "did not complete" in res["error"]


# ---- the registry and the rules agree -------------------------------------------

def test_every_tier2_tool_is_governed_by_the_access_rules():
    import tools
    governed = yaml.safe_load(RULES.read_text())["tools"]
    assert set(tools.REGISTRY) == set(governed) - {"a2a_delegate"}
    assert governed["deploy_staging"]["approval_required"] is True
    assert not any(governed[t]["approval_required"] for t in tools.REGISTRY if t != "deploy_staging")


def test_the_agent_card_offers_the_five_skills(monkeypatch):
    monkeypatch.setenv("A2A_JWT_SECRET", "test")
    import server
    card = server.agent_card()
    assert card.name == "sojourner-tier2-ops"
    assert {s.id for s in card.skills} == {"build", "validate", "evaluate", "deploy", "notify"}
