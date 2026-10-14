/**
 * Home: the prompt with PROJECT · MODEL · SETTINGS attached under it (the
 * prompt's own hint row, so the tabs sit on the box's bottom edge, left of
 * OpenCode's key hints). Typing and sending is untouched — this is the stock
 * prompt; the first message moves it to the bottom of the session view, as
 * Claude Code does.
 */
import type { TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui";
import { readFileSync } from "node:fs";
import { createSignal } from "solid-js";
import { CORE } from "../lib/env.ts";
import { BOLD, C } from "../lib/palette.ts";
import type { Store } from "../lib/store.tsx";
import { useSize } from "./logo.tsx";

let homePrompt: TuiPromptRef | undefined;

const PLACEHOLDERS = { normal: CORE.home.placeholders };

export function projectInfo(api: TuiPluginApi): { name: string; dir: string } {
  const dir = api.state.path?.directory || process.cwd();
  let name = CORE.workspace.name;
  try {
    name = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).name ?? name;
  } catch {
    // not a node project (the ops workspace) — the record's name stands
  }
  return { name, dir };
}

/**
 * Put text in the prompt of whichever screen is showing: the home prompt
 * directly, a session's through OpenCode's own prompt.append event.
 */
export function fillPrompt(api: TuiPluginApi, text: string) {
  setTimeout(() => {
    if (api.route.current.name === "home" && homePrompt) {
      homePrompt.set({ input: text, parts: [] });
      homePrompt.focus();
      return;
    }
    void api.client.tui.executeCommand({ command: "prompt.clear" })
      .then(() => api.client.tui.appendPrompt({ text }));
  }, 60);
}

function Tab(props: { label: string; value?: string; hot?: boolean; onClick: () => void }) {
  const [hover, setHover] = createSignal(false);
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={hover() ? C.border : C.element}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => props.onClick()}
    >
      <text fg={props.hot ? C.accentBright : C.accent} attributes={BOLD} wrapMode="none">{props.label}</text>
      {props.value ? <text fg={C.text} wrapMode="none">{` ${props.value}`}</text> : null}
    </box>
  );
}

export function Tabs(props: { api: TuiPluginApi; store: Store; openProject: () => void; openSettings: () => void }) {
  const project = projectInfo(props.api);
  const size = useSize(props.api);
  // the tabs share the row with OpenCode's key hints; under ~104 columns the
  // prompt is 75 wide and the project name gives way first
  const roomy = () => size().cols >= 104;
  return (
    <box flexDirection="row" gap={1} marginLeft={1} flexShrink={0}>
      <Tab label="PROJECT" value={roomy() ? project.name : undefined} onClick={props.openProject} />
      <Tab label="MODEL" value={props.store.model().name}
           onClick={() => props.api.keymap.dispatchCommand("model.list")} />
      <Tab label="SETTINGS" hot onClick={props.openSettings} />
    </box>
  );
}

export function HomePrompt(props: {
  api: TuiPluginApi;
  store: Store;
  ref?: (ref: TuiPromptRef | undefined) => void;
  openProject: () => void;
  openSettings: () => void;
}) {
  const Prompt = props.api.ui.Prompt;
  const Slot = props.api.ui.Slot;
  return (
    <Prompt
      ref={(r) => {
        homePrompt = r;
        props.ref?.(r);
      }}
      placeholders={PLACEHOLDERS}
      hint={<Tabs api={props.api} store={props.store} openProject={props.openProject} openSettings={props.openSettings} />}
      right={<Slot name="home_prompt_right" />}
    />
  );
}
