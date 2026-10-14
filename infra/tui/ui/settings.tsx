/**
 * SETTINGS — the agent's console, read off its record (core.json) and grouped
 * the way an engineer reasons about an agent:
 *
 *   AGENT       Identity · Agents · Inference
 *   CATALOG     Commands · Skills · Books · Documents · Prompts
 *   GOVERNANCE  Permissions · Connections · Requests/Approvals · Audit
 *   MEMORY      Sessions
 *
 * Keys (the layers live in sojourner-ui.tsx) — menu: ↑↓ jk move · → l enter open
 * the section · esc leave. Rows: ↑↓ jk move · enter OPEN · u USE (fill the
 * chat and leave) · a add · x reject · r refresh · s brief · / filter ·
 * ← h esc back to the menu. The hint row lists exactly the keys that apply
 * to the selected row.
 *
 * Under every list: the detail band (ui/detail.tsx) — a cover on the left,
 * ABOUT on the right. Nothing on this screen asks the model on its own: `s`
 * is the only inference here.
 *
 * Books is a shelf at ≥ 100 columns: braille covers (lib/covers.ts) as tiles,
 * ←→ hl along the shelf, the selected book's cover + contents in the band.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { readFileSync } from "node:fs";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import * as audit from "../lib/audit.ts";
import * as catalog from "../lib/catalog.ts";
import { coversFor } from "../lib/covers.ts";
import { A2A, AGENT, AUDIT, CAN, CORE, lane, PATHS, PLUGIN, SIG, SIGNATURE, TIER } from "../lib/env.ts";
import * as gov from "../lib/governance.ts";
import { BOLD, C, type Run } from "../lib/palette.ts";
import { approve, needsApproval, reject, type Task } from "../lib/requests.ts";
import type { Store } from "../lib/store.tsx";
import * as summary from "../lib/summary.ts";
import { type About, bookAbout, bookCover, type Cover, type CoverLine, DetailPane, entryAbout, entryCover, taskAbout,
         taskCover } from "./detail.tsx";
import { ask, confirm, view } from "./dialogs.tsx";
import { fillPrompt } from "./home.tsx";
import { CompactMark, Runs, useSize } from "./logo.tsx";

export const SETTINGS_ROUTE = "sojourner.settings";

export type From = { name: string; params?: Record<string, unknown> };
type Tone = "ops" | "new" | "mine" | "warn" | "ok" | "err" | "muted" | "accent";
type Group = "AGENT" | "CATALOG" | "GOVERNANCE" | "MEMORY";

type Row = {
  key: string;
  title: string;
  glyph?: string;
  detail?: string;
  tag?: string;
  tone?: Tone;
  add?: boolean;
  /** enter */
  open?: () => void;
  openLabel?: string;
  /** u — fill the chat and leave */
  use?: () => void;
  useLabel?: string;
  /** shown in the hint row instead of `u …` when there is nothing to use */
  note?: string;
  reject?: () => void;
  cover?: () => Cover;
  about?: () => About;
  /** 14×6 braille spine — a book on the shelf */
  spine?: () => Run[][];
};
type Section = {
  id: string;
  group: Group;
  title: string;
  hint: string;
  count: () => string;
  countFg?: () => string | undefined;
  rows: () => Row[];
  /** entering the section (load data) */
  open?: () => void;
  /** leaving it: what was shown is now acknowledged — "new" tags and alerts clear */
  seen?: () => void;
  /** r — the section shows live state */
  refresh?: () => void;
  /** one card, no list */
  card?: boolean;
  /** a shelf of tiles instead of rows (at ≥ 100 columns) */
  shelf?: boolean;
  coverWidth?: number;
};

export type SettingsCtl = {
  move(d: number): void;
  /** ← h / → l: the menu and the rows — or along the shelf */
  left(): void;
  right(): void;
  focus(where: "menu" | "rows" | "toggle"): void;
  enter(): void;
  back(): void;
  add(): void;
  use(): void;
  reject(): void;
  refresh(): void;
  brief(): void;
  filter(): void;
  /** true while `/` is taking typed text — the settings key layer stands down */
  typing(): boolean;
};
let ctl: SettingsCtl | undefined;
export const settingsCtl = () => ctl;

/** Section ids other screens (alerts, quick actions) may still use. */
const ALIAS: Record<string, string> = { history: "sessions", model: "inference", approvals: "requests" };

const TONE: Record<Tone, string> = {
  ops: C.blue, new: C.yellow, mine: C.green, warn: C.yellow, ok: C.green, err: C.red, muted: C.muted, accent: C.accent,
};
const ACTION_TONE: Record<gov.Action, Tone> = { allow: "ok", deny: "err", ask: "warn" };

const stateTone = (s: string): Tone =>
  s === "input-required" ? "warn" : s === "completed" ? "ok" : ["failed", "rejected", "canceled"].includes(s) ? "err" : "muted";

const GLYPH: Partial<Record<catalog.Kind, string>> = { skill: "◆", document: "▫", prompt: "❯" };

function sourceTag(e: catalog.Entry, store: Store): { tag: string; tone: Tone } {
  if (e.source === "mine") return { tag: "mine", tone: "mine" };
  if (e.source === "ops") {
    if (store.isNew(e.path)) return { tag: "new from ops", tone: "new" };
    return { tag: CAN.publish ? "published" : "from ops", tone: "ops" };
  }
  return { tag: "built-in", tone: "muted" };
}

function taskText(t: Task): string {
  const lines = [`task      ${t.id}`, `state     ${t.state}`, `skill     ${t.skill}`,
                 `summary   ${t.summary}`, `requested ${t.requestedBy}`, `updated   ${t.updated}`];
  if (t.message) lines.push("", t.message);
  for (const a of t.artifacts) {
    lines.push("", `# ${a.name}`);
    try {
      lines.push(JSON.stringify(JSON.parse(a.text), null, 1).slice(0, 1600));
    } catch {
      lines.push(a.text.slice(0, 1600));
    }
  }
  return lines.join("\n");
}

