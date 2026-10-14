/**
 * Who this TUI is — read from ONE record, the tier's core.json (SOJOURNER_CORE,
 * default /workspace/core.json, bind-mounted read-only; baked at
 * /opt/sojourner/core.json). Identity, paths, audit channel, documents and what
 * the console may do are all DERIVED from it; nothing here branches on a
 * tier number. The same record compiles the tier's opencode.json
 * (scripts/core-compile.py), and its sha256 is the `core <sig>` on screen.
 *
 * A missing or invalid record is a hard error at plugin load: the console
 * must never quietly fall back to being "tier 1".
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Tier = 1 | 2;
export type Kind = "command" | "skill" | "book" | "document" | "prompt";

export type QuickAction = {
  title: string;
  description: string;
  category: string;
  action:
    | { type: "view"; path: string }
    | { type: "settings"; section: string }
    | { type: "prompt"; text: string }
    | { type: "none" };
};

export type Connection = {
  id: string;
  kind: "a2a" | "openai-compatible" | "volume";
  url?: string;
  url_env?: string;
  role?: string;
  token_env?: string;
  secret_env?: string;
  lane_env?: string;
  lane_url_env?: string;
  path?: string;
  access?: "ro" | "rw";
};

export type Rules = Record<string, string> | string;

export type Core = {
  schema: "sojourner/terminal-agent/1";
  id: string;
  tier: Tier;
  name: string;
  role: string;
  version: string;
  platform: string;
  workspace: { name: string; dir: string; write_root: string; kind: string };
  inference: {
    default: string;
    provider: { id: string; name: string; npm: string; base_url_env: string };
    models: Record<string, string>;
    residency: string;
    local_always: string[];
  };
  agents: { name: string; mode: "primary" | "subagent"; file: string }[];
  default_agent: string;
  catalog: { path: string; role: "consumer" | "curator"; adds?: Kind[]; publishes?: Kind[]; mine: string };
  books: string;
  documents: string[];
  connections: Connection[];
  permissions: Record<string, Rules>;
  guards: { path_guard_root: string; read_only: string[]; network: string };
  approvals: { can_approve: boolean; can_request: boolean; rules: string };
  audit: { channel: string; kind: string; version: string; file: string; file_env?: string };
  home: { placeholders: string[]; quick_actions: QuickAction[] };
};

export function readJson<T>(path: string | URL): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const REQUIRED: (keyof Core)[] = ["schema", "id", "tier", "name", "role", "version", "platform",
  "workspace", "inference", "agents", "default_agent", "catalog", "books", "documents", "connections",
  "permissions", "guards", "approvals", "audit", "home"];

/** SOJOURNER_CORE when set (tests, a second record); else the mounted record, else the image bake. */
export const CORE_PATH = process.env["SOJOURNER_CORE"]
  ?? ["/workspace/core.json", "/opt/sojourner/core.json"].find((p) => existsSync(p)) ?? "/workspace/core.json";

function loadCore(path: string): Core {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`sojourner-ui: cannot read the core record at ${path} (SOJOURNER_CORE) — ${(e as Error).message}`);
  }
  let rec: Core;
  try {
    rec = JSON.parse(text) as Core;
  } catch (e) {
    throw new Error(`sojourner-ui: the core record at ${path} is not valid JSON — ${(e as Error).message}`);
  }
  const missing = REQUIRED.filter((k) => !(k in (rec as object)));
  if (missing.length) throw new Error(`sojourner-ui: the core record at ${path} is missing ${missing.join(", ")}`);
  if (rec.schema !== "sojourner/terminal-agent/1") throw new Error(`sojourner-ui: ${path} has schema ${rec.schema}`);
  return rec;
}

/** JSON with sorted keys and no whitespace — Python's json.dumps(sort_keys, (",", ":"), ensure_ascii=False). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const CORE: Core = loadCore(CORE_PATH);
/** sha256 of the canonical record — scripts/core-compile.py --sign computes the same. */
export const SIGNATURE = createHash("sha256").update(canonical(CORE), "utf8").digest("hex");
export const SIG = SIGNATURE.slice(0, 12);

/** Display only ("tier 1"); never branch on it — branch on CAN or CORE. */
export const TIER: Tier = CORE.tier;

