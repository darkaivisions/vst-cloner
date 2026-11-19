import { open } from "@tauri-apps/plugin-dialog";
import { call, startJob, type JobHandle } from "../bridge.ts";
import { clear, formatBytes, formatDb, h, openInSystem, revealInFolder, toast, verdictClass, zoomImage } from "../dom.ts";
import { Progress } from "../progress.ts";
import type { CaptureResult, CloneResult, PluginEntry, PluginInfo, ProfileSummary } from "../types.ts";

/** Main workflow: 1 choose plugin → 2 capture → 3 build the clone. */
type Mode = "eq" | "dynamics" | "distortion" | "delay" | "reverb" | "neural";

export class CloneView {
  readonly element: HTMLElement;

  private plugins: PluginEntry[] = [];
  private selected?: PluginEntry;
  private info?: PluginInfo;
  private profile?: { path: string; name: string; renders: number; planner: string };
  /** Python with PyTorch is set up (the universal clone trains with it) */
  private neuralReady = false;
  private setupJob?: JobHandle<{ python: string }>;
  private mode: Mode = "eq";
  private captureJob?: JobHandle<CaptureResult>;
  private cloneJob?: JobHandle<CloneResult>;

  private readonly search = h("input.search", { type: "search", placeholder: "Search plugins …" });
  private readonly list = h("div.plugin-list");
  private readonly details = h("div.plugin-details");
  private readonly modeBox = h("div.segmented");
  private readonly captureHint = h("p.hint");
  private readonly captureButton = h("button.primary", {}, "Start measuring");
  private readonly captureProgress = new Progress();
  private readonly captureNote = h("div.capture-note");
  private readonly profileLine = h("div.profile-line");
  private readonly installBox = h("input", { type: "checkbox", checked: true });
  private readonly guiBox = h("input", { type: "checkbox", checked: true });
  private readonly refitGuiBox = h("input", { type: "checkbox" });
  private readonly refitBox = h("input", { type: "checkbox" });
  private readonly minutesSelect = h("select", { title: "Longer training is usually more exact; the graphics card does the work" },
    h("option", { value: "5" }, "5 minutes"), h("option", { value: "10" }, "10 minutes"), h("option", { value: "20", selected: true }, "20 minutes"), h("option", { value: "40" }, "40 minutes"));
  private readonly neuralBox = h("div.neural-options");
  private readonly cloneButton = h("button.primary", {}, "Build clone");
  private readonly cloneProgress = new Progress();
  private readonly result = h("div.result");
  private readonly steps: HTMLElement[];

