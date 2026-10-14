/**
 * SOJOURNER dev-agent TUI — one OpenCode 1.18.30 plugin for both tiers.
 *
 *   home      chip logo (braille, biggest that fits) · stock prompt with
 *             PROJECT · MODEL · SETTINGS attached under it
 *   settings  a plugin route: the agent's inventory, per tier (ui/settings.tsx)
 *   session   the stock view + a Claude-Code-style header as the transcript's
 *             first block (ui/header.tsx)
 *   footer    AGENT · PLUGIN · AUDIT · AGENTIZATION-CORE DEV · ALERTS on every
 *             screen (app_bottom)
 *
 * Loaded by absolute path from each tier's tui.json; infra/tui is bind-mounted
 * read-only at /opt/sojourner/tui (and baked into the image), so edits show on the
 * next `opencode` start. Slot names verified against TuiHostSlotMap in
 * @opencode-ai/plugin 1.18.30; the OpenCode version is pinned in the image.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import * as catalog from "./lib/catalog.ts";
import { CAN, CORE, type QuickAction, SIG, TIER } from "./lib/env.ts";
import { C } from "./lib/palette.ts";
import { createStore, type Store } from "./lib/store.tsx";
import { pick, view } from "./ui/dialogs.tsx";
import { Footer } from "./ui/footer.tsx";
import { HeaderInjector } from "./ui/header.tsx";
import { fillPrompt, HomePrompt, projectInfo } from "./ui/home.tsx";
import { ChipLogo, CompactMark } from "./ui/logo.tsx";
import { SETTINGS_ROUTE, SettingsPage, settingsCtl, type From } from "./ui/settings.tsx";

function here(api: TuiPluginApi): From {
  const r = api.route.current as From;
  return r.name === SETTINGS_ROUTE ? ((r.params?.["from"] as From) ?? { name: "home" }) : { name: r.name, params: r.params };
}

function openSettings(api: TuiPluginApi, section?: string) {
  api.ui.dialog.clear();
  api.route.navigate(SETTINGS_ROUTE, { section, from: here(api), at: Date.now() });
}

async function openAlerts(api: TuiPluginApi, store: Store) {
  const alerts = store.alerts();
  if (!alerts.length) {
    api.ui.toast({ message: "no alerts", variant: "info", duration: 2000 });
    return;
  }
  const a = await pick(api, "Alerts", alerts.map((x) => ({
    title: x.text, value: x, category: x.tone === "error" ? "Problems" : x.tone === "warn" ? "Needs you" : "Updates",
  })));
  if (a) openSettings(api, a.section);
}

/** The record's quick actions (core.json home.quick_actions), live values filled in. */
async function openProject(api: TuiPluginApi, store: Store) {
  const p = projectInfo(api);
  const published = () => (["command", "skill", "book", "prompt"] as catalog.Kind[])
    .map((k) => catalog.list(k).filter((e) => e.source === "ops").length).reduce((a, b) => a + b, 0);
  const vars: Record<string, () => string> = {
    project: () => p.name,
    dir: () => p.dir,
    catalog: () => CORE.catalog.path,
    published: () => String(published()),
    waiting: () => String(store.tasks().filter((t) => t.state === "input-required").length),
  };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k]?.() ?? m);
  const run = (q: QuickAction) => {
    const a = q.action;
    if (a.type === "view") view(api, a.path.split("/").pop() ?? a.path, catalog.body({ path: a.path } as catalog.Entry));
    else if (a.type === "settings") openSettings(api, a.section);
    else if (a.type === "prompt") fillPrompt(api, a.text);
  };
  const act = await pick(api, `Project · ${p.name}`, CORE.home.quick_actions.map((q) => ({
    title: fill(q.title), description: fill(q.description), category: q.category, value: () => run(q),
  })));
  act?.();
}

