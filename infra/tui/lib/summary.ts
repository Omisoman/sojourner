/**
 * Model briefs for the ABOUT pane — written ONLY when someone presses `s`
 * (or clicks ↻) on an item, never on selection: on a laptop that is also
 * serving the chat, a brief is 15–40 s of inference. A written brief is kept
 * on disk and shown under the item's authored text from then on. The key is
 * a hash of exactly what the model was given, so an edited book or a request
 * that gained its phase-b result has no brief until someone asks again.
 *
 * Same OpenAI-compatible endpoint as every other LLM call (LLM_BASE_URL →
 * llm-proxy → host Ollama); one request at a time, the newest ask wins the
 * queue.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { debug, PATHS } from "./env.ts";

export type Spec = {
  /** what it is, for the model: "book", "skill", "deploy request"… */
  kind: string;
  title: string;
  /** the material to summarise (trimmed to fit an 8k context) */
  text: string;
  /** what the reader of this pane needs from it */
  ask: string;
};
export type Summary = { text: string; model: string; at: string };
export type State = "ready" | "pending" | "failed" | "none";

const DIR = process.env["SOJOURNER_SUMMARY_DIR"] ?? join(PATHS.mine, "summaries");
const MAX_INPUT = 9000; // chars — leaves room in num_ctx 8192 for the answer

const SYSTEM = [
  "You write the summary pane of an operator console for a software team.",
  "Plain text only: no markdown, no headings, no bullet symbols, no preamble, no sign-off.",
  "3 to 5 short sentences, each on its own line. Be concrete: name the rules, files, risks and numbers that are in the material.",
  "Never invent facts that are not in the material. If something is missing, say so in a few words.",
].join(" ");

export function keyOf(s: Spec): string {
  return createHash("sha256").update(`${s.kind}\0${s.title}\0${s.ask}\0${s.text.slice(0, MAX_INPUT)}`)
    .digest("hex").slice(0, 24);
}

// no solid-js here (it resolves only inside OpenCode): the UI subscribes and
// keeps its own signal, so this module stays testable with plain bun
const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const bump = () => listeners.forEach((fn) => fn());

const pending = new Set<string>();
const failed = new Map<string, string>();
const memo = new Map<string, Summary | null>();
let queued: { key: string; spec: Spec; model: string } | undefined;
let running = false;

function load(key: string): Summary | undefined {
  if (!memo.has(key)) {
    try {
      memo.set(key, JSON.parse(readFileSync(join(DIR, `${key}.json`), "utf8")) as Summary);
    } catch {
      memo.set(key, null);
    }
  }
  return memo.get(key) ?? undefined;
}

function save(key: string, s: Summary) {
  memo.set(key, s);
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${key}.json`), JSON.stringify(s));
  } catch (e) {
    debug("summary save failed", String(e)); // shown this session; regenerated next start
  }
}

/** Briefs on disk (the Sessions screen's "console state"). */
export function cachedCount(): number {
  try {
    return readdirSync(DIR).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** Current state of one item; `subscribe` says when to read again. */
export function get(key: string): { state: State; summary?: Summary; error?: string } {
  const s = load(key);
  if (pending.has(key)) return { state: "pending", summary: s };
  if (s) return { state: "ready", summary: s };
  if (failed.has(key)) return { state: "failed", error: failed.get(key) };
  return { state: "none" };
}

/** Ask for a summary. Cached → nothing happens unless `force` (the ↻). */
export function request(spec: Spec, model: string, force = false) {
  const key = keyOf(spec);
  debug("brief request", { kind: spec.kind, title: spec.title, model, force });
  if (!force && (load(key) || pending.has(key) || failed.has(key))) return;
  failed.delete(key);
  queued = { key, spec, model };
  pending.add(key);
  bump();
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queued) {
      const job = queued;
      queued = undefined;
      try {
        const text = await complete(job.spec, job.model);
        save(job.key, { text, model: job.model, at: new Date().toISOString() });
      } catch (e) {
        failed.set(job.key, String((e as Error).message ?? e).slice(0, 160));
      }
      pending.delete(job.key);
      // a selection that was queued and then superseded never ran: let it ask again
      for (const k of [...pending]) if (k !== queued?.key) pending.delete(k);
      bump();
    }
  } finally {
    running = false;
  }
}

async function complete(spec: Spec, model: string): Promise<string> {
  const base = (process.env["LLM_BASE_URL"] ?? "http://llm-proxy:11434/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env["LLM_API_KEY"] ?? "none"}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 260,
      reasoning_effort: "none", // qwen3: answer, don't think — this is a caption, not a task
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${spec.ask}\n\n${spec.kind.toUpperCase()}: ${spec.title}\n\n${spec.text.slice(0, MAX_INPUT)}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = clean(json.choices?.[0]?.message?.content ?? "");
  if (!text) throw new Error("empty answer");
  return text;
}

/** Strip what an 8B model adds anyway: think blocks, markdown marks, bullets. */
export function clean(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim())
    .filter((l) => l && !/^#+\s*$/.test(l)).map((l) => l.replace(/^#+\s*/, ""))
    .join("\n").trim();
}
