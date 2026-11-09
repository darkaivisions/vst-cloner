import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { call, startJob, type JobHandle } from "../bridge.ts";
import { clear, formatBytes, formatDb, h, toast, verdictClass } from "../dom.ts";
import { Progress } from "../progress.ts";
import type { CaptureResult, CloneResult, PluginEntry, PluginInfo, ProfileSummary } from "../types.ts";

/** Main workflow: 1 choose plugin → 2 capture → 3 build the clone. */
export class CloneView {
  readonly element: HTMLElement;

  private plugins: PluginEntry[] = [];
  private selected?: PluginEntry;
  private info?: PluginInfo;
  private profile?: { path: string; name: string; renders: number };
  private mode: "eq" | "generic" = "eq";
  private captureJob?: JobHandle<CaptureResult>;
  private cloneJob?: JobHandle<CloneResult>;

  private readonly search = h("input.search", { type: "search", placeholder: "Plugin suchen …" });
  private readonly list = h("div.plugin-list");
  private readonly details = h("div.plugin-details");
  private readonly modeBox = h("div.segmented");
  private readonly captureHint = h("p.hint");
  private readonly captureButton = h("button.primary", {}, "Messen starten");
  private readonly captureProgress = new Progress();
  private readonly profileLine = h("div.profile-line");
  private readonly installBox = h("input", { type: "checkbox", checked: true });
  private readonly cloneButton = h("button.primary", {}, "Klon bauen");
  private readonly cloneProgress = new Progress();
  private readonly result = h("div.result");
  private readonly steps: HTMLElement[];

