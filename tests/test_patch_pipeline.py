"""The tier-1 → tier-2 patch channel.

Tier-2 replays tier-1's commits onto its own copy of the baked baseline
(`sojourner-base`): no shared filesystem, no credentials in tier-1 — what
crosses the boundary is a hash-identified patch.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from new_horizons.shared.patch.apply import apply_patch, patch_sha256, reset_to_base

BASE = "sojourner-base"
VIEW = Path("src/new_horizons/app/views/overview.py")


def git(repo: Path, *args: str) -> str:
    p = subprocess.run(["git", *args], cwd=str(repo), capture_output=True,
                       text=True, check=True)
    return p.stdout.strip()


def make_repo(path: Path) -> Path:
    """A repo shaped like the baked image: one baseline commit, tagged."""
    (path / VIEW.parent).mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Sojourner tier-1 agent")
    git(path, "config", "user.email", "agent@sojourner.local")
    (path / VIEW).write_text('TITLE = "Overview"\n')
    (path / "README.md").write_text("# new-horizons\n")
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "chore: new-horizons baseline")
    git(path, "tag", BASE)
    return path


@pytest.fixture()
def tiers(tmp_path):
    """Two independent copies of the same baseline — no shared filesystem."""
    return make_repo(tmp_path / "tier1"), make_repo(tmp_path / "tier2")


def commit_change(repo: Path, text: str, message: str) -> None:
    (repo / VIEW).write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


def format_patch(repo: Path) -> str:
    return subprocess.run(["git", "format-patch", f"{BASE}..HEAD", "--stdout"],
                          cwd=str(repo), capture_output=True, text=True,
                          check=True).stdout


def test_patch_carries_the_developers_commit(tiers):
    tier1, tier2 = tiers
    commit_change(tier1, 'TITLE = "Farm overview"\n', "feat(overview): rename the page")

    res = apply_patch(format_patch(tier1), project_dir=tier2, base_ref=BASE)

    assert res["ok"], res
    assert (tier2 / VIEW).read_text() == 'TITLE = "Farm overview"\n'
    assert res["files"] == [str(VIEW)]
    assert res["commits"] == ["feat(overview): rename the page"]
    # the commit keeps its tier-1 authorship through the handoff
    assert "Sojourner tier-1 agent" in res["author"]


def test_replay_is_idempotent_across_retries(tiers):
    """A failed evaluation means fix-and-re-request: the second attempt must
    land on the baseline, never stack on the first."""
    tier1, tier2 = tiers
    commit_change(tier1, 'TITLE = "Farm overview"\n', "feat(overview): rename the page")
    patch = format_patch(tier1)

    first = apply_patch(patch, project_dir=tier2, base_ref=BASE)
    second = apply_patch(patch, project_dir=tier2, base_ref=BASE)

    assert first["ok"] and second["ok"]
    assert second["commits"] == ["feat(overview): rename the page"]


def test_multiple_commits_replay_in_order(tiers):
    tier1, tier2 = tiers
    commit_change(tier1, 'TITLE = "Farm overview"\n', "feat(overview): rename the page")
    commit_change(tier1, 'TITLE = "Farm overview."\n', "fix(overview): house style full stop")

    res = apply_patch(format_patch(tier1), project_dir=tier2, base_ref=BASE)

    assert res["ok"], res
    assert res["commits"] == ["feat(overview): rename the page", "fix(overview): house style full stop"]
    assert (tier2 / VIEW).read_text() == 'TITLE = "Farm overview."\n'


def test_a_request_with_no_patch_rebuilds_the_baseline(tiers):
    """"Deploy the baseline" must be enforced, not assumed: the work tree still
    holds the previous request's patch."""
    tier1, tier2 = tiers
    commit_change(tier1, 'TITLE = "Farm overview"\n', "feat(overview): rename the page")
    apply_patch(format_patch(tier1), project_dir=tier2, base_ref=BASE)

    res = reset_to_base(project_dir=tier2, base_ref=BASE)

    assert res["ok"], res
    assert res["baseline"] is True
    assert (tier2 / VIEW).read_text() == 'TITLE = "Overview"\n'


def test_tampered_patch_is_refused_not_applied(tiers):
    tier1, tier2 = tiers
    commit_change(tier1, 'TITLE = "Farm overview"\n', "feat(overview): rename the page")
    patch = format_patch(tier1)
    tampered = patch.replace("Farm overview", "Anything else")

    res = apply_patch(tampered, project_dir=tier2, base_ref=BASE, sha_stated=patch_sha256(patch))

    assert res["ok"] is False
    assert "sha256" in res["error"]
    assert (tier2 / VIEW).read_text() == 'TITLE = "Overview"\n'


def test_unapplyable_patch_fails_cleanly(tiers):
    tier1, tier2 = tiers
    commit_change(tier1, 'TITLE = "Farm overview"\n', "feat(overview): rename the page")
    # tier-2's baseline no longer matches what the patch was cut against
    (tier2 / VIEW).write_text("completely different content\n")
    git(tier2, "add", "-A")
    git(tier2, "commit", "-q", "-m", "chore: drift")
    git(tier2, "tag", "-f", BASE)

    res = apply_patch(format_patch(tier1), project_dir=tier2, base_ref=BASE)

    assert res["ok"] is False
    assert res["error"]


def test_ignored_paths_survive_the_rebuild(tiers):
    """`git clean -fd` omits -x on purpose: ignored, regenerable state (a local
    .venv, caches) must survive the rebuild — the sandbox cannot refetch it."""
    tier1, tier2 = tiers
    (tier2 / ".gitignore").write_text(".venv/\n")
    git(tier2, "add", "-A")
    git(tier2, "commit", "-q", "-m", "chore: ignore the venv")
    git(tier2, "tag", "-f", BASE)
    venv = tier2 / ".venv" / "lib"
    venv.mkdir(parents=True)
    (venv / "marker").write_text("x\n")

    commit_change(tier1, 'TITLE = "Farm overview"\n', "feat(overview): rename the page")
    apply_patch(format_patch(tier1), project_dir=tier2, base_ref=BASE)

    assert (venv / "marker").exists()
