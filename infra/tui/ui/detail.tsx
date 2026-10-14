/**
 * The detail band under every SETTINGS list — one layout for all sections:
 *
 *   left   COVER  the selected item at a glance (kind, title, contents, facts);
 *                 hidden under 100 columns
 *   right  ABOUT  authored text first (a `summary:` in the frontmatter, else
 *                 the description), then facts. A model BRIEF appears under it
 *                 only once someone pressed `s` — nothing here asks the model
 *                 on its own; a brief is cached (lib/summary.ts) and ↻ / s
 *                 writes it again.
 *
 * Rows describe themselves with `cover` + `about`.
 */
import { createRoot, createSignal, For, Show } from "solid-js";
import type { Entry } from "../lib/catalog.ts";
import type { Covers } from "../lib/covers.ts";
import { BOLD, C, type Run } from "../lib/palette.ts";
import type { Task } from "../lib/requests.ts";
import * as summary from "../lib/summary.ts";
import { Runs } from "./logo.tsx";

export type CoverLine = { text: string; fg?: string; bold?: boolean; wrap?: boolean };
export type Cover = {
  kind: string;
  tag?: string;
  tagFg?: string;
  title: string;
  subtitle?: string;
  lines: CoverLine[];
  foot?: string[];
  /** braille art (a book cover): drawn under the kind line; the card drops its rule */
  art?: Run[][];
};
/** ABOUT: authored first; `brief` is what `s` would ask the model for. */
export type About = {
  /** braille art above the text (a book's spine when the cover card is hidden) */
  art?: Run[][];
  heading?: string;
  text: string;
  fg?: string;
  sections?: { title: string; lines: string[]; columns?: number }[];
  facts?: string[];
  brief?: summary.Spec;
};

/** Bumped whenever a summary lands or starts — the pane reads through it. */
const version = createRoot(() => {
  const [ver, setVer] = createSignal(0);
  summary.subscribe(() => setVer((n) => n + 1));
  return ver;
});

const KIND: Record<Entry["kind"], string> = {
  command: "COMMAND", skill: "SKILL", book: "BOOK", document: "DOCUMENT", prompt: "PROMPT",
};

