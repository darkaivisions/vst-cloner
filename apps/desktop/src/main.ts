import "./styles.css";
import { call, initBridge, onStatus, restartBridge } from "./bridge.ts";
import { append, clear, h } from "./dom.ts";
import { LogPanel } from "./log.ts";
import type { AppInfo, ToolStatus } from "./types.ts";
import { AiView } from "./views/ai.ts";
import { CloneView } from "./views/clone.ts";
import { LibraryView } from "./views/library.ts";

type Tab = "clone" | "library" | "ai";

async function main() {
  const root = document.getElementById("app")!;
  const log = new LogPanel();
  const library = new LibraryView((profile) => {
    show("clone");
    cloneView.useProfile(profile);
  });
  const cloneView = new CloneView(() => void library.refresh());
  const ai = new AiView();

  const views: Record<Tab, HTMLElement> = { clone: cloneView.element, library: library.element, ai: ai.element };
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  const content = h("main.content");
  const banner = h("div.banner.hidden");
  const statusPill = h("span.status-pill");

  const show = (tab: Tab) => {
    for (const [name, button] of tabButtons) button.classList.toggle("active", name === tab);
    clear(content);
    content.appendChild(views[tab]);
    if (tab === "library") void library.refresh();
    if (tab === "ai") void ai.refresh();
  };

  const tab = (name: Tab, label: string) => {
    const button = h("button.tab", { onclick: () => show(name) }, label);
    tabButtons.set(name, button);
    return button;
  };

  root.append(
    h("header.topbar", {},
      h("div.brand", {}, h("span.logo"), "vst-cloner"),
      h("nav.tabs", {}, tab("clone", "Clone"), tab("library", "Library"), tab("ai", "AI models")),
      statusPill),
    banner,
    content,
    log.element,
  );
  show("clone");

  const showBanner = (text: string, action?: { label: string; run: () => void }) => {
    clear(banner);
    banner.classList.remove("hidden");
    append(banner, h("span", {}, text), action && h("button.ghost.small", { onclick: action.run }, action.label));
  };

  /** Missing build tools: what is missing, how to install it, and a check again after installing. */
  const showToolchain = (tools: ToolStatus[]) => {
    const missing = tools.filter((t) => t.required && !t.found);
    if (!missing.length) {
      banner.classList.add("hidden");
      return;
    }
    clear(banner);
    banner.classList.remove("hidden");
    append(banner,
      h("div.toolchain", {},
        h("strong", {}, "Clones cannot be built yet – missing: "),
        h("ul", {}, ...missing.map((t) => h("li", {}, h("b", {}, t.name), ` (${t.purpose}): `, h("code", {}, t.hint)))),
        h("span.muted", {}, "Measuring works without them; building the clone needs them.")),
      h("button.ghost.small", { onclick: async () => showToolchain(await call<ToolStatus[]>("system.toolchain")) }, "Check again"));
  };

  let started = false;
  onStatus(async (status) => {
    statusPill.className = `status-pill ${status.state}`;
    statusPill.textContent = { starting: "starting …", ready: "ready", stopped: "stopped", error: "error" }[status.state];
    if (status.state === "error" || status.state === "stopped") {
      showBanner(status.message ?? "The background process is not running.", { label: "Restart", run: () => void restartBridge() });
      return;
    }
    if (status.state !== "ready" || started) return;
    started = true;
    banner.classList.add("hidden");

    const info = await call<AppInfo>("app.info");
    library.setProfilesDir(info.profilesDir);
    cloneView.setNeuralReady(Boolean(info.neural?.python));
    if (!info.host.found) showBanner("vch-host is missing (npm run host:configure && npm run host:build) – measuring only works once it is there.");
    else showToolchain(info.toolchain);
    for (const t of info.toolchain.filter((t) => !t.required && !t.found)) log.note("info", `Optional: ${t.name} is not installed – ${t.purpose}. ${t.hint}`);
    log.note("info", `vst-cloner ${info.version} ready – data in ${info.dataDir}`);
    await cloneView.refresh();
  });

  await initBridge();
}

void main();
