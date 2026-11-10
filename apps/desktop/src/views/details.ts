import { openPath } from "@tauri-apps/plugin-opener";
import { call } from "../bridge.ts";
import { clear, formatBytes, formatDate, h, toast, verdictClass } from "../dom.ts";
import type { ProfileDetails } from "../types.ts";

const seconds = (s: number) => (s >= 10 ? `${s.toFixed(0)} s` : `${s.toFixed(1)} s`);

/** Overlay with everything about one profile: plugin, capture, signal, parameters, model, editor. */
export class ProfileDetailsDialog {
  private readonly overlay = h("div.overlay", { onclick: (e: Event) => e.target === this.overlay && this.close() });
  private readonly body = h("div.dialog-body");
  private readonly onKey = (e: KeyboardEvent) => e.key === "Escape" && this.close();

  constructor() {
    this.overlay.appendChild(h("div.dialog", {},
      h("header.dialog-header", {}, h("h2", {}, "Profil"), h("div.spacer"), h("button.ghost.small", { onclick: () => this.close() }, "Schließen")),
      this.body));
  }

  async show(path: string): Promise<void> {
    clear(this.body);
    this.body.appendChild(h("div.loading", {}, "Profil wird gelesen …"));
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
          ? h("span.pill", { class: verdictClass(d.verdict.text), title: d.verdict.pluginName ?? "" }, `Klon: ${d.verdict.text}`)
          : h("span.pill.neutral", {}, "noch kein Klon")),
    );

    // editor: rebuilt layout and, if available, the comparison with the original
    if (d.gui) {
      this.body.appendChild(section("Oberfläche",
        h("div.preview-grid", {},
          h("figure.preview", {},
            h("img", { src: d.gui.layout, alt: "Nachgebautes Layout", style: `aspect-ratio: ${d.gui.width} / ${d.gui.height}` }),
            h("figcaption", {}, `Nachgebautes Layout · ${d.gui.controls} Bedienelemente · ${d.gui.width}×${d.gui.height}`)),
          d.gui.compare
            && h("figure.preview", {},
              h("img", { src: d.gui.compare, alt: "Original und Klon" }),
              h("figcaption", {}, "Original (links) und gebauter Klon (rechts) – nur lokal gespeichert"))),
      ));
    } else {
      this.body.appendChild(section("Oberfläche", h("p.hint", {}, "Keine nachgebaute Oberfläche im Profil – beim Klonen „Oberfläche des Originals nachbauen“ wählen.")));
    }

    // capture
    const c = d.capture;
    this.body.appendChild(section("Messung",
      h("div.fact-grid", {},
        fact("Gemessen", formatDate(c.createdAt)),
        fact("Messmodus", c.plannerName),
        fact("Einstellungen", `${c.renders} (${c.train} zum Lernen, ${c.validate} zur Gegenprobe)`),
        fact("Abtastrate", `${(c.sampleRate / 1000).toFixed(1)} kHz, Block ${c.blockSize}`),
        fact("Kanäle", d.plugin.channels),
        fact("Latenz (gemeldet)", `${d.plugin.latency} Samples`),
        fact("Messprogramm", c.host),
        fact("System", c.os),
        fact("Plugin-Datei", d.plugin.file),
        fact("Profil", `${d.file} · ${formatBytes(d.bytes)}`)),
      c.notes ? h("p.hint", {}, c.notes) : undefined));

    // signal
    if (d.signal) {
      const total = d.signal.segments.reduce((s, x) => s + x.seconds, 0) || 1;
      this.body.appendChild(section(`Messsignal · ${seconds(d.signal.seconds)} pro Einstellung`,
        h("div.signal-bar", {}, ...d.signal.segments.map((s) =>
          h("div.signal-part", { style: `flex: ${s.seconds / total}`, title: `${s.kind} (${s.id}) · ${seconds(s.seconds)}` }, h("span", {}, s.kind)))),
        h("div.muted.small", {}, d.signal.segments.map((s) => `${s.kind} ${seconds(s.seconds)}`).join(" · "))));
    }

    // parameters
    if (d.parameters.length) {
      const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Parameter"), h("th", {}, "Bereich"), h("th", {}, "Grundeinstellung"))));
      const tbody = h("tbody");
      for (const p of d.parameters) tbody.appendChild(h("tr", {}, h("td", {}, p.name), h("td", {}, p.discrete ? `${p.from} … ${p.to} (Stufen)` : `${p.from} … ${p.to}`), h("td", {}, p.initial)));
      table.appendChild(tbody);
      this.body.appendChild(section(`Gemessene Parameter · ${d.parameters.length} von ${d.plugin.parameters}`, table));
    }

    // model
    this.body.appendChild(section("Modell",
      d.model ? h("ul.model-summary", {}, ...d.model.summary.map((line) => h("li", {}, line))) : h("p.hint", {}, "Noch nicht analysiert – „Klon bauen“ erstellt das Modell.")));

    this.body.appendChild(h("div.actions", {}, h("button.ghost.small", { onclick: () => openPath(d.path.replace(/[\\/][^\\/]+$/, "")) }, "Ordner öffnen")));
  }
}
