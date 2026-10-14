/**
 * The status bar under every screen (OpenCode's app_bottom slot — home,
 * settings and sessions alike):
 *   AGENT · PLUGIN · AUDIT CHANNEL · AGENTIZATION-CORE DEV · ALERTS
 * ALERTS turns yellow while anything needs a human (a deploy waiting for
 * approval, a request that finished, something ops published, a permission
 * prompt) and opens the list on click.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createSignal, Show } from "solid-js";
import { AGENT, AUDIT, PLATFORM, PLUGIN } from "../lib/env.ts";
import { BOLD, C } from "../lib/palette.ts";
import type { Store } from "../lib/store.tsx";
import { useSize } from "./logo.tsx";

function Item(props: { label: string; value: string; short?: boolean }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <Show when={!props.short}>
        <text fg={C.muted} wrapMode="none">{`${props.label} `}</text>
      </Show>
      <text fg={C.text} wrapMode="none">{props.value}</text>
    </box>
  );
}

export function Footer(props: { api: TuiPluginApi; store: Store; openAlerts: () => void }) {
  const size = useSize(props.api);
  const [hover, setHover] = createSignal(false);
  const count = () => props.store.alerts().length;
  const wide = () => size().cols >= 112;
  const mid = () => size().cols >= 76;
  return (
    <box flexDirection="row" justifyContent="space-between" width="100%" height={1}
         backgroundColor={C.panel} paddingLeft={1} paddingRight={0} flexShrink={0}>
      <box flexDirection="row" gap={2} flexShrink={1}>
        <Item label="AGENT" value={wide() ? AGENT.id : `tier-${AGENT.tier}`} short={!mid()} />
        <Show when={mid()}>
          <Item label="PLUGIN" value={`${PLUGIN.name} ${PLUGIN.version}`} short={!wide()} />
        </Show>
        <Item label="AUDIT" value={`${AUDIT.channel} ${AUDIT.version}`} short={!mid()} />
      </box>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <Show when={mid()}>
          <text fg={C.accent} wrapMode="none">{wide() ? PLATFORM : "AC DEV"}</text>
        </Show>
        <box flexDirection="row" paddingLeft={1} paddingRight={1}
             backgroundColor={count() ? C.yellow : hover() ? C.border : C.element}
             onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}
             onMouseUp={() => props.openAlerts()}>
          <text fg={count() ? C.bg : C.muted} attributes={count() ? BOLD : 0} wrapMode="none">
            {count() ? `● ALERTS ${count()}` : "ALERTS 0"}
          </text>
        </box>
      </box>
    </box>
  );
}
