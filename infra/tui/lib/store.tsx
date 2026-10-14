/**
 * Live console state, one instance per TUI: current model, the A2A request
 * queue, what tier-2 has published, and the alerts derived from them.
 * Polled (cheap: one JSON-RPC call and a few readdirs every few seconds) so
 * the footer turns yellow without anyone opening a screen.
 */
import { readFileSync } from "node:fs";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createMemo, createRoot, createSignal } from "solid-js";
import * as catalog from "./catalog.ts";
import { CAN, debug, PATHS } from "./env.ts";
import { finished, listTasks, needsApproval, type Task } from "./requests.ts";

export type Alert = { id: string; tone: "warn" | "info" | "error"; text: string; section: string };

type Model = { providerID: string; modelID: string; name: string };

function parseModel(api: TuiPluginApi): Model {
  let ref: { providerID?: string; modelID?: string } | undefined;
  try {
    ref = JSON.parse(readFileSync(PATHS.modelState, "utf8"))?.recent?.[0];
  } catch {
    // no model picked yet this container lifetime — the config default applies
  }
  let providerID = ref?.providerID;
  let modelID = ref?.modelID;
  if (!providerID || !modelID) {
    const conf = String(api.state.config?.model ?? "");
    const cut = conf.indexOf("/");
    providerID = cut > 0 ? conf.slice(0, cut) : conf;
    modelID = cut > 0 ? conf.slice(cut + 1) : "";
  }
  const provider = api.state.provider.find((p) => p.id === providerID) as any;
  const full: string = provider?.models?.[modelID]?.name ?? modelID ?? "model";
  return { providerID, modelID, name: full.replace(/\s*\(.*\)\s*$/, "") || modelID };
}

export function providerName(api: TuiPluginApi, id: string): string {
  return (api.state.provider.find((p) => p.id === id) as any)?.name ?? id;
}

export function createStore(api: TuiPluginApi) {
  return createRoot(() => {
    const [model, setModel] = createSignal<Model>(parseModel(api), {
      equals: (a, b) => a.providerID === b.providerID && a.modelID === b.modelID && a.name === b.name,
    });
    const [tasks, setTasks] = createSignal<Task[]>([]);
    const [a2aUp, setA2aUp] = createSignal<boolean | undefined>(undefined);
    const [tick, setTick] = createSignal(0);
    const [seenTasks, setSeenTasks] = createSignal<Record<string, string>>(api.kv.get("sojourner.seen.tasks", {}));
    const [seenCatalog, setSeenCatalog] = createSignal<string[]>(api.kv.get("sojourner.seen.catalog", []));

    const published = createMemo(() => (tick(), CAN.consume ? catalog.published() : []));

    let misses = 0;
    const pollTasks = async () => {
      const t0 = Date.now();
      try {
        setTasks(await listTasks());
        misses = 0;
        setA2aUp(true);
      } catch (e) {
        // two misses in a row before the footer says so: a single timeout
        // (container DNS at start, a busy model host) is not an alert
        debug("a2a poll failed", { ms: Date.now() - t0, misses: misses + 1, error: String(e).slice(0, 80) });
        if (++misses >= 2) setA2aUp(false);
      }
    };
    const pollModel = () => setModel(parseModel(api));

    void pollTasks();
    const timers = [
      setInterval(pollModel, 1500),
      // 3 s: with the 4 s request timeout and two misses, A2A down shows within 10 s
      setInterval(() => void pollTasks(), 3000),
      setInterval(() => setTick((n) => n + 1), 4000), // catalog + disk-backed lists
    ];
    api.lifecycle.onDispose(() => timers.forEach(clearInterval));

    const alerts = createMemo<Alert[]>(() => {
      const out: Alert[] = [];
      if (CAN.approve) {
        for (const t of tasks().filter(needsApproval)) {
          out.push({ id: `approve:${t.id}`, tone: "warn", section: "requests",
                     text: `approval waiting — ${t.summary}` });
        }
      } else {
        const seen = seenTasks();
        for (const t of tasks()) {
          if (!(needsApproval(t) || finished(t)) || seen[t.id] === t.state) continue;
          out.push({ id: `task:${t.id}:${t.state}`, tone: t.state === "failed" ? "error" : "info",
                     section: "requests", text: `request ${t.state} — ${t.summary}` });
        }
        const known = new Set(seenCatalog());
        for (const e of published()) {
          if (known.has(e.path)) continue;
          const section = { command: "commands", skill: "skills", book: "books", prompt: "prompts" }[e.kind as string] ?? "commands";
          out.push({ id: `catalog:${e.path}`, tone: "info", section, text: `ops published ${e.kind} ${e.title}` });
        }
      }
      for (const p of pendingPermissions(api)) out.push(p);
      if (a2aUp() === false) {
        out.push({ id: "a2a:down", tone: "error", section: "requests", text: "tier-2 A2A unreachable" });
      }
      return out;
    });

    return {
      model,
      tasks,
      a2aUp,
      tick,
      alerts,
      refresh() {
        setTick((n) => n + 1);
        void pollTasks();
        pollModel();
      },
      /** Requester: the requests screen was opened — current states are acknowledged. */
      markTasksSeen() {
        const next = Object.fromEntries(tasks().map((t) => [t.id, t.state]));
        setSeenTasks(next);
        api.kv.set("sojourner.seen.tasks", next);
      },
      /** Consumer: a catalog section was opened. */
      markCatalogSeen(kind: catalog.Kind) {
        const paths = published().filter((e) => e.kind === kind).map((e) => e.path);
        const next = [...new Set([...seenCatalog(), ...paths])];
        setSeenCatalog(next);
        api.kv.set("sojourner.seen.catalog", next);
      },
      /** What this console has acknowledged (Sessions → Console state). */
      seenCounts() {
        return { tasks: Object.keys(seenTasks()).length, catalog: seenCatalog().length };
      },
      isNew(path: string) {
        return CAN.consume && !seenCatalog().includes(path);
      },
    };
  });
}

/** Sessions blocked on a permission prompt count as alerts too. */
function pendingPermissions(api: TuiPluginApi): Alert[] {
  const out: Alert[] = [];
  const route = api.route.current;
  const sid = route.name === "session" ? (route as any).params?.sessionID : undefined;
  if (!sid) return out;
  const n = api.state.session.permission(sid).length;
  if (n) out.push({ id: `perm:${sid}`, tone: "warn", section: "sessions", text: `${n} permission request(s) waiting` });
  return out;
}

export type Store = ReturnType<typeof createStore>;
