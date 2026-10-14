"""The terminal agent's TUI contract: one plugin for both tiers, pinned OpenCode,
the record decides the tier, the catalog wiring between tiers, and the book
shelf's braille covers.

Tests that read a file another part of the repo owns (compose, Dockerfiles, the
tiers' .opencode commands and agents) skip while that file does not exist yet,
and run as soon as it does."""

import importlib.util
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).parents[1]
TUI = ROOT / "infra" / "tui"
OC = {1: ROOT / "tier1" / ".opencode", 2: ROOT / "tier2" / ".opencode"}
RECORD = {1: ROOT / "tier1" / "core.json", 2: ROOT / "tier2" / "core.json"}
COMPOSE = ROOT / "infra" / "compose" / "docker-compose.yml"
DOCKERFILE = {1: ROOT / "tier1" / "Dockerfile", 2: ROOT / "tier2" / "Dockerfile"}
PIN = "1.18.30"
PLUGIN_PATH = "/opt/sojourner/tui/sojourner-ui.tsx"
SERVER_PLUGINS = ["/opt/sojourner/tui/server/audit-log.ts", "/opt/sojourner/tui/server/path-guard.ts"]

_spec = importlib.util.spec_from_file_location("book_covers", ROOT / "scripts" / "book-covers.py")
book_covers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(book_covers)
BOOKS = ROOT / "tier1" / "docs" / "books"


def _need(*paths: Path) -> None:
    missing = [str(p.relative_to(ROOT)) for p in paths if not p.exists()]
    if missing:
        pytest.skip(f"not written yet: {', '.join(missing)}")


def _compose() -> dict:
    _need(COMPOSE)
    return yaml.safe_load(COMPOSE.read_text())


def _record(tier: int) -> dict:
    return json.loads(RECORD[tier].read_text(encoding="utf-8"))


# ---- pinning and loading ------------------------------------------------------

def test_opencode_is_pinned_in_image_and_both_tier_configs():
    _need(DOCKERFILE[1], OC[1] / "package.json", OC[2] / "package.json")
    dockerfile = DOCKERFILE[1].read_text()
    assert f"ARG OPENCODE_VERSION={PIN}" in dockerfile
    assert '--version "${OPENCODE_VERSION}"' in dockerfile
    assert 'test "$(opencode --version)" = "${OPENCODE_VERSION}"' in dockerfile
    for tier, oc in OC.items():
        pkg = json.loads((oc / "package.json").read_text())
        assert pkg["dependencies"]["@opencode-ai/plugin"] == PIN, tier  # exact, no caret
        assert re.fullmatch(r"\d+\.\d+\.\d+", pkg["version"]), tier


def test_both_tiers_load_the_one_plugin_and_its_server_plugins():
    _need(*(oc / "tui.json" for oc in OC.values()), *(oc / "opencode.json" for oc in OC.values()))
    for tier, oc in OC.items():
        tui = json.loads((oc / "tui.json").read_text())
        assert tui["plugin"] == [PLUGIN_PATH] and tui["theme"] == "sojourner", tier
        assert (oc / "themes" / f"{tui['theme']}.json").exists(), tier
        conf = json.loads((oc / "opencode.json").read_text())
        assert conf["plugin"] == SERVER_PLUGINS, tier
        assert not (oc / "plugins").exists(), "server plugins live once, in infra/tui/server"


def test_the_plugin_is_mounted_live_and_baked():
    svc = _compose()["services"]
    for name in ("tier1", "tier2"):
        assert "../tui:/opt/sojourner/tui:ro" in svc[name]["volumes"], name
    _need(DOCKERFILE[1])
    assert "COPY infra/tui /opt/sojourner/tui" in DOCKERFILE[1].read_text()


def test_plugin_registers_only_host_slots():
    types = OC[1] / "node_modules/@opencode-ai/plugin/dist/tui.d.ts"
    if not types.exists():  # build artifact (make demo2-build runs bun install)
        pytest.skip(".opencode/node_modules not installed")
    slot_map = types.read_text()
    host = set(re.findall(r"^\s{4}(\w+): \{", slot_map.split("export type TuiHostSlotMap")[1]
                          .split("};\nexport")[0], re.M))
    src = (TUI / "sojourner-ui.tsx").read_text()
    block = src.split("api.slots.register({")[1].split("\n  });")[0]
    used = set(re.findall(r"^\s{6}(\w+): \(", block, re.M))
    assert used == {"home_logo", "home_prompt", "home_footer", "app_bottom", "app", "sidebar_footer"}
    assert used <= host, used - host