  constructor(private readonly onLibraryChanged: () => void) {
    this.search.addEventListener("input", () => this.renderList());
    this.captureButton.addEventListener("click", () => (this.captureJob ? this.captureJob.cancel() : this.capture()));
    this.cloneButton.addEventListener("click", () => (this.cloneJob ? this.cloneJob.cancel() : this.buildClone()));

    const step1 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "1"), h("h2", {}, "Plugin wählen"),
        h("div.spacer"),
        h("button.ghost.small", { onclick: () => this.pickFile() }, "Andere Datei …"),
        h("button.ghost.small", { onclick: () => this.refresh(), title: "Plugin-Ordner neu durchsuchen" }, "Aktualisieren")),
      this.search, this.list, this.details);

    const step2 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "2"), h("h2", {}, "Messen")),
      this.modeBox, this.captureHint,
      h("div.actions", {}, this.captureButton), this.captureProgress.element);

    const step3 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "3"), h("h2", {}, "Klon bauen")),
      this.profileLine,
      h("label.check", {}, this.installBox, "Nach dem Bau installieren (für die DAW sichtbar)"),
      h("div.actions", {}, this.cloneButton), this.cloneProgress.element, this.result);

    this.steps = [step1, step2, step3];
    this.element = h("div.view.clone-view", {}, ...this.steps);
    this.update();
  }

  async refresh(): Promise<void> {
    clear(this.list);
    this.list.appendChild(h("div.empty", {}, "Plugin-Ordner werden durchsucht …"));
    try {
      this.plugins = await call<PluginEntry[]>("plugins.scan");
    } catch (error) {
      toast((error as Error).message, "error");
      this.plugins = [];
    }
    this.renderList();
  }

  /** Opens a profile from the library in step 3. */
  useProfile(profile: ProfileSummary): void {
    this.profile = { path: profile.path, name: profile.name, renders: profile.renders };
    clear(this.result);
    this.update();
    this.steps[2]!.scrollIntoView({ behavior: "smooth" });
  }

  private renderList() {
    clear(this.list);
    const query = this.search.value.trim().toLowerCase();
    const items = this.plugins.filter((p) => !query || p.name.toLowerCase().includes(query));
    if (items.length === 0) {
      this.list.appendChild(h("div.empty", {}, this.plugins.length ? "Kein Treffer" : "Keine Plugins gefunden – „Andere Datei …“ wählen"));
      return;
    }
    for (const plugin of items) {
      const row = h("button.plugin-row", { class: plugin === this.selected ? "selected" : "", onclick: () => this.select(plugin) },
        h("span.plugin-name", {}, plugin.name),
        h("span.badge", {}, plugin.format),
        plugin.source === "yabridge" && h("span.badge.accent", { title: "Windows-Plugin über yabridge" }, "Windows"),
        plugin.clone && h("span.badge.muted", {}, "Klon"));
      this.list.appendChild(row);
    }
  }

  private async pickFile() {
    const path = await open({ directory: true, title: "Plugin-Bundle wählen (.vst3 oder .lv2)" });
    if (typeof path !== "string") return;
    const name = path.split(/[\\/]/).pop()!.replace(/\.(vst3|lv2)$/i, "");
    const entry: PluginEntry = { path, name, format: /\.lv2$/i.test(path) ? "LV2" : "VST3", source: /yabridge/i.test(path) ? "yabridge" : "native", clone: false };
    this.plugins = [entry, ...this.plugins.filter((p) => p.path !== path)];
    this.renderList();
    await this.select(entry);
  }

  private async select(plugin: PluginEntry) {
    if (this.captureJob) return;
    this.selected = plugin;
    this.info = undefined;
    this.renderList();
    clear(this.details);
    this.details.appendChild(h("div.loading", {}, `${plugin.name} wird geladen …`));
    this.update();
    try {
      this.info = await call<PluginInfo>("plugins.info", { path: plugin.path });
      this.mode = this.info.eq ? "eq" : "generic";
    } catch (error) {
      clear(this.details);
      this.details.appendChild(h("div.error-box", {}, `Plugin konnte nicht geladen werden: ${(error as Error).message}`));
      this.update();
      return;
    }
    this.renderDetails();
    this.update();
  }

  private renderDetails() {
    clear(this.details);
    const info = this.info;
    if (!info) return;
    this.details.append(
      h("div.detail-title", {}, info.name, h("span.muted", {}, ` · ${info.manufacturer} · ${info.format} ${info.version}`)),
      h("div.detail-facts", {},
        h("span", {}, `${info.parameters} Parameter`),
        h("span", {}, `${info.inputs} → ${info.outputs} Kanäle`),
        info.latency > 0 && h("span", {}, `Latenz ${info.latency} Samples`),
        info.eq ? h("span.badge.good", {}, `EQ erkannt: ${info.eq.bands} Bänder, ${info.eq.shapes.length} Formen`) : h("span.badge.muted", {}, "kein parametrischer EQ erkannt")),
    );
  }

  private update() {
    const info = this.info;
    const busy = Boolean(this.captureJob || this.cloneJob);

    // step 2
    clear(this.modeBox);
    const option = (mode: "eq" | "generic", label: string, enabled: boolean) =>
      h("button", { class: this.mode === mode ? "active" : "", disabled: !enabled || busy, onclick: () => { this.mode = mode; this.update(); } }, label);
    this.modeBox.append(option("eq", "EQ-Messung", Boolean(info?.eq)), option("generic", "Allgemein", Boolean(info)));
    this.captureHint.textContent = !info
      ? "Zuerst ein Plugin wählen."
      : this.mode === "eq" && info.eq
        ? `${info.eq.renders} Einstellungen – jede Filterform bei mehreren Frequenzen, Gains und Güten. Dauert meist nur Sekunden.`
        : `${info.genericRenders} Einstellungen – jeder Parameter einzeln und in Zufallskombinationen. Klone sind bisher nur für EQs möglich.`;
    this.captureButton.disabled = !info || Boolean(this.cloneJob);
    this.captureButton.textContent = this.captureJob ? "Abbrechen" : "Messen starten";
    this.captureButton.classList.toggle("danger", Boolean(this.captureJob));
    this.steps[1]!.classList.toggle("disabled", !info);

    // step 3
    clear(this.profileLine);
    if (this.profile) {
      this.profileLine.append(h("span.muted", {}, "Profil: "), h("strong", {}, this.profile.name), h("span.muted", {}, ` · ${this.profile.renders} Messungen · `),
        h("button.link", { onclick: () => revealItemInDir(this.profile!.path) }, "im Ordner zeigen"));
    } else {
      this.profileLine.append(h("span.muted", {}, "Nach dem Messen geht es hier weiter – oder ein Profil aus der Bibliothek wählen."));
    }
    this.cloneButton.disabled = !this.profile || Boolean(this.captureJob);
    this.cloneButton.textContent = this.cloneJob ? "Abbrechen" : "Klon bauen";
    this.cloneButton.classList.toggle("danger", Boolean(this.cloneJob));
    this.installBox.disabled = busy;
    this.steps[2]!.classList.toggle("disabled", !this.profile);
  }

  private async capture() {
    if (!this.info) return;
    clear(this.result);
    this.captureProgress.busy("Plugin wird geladen …");
    try {
      this.captureJob = await startJob<CaptureResult>("capture.start", { path: this.info.path, mode: this.mode }, (event) => {
        if (event.kind === "progress") this.captureProgress.set(event.done, event.total, `${event.done} / ${event.total} Einstellungen`);
      });
      this.update();
      const result = await this.captureJob.result;
      this.profile = { path: result.profile, name: result.name, renders: result.renders };
      this.captureProgress.set(1, 1, `Fertig – ${result.renders} Einstellungen, ${formatBytes(result.bytes)}`);
      this.onLibraryChanged();
    } catch (error) {
      this.captureProgress.hide();
      if (!(error as { cancelled?: boolean }).cancelled) toast((error as Error).message, "error");
    } finally {
      this.captureJob = undefined;
      this.update();
    }
  }

  private async buildClone() {
    if (!this.profile) return;
    clear(this.result);
    this.cloneProgress.busy("Analyse …");
    const titles: Record<string, string> = { analyse: "Analyse …", build: "Plugin wird kompiliert …", verify: "Vergleich mit dem Original …", save: "Speichern …" };
    try {
      this.cloneJob = await startJob<CloneResult>("clone.start", { profile: this.profile.path, install: this.installBox.checked }, (event) => {
        if (event.kind === "stage") this.cloneProgress.busy(titles[event.stage] ?? event.title);
      });
      this.update();
      const result = await this.cloneJob.result;
      this.cloneProgress.hide();
      this.renderResult(result);
      this.onLibraryChanged();
    } catch (error) {
      this.cloneProgress.hide();
      if (!(error as { cancelled?: boolean }).cancelled) {
        this.result.appendChild(h("div.error-box", {}, (error as Error).message));
      }
    } finally {
      this.cloneJob = undefined;
      this.update();
    }
  }

  private renderResult(result: CloneResult) {
    clear(this.result);
    const v = result.verify;
    if (v) {
      this.result.append(
        h("div.verdict", { class: verdictClass(v.verdict) },
          h("div.verdict-main", {}, v.verdict),
          h("div.verdict-sub", {}, `Abweichung zum Original ${formatDb(v.overall.rmsDb)} im Mittel · ${v.overall.renders} Einstellungen geprüft`)),
      );
      const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Filterform"), h("th", {}, "Abweichung"), h("th", {}, "Bewertung"))));
      const body = h("tbody");
      for (const s of v.shapes) {
        body.appendChild(h("tr", {}, h("td", {}, s.label), h("td.num", {}, formatDb(s.rmsDb)), h("td", {}, h("span.pill", { class: verdictClass(s.verdict) }, s.verdict))));
      }
      for (const s of result.shapes.filter((s) => !s.supported)) {
        body.appendChild(h("tr.muted", {}, h("td", {}, s.label), h("td.num", {}, "–"), h("td", {}, h("span.pill.neutral", {}, "nicht unterstützt"))));
      }
      table.appendChild(body);
      this.result.appendChild(table);
      if (v.limited) {
        this.result.appendChild(h("p.hint", {}, `Nicht exakt nachgebildet: ${v.limited.labels.join(", ")} (${v.limited.renders} Einstellungen, ${formatDb(v.limited.rmsDb)}).`));
      }
    }
    const folder = result.vst3.replace(/[\\/][^\\/]+$/, "");
    this.result.append(
      h("div.result-files", {},
        h("div", {}, h("strong", {}, result.pluginName), h("span.muted", {}, " · VST3 + LV2")),
        result.installed.length > 0
          ? h("div.muted", {}, `Installiert: ${result.installed.join(", ")}`)
          : h("div.muted", {}, "Nicht installiert – zum Installieren „Nach dem Bau installieren“ anhaken und erneut bauen."),
        h("div.actions", {}, h("button.ghost", { onclick: () => openPath(folder) }, "Ordner öffnen"))),
    );
  }
}