export const PLUGIN = {
  name: "sojourner-ui",
  version: readJson<{ version: string }>(new URL("../package.json", import.meta.url))?.version ?? "0.0.0",
};

export const AGENT = {
  tier: CORE.tier,
  id: CORE.id,
  name: CORE.name,
  role: CORE.role,
  version: CORE.version,
};

export const AUDIT = {
  channel: CORE.audit.channel,
  kind: CORE.audit.kind,
  version: CORE.audit.version,
  file: (CORE.audit.file_env && process.env[CORE.audit.file_env]) || CORE.audit.file,
};

export const PLATFORM = CORE.platform;

const volume = (id: string) => CORE.connections.find((c) => c.kind === "volume" && c.id === id);

export const PATHS = {
  /** The tier's OpenCode config dir (ro bind mount of tier{1,2}/.opencode). */
  config: process.env["SOJOURNER_CONFIG_DIR"] ?? "/workspace/.opencode",
  /** Where console actions are logged beside the tool log (the audit volume). */
  auditDir: volume("audit")?.path ?? dirname(AUDIT.file),
  /** Shared catalog: curator writes, consumer reads (and uses it as OPENCODE_CONFIG_DIR). */
  catalog: CORE.catalog.path,
  books: CORE.books,
  core: CORE_PATH,
  agents: CORE.documents.find((d) => d.endsWith("/AGENTS.md")) ?? "/workspace/AGENTS.md",
  /** The console's own writable corner: saved prompts (consumer), cached briefs. */
  mine: CORE.catalog.mine,
  /** The access-rules file (roles → tools → approval gate) the tier-2 RBAC enforces. */
  rules: CORE.approvals.rules,
  modelState: join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "model.json"),
  /** Image bake: the tier-2 server code, the bake root (cwd for python), the venv. */
  tier2: "/opt/sojourner/tier2",
  shared: "/opt/sojourner",
  bake: "/opt/sojourner",
  python: "/opt/venv/bin/python",
};

/** Documents this console can open (globs are a single trailing `*.md` level). */
export const DOCUMENTS: string[] = CORE.documents;

const allowed = new Set<Kind>([...(CORE.catalog.publishes ?? []), ...(CORE.catalog.adds ?? [])]);
/** What this console may do — every flag read off the record. */
export const CAN = {
  addCommand: allowed.has("command"),
  addSkill: allowed.has("skill"),
  addBook: allowed.has("book"),
  addPrompt: allowed.has("prompt"),
  approve: CORE.approvals.can_approve,
  requestDeploy: CORE.approvals.can_request,
  verifyChain: CORE.audit.kind === "hash chain",
  /** consumer: reads the catalog, tracks what is new, keeps its own prompts */
  consume: CORE.catalog.role === "consumer",
  /** curator: publishes into the catalog */
  publish: CORE.catalog.role === "curator",
};

/** The one A2A connection (tier-2's queue), however this console reaches it. */
export const A2A: Connection | undefined = CORE.connections.find((c) => c.kind === "a2a");
export const A2A_URL = (A2A?.url_env && process.env[A2A.url_env]) || A2A?.url || "http://localhost:9000";

/** The inference lane as the tier was told it (scripts/llm-target.sh writes both). */
export function lane(): { mode: string; url: string } {
  const llm = CORE.connections.find((c) => c.kind === "openai-compatible");
  const mode = (llm?.lane_env && process.env[llm.lane_env]) || "local";
  const url = (llm?.lane_url_env && process.env[llm.lane_url_env])
    || (llm?.url_env && process.env[llm.url_env]) || "";
  return { mode, url };
}

/** SOJOURNER_UI_DEBUG=1 -> /tmp/sojourner-ui.log (the TUI owns the terminal; no console). */
export function debug(...parts: unknown[]) {
  if (process.env["SOJOURNER_UI_DEBUG"] !== "1") return;
  try {
    appendFileSync("/tmp/sojourner-ui.log", `${new Date().toISOString()} ${parts.map((p) =>
      typeof p === "string" ? p : JSON.stringify(p)).join(" ")}\n`);
  } catch {
    // debugging must never break the TUI
  }
}