# ---- the record decides the tier ---------------------------------------------

def test_tui_never_branches_on_a_tier_number():
    """core.json is the agent: ui/ and sojourner-ui.tsx read the record (CORE, CAN),
    never `TIER === n`; lib/ derives from the record too."""
    hits = []
    for p in [TUI / "sojourner-ui.tsx", *(TUI / "ui").glob("*.tsx"), *(TUI / "lib").glob("*.ts*")]:
        for n, line in enumerate(p.read_text().splitlines(), 1):
            if re.search(r"\bTIER\s*[!=]==", line):
                hits.append(f"{p.relative_to(TUI)}:{n}: {line.strip()}")
    assert not hits, "\n".join(hits)


def test_the_tui_reads_the_record_schema_the_records_carry():
    env = (TUI / "lib" / "env.ts").read_text()
    for tier in (1, 2):
        rec = _record(tier)
        assert f'"{rec["schema"]}"' in env
        assert "client" not in rec and rec["platform"] == "AGENTIZATION-CORE DEV"
        assert rec["approvals"]["rules"].endswith("rules.yaml")
    assert '"client"' not in env.split("const REQUIRED")[1].split(";")[0]


def test_both_tiers_mount_and_bake_their_record():
    svc = _compose()["services"]
    for tier, name in ((1, "tier1"), (2, "tier2")):
        assert f"../../tier{tier}/core.json:/workspace/core.json:ro" in svc[name]["volumes"], name
        _need(DOCKERFILE[tier])
        assert f"tier{tier}/core.json /opt/sojourner/core.json" in DOCKERFILE[tier].read_text(), name


def test_both_tiers_are_told_the_inference_lane():
    """Inside a tier LLM_BASE_URL is llm-proxy on every lane — so the lane itself
    must reach the tier, or its Inference screen would report local inference."""
    envs = [ROOT / "infra" / "compose" / n for n in ("tier1.env", "tier2.env")]
    _need(*envs)
    for path in envs:
        env = path.read_text()
        assert re.search(r"^LLM_PROVIDER=\w+$", env, re.M), path.name
        assert re.search(r"^LLM_LANE_URL=\S+$", env, re.M), path.name


# ---- SETTINGS: a grouped console, no inference on its own ---------------------

SECTIONS = ["identity", "agents", "inference", "commands", "skills", "books", "documents",
            "prompts", "permissions", "connections", "requests", "audit", "sessions"]


def test_settings_sections_are_the_grouped_console():
    src = (TUI / "ui" / "settings.tsx").read_text()
    ids = re.findall(r'\{ id: "([a-z]+)", group: "(AGENT|CATALOG|GOVERNANCE|MEMORY)"', src)
    assert [i for i, _ in ids] == SECTIONS
    groups = [g for _, g in ids]
    assert groups == sorted(groups, key=["AGENT", "CATALOG", "GOVERNANCE", "MEMORY"].index), "groups stay contiguous"
    assert 'history: "sessions"' in src  # old alert links (section "history") still land


def test_settings_never_asks_the_model_on_its_own():
    """No dwell inference: `s` is the only path to a model brief on this screen."""
    for p in (TUI / "ui").glob("*.tsx"):
        src = p.read_text()
        calls = re.findall(r"summary\.request\(", src)
        if p.name == "settings.tsx":
            assert len(calls) == 1, "one call, inside brief() (the `s` key / the refresh mark)"
            body = src.split("const brief = () => {")[1].split("\n  };")[0]
            assert "summary.request(" in body
        else:
            assert not calls, p.name
        assert "createEffect(on(" not in src or p.name == "header.tsx", f"{p.name}: no selection-driven effects"


def test_settings_shows_the_access_rules_file_the_record_names():
    src = (TUI / "ui" / "settings.tsx").read_text()
    assert "gov.readRules(PATHS.rules)" in src and 'kind: "ACCESS RULES"' in src
    assert "rules: CORE.approvals.rules" in (TUI / "lib" / "env.ts").read_text()


def _frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n"), path
    return yaml.safe_load(text.split("---\n", 2)[1])


