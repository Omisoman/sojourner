/**
 * The conversation header — Claude Code's welcome block, SOJOURNER's content:
 *
 *   ⡀⠀ ⢀⣀ ⣀⣀ ⣀⣀   SOJOURNER DEV AGENT  v1.0.0
 *   ⠈⠢ ⣏⣹ ⠤⠤ ⣇⣀   Qwen3 8B · Ollama (host)
 *                   new-horizons  /workspace/project
 *                   audit CH-1 · tool log v1
 *                   core 9f3c1a2b7d0e
 *                   plugin sojourner-ui 1.0.0 · OpenCode 1.18.30
 *
 * OpenCode 1.18.30 has no slot above the transcript, so the block is placed
 * as the transcript's first child (before its 1-row top spacer): it sits top
 * left, scrolls away with the conversation like Claude Code's, and covers
 * nothing. Found by shape — the one scrollbox with stickyStart "bottom" —
 * and re-attached whenever the session view remounts.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createEffect, createRoot, getOwner, on, onCleanup } from "solid-js";
import { AGENT, AUDIT, debug, PLUGIN, SIG } from "../lib/env.ts";
import { BOLD, C } from "../lib/palette.ts";
import { providerName, type Store } from "../lib/store.tsx";
import { projectInfo } from "./home.tsx";
import { CompactMark } from "./logo.tsx";

export function SessionHeader(props: { api: TuiPluginApi; store: Store }) {
  const project = projectInfo(props.api);
  const model = () => props.store.model();
  return (
    <box flexDirection="row" alignSelf="flex-start" flexShrink={0} marginTop={1}
         border borderStyle="rounded" borderColor={C.border}
         paddingLeft={1} paddingRight={2} gap={3}>
      <CompactMark />
      <box flexDirection="column">
        <box flexDirection="row" gap={2}>
          <text fg={C.accent} attributes={BOLD} wrapMode="none">{AGENT.name}</text>
          <text fg={C.muted} wrapMode="none">{`v${AGENT.version}`}</text>
        </box>
        <text fg={C.text} wrapMode="none">
          {`${model().name} · ${providerName(props.api, model().providerID)}`}
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={C.text} wrapMode="none">{project.name}</text>
          <text fg={C.muted} wrapMode="none">{project.dir}</text>
        </box>
        <text fg={C.muted} wrapMode="none">{`audit ${AUDIT.channel} · ${AUDIT.kind} ${AUDIT.version}`}</text>
        <text fg={C.muted} wrapMode="none">{`core ${SIG}`}</text>
        <text fg={C.muted} wrapMode="none">
          {`plugin ${PLUGIN.name} ${PLUGIN.version} · OpenCode ${props.api.app.version}`}
        </text>
      </box>
    </box>
  );
}

type Node = {
  parent: Node | null;
  isDestroyed?: boolean;
  stickyStart?: string;
  content?: Node;
  getChildren(): Node[];
  add(child: Node, index?: number): number;
  remove(child: Node): void;
};

function findTranscript(root: Node): Node | undefined {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.stickyStart === "bottom" && n.content) return n;
    let kids: Node[] = [];
    try {
      kids = n.getChildren?.() ?? [];
    } catch {
      // slot renderables refuse getChildren on some nodes
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return undefined;
}

/** Lives in the always-mounted `app` slot; renders nothing itself. */
export function HeaderInjector(props: { api: TuiPluginApi; store: Store }) {
  // the header's own root hangs off this owner: createElement needs the
  // renderer context, which a detached root would not see
  const owner = getOwner();
  let mounted: { box: Node; node: Node; dispose: () => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const detach = () => {
    if (!mounted) return;
    const { box, node, dispose } = mounted;
    mounted = undefined;
    try {
      if (!node.isDestroyed && node.parent) box.remove(node);
    } catch {
      // the session view (and our node with it) is already gone
    }
    dispose();
  };

  const attach = (tries: number) => {
    clearTimeout(timer);
    if (props.api.route.current.name !== "session") return detach();
    const box = findTranscript(props.api.renderer.root as unknown as Node);
    debug("header attach", { tries, found: !!box, mounted: !!mounted });
    if (!box) {
      if (tries > 0) timer = setTimeout(() => attach(tries - 1), 80);
      return;
    }
    if (mounted && mounted.box === box && !mounted.node.isDestroyed) return;
    detach();
    createRoot((dispose) => {
      try {
        const node = (<SessionHeader api={props.api} store={props.store} />) as unknown as Node;
        box.add(node, 0);
        mounted = { box, node, dispose };
        debug("header attached");
      } catch (e) {
        debug("header add failed", String(e), (e as Error)?.stack ?? "");
        dispose();
      }
    }, owner ?? undefined);
  };

  const routeKey = () => {
    const r = props.api.route.current as { name: string; params?: { sessionID?: string } };
    return `${r.name}:${r.params?.sessionID ?? ""}`;
  };
  createEffect(on(routeKey, (key) => {
    debug("header route", key);
    timer = setTimeout(() => attach(25), 0);
  }));
  onCleanup(() => {
    clearTimeout(timer);
    detach();
  });
  return null;
}
