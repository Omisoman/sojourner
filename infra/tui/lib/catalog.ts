/**
 * What the agent can use, read straight from disk on every call (the lists
 * are small; re-reading means an entry the curator publishes shows up in the
 * consumer's settings without a restart).
 *
 *   built-in  the tier's own .opencode (ro), its books and documents (core.json)
 *   ops       the shared catalog volume — the curator (tier-2) writes, the
 *             consumer (tier-1) reads. It is also the consumer's
 *             OPENCODE_CONFIG_DIR, so published commands and skills become
 *             native slash commands / skills on its next start.
 *   mine      the consumer's own prompts, on its writable workspace volume
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AGENT, CAN, DOCUMENTS, type Kind, PATHS } from "./env.ts";

export type { Kind };
export type Source = "built-in" | "ops" | "mine";
export type Entry = {
  kind: Kind;
  name: string;
  title: string;
  description: string;
  /** authored `summary:` frontmatter (2–3 lines, imperative) — the ABOUT text */
  summary: string;
  /** the rest of the frontmatter (books: subtitle, version, owner, cover) */
  meta: Record<string, string>;
  path: string;
  source: Source;
  mtime: number;
  size: number;
};

export function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function heading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("```") && !l.startsWith("<!--"));
  return (line ?? "").replace(/[*_`]/g, "").slice(0, 120);
}

/** Files matching `dir/*.md`-style patterns (one trailing wildcard level). */
function glob(pattern: string): string[] {
  if (!pattern.includes("*")) return existsSync(pattern) ? [pattern] : [];
  const [head, ...rest] = pattern.split("*");
  const dir = dirname(head + "x");
  const prefix = basename(head + "x").slice(0, -1);
  const tail = rest.join("*");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith(prefix)) continue;
    if (tail.startsWith("/")) {
      const p = join(dir, name) + tail;
      if (existsSync(p)) out.push(p);
    } else if (name.endsWith(tail)) {
      out.push(join(dir, name));
    }
  }
  return out;
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function stat(path: string): { mtime: number; size: number } {
  try {
    const s = statSync(path);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return { mtime: 0, size: 0 };
  }
}

function entry(kind: Kind, path: string, source: Source): Entry {
  const text = read(path);
  const { meta, body } = frontmatter(text);
  const file = basename(path).replace(/\.(md|ya?ml)$/, "");
  const name = kind === "skill" ? basename(dirname(path)) : file;
  const title = kind === "command" ? `/${name}`
    : kind === "skill" ? (meta["name"] ?? name)
    : meta["title"] ?? heading(body) ?? name;
  const description = meta["description"] ?? firstLine(body);
  return { kind, name, title, description, summary: meta["summary"] ?? "", meta, path, source, ...stat(path) };
}

const SOURCES: Record<Kind, [string, Source][]> = {
  command: [[`${PATHS.config}/commands/*.md`, "built-in"], [`${PATHS.catalog}/commands/*.md`, "ops"]],
  skill: [[`${PATHS.config}/skills/*/SKILL.md`, "built-in"], [`${PATHS.catalog}/skills/*/SKILL.md`, "ops"]],
  book: [[`${PATHS.books}/*.md`, "built-in"], [`${PATHS.catalog}/books/*.md`, "ops"]],
  document: DOCUMENTS.map((p) => [p, "built-in"] as [string, Source]),
  prompt: [[`${PATHS.catalog}/prompts/*.md`, "ops"],
           ...(CAN.consume ? [[`${PATHS.mine}/prompts/*.md`, "mine"] as [string, Source]] : [])],
};

export function list(kind: Kind): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const [pattern, source] of SOURCES[kind]) {
    for (const path of glob(pattern)) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(entry(kind, path, source));
    }
  }
  return out;
}

export function body(e: Entry): string {
  return frontmatter(read(e.path)).body.trim();
}

/** Catalog entries the curator published — the consumer tracks which it has seen. */
export function published(): Entry[] {
  return (["command", "skill", "book", "prompt"] as Kind[])
    .flatMap((k) => list(k).filter((e) => e.source === "ops"));
}

export function slug(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** A frontmatter value that stays valid YAML (OpenCode parses command/skill frontmatter). */
const yamlText = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

export type Draft = { name: string; description?: string; body: string };

/**
 * Write a new entry. The curator publishes into the catalog; the consumer may
 * only add its own prompts. Never overwrites. Returns the written entry.
 */
export function add(kind: Exclude<Kind, "document">, d: Draft): Entry {
  const allowed = { command: CAN.addCommand, skill: CAN.addSkill, book: CAN.addBook, prompt: CAN.addPrompt }[kind];
  if (!allowed) throw new Error(`${AGENT.id} cannot add ${kind}s (core.json catalog)`);
  const name = slug(d.name);
  if (!name) throw new Error("a name needs at least one letter or digit");
  const desc = oneLine(d.description ?? "");
  const text = d.body.trim();
  if (!text) throw new Error("the body is empty");
  const stamp = `${AGENT.id} · ${new Date().toISOString()}`;
  const root = kind === "prompt" && CAN.consume ? PATHS.mine : PATHS.catalog;
  let path: string;
  let content: string;
  switch (kind) {
    case "command": // OpenCode command format — frontmatter kept to keys it knows
      path = join(root, "commands", `${name}.md`);
      content = `---\ndescription: ${desc || `Run ${name}`}\n---\n\n${text}\n`;
      break;
    case "skill": // OpenCode skill format: skills/<name>/SKILL.md, name == dir
      path = join(root, "skills", name, "SKILL.md");
      content = `---\nname: ${name}\ndescription: ${desc || name}\n---\n\n# ${name}\n\n${text}\n`;
      break;
    case "book": {
      // the keys every book carries (tier1/docs/books): the shelf
      // and the reader show title, subtitle, summary, owner and version
      const summary = yamlText(oneLine(text).split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").slice(0, 280));
      path = join(root, "books", `${name}.md`);
      content = `---\ntitle: ${yamlText(oneLine(d.name))}\nsubtitle: ${yamlText(desc)}\nsummary: ${summary}\n` +
        `owner: ${AGENT.id}\nversion: "1.0"\ndescription: ${yamlText(desc)}\npublished_by: ${stamp}\n---\n\n# ${oneLine(d.name)}\n\n${text}\n`;
      break;
    }
    case "prompt":
      path = join(root, "prompts", `${name}.md`);
      content = `---\ntitle: ${oneLine(d.name)}\ndescription: ${desc}\n${CAN.publish ? "published_by" : "saved_by"}: ${stamp}\n---\n\n${text}\n`;
      break;
  }
  if (existsSync(path)) throw new Error(`${basename(path)} already exists`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: "wx" });
  return entry(kind, path, root === PATHS.mine ? "mine" : "ops");
}