  constructor(private readonly onLibraryChanged: () => void) {
    this.search.addEventListener("input", () => this.renderList());
    this.captureButton.addEventListener("click", () => (this.captureJob ? this.captureJob.cancel() : this.capture()));
    this.cloneButton.addEventListener("click", () => (this.cloneJob ? this.cloneJob.cancel() : this.buildClone()));
    this.guiBox.addEventListener("change", () => this.update());

    const step1 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "1"), h("h2", {}, "Choose a plugin"),
        h("div.spacer"),
        h("button.ghost.small", { onclick: () => this.pickFile() }, "Other file …"),
        h("button.ghost.small", { onclick: () => this.refresh(), title: "Scan the plugin folders again" }, "Refresh")),
      this.search, this.list, this.details);

    const step2 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "2"), h("h2", {}, "Measure")),
      this.modeBox, this.captureHint,
      h("div.actions", {}, this.captureButton), this.captureProgress.element, this.captureNote);

    const step3 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "3"), h("h2", {}, "Build the clone")),
      this.profileLine,
      h("label.check", {}, this.installBox, "Install after building (visible to the DAW)"),
      h("label.check", { title: "The original plugin is opened invisibly for this and every control is moved once" },
        this.guiBox, "Rebuild the original's editor"),
      h("label.check.sub", { title: "Otherwise an editor layout stored in the profile is reused. Capturing it again uses the current detection – the original plugin has to be installed." },
        this.refitGuiBox, "Capture the editor again (instead of the one stored in the profile)"),
      h("label.check", { title: "Otherwise a model stored in the profile is reused. Fitting it again takes seconds to a few minutes depending on the effect type." },
        this.refitBox, "Fit the model again (instead of the one stored in the profile)"),
      this.neuralBox,
      h("div.actions", {}, this.cloneButton), this.cloneProgress.element, this.result);

    this.steps = [step1, step2, step3];
    this.element = h("div.view.clone-view", {}, ...this.steps);
    this.update();
  }

  async refresh(): Promise<void> {
    clear(this.list);
    this.list.appendChild(h("div.empty", {}, "Scanning plugin folders …"));
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
    this.profile = { path: profile.path, name: profile.name, renders: profile.renders, planner: profile.planner };
    clear(this.result);
    this.update();
    this.steps[2]!.scrollIntoView({ behavior: "smooth" });
  }

  /** Called with app.info: whether the training environment (PyTorch) exists. */
  setNeuralReady(ready: boolean): void {
    this.neuralReady = ready;
    this.update();
  }

  /** Step 3 for a universal profile: training time, or setting up the training environment first. */
  private renderNeuralOptions(busy: boolean) {
    clear(this.neuralBox);
    if (this.profile?.planner !== "neural") return;
    if (!this.neuralReady) {
      this.neuralBox.append(h("div.note.warn", {},
        h("strong", {}, "Training environment missing"),
        " – the universal clone trains a network with PyTorch. Setting it up downloads about 3 GB once (with an NVIDIA card the CUDA version, otherwise training runs on the CPU and takes much longer). ",
        h("button.ghost.small", { disabled: busy || Boolean(this.setupJob), onclick: () => this.setupTraining() }, this.setupJob ? "Setting up …" : "Set up training")));
      return;
    }
    this.minutesSelect.disabled = busy;
    this.neuralBox.append(h("label.check", {}, "Training time", this.minutesSelect));
  }

  private async setupTraining() {
    this.cloneProgress.busy("Setting up the training environment (PyTorch) – this takes a few minutes …");
    try {
      this.setupJob = await startJob<{ python: string }>("neural.setup", {});
      this.update();
      await this.setupJob.result;
      this.neuralReady = true;
      toast("Training environment ready");
    } catch (error) {
      if (!(error as { cancelled?: boolean }).cancelled) toast((error as Error).message, "error");
    } finally {
      this.setupJob = undefined;
      this.cloneProgress.hide();
      this.update();
    }
  }

  private renderList() {
    clear(this.list);
    const query = this.search.value.trim().toLowerCase();
    const items = this.plugins.filter((p) => !query || p.name.toLowerCase().includes(query));
    if (items.length === 0) {
      this.list.appendChild(h("div.empty", {}, this.plugins.length ? "No match" : "No plugins found – choose \"Other file …\""));
      return;
    }
    for (const plugin of items) {
      const row = h("button.plugin-row", { class: plugin === this.selected ? "selected" : "", onclick: () => this.select(plugin) },
        h("span.plugin-name", {}, plugin.name),
        h("span.badge", {}, plugin.format),
        plugin.source === "yabridge" && h("span.badge.accent", { title: "Windows plugin via yabridge" }, "Windows"),
        plugin.clone && h("span.badge.muted", {}, "Clone"));
      this.list.appendChild(row);
    }
  }

  private async pickFile() {
    const path = await open({ directory: true, title: "Choose a plugin bundle (.vst3 or .lv2)" });
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
    // progress and findings belong to the plugin measured before
    this.captureProgress.hide();
    clear(this.captureNote);
    this.renderList();
    clear(this.details);
    this.details.appendChild(h("div.loading", {}, `Loading ${plugin.name} …`));
    this.update();
    try {
      this.info = await call<PluginInfo>("plugins.info", { path: plugin.path });
      // a known effect class has its own exact model; everything else gets the universal clone
      this.mode = this.info.eq ? "eq" : this.info.dynamics ? "dynamics" : this.info.distortion ? "distortion" : this.info.delay ? "delay" : this.info.reverb ? "reverb" : "neural";
    } catch (error) {
      clear(this.details);
      this.details.appendChild(h("div.error-box", {}, `Plugin could not be loaded: ${(error as Error).message}`));
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
        h("span", {}, `${info.parameters} parameters`),
        h("span", {}, `${info.inputs} → ${info.outputs} channels`),
        info.latency > 0 && h("span", {}, `Latency ${info.latency} samples`),
        info.eq
          ? h("span.badge.good", {}, eqBadge(info.eq))
          : info.dynamics
            ? h("span.badge.good", {}, "Compressor/gate detected")
            : info.distortion
              ? h("span.badge.good", {}, "Distortion detected")
              : info.delay
                ? h("span.badge.good", {}, "Delay detected")
                : info.reverb
                  ? h("span.badge.good", {}, "Reverb detected")
                  : h("span.badge.accent", { title: "A network learns the plugin from the measurements – works for any plugin" }, "no known effect class – universal clone")),
    );
  }

  private update() {
    const info = this.info;
    const busy = Boolean(this.captureJob || this.cloneJob);

    // step 2
    clear(this.modeBox);
    const option = (mode: Mode, label: string, enabled: boolean) =>
      h("button", { class: this.mode === mode ? "active" : "", disabled: !enabled || busy, onclick: () => { this.mode = mode; this.update(); } }, label);
    this.modeBox.append(
      option("eq", "EQ", Boolean(info?.eq)),
      option("dynamics", "Dynamics", Boolean(info?.dynamics)),
      option("distortion", "Distortion", Boolean(info?.distortion)),
      option("delay", "Delay", Boolean(info?.delay)),
      option("reverb", "Reverb", Boolean(info?.reverb)),
      option("neural", "Universal", Boolean(info)),
    );
    this.captureHint.textContent = !info
      ? "Choose a plugin first."
      : this.mode === "eq" && info.eq
        ? `${info.eq.renders} settings – ${info.eq.sliders === info.eq.bands ? "every slider on its own at several gains" : "every filter shape at several frequencies, gains and Q values"}, plus several bands at once. Usually takes only seconds.`
        : this.mode === "dynamics" && info.dynamics
          ? `${info.dynamics.renders} settings of ~27 s test signal each (level staircase, bursts, long pauses for slow release) – every control on its own and in random combinations. Usually takes less than a minute.`
          : this.mode === "distortion" && info.distortion
            ? `${info.distortion.renders} settings of ~${info.distortion.signalSeconds} s test signal each (sine level staircases at several frequencies, noise, quiet sweep) – every control on its own and in random combinations. The analysis when cloning then takes about 2 minutes.`
            : this.mode === "delay" && info.delay
              ? `${info.delay.survey > 0 ? "At least " : ""}${info.delay.renders} settings of ~${info.delay.signalSeconds} s test signal each (impulse, long silence, noise burst) – every control on its own and in random combinations.` +
                (info.delay.survey > 0
                  ? ` First ${info.delay.survey} short renders look for hidden switches; every switch found adds further settings. Takes one to a few minutes.`
                  : " Usually takes less than a minute.")
              : this.mode === "reverb" && info.reverb
                ? `${info.reverb.renders} settings of ~${info.reverb.signalSeconds} s test signal each (an impulse and its decay) – every control on its own and in random combinations. Usually takes less than a minute.`
                : `${info.neural.renders} settings of ~${info.neural.signalSeconds} s test signal each (noise, sweeps, level steps, a tone burst, an impulse) with all controls at random – ` +
                  "a network then learns how the plugin sounds at every setting (when building the clone, about 10 minutes on the graphics card). Works for any plugin; " +
                  "long reverb tails, long delays and modulation (LFO) are its weak spots." +
                  (info.neural.skipped > 0 ? ` ${info.neural.skipped} controls beyond the first ${info.neural.controls} stay at their default.` : "");
    this.captureButton.disabled = !info || Boolean(this.cloneJob);
    this.captureButton.textContent = this.captureJob ? "Cancel" : "Start measuring";
    this.captureButton.classList.toggle("danger", Boolean(this.captureJob));
    this.steps[1]!.classList.toggle("disabled", !info);

    // step 3
    clear(this.profileLine);
    if (this.profile) {
      this.profileLine.append(h("span.muted", {}, "Profile: "), h("strong", {}, this.profile.name), h("span.muted", {}, ` · ${this.profile.renders} measurements · `),
        h("button.link", { onclick: () => revealInFolder(this.profile!.path) }, "show in folder"));
    } else {
      this.profileLine.append(h("span.muted", {}, "After measuring, continue here – or choose a profile from the library."));
    }
    this.renderNeuralOptions(busy);
    this.cloneButton.disabled = !this.profile || Boolean(this.captureJob) || Boolean(this.setupJob) || (this.profile.planner === "neural" && !this.neuralReady);
    this.cloneButton.textContent = this.cloneJob ? "Cancel" : "Build clone";
    this.cloneButton.classList.toggle("danger", Boolean(this.cloneJob));
    this.installBox.disabled = busy;
    this.guiBox.disabled = busy;
    this.refitGuiBox.disabled = busy || !this.guiBox.checked;
    this.refitBox.disabled = busy;
    this.steps[2]!.classList.toggle("disabled", !this.profile);
  }

  private async capture() {
    if (!this.info) return;
    clear(this.result);
    clear(this.captureNote);
    this.captureProgress.busy("Loading plugin …");
    let isolated = false;
    // title of the running preliminary step; its renders are counted on their own
    let step: string | undefined;
    try {
      this.captureJob = await startJob<CaptureResult>("capture.start", { path: this.info.path, mode: this.mode }, (event) => {
        if (event.kind === "progress") {
          this.captureProgress.set(event.done, event.total, step
            ? `${step} – ${event.done} / ${event.total} preliminary renders`
            : `${event.done} / ${event.total} settings${isolated ? " · fresh instance per render" : ""}`);
        } else if (event.kind === "stage" && event.stage !== "capture") {
          step = event.stage === "render" ? undefined : event.title;
          this.captureProgress.busy(`${event.title} …`);
        }
        else if (event.kind === "log" && event.level === "warn" && event.message.startsWith("Not repeatable")) {
          isolated = true;
          this.renderCaptureNote({ isolated, stepped: [], retries: 0 });
        }
      });
      this.update();
      const result = await this.captureJob.result;
      this.profile = { path: result.profile, name: result.name, renders: result.renders, planner: this.mode };
      this.captureProgress.set(1, 1, `Done – ${result.renders} settings, ${formatBytes(result.bytes)}`);
      this.renderCaptureNote(result);
      this.onLibraryChanged();
    } catch (error) {
      this.captureProgress.hide();
      if (!(error as { cancelled?: boolean }).cancelled) toast((error as Error).message, "error");
    } finally {
      this.captureJob = undefined;
      this.update();
    }
  }

  /** What the capture found out about the plugin beyond its parameter list. */
  private renderCaptureNote(found: Pick<CaptureResult, "isolated" | "stepped" | "retries">) {
    clear(this.captureNote);
    if (found.isolated) {
      this.captureNote.appendChild(h("div.note.warn", {},
        h("strong", {}, "Not repeatable"),
        " – the plugin keeps a state between renders. Every setting is measured with a fresh instance; this takes longer."));
    }
    if (found.stepped.length) {
      this.captureNote.appendChild(h("div.note", {},
        h("strong", {}, "Detected as switches"),
        `: ${found.stepped.map((s) => `${s.name} (${s.positions} positions)`).join(", ")} – reported as continuous by the plugin, every position is measured on its own.`));
    }
    if (found.retries > 0) {
      this.captureNote.appendChild(h("div.note", {}, `${found.retries} ${found.retries === 1 ? "render" : "renders"} failed at the first attempt and ${found.retries === 1 ? "was" : "were"} repeated.`));
    }
  }

  private async buildClone() {
    if (!this.profile) return;
    clear(this.result);
    this.cloneProgress.busy("Analysis …");
    const titles: Record<string, string> = {
      analyse: this.profile.planner === "neural" ? "Training the network …" : "Analysis …", gui: "Capturing the original's editor …", build: "Compiling the plugin …",
      verify: "Comparing with the original …", "gui-verify": "Comparing the editor …", save: "Saving …",
    };
    // the original plugin is known when the profile was measured in this session
    const plugin = this.info && this.profile.name === this.info.name ? this.info.path : undefined;
    try {
      this.cloneJob = await startJob<CloneResult>("clone.start",
        {
          profile: this.profile.path, install: this.installBox.checked, gui: this.guiBox.checked,
          ...(this.profile.planner === "neural" ? { minutes: Number(this.minutesSelect.value) } : {}),
          ...(this.guiBox.checked && this.refitGuiBox.checked ? { refitGui: true } : {}),
          ...(this.refitBox.checked ? { refit: true } : {}),
          ...(plugin ? { plugin } : {}),
        }, (event) => {
          if (event.kind === "stage") this.cloneProgress.busy(titles[event.stage] ?? event.title);
          else if (event.kind === "progress") this.cloneProgress.set(event.done, event.total, event.label ?? `${event.done} / ${event.total}`);
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
    // compressors, delays and reverbs report the same numbers; only what was compared differs
    const d = result.kind === "dynamics" ? result.dynamics : result.kind === "delay" || result.kind === "reverb" ? result.levels : undefined;
    if (d) {
      const compared = result.kind === "delay" ? "Echo level over time and frequency band deviates" : result.kind === "reverb" ? "Decay (level and decay per band) deviates" : "Level curve deviates";
      this.result.append(
        h("div.verdict", { class: verdictClass(d.verdict) },
          h("div.verdict-main", {}, d.verdict),
          h("div.verdict-sub", {}, `${compared} from the original by ${formatDb(d.overall.rmsDb)} on average · ${d.renders} settings checked` +
            (d.validate ? ` · unseen combinations ${formatDb(d.validate.rmsDb)}` : ""))),
        h("ul.model-summary", {}, ...(result.summary ?? []).map((line) => h("li", {}, line))),
      );
      if (d.worst.length) {
        const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Largest deviations"), h("th", {}, "Mean"), h("th", {}, "Peak"))));
        const body = h("tbody");
        for (const w of d.worst) body.appendChild(h("tr", {}, h("td", {}, w.label), h("td.num", {}, formatDb(w.rmsDb)), h("td.num", {}, formatDb(w.maxDb))));
        table.appendChild(body);
        this.result.appendChild(table);
      }
    }
    const nn = result.neural;
    if (result.kind === "neural" && nn) {
      const pct = (e: number) => `${(e * 100).toFixed(e < 0.1 ? 2 : 1)} %`;
      this.result.append(
        h("div.verdict", { class: verdictClass(nn.verdict) },
          h("div.verdict-main", {}, nn.verdict),
          h("div.verdict-sub", {}, `The clone's output differs from the original by ${pct(nn.median ?? nn.esr)} of the signal energy in a typical setting` +
            (nn.median !== undefined ? ` (mean ${pct(nn.esr)})` : "") + ` · ${nn.renders} settings checked` +
            (nn.validate !== undefined ? ` · unseen combinations ${pct(nn.validate)}` : "") +
            (nn.outliers ? ` · ${nn.outliers} setting${nn.outliers === 1 ? "" : "s"} off by half the signal or more` : ""))),
        h("ul.model-summary", {}, ...(result.summary ?? []).map((line) => h("li", {}, line))),
      );
      if (nn.worst.length) {
        const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Largest deviations"), h("th", {}, "Error"))));
        const body = h("tbody");
        for (const w of nn.worst) body.appendChild(h("tr", {}, h("td", {}, w.label), h("td.num", {}, pct(w.esr))));
        table.appendChild(body);
        this.result.appendChild(table);
      }
    }
    const x = result.distortion;
    if (result.kind === "distortion" && x) {
      this.result.append(
        h("div.verdict", { class: verdictClass(x.verdict) },
          h("div.verdict-main", {}, x.verdict),
          h("div.verdict-sub", {}, `Mean deviation: fundamental ${formatDb(x.overall.gainDb)}, harmonics ${formatDb(x.overall.harmonicsDb)}, small signal ${formatDb(x.overall.smallDb)} · ` +
            `${x.renders} settings checked` + (x.validate ? ` · unseen combinations ${x.validate.total.toFixed(2)}` : ""))),
        h("ul.model-summary", {}, ...(result.summary ?? []).map((line) => h("li", {}, line)),
          h("li", {}, `Signal comparison with loud noise: error/signal ${x.esrDb.toFixed(1)} dB`)),
      );
      if (x.worst.length) {
        const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Largest deviations"), h("th", {}, "Error"), h("th", {}, "Error/signal"))));
        const body = h("tbody");
        for (const w of x.worst) body.appendChild(h("tr", {}, h("td", {}, w.label), h("td.num", {}, w.total.toFixed(2)), h("td.num", {}, `${w.esrDb.toFixed(1)} dB`)));
        table.appendChild(body);
        this.result.appendChild(table);
      }
    }
    const v = result.verify;
    if (v) {
      this.result.append(
        h("div.verdict", { class: verdictClass(v.verdict) },
          h("div.verdict-main", {}, v.verdict),
          h("div.verdict-sub", {}, `Mean deviation from the original ${formatDb(v.overall.rmsDb)} · ${v.overall.renders} settings checked`)),
      );
      const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Filter shape"), h("th", {}, "Deviation"), h("th", {}, "Rating"))));
      const body = h("tbody");
      for (const s of v.shapes) {
        body.appendChild(h("tr", {}, h("td", {}, s.label), h("td.num", {}, formatDb(s.rmsDb)), h("td", {}, h("span.pill", { class: verdictClass(s.verdict) }, s.verdict))));
      }
      for (const s of result.shapes.filter((s) => !s.supported)) {
        body.appendChild(h("tr.muted", {}, h("td", {}, s.label), h("td.num", {}, "–"), h("td", {}, h("span.pill.neutral", {}, "not supported"))));
      }
      table.appendChild(body);
      this.result.appendChild(table);
      if (v.combined) {
        body.appendChild(h("tr", {}, h("td", {}, `Several bands at once (${v.combined.renders} settings)`), h("td.num", {}, formatDb(v.combined.rmsDb)),
          h("td", {}, h("span.pill", { class: verdictClass(v.combined.verdict) }, v.combined.verdict))));
      }
      if (v.limited) {
        this.result.appendChild(h("p.hint", {}, `Not reproduced exactly: ${v.limited.labels.join(", ")} (${v.limited.renders} settings, ${formatDb(v.limited.rmsDb)}).`));
      }
    }
    if (result.gui) {
      const g = result.gui;
      this.result.append(
        h("div.result-gui", {},
          h("strong", {}, "Editor rebuilt"),
          h("span.muted", {}, ` · ${g.controls} controls${g.similarity !== undefined ? ` · ${Math.round(g.similarity * 100)} % structural, ${Math.round((g.colorSimilarity ?? 0) * 100)} % colour similarity` : ""}`),
          g.comparePng ? h("span.muted", {}, " · ") : "",
          g.comparePng ? h("button.link", { onclick: () => openInSystem(g.comparePng!) }, "Open comparison image") : ""),
        g.preview
          ? h("figure.preview", {},
            h("img", { src: g.preview, alt: "Original and clone", onclick: () => zoomImage(g.preview!, "Original (left) and clone (right)", g.comparePng) }),
            h("figcaption", {}, "This is what the clone looks like: original (left), clone (right)"))
          : "",
      );
    }
    const folder = result.vst3.replace(/[\\/][^\\/]+$/, "");
    this.result.append(
      h("div.result-files", {},
        h("div", {}, h("strong", {}, result.pluginName), h("span.muted", {}, " · VST3 + LV2")),
        result.installed.length > 0
          ? h("div.muted", {}, `Installed: ${result.installed.join(", ")}`)
          : h("div.muted", {}, "Not installed – tick \"Install after building\" and build again to install."),
        h("div.actions", {}, h("button.ghost", { onclick: () => openInSystem(folder) }, "Open folder"))),
    );
  }
}

/** "EQ detected: 6 bands, 5 shapes" – graphic EQs and bands with a fixed shape have no shapes to count. */
function eqBadge(eq: NonNullable<PluginInfo["eq"]>): string {
  if (eq.sliders === eq.bands) return `Graphic EQ detected: ${eq.bands} bands`;
  const parts = [`${eq.bands} bands`];
  if (eq.shapes.length) parts.push(`${eq.shapes.length} shapes`);
  if (eq.fixedBands > 0) parts.push(eq.fixedBands === eq.bands ? "fixed shapes" : `${eq.fixedBands} with a fixed shape`);
  if (eq.groups > 1) parts.push(`${eq.groups} band groups`);
  return `EQ detected: ${parts.join(", ")}`;
}
