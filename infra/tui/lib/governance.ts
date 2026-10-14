/**
 * What the GOVERNANCE screens show, read from the record and the files it
 * names — nothing here is a second source of truth:
 *
 *   rules       CORE.permissions flattened to one row per rule (what OpenCode
 *               enforces, as compiled into opencode.json)
 *   access      the tier-2 access-rules file (roles → tools → approval gate);
 *               parsed for its one fixed shape, no YAML dependency
 *   persona     an agent file's frontmatter (mode, description, tools denied)
 *   card        the A2A agent card of a connection, fetched once
 *
 * No solid-js here: bun tests run it on the host.
 */
import { readFileSync } from "node:fs";
import type { Connection, Core } from "./env.ts";
import { frontmatter } from "./catalog.ts";

export type Action = "allow" | "deny" | "ask";
export type Rule = { tool: string; pattern: string; action: Action };

/** One row per rule, in record order: `edit /workspace/project/** allow` … `task deny`. */
export function rules(perms: Core["permissions"]): Rule[] {
  const out: Rule[] = [];
  for (const [tool, v] of Object.entries(perms)) {
    if (typeof v === "string") out.push({ tool, pattern: "", action: v as Action });
    else for (const [pattern, action] of Object.entries(v)) out.push({ tool, pattern, action: action as Action });
  }
  return out;
}

export function tally(rs: Rule[]): Record<Action, number> {
  const t: Record<Action, number> = { allow: 0, deny: 0, ask: 0 };
  for (const r of rs) t[r.action] = (t[r.action] ?? 0) + 1;
  return t;
}

export type AccessTool = { tool: string; roles: string[]; approval: boolean };
export type AccessRules = { roles: string[]; tools: AccessTool[] };

/**
 * new_horizons/shared/rules/rules.yaml — `roles:` (a list) and `tools:`
 * (name → roles + approval_required). Other top-level blocks (`evaluation:`,
 * the analytics app's `analytics_tools:`) are not the delivery pipeline and
 * are skipped.
 */
export function parseRules(text: string): AccessRules {
  const strip = (l: string) => l.replace(/\s+#.*$/, "");
  const roles: string[] = [];
  const tools: AccessTool[] = [];
  let block = "";
  let cur: AccessTool | undefined;
  for (const raw of text.split("\n")) {
    const line = strip(raw);
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = /^(\w[\w-]*):\s*$/.exec(line);
    if (top) {
      block = top[1]!;
      cur = undefined;
      continue;
    }
    if (block === "roles") {
      const m = /^\s+-\s+(\S+)/.exec(line);
      if (m) roles.push(m[1]!);
    } else if (block === "tools") {
      const name = /^ {2}(\w[\w-]*):\s*$/.exec(line);
      if (name) {
        cur = { tool: name[1]!, roles: [], approval: false };
        tools.push(cur);
        continue;
      }
      const r = /^\s{4}roles:\s*\[(.*)\]/.exec(line);
      if (r && cur) cur.roles = r[1]!.split(",").map((x) => x.trim()).filter(Boolean);
      const a = /^\s{4}approval_required:\s*(true|false)/.exec(line);
      if (a && cur) cur.approval = a[1] === "true";
    }
  }
  return { roles, tools };
}

export function readRules(path: string): { access?: AccessRules; text: string } {
  try {
    const text = readFileSync(path, "utf8");
    return { access: parseRules(text), text };
  } catch {
    return { text: "" };
  }
}

export type Persona = { name: string; mode: string; description: string; denied: string[]; body: string; path: string };

/** An agent file: frontmatter mode/description and the tools it switches off. */
export function persona(path: string, name: string, mode: string): Persona {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { name, mode, description: "(persona file not readable)", denied: [], body: "", path };
  }
  const { meta, body } = frontmatter(text);
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const denied: string[] = [];
  let inTools = false;
  for (const line of head.split("\n")) {
    if (/^tools:\s*$/.test(line)) {
      inTools = true;
      continue;
    }
    if (inTools) {
      const m = /^\s+(\w[\w-]*):\s*false\s*$/.exec(line);
      if (m) denied.push(m[1]!);
      else if (!/^\s/.test(line)) inTools = false;
    }
  }
  const first = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return { name, mode: meta["mode"] ?? mode, description: meta["description"] ?? first, denied, body: body.trim(), path };
}

export type Card = { name: string; version: string; description: string; skills: { id: string; name: string }[]; raw: string };

const cards = new Map<string, Promise<Card | undefined>>();

/** The A2A agent card (public, no auth), fetched once per URL for the console's lifetime. */
export function agentCard(url: string): Promise<Card | undefined> {
  const base = url.replace(/\/+$/, "");
  if (!cards.has(base)) {
    cards.set(base, fetch(`${base}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!r.ok) return undefined;
        const raw = await r.text();
        const d = JSON.parse(raw) as { name?: string; version?: string; description?: string;
                                       skills?: { id: string; name?: string }[] };
        return { name: d.name ?? "?", version: d.version ?? "?", description: d.description ?? "",
                 skills: (d.skills ?? []).map((s) => ({ id: s.id, name: s.name ?? s.id })), raw };
      })
      .catch(() => {
        cards.delete(base); // try again on the next refresh
        return undefined;
      }));
  }
  return cards.get(base)!;
}

export function connectionUrl(c: Connection): string {
  return (c.url_env && process.env[c.url_env]) || c.url || "";
}
