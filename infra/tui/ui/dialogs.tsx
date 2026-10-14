/** Promise-shaped wrappers over OpenCode's dialog stack. */
import type { TuiDialogSelectOption, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { BOLD, C } from "../lib/palette.ts";

/** One line of input; undefined when cancelled or left empty. */
export function ask(api: TuiPluginApi, title: string, placeholder = "", value = "", hint?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      resolve(v?.trim() ? v.trim() : undefined);
    };
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogPrompt
          title={title}
          placeholder={placeholder}
          value={value}
          description={hint ? () => <text fg={C.muted}>{hint}</text> : undefined}
          onConfirm={(v) => finish(v)}
          onCancel={() => finish(undefined)}
        />
      ),
      () => finish(undefined),
    );
  });
}

export function confirm(api: TuiPluginApi, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      api.ui.dialog.clear();
      resolve(v);
    };
    api.ui.dialog.replace(
      () => <api.ui.DialogConfirm title={title} message={message}
                                  onConfirm={() => finish(true)} onCancel={() => finish(false)} />,
      () => finish(false),
    );
  });
}

export function pick<V>(api: TuiPluginApi, title: string, options: TuiDialogSelectOption<V>[],
                        current?: V): Promise<V | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: V | undefined) => {
      if (done) return;
      done = true;
      api.ui.dialog.clear();
      resolve(v);
    };
    api.ui.dialog.replace(
      () => <api.ui.DialogSelect title={title} options={options} current={current}
                                 onSelect={(o) => finish(o.value)} />,
      () => finish(undefined),
    );
  });
}

/**
 * Read-only text viewer (file bodies, task details, audit lines). Content goes
 * straight into the dialog stack's panel — like OpenCode's own dialogs — which
 * already centres, frames and closes it on esc.
 */
export function view(api: TuiPluginApi, title: string, text: string, footer?: string, wrap = true, meta?: string) {
  const lines = text.replace(/\t/g, "  ").split("\n");
  api.ui.dialog.replace(() => (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={C.accent} attributes={BOLD} wrapMode="none">{title}</text>
        <text fg={C.muted} wrapMode="none">{meta ? `${meta}   esc` : "esc"}</text>
      </box>
      <scrollbox height={Math.min(lines.length, 24)} scrollY>
        <box flexDirection="column">
          {lines.map((l) => (
            <text fg={l.startsWith("#") ? C.accentBright : C.text} wrapMode={wrap ? "word" : "none"}>{l || " "}</text>
          ))}
        </box>
      </scrollbox>
      {footer ? <text fg={C.muted} wrapMode="none">{footer}</text> : null}
    </box>
  ));
  api.ui.dialog.setSize("large");
}