function read(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

const kv = (k: string, v: string, w = 11): CoverLine => ({ text: `${k.padEnd(w)}${v}` });
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const stripNote = (s: string) => s.replace(/\s*\(.*\)\s*$/, "");
/** host:port of a URL — covers are narrow */
const host = (u: string) => u.replace(/^\w+:\/\//, "").replace(/\/.*$/, "") || u;

export function SettingsPage(props: { api: TuiPluginApi; store: Store; params?: Record<string, unknown> }) {
  const api = props.api;
  const store = props.store;
  const from = (props.params?.["from"] as From | undefined) ?? { name: "home" };
  const size = useSize(api);
  const [sessions, setSessions] = createSignal<{ id: string; title: string; updated: number }[]>([]);
  const [busy, setBusy] = createSignal<string | undefined>();
  const [card, setCard] = createSignal<gov.Card | undefined>();

  const leave = () => api.route.navigate(from.name, from.params);
  const use = (text: string) => {
    leave();
    fillPrompt(api, text);
  };
  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    api.ui.toast({ message, variant, duration: 4000 });

  const list = (kind: catalog.Kind) => (store.tick(), catalog.list(kind));
  const modelId = () => store.model().modelID || process.env["LLM_MODEL_DEFAULT"] || "qwen3:8b";
  const narrow = () => size().cols < 100;
  const ctx = process.env["LLM_NUM_CTX"] ?? "8192";

  // ---- actions ------------------------------------------------------------------

  async function addFlow(kind: Exclude<catalog.Kind, "document">) {
    const noun = { command: "command", skill: "skill", book: "book", prompt: "prompt" }[kind];
    const where = kind === "prompt" && CAN.consume ? "your prompts" : "the ops catalog → tier-1";
    const name = await ask(api, `New ${noun} — name`, kind === "command" ? "release-notes" : "", "",
                           `saved to ${where}`);
    if (!name) return api.ui.dialog.clear();
    const description = kind === "prompt" || kind === "book"
      ? await ask(api, `New ${noun} — one-line description`, "optional")
      : await ask(api, `New ${noun} — description`, kind === "command" ? "Draft release notes from the last commits" : "");
    if (kind !== "prompt" && kind !== "book" && !description) return api.ui.dialog.clear();
    const bodyHint = { command: "the prompt the command sends ($ARGUMENTS = what follows the command)",
                       skill: "instructions the agent follows when it uses the skill",
                       book: "the rules or procedure, in one paragraph",
                       prompt: "the text that fills the chat box" }[kind];
    const text = await ask(api, `New ${noun} — ${kind === "prompt" ? "text" : "content"}`, "", "", bodyHint);
    api.ui.dialog.clear();
    if (!text) return;
    try {
      const e = catalog.add(kind, { name, description, body: text });
      const hash = await audit.record(CAN.publish ? "catalog_publish" : "prompt_saved",
                                      { kind, name: e.name, path: e.path });
      store.refresh();
      toast(`${e.title} ${CAN.publish && kind !== "prompt" ? "published to tier-1" : "saved"}${hash ? ` · audit ${hash}` : ""}`, "success");
    } catch (err) {
      toast(String((err as Error).message ?? err), "error");
    }
  }

  async function doApprove(t: Task) {
    if (!(await confirm(api, "Approve deploy", `${t.summary}\n\ntask ${t.id.slice(0, 8)} → deploy_staging, smoke, notify`))) return;
    setBusy(t.id);
    toast(`approving ${t.id.slice(0, 8)} — deploy, smoke and notify run now`);
    const r = await approve(t.id);
    setBusy(undefined);
    store.refresh();
    const state = /state=(\S+)/.exec(r.out.split("\n").reverse().join("\n"))?.[1];
    toast(r.ok ? `approved → ${state ?? "done"}` : `approve failed: ${r.out.split("\n").pop()}`, r.ok ? "success" : "error");
  }

  async function doReject(t: Task) {
    if (!needsApproval(t)) return toast("only a task waiting for approval can be rejected", "warning");
    if (!(await confirm(api, "Reject deploy", `${t.summary}\n\ntask ${t.id.slice(0, 8)} will be canceled`))) return;
    const r = await reject(t.id);
    if (r.ok) await audit.record("approval_rejected", { task: t.id, summary: t.summary });
    store.refresh();
    toast(r.ok ? `rejected → ${r.out}` : `reject failed: ${r.out}`, r.ok ? "success" : "error");
  }

  async function loadSessions() {
    try {
      const r: any = await api.client.session.list();
      const all: any[] = r?.data ?? [];
      setSessions(all.filter((s) => !s.parentID)
        .map((s) => ({ id: s.id, title: s.title, updated: s.time?.updated ?? s.time?.created ?? 0 }))
        .sort((a, b) => b.updated - a.updated).slice(0, 15));
    } catch {
      setSessions([]);
    }
  }

  const loadCard = () => {
    if (A2A) void gov.agentCard(gov.connectionUrl(A2A)).then(setCard);
  };

  // ---- rows ---------------------------------------------------------------------

  const entryRows = (kind: catalog.Kind, useText: (e: catalog.Entry) => string, useLabel = "use"): Row[] =>
    list(kind).map((e) => {
      const { tag, tone } = sourceTag(e, store);
      const body = () => catalog.body(e);
      return {
        key: e.path, title: e.title, glyph: GLYPH[kind], detail: e.description, tag, tone,
        open: () => view(api, e.title, body(), e.path), openLabel: "read",
        use: () => use(useText(e)), useLabel,
        cover: () => entryCover(e, body(), tag, TONE[tone]),
        about: () => entryAbout(e, body()),
      };
    });

  /** the band under the shelf: room for the 28×14 cover, or the spine */
  const bigCover = () => pane() - 2 - 10 >= 19;

  const bookRows = (): Row[] => list("book").map((e) => {
    const { tag, tone } = sourceTag(e, store);
    const body = () => catalog.body(e);
    const covers = () => coversFor(e.path);
    const edition = [e.meta["version"] && `v${e.meta["version"]}`, e.meta["owner"]].filter(Boolean).join(" · ");
    return {
      key: e.path, title: e.title, detail: e.meta["subtitle"] || e.description, tag, tone,
      open: () => view(api, e.title, body(), e.path, true, edition ? ` · ${edition}` : undefined), openLabel: "open",
      use: () => use(`Follow the book ${e.path}. `), useLabel: "follow in chat",
      cover: () => bookCover(e, body(), covers(), tag, TONE[tone], bigCover()),
      about: () => bookAbout(e, body(), covers(), narrow()),
      spine: () => covers().spine.lines,
    };
  });

  const addRow = (kind: Exclude<catalog.Kind, "document">, label: string): Row[] =>
    ({ command: CAN.addCommand, skill: CAN.addSkill, book: CAN.addBook, prompt: CAN.addPrompt }[kind])
      ? [{ key: `add:${kind}`, title: label, add: true, tone: "accent",
           detail: kind === "prompt" && CAN.consume ? "saved in your workspace" : "published to tier-1 through the catalog",
           open: () => void addFlow(kind), openLabel: "add",
           cover: () => ({ kind: `NEW ${kind.toUpperCase()}`, title: label.replace(/^\+\s*/, ""),
                           subtitle: kind === "prompt" && CAN.consume ? "your workspace" : "ops catalog → tier-1",
                           lines: ["name", "one-line description", kind === "prompt" ? "text" : "content"]
                             .map((t, i) => ({ text: `${i + 1}  ${t}`, fg: C.text })),
                           foot: ["enter or a to start"] }),
           about: () => ({ text: kind === "prompt" && CAN.consume
             ? "Saves a prompt in your workspace. u on it later fills the chat box with it."
             : `Writes a ${kind} into the shared catalog. Tier-1 reads the catalog read-only: it sees the ${kind} on its next refresh, flagged "new from ops", and the publish is recorded in audit channel 2.` }) }]
      : [];

  // AGENT ----------------------------------------------------------------------------

  const identityLines = (): CoverLine[] => [
    kv("id", CORE.id), kv("tier", String(TIER)), kv("role", CORE.role), kv("version", CORE.version),
    { text: `${"core".padEnd(11)}${SIG}`, fg: C.accentBright },
    kv("platform", CORE.platform),
    kv("workspace", CORE.workspace.dir), kv("write root", CORE.workspace.write_root),
    kv("catalog", CORE.catalog.role), kv("audit", `${AUDIT.channel} · ${AUDIT.kind} ${AUDIT.version}`),
    kv("OpenCode", api.app.version), kv("plugin", `${PLUGIN.name} ${PLUGIN.version}`), kv("image", PATHS.bake),
  ];
  const IDENTITY_LINE = "This console is compiled from one record. Change the record, recompile, and the agent's persona, catalog, permissions, connections and audit channel follow.";

  const identityRow = (): Row => ({
    key: "identity", title: CORE.name,
    open: () => view(api, `core.json · core ${SIG}`, read(PATHS.core, "core.json not readable"), `${PATHS.core} · sha256 ${SIGNATURE}`, false),
    openLabel: "view core.json",
    cover: () => ({ kind: "IDENTITY", tag: `tier ${TIER}`, tagFg: C.accent, title: CORE.name, subtitle: CORE.role,
                    lines: identityLines(), foot: [PATHS.core] }),
    about: () => ({
      text: IDENTITY_LINE,
      sections: narrow() ? [{ title: "RECORD", lines: identityLines().map((l) => l.text) }] : undefined,
      facts: [`core ${SIG} — sha256 of the sorted record (enter shows it)`, `${PATHS.core} → .opencode/opencode.json (make core)`],
    }),
  });

  const agentRows = (): Row[] => CORE.agents.map((a) => {
    const p = gov.persona(`${PATHS.config}/${a.file}`, a.name, a.mode);
    const sub = a.mode === "subagent";
    return {
      key: `agent:${a.name}`, title: a.name, glyph: "◉", detail: p.description,
      tag: a.name === CORE.default_agent ? "default" : a.mode, tone: a.name === CORE.default_agent ? "accent" : "muted",
      open: () => view(api, `@${a.name} · ${a.mode}`, p.body || "(empty persona)", p.path), openLabel: "read persona",
      use: sub ? () => use(`@${a.name} `) : undefined, useLabel: "mention",
      note: sub ? undefined : "current",
      cover: () => ({ kind: "AGENT", tag: a.mode, tagFg: sub ? C.muted : C.accent, title: a.name, subtitle: p.description,
                      lines: [kv("mode", a.mode, 8), kv("default", a.name === CORE.default_agent ? "yes" : "no", 8),
                              kv("denied", p.denied.length ? p.denied.join(", ") : "none", 8)],
                      foot: [a.file] }),
      about: () => ({ text: p.description, facts: [p.path, sub ? "u mentions it in the chat (@name)" : "the primary agent — every chat runs as it"] }),
    };
  });

  const laneTitle = () => {
    const l = lane();
    if (l.mode === "local") return "local · host Ollama through llm-proxy";
    if (l.mode === "rented") return `rented · ${l.url}`;
    if (l.mode === "claude") return "claude · LiteLLM gateway";
    if (l.mode === "hybrid") return "hybrid";
    return `${l.mode} · ${l.url}`;
  };
  const LOCAL_LINE = "Inference runs on this machine: host Ollama, reached through llm-proxy — the only route out of this container's network.";
  const REMOTE_LINE = "Inference leaves this machine: one controlled egress point to the configured endpoint";

  const inferenceRows = (): Row[] => {
    const l = lane();
    const local = l.mode === "local";
    const cur = store.model();
    const pick = () => api.keymap.dispatchCommand("model.list");
    const rows: Row[] = [{
      key: "lane", title: laneTitle(), detail: `chat through ${process.env["LLM_BASE_URL"] ?? "?"}`,
      tag: l.mode, tone: local ? "ok" : "warn",
      cover: () => ({ kind: "LANE", tag: l.mode, tagFg: local ? C.green : C.yellow, title: laneTitle(),
                      lines: [kv("in tier", host(process.env["LLM_BASE_URL"] ?? "?"), 9), kv("lane", host(l.url || "?"), 9),
                              kv("switch", "make llm-target", 9)],
                      foot: ["LLM_PROVIDER · LLM_LANE_URL"] }),
      about: () => ({ text: local ? LOCAL_LINE : REMOTE_LINE, fg: local ? C.text : C.yellow,
                      facts: ["embeddings and vision stay local on every lane", "switch: make llm-target MODE=local|rented|claude|hybrid"] }),
    }, {
      key: "resident", title: cur.name, detail: `${cur.providerID}/${cur.modelID} · context ${ctx}`, tag: "resident", tone: "ok",
      open: pick, openLabel: "switch",
      about: () => ({ text: `${CORE.inference.residency}; context ${ctx} tokens, KV cache q8_0.`,
                      facts: [`${cur.providerID}/${cur.modelID}`, "OpenCode's picker: enter here, or ctrl+x m anywhere"] }),
    }];
    for (const [id, label] of Object.entries(CORE.inference.models)) {
      const current = id === cur.modelID;
      rows.push({
        key: `model:${id}`, title: stripNote(label), detail: `${CORE.inference.provider.id}/${id}`,
        tag: current ? "current" : undefined, tone: "ok", open: pick, openLabel: "switch",
        about: () => ({ text: label, facts: [`${CORE.inference.provider.name} · ${CORE.inference.provider.npm}`,
                                             current ? "answering now" : "switching unloads the current 8B model"] }),
      });
    }
    rows.push({
      key: "local", title: "always local", detail: CORE.inference.local_always.join(" · "), tone: "muted",
      about: () => ({ text: "Embeddings and the vision model are laptop models: they never follow the chat lane.",
                      facts: CORE.inference.local_always }),
    });
    return rows;
  };

  // GOVERNANCE ------------------------------------------------------------------------

  const RULES = gov.rules(CORE.permissions);
  const accessFile = gov.readRules(PATHS.rules);
  const ENFORCED = "Enforced, not promised: OpenCode permission rules, the path-guard server plugin (refusals audited), read-only mounts, and a network with no route out.";

  const permissionsCover = (): Cover => {
    const t = gov.tally(RULES);
    const tools = [...new Set(RULES.map((r) => r.tool))];
    return {
      kind: "PERMISSIONS", tag: `${RULES.length} rules`, tagFg: C.accent, title: CORE.name, subtitle: "what this agent may do",
      lines: [
        { text: `allow ${t.allow} · deny ${t.deny} · ask ${t.ask}` },
        { text: tools.map((tool) => `${tool} ${RULES.filter((r) => r.tool === tool).length}`).join(" · "), fg: C.muted, wrap: true },
        { text: "ENFORCED BY", fg: C.muted },
        { text: "1 OpenCode rules" }, { text: "2 path-guard, audited" },
        { text: "3 read-only mounts" }, { text: "4 no route out" },
      ],
      foot: ["core.json → opencode.json"],
    };
  };

  const ruleText = (r: gov.Rule): string => {
    if (!r.pattern) {
      if (r.tool === "task") return r.action === "deny" ? "The agent cannot hand work to a subagent: a subagent's edits never reach this workspace." : `task: ${r.action}.`;
      if (r.tool === "webfetch") return r.action === "deny" ? "The agent cannot fetch from the web — and the network has no route out anyway." : `webfetch: ${r.action}.`;
      return `${r.tool}: ${r.action} for every call.`;
    }
    if (r.pattern === "*") return `Default for ${r.tool}: anything no other ${r.tool} rule allows is ${r.action === "deny" ? "refused" : r.action}.`;
    if (r.action === "allow") return `${r.tool} calls matching ${r.pattern} run without asking.`;
    if (r.action === "ask") return `${r.tool} calls matching ${r.pattern} stop and ask the operator first.`;
    return `${r.tool} calls matching ${r.pattern} are refused before they run.`;
  };

  const permissionRows = (): Row[] => {
    const rows: Row[] = RULES.map((r, i) => ({
      key: `rule:${i}`, title: `${r.tool.padEnd(9)}${r.pattern}`.trimEnd(), tag: r.action, tone: ACTION_TONE[r.action],
      cover: permissionsCover,
      about: () => ({ text: ruleText(r), facts: [ENFORCED] }),
    }));
    const g = CORE.guards;
    rows.push({
      key: "guard:root", title: "path-guard root", detail: g.path_guard_root, tag: "guard", tone: "accent",
      cover: permissionsCover,
      about: () => ({ text: `The path-guard server plugin resolves every write target and refuses anything outside ${g.path_guard_root}; each refusal is written to audit channel ${AUDIT.channel}.`,
                      facts: ["infra/tui/server/path-guard.ts", ENFORCED] }),
    }, {
      key: "guard:ro", title: "read-only mounts", detail: `${g.read_only.length} mounts`, tag: "guard", tone: "accent",
      open: () => view(api, "Read-only mounts", g.read_only.join("\n")), openLabel: "list",
      cover: permissionsCover,
      about: () => ({ text: "Mounted read-only into this container: the agent cannot change its own rules, persona or record.",
                      sections: [{ title: "MOUNTS", lines: g.read_only }] }),
    }, {
      key: "guard:net", title: "network", detail: g.network, tag: "guard", tone: "accent",
      cover: permissionsCover,
      about: () => ({ text: g.network, facts: [ENFORCED] }),
    });
    const access = accessFile.access;
    if (access) {
      const accessCover = (): Cover => ({
        kind: "ACCESS RULES", tag: `${access.tools.length} tools`, tagFg: C.accent, title: "tool → roles → gate",
        subtitle: PATHS.rules,
        lines: [{ text: "ROLES", fg: C.muted }, ...access.roles.map((r) => ({ text: r })),
                { text: "HUMAN GATE", fg: C.muted },
                ...access.tools.filter((t) => t.approval).map((t) => ({ text: t.tool, fg: C.yellow }))],
      });
      for (const t of access.tools) {
        rows.push({
          key: `access:${t.tool}`, title: `${"rules".padEnd(9)}${t.tool}`, detail: t.roles.join(", "),
          tag: t.approval ? "human approval" : "direct", tone: t.approval ? "warn" : "muted",
          open: () => view(api, "Access rules", accessFile.text, PATHS.rules), openLabel: "view rules",
          cover: accessCover,
          about: () => ({ text: t.approval
            ? `${t.tool} runs only after a human approves the task (approve.py, or enter on it in Approvals). Allowed roles: ${t.roles.join(", ")}.`
            : `${t.tool} runs without a human gate for ${t.roles.join(", ")}; any other role gets an access error, never a silent skip.`,
            facts: ["checked on every A2A task (JWT role) by new_horizons/shared/rules/rbac.py"] }),
        });
      }
    }
    return rows;
  };

  const lineCount = (path: string) => {
    try {
      return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const published = () => (["command", "skill", "book", "prompt"] as catalog.Kind[])
    .map((k) => list(k).filter((e) => e.source === "ops").length).reduce((a, b) => a + b, 0);

  const connectionRows = (): Row[] => CORE.connections.map((c): Row => {
    const url = gov.connectionUrl(c);
    if (c.kind === "a2a") {
      const up = store.a2aUp();
      const auth = c.secret_env ? `signs its own JWT (${c.secret_env})` : `bearer token (${c.token_env ?? "?"})`;
      return {
        key: `conn:${c.id}`, title: c.id, detail: `a2a · ${url} · role ${c.role}`,
        tag: up === false ? "down" : up ? "up" : "…", tone: up === false ? "err" : up ? "ok" : "muted",
        open: () => view(api, `A2A agent card · ${url}`, card()?.raw ? JSON.stringify(JSON.parse(card()!.raw), null, 2) : "card not fetched yet — r to retry", url),
        openLabel: "view card",
        cover: () => {
          const k = card();
          return { kind: "A2A", tag: up === false ? "down" : "up", tagFg: up === false ? C.red : C.green,
                   title: k?.name ?? c.id, subtitle: k ? `v${k.version}` : url,
                   lines: [kv("url", host(url), 6), kv("role", c.role ?? "?", 6), kv("auth", c.secret_env ? "own JWT" : "bearer", 6),
                           { text: `SKILLS ${k?.skills.length ?? "?"}`, fg: C.muted },
                           ...(k?.skills ?? []).map((s) => ({ text: s.id }))],
                   foot: ["agent card"] };
        },
        about: () => ({
          text: CAN.approve
            ? "The ops agent's A2A queue: this console signs its own admin JWT to list, approve and cancel tasks."
            : "The only way out of this sandbox to the pipeline: tasks go to tier-2 as JSON-RPC under a JWT role, and code crosses as a git patch with its sha256.",
          facts: [auth, card()?.description ?? ""].filter(Boolean),
        }),
      };
    }
    if (c.kind === "openai-compatible") {
      const l = lane();
      const cur = store.model();
      return {
        key: `conn:${c.id}`, title: c.id, detail: `openai-compatible · ${url}`,
        tag: l.mode, tone: l.mode === "local" ? "ok" : "warn",
        open: () => view(api, "Inference endpoint", [`lane      ${l.mode}`, `in tier   ${url}`, `lane url  ${l.url}`,
                                                      `model     ${cur.providerID}/${cur.modelID}`, `context   ${ctx}`].join("\n")),
        openLabel: "view",
        cover: () => ({ kind: "LLM", tag: l.mode, tagFg: l.mode === "local" ? C.green : C.yellow, title: laneTitle(),
                        lines: [kv("in tier", host(url), 9), kv("lane", host(l.url), 9), kv("model", cur.modelID, 9), kv("context", ctx, 9)] }),
        about: () => ({ text: l.mode === "local" ? LOCAL_LINE : REMOTE_LINE, fg: l.mode === "local" ? C.text : C.yellow,
                        facts: ["OpenAI-compatible protocol only — no provider SDK in the agent"] }),
      };
    }
    const path = c.path ?? "";
    const isCatalog = c.id === "catalog";
    const count = isCatalog ? `${published()} published` : c.id === "audit" ? `${lineCount(AUDIT.file)} events` : "";
    return {
      key: `conn:${c.id}`, title: c.id, detail: `volume · ${path}${count ? ` · ${count}` : ""}`,
      tag: c.access, tone: c.access === "ro" ? "muted" : "ok",
      open: () => view(api, `Volume ${c.id}`, [`path    ${path}`, `access  ${c.access}`, count && `entries ${count}`].filter(Boolean).join("\n")),
      openLabel: "view",
      cover: () => ({ kind: "VOLUME", tag: c.access, tagFg: C.muted, title: c.id, subtitle: path,
                      lines: count ? [{ text: count }] : [] }),
      about: () => ({
        text: isCatalog
          ? (CAN.publish ? "Written only by this console; tier-1 mounts it read-only and loads it as its OpenCode config dir, so a published command or skill is native there."
                         : "Read-only here: tier-2 publishes commands, skills, books and prompts into it, and they appear in this console on the next refresh.")
          : c.id === "audit" ? `Audit channel ${AUDIT.channel} (${AUDIT.kind}) writes here: ${AUDIT.file}.`
          : `${c.access === "ro" ? "Read-only" : "Read-write"} volume at ${path}.`,
      }),
    };
  });

  const taskRows = (): Row[] => {
    const rows: Row[] = [];
    if (CAN.requestDeploy) {
      rows.push({ key: "req", title: "+ Request a deploy", add: true, tone: "accent",
                  detail: "/request-deploy — build, evaluate, then wait for approval",
                  use: () => use("/request-deploy "), useLabel: "fill the chat",
                  about: () => ({ text: "Commit first, then /request-deploy: the patch of your commits crosses to tier-2, which builds, evaluates and stops for a human before deploying." }) });
    }
    if (store.a2aUp() === false) {
      rows.push({ key: "down", title: "tier-2 A2A unreachable", tone: "err", detail: "is demo 2 up? (make demo2-up)" });
    }
    for (const t of store.tasks()) {
      const waiting = needsApproval(t);
      const tag = busy() === t.id ? "approving…" : waiting ? (CAN.approve ? "approve?" : "waiting approval") : t.state;
      rows.push({
        key: t.id, title: t.summary, detail: `${t.skill} · ${t.id.slice(0, 8)} · ${t.requestedBy}`,
        tag, tone: stateTone(t.state),
        open: () => (CAN.approve && waiting ? void doApprove(t) : view(api, t.summary, taskText(t))),
        openLabel: CAN.approve && waiting ? "approve" : "view",
        reject: CAN.approve && waiting ? () => void doReject(t) : undefined,
        cover: () => taskCover(t, tag, TONE[stateTone(t.state)]),
        about: () => taskAbout(t, t.state),
      });
    }
    if (!store.tasks().length && store.a2aUp() !== false) {
      rows.push({ key: "none", title: "no requests yet", tone: "muted",
                  detail: CAN.approve ? "tier-1 asks with /request-deploy" : "ask with /request-deploy" });
    }
    return rows;
  };

  const auditEvents = (n: number) => audit.tail(n).map((l) =>
    `${l.ts.slice(5, 19).replace("T", " ")}  ${l.who.padEnd(14)} ${l.what.padEnd(18)} ${l.detail}${l.hash ? `  #${l.hash}` : ""}`).join("\n");

  const auditRows = (): Row[] => {
    const rows: Row[] = [{
      key: "audit", title: `Audit channel ${AUDIT.channel}`, tone: "accent", detail: `${AUDIT.kind} ${AUDIT.version} — last 60 events`,
      open: () => view(api, `Audit ${AUDIT.channel} · ${AUDIT.kind}`, auditEvents(60) || "no events yet", AUDIT.file, false),
      openLabel: "view events",
      cover: () => ({ kind: "AUDIT", tag: AUDIT.channel, tagFg: C.accent, title: `Audit channel ${AUDIT.channel}`,
                      subtitle: `${AUDIT.kind} ${AUDIT.version}`,
                      lines: audit.tail(20).map((l) => ({ text: `${l.ts.slice(11, 19)} ${l.what}`, fg: C.text })),
                      foot: [AUDIT.file] }),
      about: () => ({ text: CAN.verifyChain
        ? "Every tier-2 action and every console action lands in a Postgres hash chain: each row carries the hash of the one before, so an edit anywhere breaks every hash after it."
        : "Every tool call this agent makes is logged before and after it runs, by the audit-log server plugin; console actions are logged beside it.",
        sections: [{ title: "LATEST", lines: audit.tail(6).map((l) => `${l.ts.slice(5, 16).replace("T", " ")}  ${l.what}  ${l.detail}`.slice(0, 90)) }],
        facts: [AUDIT.file] }),
    }];
    if (CAN.verifyChain) {
      rows.push({ key: "verify", title: "Verify hash chain", tone: "accent", detail: `recompute every hash of audit channel ${AUDIT.channel}`,
                  open: async () => {
                    toast("verifying the audit chain…");
                    const v = await audit.verifyChain();
                    toast(v.ok ? `chain intact · ${v.rows} rows` : `chain BROKEN: ${v.reason}`, v.ok ? "success" : "error");
                  }, openLabel: "verify",
                  about: () => ({ text: "Recomputes every row's hash from the first one. A broken chain is reported with the row it breaks at — never repaired." }) });
    }
    return rows;
  };

  const sessionRows = (): Row[] => {
    const seen = store.seenCounts();
    const briefs = (store.tick(), summary.cachedCount());
    const state = [`seen tasks        ${seen.tasks}`, `seen catalog      ${seen.catalog}`, `cached briefs     ${briefs}`];
    const rows: Row[] = [{
      key: "state", title: "Console state", tone: "accent", detail: `${seen.tasks} tasks · ${seen.catalog} catalog entries seen · ${briefs} briefs`,
      open: () => view(api, "Console state", state.join("\n")), openLabel: "view",
      about: () => ({ text: "What this console remembers between runs: which requests and catalog entries you have seen (that is what clears alerts), and the briefs someone asked for with s.",
                      sections: [{ title: "STATE", lines: state }], facts: [`briefs in ${PATHS.mine}/summaries`] }),
    }];
    for (const s of sessions()) {
      rows.push({ key: s.id, title: s.title || s.id, detail: new Date(s.updated).toLocaleString(), tag: "session", tone: "muted",
                  open: () => api.route.navigate("session", { sessionID: s.id }), openLabel: "resume",
                  about: () => ({ text: s.title || s.id, facts: [s.id, new Date(s.updated).toLocaleString()] }) });
    }
    return rows;
  };

  // ---- sections -----------------------------------------------------------------

  const curatorOr = (ours: string, theirs: string) => (CAN.publish ? ours : theirs);
  const sections: Section[] = [
    { id: "identity", group: "AGENT", title: "Identity", hint: "the record this console is compiled from",
      count: () => `core ${SIG.slice(0, 6)}`, rows: () => [identityRow()], card: true, coverWidth: 44 },
    { id: "agents", group: "AGENT", title: "Agents", hint: "the personas this record defines",
      count: () => String(CORE.agents.length), rows: agentRows },
    { id: "inference", group: "AGENT", title: "Inference", hint: "where the model runs and which one answers",
      // off the laptop the lane leads (it is the point); the menu keeps a gap before the title
      count: () => (lane().mode === "local" ? `${store.model().name} · local` : clip(`${lane().mode} · ${store.model().name}`, 15)),
      countFg: () => (lane().mode === "local" ? undefined : C.yellow), rows: inferenceRows },
    { id: "commands", group: "CATALOG", title: "Commands",
      hint: curatorOr("slash commands — add one and tier-1 gets it on its next start", "slash commands in this sandbox"),
      count: () => String(list("command").length), seen: () => store.markCatalogSeen("command"),
      rows: () => [...addRow("command", "+ Add command"), ...entryRows("command", (e) => `${e.title} `)] },
    { id: "skills", group: "CATALOG", title: "Skills",
      hint: curatorOr("skills the agents load on demand — publish one to tier-1", "skills the agent loads on demand"),
      count: () => String(list("skill").length), seen: () => store.markCatalogSeen("skill"),
      rows: () => [...addRow("skill", "+ Add skill"), ...entryRows("skill", (e) => `Use the ${e.name} skill: `)] },
    { id: "books", group: "CATALOG", title: "Books", hint: "the rulebooks the agent follows",
      count: () => String(list("book").length), seen: () => store.markCatalogSeen("book"),
      rows: () => [...addRow("book", "+ Add book"), ...bookRows()], shelf: true },
    { id: "documents", group: "CATALOG", title: "Documents", hint: "reference documents this console can open",
      count: () => String(list("document").length), rows: () => entryRows("document", (e) => `Read ${e.path} and `) },
    { id: "prompts", group: "CATALOG", title: "Prompts",
      hint: curatorOr("saved prompts — publish one to tier-1", "saved prompts — yours and the ones ops published"),
      count: () => String(list("prompt").length), seen: () => store.markCatalogSeen("prompt"),
      rows: () => [...addRow("prompt", CAN.publish ? "+ Add prompt" : "+ New prompt"), ...entryRows("prompt", (e) => catalog.body(e))] },
    { id: "permissions", group: "GOVERNANCE", title: "Permissions", hint: "what the agent may do — enforced, not promised",
      count: () => `${RULES.length} rules`, rows: permissionRows },
    { id: "connections", group: "GOVERNANCE", title: "Connections", hint: "every way in or out of this container",
      count: () => String(CORE.connections.length), countFg: () => (store.a2aUp() === false ? C.red : undefined),
      rows: connectionRows, open: loadCard, refresh: () => { loadCard(); store.refresh(); } },
    { id: "requests", group: "GOVERNANCE", title: CAN.approve ? "Approvals" : "Requests",
      hint: CAN.approve ? "the tier-2 queue — deploys wait here for a human" : "your requests to tier-2 — deploys wait for a human approval",
      count: () => {
        const waiting = store.tasks().filter(needsApproval).length;
        return waiting ? `${waiting} waiting` : String(store.tasks().length);
      },
      countFg: () => (store.tasks().some(needsApproval) ? C.yellow : undefined),
      seen: () => CAN.requestDeploy && store.markTasksSeen(), rows: taskRows, refresh: () => store.refresh() },
    { id: "audit", group: "GOVERNANCE", title: "Audit", hint: `channel ${AUDIT.channel} · ${AUDIT.kind} ${AUDIT.version}`,
      count: () => AUDIT.channel, rows: auditRows, refresh: () => store.refresh() },
    { id: "sessions", group: "MEMORY", title: "Sessions", hint: "conversations and what this console remembers",
      count: () => String(sessions().length), rows: sessionRows, open: () => void loadSessions(),
      refresh: () => { void loadSessions(); store.refresh(); } },
  ];

  // ---- selection, focus, filter -------------------------------------------------

  const wanted = String(props.params?.["section"] ?? "");
  const start = Math.max(0, sections.findIndex((s) => s.id === (ALIAS[wanted] ?? wanted)));
  const [sel, setSel] = createSignal(start);
  const [focus, setFocus] = createSignal<"menu" | "rows">(wanted ? "rows" : "menu");
  const [row, setRow] = createSignal(0);
  const [query, setQuery] = createSignal("");
  const [typing, setTyping] = createSignal(false);
  const section = () => sections[sel()]!;
  const shelfMode = () => !!section().shelf && !narrow();
  const allRows = createMemo(() => section().rows());
  const rows = createMemo(() => {
    const q = query().toLowerCase();
    const base = shelfMode() ? allRows().filter((r) => !r.add) : allRows();
    if (!q) return base;
    return base.filter((r) => !r.add && `${r.title} ${r.detail ?? ""}`.toLowerCase().includes(q));
  });
  const current = () => rows()[Math.min(row(), Math.max(0, rows().length - 1))];
  const cover = createMemo(() => {
    const r = current();
    return r && (r.cover?.() ?? { kind: section().title.toUpperCase(), tag: r.tag, tagFg: TONE[r.tone ?? "muted"],
                                  title: r.title.replace(/^\+\s*/, ""), subtitle: r.detail, lines: [] });
  });
  const about = createMemo(() => {
    const r = current();
    return r && (r.about?.() ?? { text: r.detail ?? "" });
  });
  const hasGlyphs = createMemo(() => rows().some((r) => r.glyph));
  // the title column gives way on narrow screens so tags stay whole
  const titleWidth = createMemo(() => Math.min(38, Math.max(12, Math.floor((size().cols - 39) * 0.45)),
                                               Math.max(12, ...rows().map((r) => r.title.length))));

  const clearFilter = () => {
    setQuery("");
    setTyping(false);
    setRow(0);
  };
  const select = (i: number) => {
    sections[sel()]!.seen?.();
    clearFilter();
    setSel((i + sections.length) % sections.length);
    setRow(0);
    sections[sel()]!.open?.();
  };
  const brief = () => {
    const b = about()?.brief;
    if (!b) return;
    summary.request(b, modelId(), true);
    toast(`writing a brief with ${modelId()} — it stays cached`);
  };

  onMount(() => {
    void loadSessions();
    sections[sel()]!.open?.();
  });

  // `/` filter: typed text arrives as raw key events while the settings key
  // layer stands down (sojourner-ui.tsx disables it through ctl.typing())
  const keyInput = (api.renderer as unknown as { keyInput?: { on: Function; off: Function } }).keyInput;
  let typingSince = 0;
  const onKey = (k: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }) => {
    if (!typing() || performance.now() - typingSince < 40) return;
    const name = k?.name ?? "";
    if (name === "escape") return clearFilter();
    if (name === "return" || name === "enter") {
      setTyping(false);
      return current()?.open?.();
    }
    if (name === "up") return ctl?.move(-1);
    if (name === "down") return ctl?.move(1);
    if (name === "backspace") {
      setQuery((q) => q.slice(0, -1));
      return setRow(0);
    }
    const seq = k?.sequence ?? "";
    if (!k?.ctrl && !k?.meta && seq.length === 1 && seq >= " ") {
      setQuery((q) => q + seq);
      setRow(0);
    }
  };
  keyInput?.on("keypress", onKey);

  ctl = {
    move(d) {
      if (focus() === "menu") return select(sel() + d);
      const n = rows().length;
      if (n) setRow((r) => Math.min(n - 1, Math.max(0, r + d)));
    },
    left() {
      if (focus() === "rows" && shelfMode()) return this.move(-1);
      this.focus("menu");
    },
    right() {
      if (focus() === "rows" && shelfMode()) return this.move(1);
      this.focus("rows");
    },
    focus(where) {
      const next = where === "toggle" ? (focus() === "menu" ? "rows" : "menu") : where;
      if (next === "rows" && !rows().length) return;
      if (next === "menu") clearFilter();
      setFocus(next);
    },
    enter() {
      if (focus() === "menu") return this.focus("rows");
      current()?.open?.();
    },
    back() {
      if (focus() === "rows") {
        if (query()) return clearFilter();
        return this.focus("menu");
      }
      leave();
    },
    add() {
      const r = allRows().find((x) => x.add && x.open);
      r?.open?.();
    },
    use() {
      if (focus() === "rows") current()?.use?.();
    },
    reject() {
      if (focus() === "rows") current()?.reject?.();
    },
    refresh() {
      section().refresh?.();
      store.refresh();
    },
    brief() {
      if (focus() === "rows") brief();
    },
    filter() {
      if (section().card) return;
      setFocus("rows");
      setTyping(true);
      typingSince = performance.now();
      setRow(0);
    },
    typing: () => typing(),
  };
  onCleanup(() => {
    keyInput?.off("keypress", onKey);
    sections[sel()]!.seen?.();
    ctl = undefined;
  });

  // ---- layout -------------------------------------------------------------------

  // body = screen minus header (4), key hints (2) and the footer bar (1); the
  // right pane spends 2 on its title line, then rows (≤ 45%) and the band (≥ 8)
  const pane = () => Math.max(10, size().rows - 9);
  const visible = () => {
    if (section().card || shelfMode()) return 0;
    const room = pane() - 2 - 1 - 8;
    return Math.max(1, Math.min(rows().length || 1, Math.floor((pane() - 2) * 0.45), room));
  };
  const windowStart = () => Math.max(0, Math.min(row() - visible() + 2, rows().length - visible()));
  const coverWidth = () => section().coverWidth ?? Math.max(24, Math.min(38, Math.floor((size().cols - 40) * 0.38)));
  const showGroups = () => size().rows >= 28;
  // shelf: 16-col tiles, gap 1, ‹ › markers at the pane edges
  const paneCols = () => size().cols - 39;
  const tilesFit = () => Math.max(1, Math.floor((paneCols() - 4 + 1) / 17));
  const tileStart = () => Math.max(0, Math.min(row() - tilesFit() + 1, rows().length - tilesFit()));


  type MenuItem = { group: Group } | { index: number };
  const menu = createMemo<MenuItem[]>(() => {
    const out: MenuItem[] = [];
    let g: Group | undefined;
    sections.forEach((s, i) => {
      if (showGroups() && s.group !== g) out.push({ group: s.group });
      g = s.group;
      out.push({ index: i });
    });
    return out;
  });

  const keys = () => {
    if (focus() === "menu") return "↑↓ section   → open   esc back to chat";
    if (typing()) return `type to filter   ↑↓ move   enter ${current()?.openLabel ?? "open"}   esc clear`;
    const r = current();
    const k = [shelfMode() ? "←→ move" : "↑↓ move"];
    if (r?.open) k.push(`enter ${r.openLabel ?? "open"}`);
    if (r?.use) k.push(`u ${r.useLabel ?? "use"}`);
    else if (r?.note) k.push(r.note);
    if (allRows().some((x) => x.add && x.open)) k.push("a add");
    if (r?.reject) k.push("x reject");
    if (about()?.brief) k.push("s brief");
    if (section().refresh) k.push("r refresh");
    if (!section().card && allRows().length > 1) k.push(query() ? "esc clear filter" : "/ filter");
    k.push(shelfMode() ? "esc back" : "← back");
    return k.join("   ");
  };

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <box flexDirection="row" gap={3}>
          <CompactMark />
          <box flexDirection="column">
            <text fg={C.accent} attributes={BOLD} wrapMode="none">SETTINGS</text>
            <text fg={C.muted} wrapMode="none">{`${AGENT.name} · tier ${TIER} ${AGENT.role}${narrow() ? "" : ` · core ${SIG}`}`}</text>
          </box>
        </box>
        <text fg={C.muted} wrapMode="none" flexShrink={0} onMouseUp={leave}>esc back</text>
      </box>
      <box height={1} flexShrink={0} />
      <box flexDirection="row" flexGrow={1} gap={2} minHeight={0}>
        <box flexDirection="column" width={30} flexShrink={0}>
          <For each={menu()}>
            {(item) => {
              if ("group" in item) {
                return <text fg={C.muted} wrapMode="none" paddingLeft={1}>{item.group}</text>;
              }
              const s = sections[item.index]!;
              const on = () => item.index === sel();
              return (
                <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}
                     backgroundColor={on() ? (focus() === "menu" ? C.element : C.panel) : undefined}
                     onMouseUp={() => { select(item.index); setFocus("menu"); }}>
                  <text fg={on() ? C.accentBright : C.text} attributes={on() ? BOLD : 0} wrapMode="none">
                    {`${on() ? "▸" : " "} ${s.title}`}
                  </text>
                  <text fg={s.countFg?.() ?? C.muted} wrapMode="none">{s.count()}</text>
                </box>
              );
            }}
          </For>
        </box>
        <box flexDirection="column" flexGrow={1} minWidth={0} border={["left"]} borderColor={C.border} paddingLeft={2}>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={C.accent} attributes={BOLD} wrapMode="none" flexShrink={0}>{section().title.toUpperCase()}</text>
            <Show when={query() || typing()}
                  fallback={<text fg={C.muted} wrapMode="none">{`· ${section().count()} · ${section().hint}`}</text>}>
              <text fg={C.accentBright} wrapMode="none">{`/ ${query()}${typing() ? "▌" : ""}`}</text>
              <text fg={C.muted} wrapMode="none">{`· ${rows().length} of ${allRows().length}`}</text>
            </Show>
          </box>
          <box height={1} flexShrink={0} />
          <Show when={shelfMode()}>
            <box flexDirection="row" flexShrink={0} height={10}>
              <text fg={C.accent} width={2} wrapMode="none">{tileStart() > 0 ? "‹" : " "}</text>
              <box flexDirection="row" gap={1} flexGrow={1} minWidth={0}>
                <For each={rows().slice(tileStart(), tileStart() + tilesFit())}>
                  {(r, i) => {
                    const idx = () => tileStart() + i();
                    const on = () => focus() === "rows" && idx() === row();
                    return (
                      <box flexDirection="column" width={16} height={10} flexShrink={0} border borderStyle="rounded"
                           borderColor={on() ? C.accent : C.border}
                           onMouseUp={() => {
                             if (focus() === "rows" && idx() === row()) return r.open?.();
                             setFocus("rows");
                             setRow(idx());
                           }}>
                        <Runs rows={r.spine?.() ?? []} />
                        <text fg={on() ? C.white : C.text} attributes={on() ? BOLD : 0} wrapMode="none">{clip(r.title, 14)}</text>
                        <text fg={TONE[r.tone ?? "muted"]} wrapMode="none">{clip(r.tag ?? "", 14)}</text>
                      </box>
                    );
                  }}
                </For>
                <Show when={!rows().length}>
                  <text fg={C.muted}>{query() ? "  nothing matches" : "  no books yet"}</text>
                </Show>
              </box>
              <text fg={C.accent} width={2} wrapMode="none">{tileStart() + tilesFit() < rows().length ? " ›" : "  "}</text>
            </box>
          </Show>
          <Show when={!section().card && !shelfMode()}>
            <For each={rows().slice(windowStart(), windowStart() + visible())}>
              {(r, i) => {
                const idx = () => windowStart() + i();
                const on = () => focus() === "rows" && idx() === row();
                return (
                  <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1} flexShrink={0}
                       backgroundColor={on() ? C.element : undefined}
                       onMouseUp={() => {
                         if (focus() === "rows" && idx() === row()) return r.open?.();
                         setFocus("rows");
                         setRow(idx());
                       }}>
                    <Show when={hasGlyphs()}>
                      <text fg={C.accent} wrapMode="none" flexShrink={0}>{r.glyph ?? " "}</text>
                    </Show>
                    <text fg={r.add ? C.accent : on() ? C.white : C.text} attributes={on() || r.add ? BOLD : 0}
                          wrapMode="none" flexShrink={0}>
                      {r.title.length > titleWidth() ? `${r.title.slice(0, titleWidth() - 1)}…` : r.title.padEnd(titleWidth())}
                    </text>
                    <text fg={C.muted} wrapMode="none" flexGrow={1} flexShrink={1}>{r.detail ?? ""}</text>
                    <Show when={r.tag}>
                      <text fg={TONE[r.tone ?? "muted"]} wrapMode="none" flexShrink={0}>{r.tag}</text>
                    </Show>
                  </box>
                );
              }}
            </For>
            <Show when={rows().length > visible()}>
              <text fg={C.muted} flexShrink={0}>{`  ${Math.min(rows().length, windowStart() + visible())}/${rows().length}`}</text>
            </Show>
            <Show when={!rows().length}>
              <text fg={C.muted} flexShrink={0}>{query() ? "  nothing matches" : "  nothing here yet"}</text>
            </Show>
            <box height={1} flexShrink={0} />
          </Show>
          {/* a card section has no list above it, so no rule either — and a box
              with borderColor set draws a border, so it is a different box */}
          <Show when={!section().card && !shelfMode()} fallback={
            <box flexDirection="column" flexGrow={1} minHeight={8}>
              <DetailPane cover={cover()} about={about()} model={modelId()} coverWidth={coverWidth()}
                          showCover={!narrow()} onBrief={brief} />
            </box>
          }>
            <box flexDirection="column" flexGrow={1} minHeight={8} border={["top"]} borderColor={C.border} paddingTop={1}>
              <DetailPane cover={cover()} about={about()} model={modelId()} coverWidth={coverWidth()}
                          showCover={!narrow()} onBrief={brief} />
            </box>
          </Show>
        </box>
      </box>
      <box flexDirection="row" gap={3} flexShrink={0} paddingTop={1}>
        <text fg={C.muted} wrapMode="none">{keys()}</text>
      </box>
    </box>
  );
}