const tui: TuiPlugin = async (api) => {
  const store = createStore(api);
  // The stock home tips would sit between the prompt tabs and the footer.
  api.kv.set("tips_hidden", true);

  api.route.register([
    { name: SETTINGS_ROUTE, render: ({ params }) => <SettingsPage api={api} store={store} params={params} /> },
  ]);

  api.keymap.registerLayer({
    commands: [
      { name: "sojourner.settings", title: "Settings", desc: "Agent, catalog, governance and memory — the console's record",
        category: "SOJOURNER", namespace: "palette", slashName: "settings", run: () => openSettings(api) },
      { name: "sojourner.project", title: "Project", desc: "Project facts and quick actions",
        category: "SOJOURNER", namespace: "palette", slashName: "project", run: () => void openProject(api, store) },
      { name: "sojourner.alerts", title: "Alerts", desc: "What needs a human right now",
        category: "SOJOURNER", namespace: "palette", slashName: "alerts", run: () => void openAlerts(api, store) },
    ],
    bindings: [
      { key: "<leader>o", cmd: "sojourner.settings", desc: "SOJOURNER settings", group: "SOJOURNER" },
      { key: "<leader>p", cmd: "sojourner.project", desc: "Project", group: "SOJOURNER" },
      { key: "<leader>w", cmd: "sojourner.alerts", desc: "Alerts", group: "SOJOURNER" },
    ],
  });

  // Settings keys: only while the settings route is showing, no dialog is up
  // and the `/` filter is not taking typed text (it reads raw keys then).
  const s = () => settingsCtl();
  api.keymap.registerLayer({
    enabled: () => api.route.current.name === SETTINGS_ROUTE && !api.ui.dialog.open && !s()?.typing(),
    bindings: [
      { key: "up", desc: "Previous", group: "Settings", cmd: () => s()?.move(-1) },
      { key: "k", desc: "Previous", group: "Settings", cmd: () => s()?.move(-1) },
      { key: "down", desc: "Next", group: "Settings", cmd: () => s()?.move(1) },
      { key: "j", desc: "Next", group: "Settings", cmd: () => s()?.move(1) },
      { key: "right", desc: "Open section / next on the shelf", group: "Settings", cmd: () => s()?.right() },
      { key: "l", desc: "Open section / next on the shelf", group: "Settings", cmd: () => s()?.right() },
      { key: "left", desc: "Sections / previous on the shelf", group: "Settings", cmd: () => s()?.left() },
      { key: "h", desc: "Sections / previous on the shelf", group: "Settings", cmd: () => s()?.left() },
      { key: "tab", desc: "Switch pane", group: "Settings", cmd: () => s()?.focus("toggle") },
      { key: "return", desc: "Open", group: "Settings", cmd: () => s()?.enter() },
      { key: "escape", desc: "Back", group: "Settings", cmd: () => s()?.back() },
      { key: "u", desc: "Use in chat", group: "Settings", cmd: () => s()?.use() },
      { key: "a", desc: "Add", group: "Settings", cmd: () => s()?.add() },
      { key: "x", desc: "Reject", group: "Settings", cmd: () => s()?.reject() },
      { key: "r", desc: "Refresh", group: "Settings", cmd: () => s()?.refresh() },
      { key: "s", desc: "Brief", group: "Settings", cmd: () => s()?.brief() },
      { key: "/", desc: "Filter", group: "Settings", cmd: () => s()?.filter() },
    ],
  });

  api.slots.register({
    slots: {
      home_logo: () => <ChipLogo api={api} />,
      home_prompt: (_ctx, props) => (
        <HomePrompt api={api} store={store} ref={props.ref}
                    openProject={() => void openProject(api, store)} openSettings={() => openSettings(api)} />
      ),
      app_bottom: () => <Footer api={api} store={store} openAlerts={() => void openAlerts(api, store)} />,
      // single_winner: an empty box keeps OpenCode's own path · version line
      // off the home screen — the footer bar above carries that now
      home_footer: () => <box height={0} />,
      app: () => <HeaderInjector api={api} store={store} />,
      sidebar_footer: () => (
        <box flexDirection="column" gap={1}>
          <CompactMark />
          <text fg={C.muted}>{`tier ${TIER} · ${CAN.approve ? "approvals" : "requests"} · audit on`}</text>
          <text fg={C.muted}>{`core ${SIG}`}</text>
        </box>
      ),
    },
  });
};

export default { id: "sojourner-ui", tui } satisfies TuiPluginModule & { id: string };