BUILT_INS = [*sorted((OC[1] / "commands").glob("*.md")),
             *sorted((OC[2] / "commands").glob("*.md")),
             *sorted((OC[1] / "skills").glob("*/SKILL.md")),
             *sorted(BOOKS.glob("*.md"))]


@pytest.mark.parametrize("path", BUILT_INS, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_every_built_in_carries_an_authored_summary(path):
    """ABOUT shows authored text first. The frontmatter must stay valid YAML —
    OpenCode parses command and skill frontmatter, and a bare `: ` in a value
    would drop the whole file."""
    meta = _frontmatter(path)
    summary = meta.get("summary")
    assert isinstance(summary, str) and 60 <= len(summary) <= 300, path
    assert not re.search(r"\b(seamless|powerful|robust|cutting-edge|world-class)\b", summary, re.I)


# ---- Books: a shelf with braille covers ----------------------------------------

def test_committed_covers_regenerate_byte_for_byte():
    """`make books` is deterministic: same name, same cover — for every book on
    the shelf and every shelf name the record ships with."""
    targets = book_covers.targets()
    stems = [p.stem for p, _ in targets]
    assert stems == sorted({*book_covers.SHELF, *(p.stem for p in BOOKS.glob("*.md"))})
    assert sorted(p.stem for p in (BOOKS / "covers").glob("*.json")) == stems, "orphan or missing cover"
    for path, text in targets:
        assert path.exists(), f"{path.name} missing — run make books"
        assert path.read_text(encoding="utf-8") == text, f"{path.name} drifted — run make books"
        doc = json.loads(text)
        assert book_covers.validate(doc) == []
        assert (doc["spine"]["cols"], doc["spine"]["rows"]) == (14, 6)
        assert (doc["cover"]["cols"], doc["cover"]["rows"]) == (28, 14)


@pytest.mark.skipif(not shutil.which("bun"), reason="bun not installed")
def test_runtime_covers_match_the_build_time_generator():
    """A book tier-2 publishes has no committed cover; the TUI draws it with
    lib/covers.ts — which must be the same algorithm as the script."""
    names = ["architecture", "coding-standards", "release-playbook", "incident-runbook", "x"]
    code = ("const c = await import('./lib/covers.ts'); console.log(JSON.stringify("
            f"{json.dumps(names)}.map((n) => [c.generated(n, 14, 6), c.generated(n, 28, 14)])))")
    r = subprocess.run(["bun", "-e", code], cwd=TUI, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr[-1500:]
    colors = book_covers.tokens()
    expected = [[book_covers.generated(n, 14, 6, colors), book_covers.generated(n, 28, 14, colors)] for n in names]
    assert json.loads(r.stdout) == expected


@pytest.mark.parametrize("path", sorted(BOOKS.glob("*.md")), ids=lambda p: p.stem)
def test_every_book_carries_the_shelf_keys(path):
    meta = _frontmatter(path)
    assert {"title", "subtitle", "summary", "owner", "version"} <= set(meta), path
    assert meta["owner"] == "platform" and str(meta["version"]) == "1.0"
    assert re.search(r"^# .+", path.read_text(), re.M), "the H1 stays"


# ---- tiers and the catalog between them ----------------------------------------

def test_catalog_is_written_by_tier2_and_read_only_in_tier1():
    compose = _compose()
    svc = compose["services"]
    assert "catalog:/workspace/catalog" in svc["tier2"]["volumes"]
    assert "catalog:/workspace/catalog:ro" in svc["tier1"]["volumes"]
    assert "catalog" in compose["volumes"]
    for name, root in (("tier1", "/workspace/project"), ("tier2", "/workspace/catalog")):
        env = svc[name]["environment"]
        assert env["OPENCODE_CONFIG_DIR"] == "/workspace/catalog", name  # native commands/skills
        assert env["SOJOURNER_WRITE_ROOT"] == root, name                # path-guard
    assert "tier2" in svc["tier1"]["depends_on"]  # tier-2 creates the volume read-write first
    # tier-1 mounts it read-only, so OpenCode's per-config-dir .gitignore must pre-exist
    _need(DOCKERFILE[1])
    assert "/workspace/catalog/.gitignore" in DOCKERFILE[1].read_text()


def test_tier_permissions_match_their_roles():
    """Read off the records (core.json compiles to opencode.json `permission`)."""
    t1, t2 = _record(1)["permissions"], _record(2)["permissions"]
    # Deny by default; each tier's own root allowed absolutely.
    assert t1["edit"]["*"] == "deny"
    assert t1["edit"]["/workspace/project/**"] == "allow"
    assert t2["edit"] == {"*": "deny", "/workspace/catalog/**": "allow"}
    # Tier-1 also carries RELATIVE allows: tools pass paths relative to the
    # agent's cwd, and an absolute-only rule denied every legitimate write
    # while the model retried against a wall it could not see. None of them may
    # be absolute, escape upward, or name the other tier's root — path-guard
    # resolves before comparing, and the rootfs is read-only.
    for pattern, action in t1["edit"].items():
        if action != "allow" or pattern.startswith("/workspace/project"):
            continue
        assert not pattern.startswith("/"), pattern
        assert ".." not in pattern, pattern
        assert "catalog" not in pattern, pattern
    # Neither tier may hand work to a subagent: `explore` is read-only, so its
    # edits vanish and the task looks done having changed nothing.
    assert t1["task"] == t2["task"] == "deny"
    approvals = {k: v for k, v in t2["bash"].items() if "approve.py" in k}
    assert approvals and set(approvals.values()) == {"ask"}, "approval stays a human act"
    assert not any("approve.py" in k for k in t1["bash"]), "tier-1 never approves"
    assert t1["webfetch"] == t2["webfetch"] == "deny"


def test_default_agent_names_an_agent_that_actually_exists():
    """A `default_agent` pointing at a missing agent is not a warning: EVERY run
    dies with `default agent "<name>" not found`."""
    for tier in (1, 2):
        _need(OC[tier] / "agents")
        name = _record(tier)["default_agent"]
        found = [p for d in ("agents", "agent") if (p := OC[tier] / d / f"{name}.md").exists()]
        assert found, f"tier-{tier}: default_agent '{name}' has no agent file"
        assert "mode: primary" in found[0].read_text(), \
            f"tier-{tier}: default_agent '{name}' must be a primary agent"


def test_tier2_queue_cli_does_not_shadow_the_stdlib():
    """server.py runs from tier2/; a queue.py there broke the A2A runtime."""
    names = {p.stem for p in (ROOT / "tier2").glob("*.py")}
    assert not names & set(sys.stdlib_module_names), names & set(sys.stdlib_module_names)


def _commands(oc: Path) -> dict[str, str]:
    return {p.stem: p.read_text() for p in (oc / "commands").glob("*.md")}


def test_commands_are_discoverable_in_both_tiers():
    _need(OC[1] / "commands", OC[2] / "commands")
    t1, t2 = _commands(OC[1]), _commands(OC[2])
    assert {"arch-check", "request-deploy", "approve", "help-sojourner"} <= set(t1)
    assert {"approve", "queue", "audit-verify"} <= set(t2)
    for name, body in {**t1, **{f"t2:{k}": v for k, v in t2.items()}}.items():
        assert "help" != name  # built-in in 1.18.30 — a custom one is shadowed
        desc = re.search(r"^description: (.+)$", body, re.M).group(1)
        assert len(desc) <= 60, f"/{name}: {len(desc)} chars"
        assert re.match(r"[A-Z][a-z]+ ", desc), f"/{name}: description should start with a verb"
    for line in ("/arch-check", "/request-deploy", "/approve", "approve.py <task_id>"):
        assert line in t1["help-sojourner"]


def test_plugin_slash_commands_do_not_shadow_builtins():
    src = (TUI / "sojourner-ui.tsx").read_text()
    ours = set(re.findall(r'slashName: "([a-z-]+)"', src))
    assert ours == {"settings", "project", "alerts"}
    builtin = {"agents", "connect", "debug", "diff", "editor", "exit", "help", "mcps", "models", "move",
               "new", "org", "sessions", "skills", "slash", "status", "themes", "variants", "warp",
               "workspaces"}  # slashName values in the 1.18.30 binary
    assert not ours & builtin
    for oc in OC.values():
        if (oc / "commands").exists():
            assert not ours & set(_commands(oc))


# ---- the plugin's own logic (bun) ---------------------------------------------

@pytest.mark.skipif(not shutil.which("bun"), reason="bun not installed")
def test_plugin_logic_bun_suite():
    r = subprocess.run(["bun", "test", "tests"], cwd=TUI, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
