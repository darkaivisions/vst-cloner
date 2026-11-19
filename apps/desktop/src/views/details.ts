import { call } from "../bridge.ts";
import { clear, formatBytes, formatDate, h, openInSystem, toast, verdictClass, zoomImage } from "../dom.ts";
import type { ProfileDetails } from "../types.ts";
import { ReplayPlayer } from "../replay.ts";

const seconds = (s: number) => (s >= 10 ? `${s.toFixed(0)} s` : `${s.toFixed(1)} s`);

/** Overlay with everything about one profile: plugin, capture, signal, parameters, model, editor. */
export class ProfileDetailsDialog {
  private readonly overlay = h("div.overlay", { onclick: (e: Event) => e.target === this.overlay && this.close() });
  private readonly body = h("div.dialog-body");
  private readonly onKey = (e: KeyboardEvent) => e.key === "Escape" && this.close();
  private player?: ReplayPlayer;

  constructor() {
    this.overlay.appendChild(h("div.dialog", {},
      h("header.dialog-header", {}, h("h2", {}, "Profile"), h("div.spacer"), h("button.ghost.small", { onclick: () => this.close() }, "Close")),
      this.body));
  }

  async show(path: string): Promise<void> {
    clear(this.body);
    this.body.appendChild(h("div.loading", {}, "Reading profile …"));
    document.body.appendChild(this.overlay);
    document.addEventListener("keydown", this.onKey);
    try {
      this.render(await call<ProfileDetails>("profiles.details", { path }));
    } catch (error) {
      this.close();
      toast((error as Error).message, "error");
    }
  }

  close(): void {
    this.player?.dispose();
    this.player = undefined;
    this.overlay.remove();
    document.removeEventListener("keydown", this.onKey);
  }

  private render(d: ProfileDetails): void {
    clear(this.body);
    const fact = (label: string, value: string | number) => h("div.fact", {}, h("span.fact-label", {}, label), h("span.fact-value", {}, String(value)));
    const section = (title: string, ...children: (HTMLElement | false | undefined)[]) =>
      h("section.detail-section", {}, h("h3", {}, title), ...children.filter((c): c is HTMLElement => Boolean(c)));

    // header: plugin and rating
    this.body.append(
      h("div.detail-head", {},
        h("div", {},
          h("div.detail-name", {}, d.plugin.name),
          h("div.muted", {}, [d.plugin.manufacturer, `${d.plugin.format} ${d.plugin.version}`.trim(), d.plugin.category].filter(Boolean).join(" · "))),
        d.verdict
          ? h("span.pill", { class: verdictClass(d.verdict.text), title: [d.verdict.pluginName, d.verdict.deviation].filter(Boolean).join(" · ") }, `Clone: ${d.verdict.text}`)
          : h("span.pill.neutral", {}, "no clone yet")),
    );

    // editor: rebuilt layout and, if available, the comparison with the original
    if (d.gui) {
      this.body.appendChild(section("Editor",
        h("div.preview-grid", {},
          h("figure.preview", {},
            h("img", { src: d.gui.layout, alt: "Rebuilt layout", style: `aspect-ratio: ${d.gui.width} / ${d.gui.height}`, onclick: () => zoomImage(d.gui!.layout, "Rebuilt layout") }),
            h("figcaption", {}, `Rebuilt layout · ${d.gui.controls} controls · ${d.gui.width}×${d.gui.height}`)),
          d.gui.compare
            && h("figure.preview", {},
              h("img", { src: d.gui.compare, alt: "Original and clone", onclick: () => zoomImage(d.gui!.compare!, "Original (left) and clone (right)") }),
              h("figcaption", {}, "Original (left) and built clone (right) – stored locally only"))),
      ));
    } else {
      this.body.appendChild(section("Editor", h("p.hint", {}, "No rebuilt editor in the profile – choose \"Rebuild the original's editor\" when cloning.")));
    }

    // replay of the editor recognition (the pictures stay in the local cache)
    this.player?.dispose();
    const player = new ReplayPlayer(d.path);
    this.player = player;
    const replay = section("Editor recognition – replay",
      h("p.hint", {}, "What the recognition saw: the editor as it opens, every control moved through its range, and the level meters filmed while a sine rises from silence. Frames show what was recognised."),
      player.element);
    replay.classList.add("hidden");
    this.body.appendChild(replay);
    player.load().then((ok) => replay.classList.toggle("hidden", !ok)).catch(() => replay.remove());

    // capture
    const c = d.capture;
    this.body.appendChild(section("Measurement",
      h("div.fact-grid", {},
        fact("Measured", formatDate(c.createdAt)),
        fact("Measurement mode", c.plannerName),
        fact("Settings", `${c.renders} (${c.train} for fitting, ${c.validate} as a cross-check)`),
        fact("Sample rate", `${(c.sampleRate / 1000).toFixed(1)} kHz, block ${c.blockSize}`),
        fact("Channels", d.plugin.channels),
        fact("Latency (reported)", `${d.plugin.latency} samples`),
        fact("Capture host", c.host),
        fact("System", c.os),
        fact("Plugin file", d.plugin.file),
        fact("Profile", `${d.file} · ${formatBytes(d.bytes)}`)),
      c.notes ? h("p.hint", {}, c.notes) : undefined));

    // signal
    if (d.signal) {
      const total = d.signal.segments.reduce((s, x) => s + x.seconds, 0) || 1;
      this.body.appendChild(section(`Test signal · ${seconds(d.signal.seconds)} per setting`,
        h("div.signal-bar", {}, ...d.signal.segments.map((s) =>
          h("div.signal-part", { style: `flex: ${s.seconds / total}`, title: `${s.kind} (${s.id}) · ${seconds(s.seconds)}` }, h("span", {}, s.kind)))),
        h("div.muted.small", {}, d.signal.segments.map((s) => `${s.kind} ${seconds(s.seconds)}`).join(" · "))));
    }

    // parameters
    if (d.parameters.length) {
      const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Parameter"), h("th", {}, "Range"), h("th", {}, "Default"))));
      const tbody = h("tbody");
      for (const p of d.parameters) tbody.appendChild(h("tr", {}, h("td", {}, p.name), h("td", {}, p.discrete ? `${p.from} … ${p.to} (steps)` : `${p.from} … ${p.to}`), h("td", {}, p.initial)));
      table.appendChild(tbody);
      this.body.appendChild(section(`Measured parameters · ${d.parameters.length} of ${d.plugin.parameters}`, table));
    }

    // model
    this.body.appendChild(section("Model",
      d.model ? h("ul.model-summary", {}, ...d.model.summary.map((line) => h("li", {}, line))) : h("p.hint", {}, "Not analysed yet – \"Build clone\" creates the model.")));

    this.body.appendChild(h("div.actions", {}, h("button.ghost.small", { onclick: () => openInSystem(d.path.replace(/[\\/][^\\/]+$/, "")) }, "Open folder")));
  }
}