const ASK: Record<Entry["kind"], string> = {
  book: "Summarise this rulebook for a developer about to change the code: what it governs, the rules that bite most often, and what breaks if they are ignored.",
  document: "Summarise this reference document: what it is for, who reads it, and the facts or rules in it that matter most.",
  skill: "Summarise this agent skill: when the agent should use it, what it does step by step at a high level, and its limits.",
  command: "Summarise this slash command: what it makes the agent do, what the argument should be, and what comes back.",
  prompt: "Summarise this saved prompt: what it asks the agent for and when to use it.",
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const day = (ms: number) => ms ? new Date(ms).toISOString().slice(0, 10) : "";

/** A cover for any catalog entry: its table of contents, or its opening lines. */
export function entryCover(e: Entry, body: string, tag: string, tagFg: string): Cover {
  const [title, subtitle] = e.title.split(/\s+[—–-]\s+/, 2) as [string, string | undefined];
  const heads = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1]!.replace(/[*_`]/g, "").trim());
  const lines: CoverLine[] = heads.length >= 2
    ? [{ text: "CONTENTS", fg: C.muted }, ...heads.map((h, i) => ({ text: `${String(i + 1).padStart(2, "0")}  ${h}` }))]
    : body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("```"))
        .slice(0, 12).map((l) => ({ text: l.replace(/[*_`]/g, ""), fg: C.muted, wrap: true }));
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    kind: KIND[e.kind], tag, tagFg, title, subtitle: subtitle ?? (e.kind === "book" ? undefined : e.description),
    lines,
    foot: [`${plural(body.split("\n").length, "line")} · ${plural(words, "word")}`,
           [e.source, day(e.mtime)].filter(Boolean).join(" · ")],
  };
}

const size = (e: Entry, body: string) =>
  e.kind === "book" || e.kind === "document" ? plural(body.split("\n").length, "line") : `${e.size} B`;

/** Authored summary, else the description; then source · date · size · path. */
export function entryAbout(e: Entry, body: string): About {
  return {
    text: e.summary || e.description,
    facts: [[e.source, day(e.mtime), size(e, body)].filter(Boolean).join(" · "), e.path],
    brief: { kind: e.kind, title: e.title, text: body, ask: ASK[e.kind] },
  };
}

/** `##` headings of a body, numbered — a book's CONTENTS. */
export function contents(body: string): string[] {
  return [...body.matchAll(/^##\s+(.+)$/gm)].map((m, i) =>
    `${String(i + 1).padStart(2, "0")}  ${m[1]!.replace(/[*_`]/g, "").replace(/\s*\(.*\)\s*$/, "").trim()}`);
}

/** A book's cover card: its braille cover (or spine when the band is short), title, edition. */
export function bookCover(e: Entry, body: string, covers: Covers, tag: string, tagFg: string, big: boolean): Cover {
  const lines = body.split("\n").length;
  return {
    kind: "BOOK", tag, tagFg, title: e.title, lines: [],
    art: (big ? covers.cover : covers.spine).lines,
    foot: [[e.meta["version"] && `v${e.meta["version"]}`, e.meta["owner"], `${lines} lines`].filter(Boolean).join(" · ")],
  };
}

/** A book's ABOUT: title — subtitle, the authored summary, CONTENTS, then facts. */
export function bookAbout(e: Entry, body: string, covers: Covers, narrow: boolean): About {
  const heads = contents(body);
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    art: narrow ? covers.spine.lines : undefined,
    heading: h1 ?? [e.title, e.meta["subtitle"]].filter(Boolean).join(" — "),
    text: e.summary || e.description,
    sections: heads.length ? [{ title: "CONTENTS", lines: heads, columns: heads.length >= 6 ? 2 : 1 }] : undefined,
    facts: [[e.source, day(e.mtime), e.meta["version"] && `v${e.meta["version"]}`, e.meta["owner"]].filter(Boolean).join(" · "), e.path],
    brief: { kind: e.kind, title: e.title, text: body, ask: ASK[e.kind] },
  };
}

type Json = Record<string, any>;
function phase(t: Task, name: string): Json {
  try {
    return JSON.parse(t.artifacts.find((a) => a.name === name)?.text ?? "{}") as Json;
  } catch {
    return {};
  }
}

/** The request as the approver sees it: what was sent, what tier-2 found. */
export function taskCover(t: Task, tag: string, tagFg: string): Cover {
  const a = phase(t, "phase-a");
  const b = phase(t, "phase-b");
  const lines: CoverLine[] = [];
  const commits = t.commits.length ? t.commits : (a["patch"]?.["commits"] as string[] | undefined) ?? [];
  const files = t.files.length ? t.files : (a["patch"]?.["files"] as string[] | undefined) ?? [];
  if (commits.length) {
    lines.push({ text: `COMMITS ${commits.length}`, fg: C.muted });
    for (const c of commits.slice(0, 4)) lines.push({ text: c });
  }
  if (files.length) {
    lines.push({ text: `FILES ${files.length}`, fg: C.muted });
    for (const f of files.slice(0, 6)) lines.push({ text: f, fg: C.text });
    if (files.length > 6) lines.push({ text: `+${files.length - 6} more`, fg: C.muted });
  }
  const checks: [string, unknown][] = [
    ["patch", a["patch"] ? (a["patch"].ok ? "applied" : "refused") : undefined],
    ["build", a["build"] ? (a["build"].ok ? "ok" : "failed") : undefined],
    ["validate", a["validate"] ? (a["validate"].ok ? "ok" : "failed") : undefined],
    ["eval", a["evaluation"]?.["verdict"]],
    ["deploy", b["deploy"] ? (b["deploy"].ok ? "ok" : "failed") : undefined],
    // staging serving the new stamp + its health check, folded into deploy
    ["smoke", b["deploy"]?.["smoke"] ? (b["deploy"]["smoke"].ok ? "ok" : "failed") : undefined],
  ];
  const got = checks.filter(([, v]) => v !== undefined);
  if (got.length) {
    lines.push({ text: "GATES", fg: C.muted });
    for (const [k, v] of got) {
      const good = v === "ok" || v === "applied" || v === "pass";
      lines.push({ text: `${good ? "✓" : "✗"} ${k.padEnd(9)}${String(v)}`, fg: good ? C.green : C.red });
    }
  }
  if (!lines.length) lines.push({ text: t.detail || "no committed work attached", fg: C.muted });
  return {
    kind: `${t.skill.toUpperCase()} REQUEST`, tag, tagFg, title: t.summary,
    subtitle: `task ${t.id.slice(0, 8)} · ${t.requestedBy}`,
    lines,
    foot: [t.updated ? t.updated.slice(0, 16).replace("T", " ") : "", a["patch"]?.["sha256"] ? `sha ${String(a["patch"]["sha256"]).slice(0, 12)}` : ""]
      .filter(Boolean),
  };
}

export function taskAbout(t: Task, state: string): About {
  const a = phase(t, "phase-a");
  const b = phase(t, "phase-b");
  // state and timestamps stay out: the summary is about the change, so a task
  // moving from working to input-required does not re-spend inference — new
  // evidence (a phase artifact) does
  const text = [
    `summary: ${t.summary}`, t.detail && `instructions: ${t.detail}`,
    t.commits.length && `commits:\n${t.commits.join("\n")}`,
    t.diffstat && `diffstat:\n${t.diffstat}`,
    Object.keys(a).length && `tier-2 checks (phase a): ${JSON.stringify({ build: a["build"], validate: a["validate"], evaluation: a["evaluation"], patch_ok: a["patch"]?.ok })}`,
    Object.keys(b).length && `after approval (phase b): ${JSON.stringify(b)}`,
    t.patch && `patch:\n${t.patch.slice(0, 5000)}`,
  ].filter(Boolean).join("\n\n");
  return {
    heading: t.summary,
    text: t.detail || "no instructions beyond the summary",
    facts: [`${t.skill} · ${state} · task ${t.id}`, `requested by ${t.requestedBy}${t.updated ? ` · ${t.updated.slice(0, 16).replace("T", " ")}` : ""}`,
            ...(t.diffstat ? [t.diffstat.trim().split("\n").pop()!.trim()] : [])],
    brief: {
      kind: `${t.skill} request`, title: t.summary, text,
      ask: "Summarise this request for the human who approves or rejects it: what the change does, which parts of the app it touches, the risk, what the tier-2 checks found, and a one-line recommendation (approve, reject, or ask) with the reason. A gate that passed is not a risk; risks come from the change itself.",
    },
  };
}

function CoverCard(props: { cover: Cover; width: number }) {
  const c = () => props.cover;
  return (
    <box flexDirection="column" width={props.width} flexShrink={0} border borderStyle="rounded"
         borderColor={C.border} paddingLeft={1} paddingRight={1} overflow="hidden">
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={C.accent} attributes={BOLD} wrapMode="none">{c().kind}</text>
        <Show when={c().tag}><text fg={c().tagFg ?? C.muted} wrapMode="none">{c().tag}</text></Show>
      </box>
      <Show when={c().art} fallback={<box height={1} flexShrink={0} />}>
        <Runs rows={c().art!} />
      </Show>
      <text fg={C.white} attributes={BOLD} wrapMode="word" flexShrink={0}>{c().title}</text>
      <Show when={c().subtitle}><text fg={C.muted} wrapMode="word" flexShrink={0}>{c().subtitle}</text></Show>
      <Show when={!c().art}><text fg={C.accent} flexShrink={0}>{"───"}</text></Show>
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <For each={c().lines}>
          {(l) => <text fg={l.fg ?? C.text} attributes={l.bold ? BOLD : 0} wrapMode={l.wrap ? "word" : "none"}
                       flexShrink={0}>{l.text}</text>}
        </For>
      </box>
      <For each={c().foot ?? []}>{(f) => <text fg={C.muted} wrapMode="none" flexShrink={0}>{f}</text>}</For>
    </box>
  );
}

/** The ABOUT half: authored text first, facts under it, a model brief only if one was written. */
function AboutPane(props: { about?: About; model: string; onBrief: () => void }) {
  const a = () => props.about;
  const got = () => {
    version();
    const b = a()?.brief;
    return b ? summary.get(summary.keyOf(b)) : undefined;
  };
  const status = () => {
    const g = got();
    if (!g || g.state === "none") return "";
    if (g.state === "pending") return `writing brief · ${props.model}`;
    if (g.summary) return `brief · ${g.summary.model} · ${g.summary.at.slice(0, 10)}`;
    return "brief failed";
  };
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={C.accent} attributes={BOLD}>ABOUT</text>
        <Show when={status()}>
          <box flexDirection="row" gap={2}>
            <text fg={got()?.state === "pending" ? C.yellow : C.muted} wrapMode="none">{status()}</text>
            <Show when={got()?.state !== "pending"}>
              <text fg={C.accent} wrapMode="none" onMouseUp={() => props.onBrief()}>↻</text>
            </Show>
          </box>
        </Show>
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <Show when={a()?.art}>
          <box flexShrink={0} paddingBottom={1}><Runs rows={a()!.art!} /></box>
        </Show>
        <Show when={a()?.heading}>
          <text fg={C.white} attributes={BOLD} wrapMode="word" flexShrink={0}>{a()!.heading}</text>
        </Show>
        <For each={(a()?.text ?? "").split("\n").filter(Boolean)}>
          {(l) => <text fg={a()?.fg ?? C.text} wrapMode="word" flexShrink={0}>{l}</text>}
        </For>
        <For each={a()?.sections ?? []}>
          {(sec) => (
            <box flexDirection="column" flexShrink={0} paddingTop={1}>
              <text fg={C.muted} wrapMode="none">{sec.title}</text>
              <For each={columns(sec.lines, sec.columns ?? 1)}>
                {(row) => <text fg={C.text} wrapMode="none">{row}</text>}
              </For>
            </box>
          )}
        </For>
        <Show when={a()?.facts?.length}>
          <box flexDirection="column" flexShrink={0} paddingTop={1}>
            <For each={a()!.facts!}>{(f) => <text fg={C.muted} wrapMode="word">{f}</text>}</For>
          </box>
        </Show>
        <Show when={got()?.summary || got()?.state === "failed"}>
          <box flexDirection="column" flexShrink={0} paddingTop={1}>
            <text fg={C.muted} wrapMode="none">BRIEF</text>
            <For each={(got()?.summary?.text ?? `could not write the brief — ${got()?.error}`).split("\n")}>
              {(l) => <text fg={got()?.state === "failed" ? C.red : C.text} wrapMode="word" flexShrink={0}>{l}</text>}
            </For>
          </box>
        </Show>
      </box>
    </box>
  );
}

/** Lay `lines` out in `n` columns, filled top to bottom. */
function columns(lines: string[], n: number): string[] {
  if (n <= 1 || lines.length < 2) return lines;
  const per = Math.ceil(lines.length / n);
  const width = Math.max(...lines.map((l) => l.length)) + 3;
  const out: string[] = [];
  for (let r = 0; r < per; r++) {
    out.push(Array.from({ length: n }, (_, c) => lines[c * per + r] ?? "").map((x, c) => c < n - 1 ? x.padEnd(width) : x).join("").trimEnd());
  }
  return out;
}

export function DetailPane(props: { cover?: Cover; about?: About; model: string; coverWidth: number;
                                   showCover: boolean; onBrief: () => void }) {
  return (
    <box flexDirection="row" flexGrow={1} minHeight={0} gap={2}>
      <Show when={props.cover && props.showCover}>
        <CoverCard cover={props.cover!} width={props.coverWidth} />
      </Show>
      <AboutPane about={props.about} model={props.model} onBrief={props.onBrief} />
    </box>
  );
}
