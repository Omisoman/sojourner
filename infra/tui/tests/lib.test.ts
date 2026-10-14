/**
 * Plugin logic that needs no TUI: the core record loader, catalog read/write
 * per role, A2A task parsing, and the server-side path guard.
 * `bun test infra/tui/tests` (tests/test_tui.py runs it when bun is on PATH).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "sojourner-ui-"));
const dirs = { config: join(root, "opencode"), catalog: join(root, "catalog"), audit: join(root, "audit") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
mkdirSync(join(dirs.config, "commands"), { recursive: true });
writeFileSync(join(dirs.config, "commands", "arch-check.md"),
  "---\ndescription: Check the import contracts between packages\n---\n\nRun it.\n");
mkdirSync(join(dirs.config, "skills", "streamlit-view"), { recursive: true });
writeFileSync(join(dirs.config, "skills", "streamlit-view", "SKILL.md"),
  "---\nname: streamlit-view\ndescription: Add a page to the farm app\n---\n\n# streamlit-view\n");

// the tier-2 record, pointed at temp dirs: env.ts reads it once, at import —
// so the modules are imported after
const tier2 = JSON.parse(readFileSync(new URL("../../../tier2/core.json", import.meta.url), "utf8"));
tier2.catalog.path = dirs.catalog;
tier2.catalog.mine = join(root, "mine");
tier2.books = join(root, "books");
tier2.audit.file = join(dirs.audit, "tier2-audit.jsonl");
delete tier2.audit.file_env;
for (const c of tier2.connections) if (c.id === "audit") c.path = dirs.audit;
writeFileSync(join(root, "core.json"), JSON.stringify(tier2));
process.env["SOJOURNER_CORE"] = join(root, "core.json");
process.env["SOJOURNER_CONFIG_DIR"] = dirs.config;
process.env["SOJOURNER_WRITE_ROOT"] = "/workspace/catalog";
const catalog = await import("../lib/catalog.ts");
const env = await import("../lib/env.ts");
const { normState, needsApproval } = await import("../lib/requests.ts");
const { PathGuard } = await import("../server/path-guard.ts");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the core record", () => {
  test("identity and capabilities are read off the record", () => {
    expect(env.TIER).toBe(2);
    expect(env.AGENT).toMatchObject({ id: "sojourner-tier2-ops", version: tier2.version });
    expect(env.AUDIT.channel).toBe("CH-2");
    expect(env.CAN.addCommand && env.CAN.addSkill && env.CAN.addBook && env.CAN.approve).toBe(true);
    expect(env.CAN.requestDeploy || env.CAN.consume).toBe(false);
    expect(env.CAN.verifyChain).toBe(true);
    expect(env.A2A?.secret_env).toBe("A2A_JWT_SECRET");
  });

  test("the signature is sha256 of the sorted, compact record", () => {
    expect(env.canonical({ b: [1, { d: "é", c: null }], a: true })).toBe('{"a":true,"b":[1,{"c":null,"d":"é"}]}');
    expect(env.SIG).toBe(env.SIGNATURE.slice(0, 12));
    expect(env.SIGNATURE).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a missing or invalid record stops the plugin, naming the path", () => {
    const load = (path: string) => Bun.spawnSync([process.execPath, "-e", "await import('./lib/env.ts')"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, SOJOURNER_CORE: path }, stderr: "pipe",
    });
    const missing = load(join(root, "nope.json"));
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain(join(root, "nope.json"));
    writeFileSync(join(root, "bad.json"), JSON.stringify({ schema: "sojourner/terminal-agent/1", id: "x" }));
    const bad = load(join(root, "bad.json"));
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.toString()).toContain("missing");
  });
});

describe("catalog (tier 2 — the curator)", () => {
  test("lists built-in entries with their frontmatter", () => {
    const [cmd] = catalog.list("command");
    expect(cmd).toMatchObject({ title: "/arch-check", source: "built-in",
                                description: "Check the import contracts between packages" });
    expect(catalog.list("skill")[0]).toMatchObject({ name: "streamlit-view", description: "Add a page to the farm app" });
  });

  test("publishes a skill in OpenCode's format, never overwriting", () => {
    const e = catalog.add("skill", { name: "Release Notes!", description: "Draft notes", body: "Group by type." });
    expect(e.path).toBe(join(dirs.catalog, "skills", "release-notes", "SKILL.md"));
    const text = readFileSync(e.path, "utf8");
    expect(text).toStartWith("---\nname: release-notes\ndescription: Draft notes\n---\n");
    expect(catalog.list("skill").map((s) => [s.name, s.source])).toContainEqual(["release-notes", "ops"]);
    expect(() => catalog.add("skill", { name: "release notes", description: "x", body: "y" })).toThrow(/exists/);
  });

  test("commands keep frontmatter to keys OpenCode knows", () => {
    const e = catalog.add("command", { name: "notes", description: "Draft release notes", body: "Do $ARGUMENTS" });
    expect(readFileSync(e.path, "utf8")).toBe("---\ndescription: Draft release notes\n---\n\nDo $ARGUMENTS\n");
    expect(catalog.published().map((p) => p.title)).toEqual(expect.arrayContaining(["/notes", "release-notes"]));
  });

  test("a published book carries the shelf's keys and a generated cover", async () => {
    const e = catalog.add("book", { name: "Incident runbook", description: "What to do when staging breaks",
                                     body: "Page the operator first. Roll back from .prev. Then write it up." });
    const { meta } = catalog.frontmatter(readFileSync(e.path, "utf8"));
    expect(meta).toMatchObject({ title: "Incident runbook", subtitle: "What to do when staging breaks",
                                 summary: "Page the operator first. Roll back from .prev.",
                                 owner: "sojourner-tier2-ops", version: "1.0" });
    expect(e.summary).toBe("Page the operator first. Roll back from .prev.");
    const covers = await import("../lib/covers.ts");
    const c = covers.coversFor(e.path);
    expect(c.source).toBe("generated");
    expect(covers.initials("incident-runbook")).toBe("IR");
    expect(c.spine.lines.map((r) => r.map((x) => x[1]).join("").length)).toEqual(Array(6).fill(14));
    expect(c.cover.lines.length).toBe(14);
  });

  test("rejects empty names and bodies", () => {
    expect(() => catalog.add("book", { name: "!!!", body: "x" })).toThrow(/letter or digit/);
    expect(() => catalog.add("book", { name: "ok", body: "  " })).toThrow(/empty/);
  });

  test("frontmatter parser tolerates quotes and missing fences", () => {
    expect(catalog.frontmatter('---\ntitle: "Hi"\n---\nbody').meta).toEqual({ title: "Hi" });
    expect(catalog.frontmatter("no fence").body).toBe("no fence");
    expect(catalog.slug("Quote Card — v2")).toBe("quote-card-v2");
  });
});

describe("governance", async () => {
  const gov = await import("../lib/governance.ts");
  const tier1 = JSON.parse(readFileSync(new URL("../../../tier1/core.json", import.meta.url), "utf8"));

  test("one row per permission rule, string rules included", () => {
    const rs = gov.rules(tier1.permissions);
    expect(rs.length).toBe(36); // 10 edit + 24 bash + task + webfetch
    expect(rs[0]).toEqual({ tool: "edit", pattern: "*", action: "deny" });
    expect(rs.at(-1)).toEqual({ tool: "webfetch", pattern: "", action: "deny" });
    expect(gov.tally(rs)).toEqual({ allow: 32, deny: 4, ask: 0 });
  });

  // the shape of new-horizons' shared/rules/rules.yaml, other blocks included
  const RULES_YAML = [
    "# Access rules — tool -> allowed roles -> approval gate.",
    "roles:", "  - tier1-dev      # OpenCode developer sandbox", "  - ops", "  - admin", "",
    "tools:", "  a2a_delegate:            # tier1 -> tier2 task creation",
    "    roles: [tier1-dev, admin]", "    approval_required: false",
    "  build_run:", "    roles: [ops, admin]", "    approval_required: false",
    "  deploy_staging:", "    roles: [ops, admin]", "    approval_required: true          # input-required",
    "", "evaluation:", "  model: llama3.1:8b", "  min_pass_rate: 0.75", "",
    "analytics_tools:", "  sql_query:          {roles: [analyst], approval_required: false}", "",
  ].join("\n");

  test("the access rules parse to roles, the pipeline tools and their gate", () => {
    const p = gov.parseRules(RULES_YAML);
    expect(p.roles).toEqual(["tier1-dev", "ops", "admin"]);
    expect(p.tools.map((t) => t.tool)).toEqual(["a2a_delegate", "build_run", "deploy_staging"]);
    expect(p.tools.filter((t) => t.approval).map((t) => t.tool)).toEqual(["deploy_staging"]);
    expect(p.tools[0]!.roles).toEqual(["tier1-dev", "admin"]);
  });

  test("the shipped rules file (new-horizons, when checked out beside) gates deploys only", () => {
    const sibling = new URL("../../../../new-horizons/src/new_horizons/shared/rules/rules.yaml", import.meta.url);
    const { access, text } = gov.readRules(fileURLToPath(sibling));
    if (!text) return; // CI installs new-horizons from git; the inline shape above still runs
    expect(access!.roles).toEqual(["tier1-dev", "ops", "admin"]);
    expect(access!.tools.map((t) => t.tool)).toEqual(expect.arrayContaining(
      ["a2a_delegate", "gitea_pr", "build_run", "evaluate_run", "deploy_staging", "notify"]));
    expect(access!.tools.filter((t) => t.approval).map((t) => t.tool)).toEqual(["deploy_staging"]);
  });

  test("a persona's denied tools come from its frontmatter", () => {
    const dir = join(root, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reviewer.md"), "---\ndescription: Reviews diffs against the books\nmode: subagent\n" +
      "tools:\n  write: false\n  edit: false\n---\n\nReview only.\n");
    writeFileSync(join(dir, "developer.md"), "---\ndescription: Builds features\nmode: primary\n---\n\nBuild.\n");
    const reviewer = gov.persona(join(dir, "reviewer.md"), "reviewer", "subagent");
    expect(reviewer.denied).toEqual(["write", "edit"]);
    expect(reviewer.description).toStartWith("Reviews diffs");
    expect(gov.persona(join(dir, "developer.md"), "developer", "primary").denied).toEqual([]);
  });
});

describe("A2A task parsing", () => {
  test("proto enum names become the states the UI shows", () => {
    expect(normState("TASK_STATE_INPUT_REQUIRED")).toBe("input-required");
    expect(normState("TASK_STATE_COMPLETED")).toBe("completed");
    expect(normState(undefined)).toBe("unknown");
    expect(needsApproval({ state: "input-required" } as never)).toBe(true);
  });
});

describe("path-guard (server plugin)", () => {
  test("allows writes under the tier's root only", async () => {
    const hooks = await PathGuard({} as never);
    const before = hooks["tool.execute.before"]!;
    await expect(before({ tool: "write" } as never, { args: { filePath: "/workspace/catalog/skills/x/SKILL.md" } } as never))
      .resolves.toBeUndefined();
    await expect(before({ tool: "edit" } as never, { args: { filePath: "/workspace/project/src/a.py" } } as never))
      .rejects.toThrow(/outside \/workspace\/catalog/);
    await expect(before({ tool: "read" } as never, { args: { filePath: "/etc/passwd" } } as never))
      .resolves.toBeUndefined();
  });
});

describe("summary", async () => {
  process.env["SOJOURNER_SUMMARY_DIR"] = join(root, "summaries");
  const summary = await import("../lib/summary.ts");
  const spec = { kind: "book", title: "Arch", text: "rules", ask: "summarise" };
  test("key follows the content, not the call", () => {
    expect(summary.keyOf(spec)).toBe(summary.keyOf({ ...spec }));
    expect(summary.keyOf(spec)).not.toBe(summary.keyOf({ ...spec, text: "rules, edited" }));
  });
  test("an uncached item is not summarised until asked", () => {
    expect(summary.get(summary.keyOf(spec)).state).toBe("none");
  });
  test("clean strips think blocks, markdown and bullets", () => {
    expect(summary.clean("<think>x</think>\n## Title\n- **One** rule\n2. Two `code`\n")).toBe("Title\nOne rule\nTwo code");
  });
});
