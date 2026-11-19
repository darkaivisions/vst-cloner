import { open } from "@tauri-apps/plugin-dialog";
import { call, startJob, type JobHandle } from "../bridge.ts";
import { clear, formatBytes, formatDb, h, openInSystem, revealInFolder, toast, verdictClass, zoomImage } from "../dom.ts";
import { Progress } from "../progress.ts";
import type { CaptureResult, CloneResult, PluginEntry, PluginInfo, PluginKind, ProfileSummary } from "../types.ts";
import { filterBar, kindBadge } from "../kinds.ts";

/** Main workflow: 1 choose plugin → 2 capture → 3 build the clone. */
type Mode = "eq" | "dynamics" | "distortion" | "delay" | "modulation" | "reverb" | "neural" | "best";

export class CloneView {
  readonly element: HTMLElement;

  private plugins: PluginEntry[] = [];
  /** what kind of effect each plugin is (by path), filled in the background */
  private readonly kinds = new Map<string, PluginKind>();
  private kindsLoading = false;
  private group = "all";
  private format: "all" | "VST3" | "LV2" | "Windows" = "all";
  private hideClones = false;
  private readonly chips = h("div.filter-chips");
  private readonly formatSelect = h("select.filter-select", { title: "Plugin format" });
  private readonly pending = h("span.filter-pending");
  private readonly filters = h("div.filters", {}, this.chips,
    h("div.filter-extra", {}, this.formatSelect,
      h("label.check.filter-check", { title: "Hide the clones vst-cloner built" },
        h("input", { type: "checkbox", onchange: (e: Event) => { this.hideClones = (e.target as HTMLInputElement).checked; this.renderList(); } }), "Hide clones"),
      this.pending));
  private selected?: PluginEntry;
  private info?: PluginInfo;
  private profile?: { path: string; name: string; renders: number; planner: string };
  /** Python with PyTorch is set up (the universal clone trains with it) */
  private neuralReady = false;
  private setupJob?: JobHandle<{ python: string }>;
  private mode: Mode = "eq";
  private captureJob?: JobHandle<CaptureResult>;
  private cloneJob?: JobHandle<CloneResult>;
  private bestJob?: JobHandle<CloneResult>;

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
  /** step 2 in "compare" mode: the whole way in one go (training time, install) */
  private readonly bestBox = h("div.best-options");
  private readonly bestMinutes = h("select", { title: "Training time of the network; the class engine is ready in minutes" },
    h("option", { value: "5" }, "5 minutes"), h("option", { value: "10" }, "10 minutes"), h("option", { value: "20", selected: true }, "20 minutes"), h("option", { value: "40" }, "40 minutes"));
  private readonly bestInstall = h("input", { type: "checkbox", checked: true });
  private readonly cloneButton = h("button.primary", {}, "Build clone");
  private readonly cloneProgress = new Progress();
  private readonly result = h("div.result");
  /** step 2 in "compare" mode: the comparison and the chosen clone */
  private readonly bestResult = h("div.result");
  private readonly steps: HTMLElement[];

  constructor(private readonly onLibraryChanged: () => void) {
    this.search.addEventListener("input", () => this.renderList());
    this.formatSelect.addEventListener("change", () => { this.format = this.formatSelect.value as typeof this.format; this.renderList(); });
    this.captureButton.addEventListener("click", () => (this.captureJob ? this.captureJob.cancel() : this.bestJob ? this.bestJob.cancel() : this.mode === "best" ? this.runBest() : this.capture()));
    this.cloneButton.addEventListener("click", () => (this.cloneJob ? this.cloneJob.cancel() : this.buildClone()));
    this.guiBox.addEventListener("change", () => this.update());

    const step1 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "1"), h("h2", {}, "Choose a plugin"),
        h("div.spacer"),
        h("button.ghost.small", { onclick: () => this.pickFile() }, "Other file …"),
        h("button.ghost.small", { onclick: () => this.refresh(), title: "Scan the plugin folders again" }, "Refresh")),
      this.search, this.filters, this.list, this.details);

    const step2 = h("section.card.step", {},
      h("header.step-header", {}, h("span.step-number", {}, "2"), h("h2", {}, "Measure")),
      this.modeBox, this.captureHint, this.bestBox,
      h("div.actions", {}, this.captureButton), this.captureProgress.element, this.captureNote, this.bestResult);

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
    void this.loadKinds();
  }

  /**
   * Looks at every plugin once to tell what kind of effect it is (the bridge caches it per bundle, so only new or
   * updated plugins are loaded). Done in small portions so the list fills in while it runs.
   */
  private async loadKinds() {
    if (this.kindsLoading) return;
    this.kindsLoading = true;
    try {
      const missing = this.plugins.map((p) => p.path).filter((path) => !this.kinds.has(path));
      for (let i = 0; i < missing.length; i += 24) {
        const found = await call<Record<string, PluginKind>>("plugins.kinds", { paths: missing.slice(i, i + 24) });
        for (const [path, kind] of Object.entries(found)) this.kinds.set(path, kind);
        this.renderList();
      }
    } catch (error) {
      toast(`Effect types: ${(error as Error).message}`, "error");
    } finally {
      this.kindsLoading = false;
      this.renderList();
    }
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

  /** Step 2 in "compare" mode: training time and install, or setting up the training first. */
  private renderBestOptions(busy: boolean) {
    clear(this.bestBox);
    if (this.mode !== "best") return;
    if (!this.neuralReady) {
      this.bestBox.append(h("div.note.warn", {},
        h("strong", {}, "Training environment missing"),
        " – the network half of the comparison trains with PyTorch (about 3 GB, downloaded once). ",
        h("button.ghost.small", { disabled: busy || Boolean(this.setupJob), onclick: () => this.setupTraining() }, this.setupJob ? "Setting up …" : "Set up training")));
      return;
    }
    this.bestMinutes.disabled = busy;
    this.bestInstall.disabled = busy;
    this.bestBox.append(
      h("label.check", {}, "Training time of the network", this.bestMinutes),
      h("label.check", {}, this.bestInstall, "Install the chosen clone (visible to the DAW)"));
  }

  /** Engine and network: both measured and built, compared on the same settings, the closer one kept. */
  private async runBest() {
    if (!this.info) return;
    clear(this.bestResult);
    clear(this.captureNote);
    this.captureProgress.busy("Loading plugin …");
    let title = "";
    try {
      this.bestJob = await startJob<CloneResult>("best.start", { path: this.info.path, minutes: Number(this.bestMinutes.value), install: this.bestInstall.checked }, (event) => {
        if (event.kind === "stage") {
          title = event.title;
          this.captureProgress.busy(`${title} …`);
        } else if (event.kind === "progress") {
          this.captureProgress.set(event.done, event.total, `${title} – ${event.label && !/^r\d+$/.test(event.label) ? event.label : `${event.done} / ${event.total}`}`);
        }
      });
      this.update();
      const result = await this.bestJob.result;
      this.captureProgress.set(1, 1, `Done – ${result.best?.chosen ?? "clone"} chosen`);
      this.renderResult(result, this.bestResult);
      this.bestResult.scrollIntoView({ behavior: "smooth" });
      this.onLibraryChanged();
    } catch (error) {
      this.captureProgress.hide();
      if (!(error as { cancelled?: boolean }).cancelled) this.bestResult.appendChild(h("div.error-box", {}, (error as Error).message));
    } finally {
      this.bestJob = undefined;
      this.update();
    }
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
    const scroll = this.list.scrollTop;
    clear(this.list);
    const query = this.search.value.trim().toLowerCase();
    const formatOk = (p: PluginEntry) => this.format === "all" || (this.format === "Windows" ? p.source === "yabridge" : p.format === this.format && p.source !== "yabridge");
    // the counts of the chips follow search, format and clones – not the group itself
    const base = this.plugins.filter((p) => (!query || p.name.toLowerCase().includes(query)) && formatOk(p) && !(this.hideClones && p.clone));
    const counts = new Map<string, number>();
    for (const p of base) {
      const group = this.kinds.get(p.path)?.group;
      if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const items = this.group === "all" ? base : base.filter((p) => this.kinds.get(p.path)?.group === this.group);
    this.renderFilters(counts, base.length);
    if (items.length === 0) {
      this.list.appendChild(h("div.empty", {}, this.plugins.length ? "No match" : "No plugins found – choose \"Other file …\""));
      return;
    }
    for (const plugin of items) {
      const row = h("button.plugin-row", { class: plugin === this.selected ? "selected" : "", onclick: () => this.select(plugin) },
        h("span.plugin-name", {}, plugin.name),
        kindBadge(this.kinds.get(plugin.path)),
        h("span.badge", {}, plugin.format),
        plugin.source === "yabridge" && h("span.badge.accent", { title: "Windows plugin via yabridge" }, "Windows"),
        plugin.clone && h("span.badge.muted", {}, "Clone"));
      this.list.appendChild(row);
    }
    this.list.scrollTop = scroll;
  }

  /** Effect groups with counts; the format choice lists the formats present. */
  private renderFilters(counts: Map<string, number>, total: number) {
    clear(this.chips);
    this.chips.appendChild(filterBar(counts, total, this.group, (group) => { this.group = group; this.renderList(); }));
    const formats = (["all", "VST3", "LV2", "Windows"] as const).filter((f) => f === "all" || f === this.format || this.plugins.some((p) => (f === "Windows" ? p.source === "yabridge" : p.format === f)));
    const wanted = formats.join(",");
    if (this.formatSelect.dataset.formats !== wanted) {
      clear(this.formatSelect);
      for (const f of formats) this.formatSelect.appendChild(h("option", { value: f, selected: f === this.format }, f === "all" ? "All formats" : f === "Windows" ? "Windows (yabridge)" : f));
      this.formatSelect.dataset.formats = wanted;
    }
    const known = [...counts.values()].reduce((a, b) => a + b, 0);
    this.pending.textContent = this.kindsLoading && known < total ? `identifying effects … ${known} / ${total}` : "";
  }


  private async pickFile() {
    const path = await open({ directory: true, title: "Choose a plugin bundle (.vst3 or .lv2)" });
    if (typeof path !== "string") return;
    const name = path.split(/[\\/]/).pop()!.replace(/\.(vst3|lv2)$/i, "");
    const entry: PluginEntry = { path, name, format: /\.lv2$/i.test(path) ? "LV2" : "VST3", source: /yabridge/i.test(path) ? "yabridge" : "native", clone: false };
    this.plugins = [entry, ...this.plugins.filter((p) => p.path !== path)];
    this.renderList();
    void this.loadKinds();
    await this.select(entry);
  }

  private async select(plugin: PluginEntry) {
    if (this.captureJob) return;
    this.selected = plugin;
    this.info = undefined;
    // progress and findings belong to the plugin measured before
    this.captureProgress.hide();
    clear(this.captureNote);
    clear(this.bestResult);
    this.renderList();
    clear(this.details);
    this.details.appendChild(h("div.loading", {}, `Loading ${plugin.name} …`));
    this.update();
    try {
      this.info = await call<PluginInfo>("plugins.info", { path: plugin.path });
      // a known effect class has its own exact model; everything else gets the universal clone
      this.mode = this.info.eq ? "eq" : this.info.dynamics ? "dynamics" : this.info.distortion ? "distortion" : this.info.delay ? "delay" : this.info.modulation ? "modulation" : this.info.reverb ? "reverb" : "neural";
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
                : info.modulation
                  ? h("span.badge.good", {}, "Chorus/flanger detected")
                : info.reverb
                  ? h("span.badge.good", {}, "Reverb detected")
                  : h("span.badge.accent", { title: "A network learns the plugin from the measurements – works for any plugin" }, "no known effect class – universal clone")),
    );
  }

  private update() {
    const info = this.info;
    const busy = Boolean(this.captureJob || this.cloneJob || this.bestJob);

    // step 2
    clear(this.modeBox);
    const option = (mode: Mode, label: string, enabled: boolean) =>
      h("button", { class: this.mode === mode ? "active" : "", disabled: !enabled || busy, onclick: () => { this.mode = mode; this.update(); } }, label);
    this.modeBox.append(
      option("eq", "EQ", Boolean(info?.eq)),
      option("dynamics", "Dynamics", Boolean(info?.dynamics)),
      option("distortion", "Distortion", Boolean(info?.distortion)),
      option("delay", "Delay", Boolean(info?.delay)),
      option("modulation", "Modulation", Boolean(info?.modulation)),
      option("reverb", "Reverb", Boolean(info?.reverb)),
      option("neural", "Universal", Boolean(info)),
      option("best", "Engine vs. network", Boolean(info?.engine)),
    );
    this.renderBestOptions(busy);
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
              : this.mode === "modulation" && info.modulation
                ? `${info.modulation.renders} settings of ~${info.modulation.signalSeconds} s test signal each (an impulse, then a click every 40 ms whose echoes trace the LFO, a noise burst) – ` +
                  "every control on its own and in random combinations. The clone is a delay line moved by an LFO: delay, depth, rate and level are read off every setting. Usually takes less than a minute."
              : this.mode === "best" && info.engine
                ? `Measures and builds the clone twice – with the ${info.engine} for this kind of effect and as a universal network – then plays the same ${info.neural.renders} random settings through both ` +
                  "and keeps the one that sounds closer to the original. The engine is ready in a few minutes, the network trains on the graphics card for the time chosen below."
              : this.mode === "reverb" && info.reverb
                ? `${info.reverb.renders} settings of ~${info.reverb.signalSeconds} s test signal each (an impulse and its decay) – every control on its own and in random combinations. Usually takes less than a minute.`
                : `${info.neural.renders} settings of ~${info.neural.signalSeconds} s test signal each (noise, sweeps, level steps, a tone burst, an impulse) with all controls at random – ` +
                  "a network then learns how the plugin sounds at every setting (when building the clone, about 10 minutes on the graphics card). Works for any plugin; " +
                  "long reverb tails, long delays and modulation (LFO) are its weak spots." +
                  (info.neural.skipped > 0 ? ` ${info.neural.skipped} controls beyond the first ${info.neural.controls} stay at their default.` : "");
    this.captureButton.disabled = !info || Boolean(this.cloneJob) || (this.mode === "best" && !this.bestJob && !this.neuralReady);
    this.captureButton.textContent = this.captureJob || this.bestJob ? "Cancel" : this.mode === "best" ? "Measure, build both and compare" : "Start measuring";
    this.captureButton.classList.toggle("danger", Boolean(this.captureJob || this.bestJob));
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
    this.cloneButton.disabled = !this.profile || Boolean(this.captureJob) || Boolean(this.bestJob) || Boolean(this.setupJob) || (this.profile.planner === "neural" && !this.neuralReady);
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

  private renderResult(result: CloneResult, target: HTMLElement = this.result) {
    clear(target);
    // compressors, delays and reverbs report the same numbers; only what was compared differs
    const d = result.kind === "dynamics" ? result.dynamics : result.kind === "delay" || result.kind === "modulation" || result.kind === "reverb" ? result.levels : undefined;
    if (d) {
      const compared = result.kind === "delay" ? "Echo level over time and frequency band deviates"
        : result.kind === "modulation" ? "Echo level and the LFO's movement of the delay deviate"
        : result.kind === "reverb" ? "Decay (level and decay per band) deviates" : "Level curve deviates";
      target.append(
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
        target.appendChild(table);
      }
    }
    const nn = result.neural;
    if (result.kind === "neural" && nn) {
      const pct = (e: number) => `${(e * 100).toFixed(e < 0.1 ? 2 : 1)} %`;
      target.append(
        h("div.verdict", { class: verdictClass(nn.verdict) },
          h("div.verdict-main", {}, nn.verdict),
          h("div.verdict-sub", {}, `The clone's output differs from the original by ${pct(nn.median ?? nn.esr)} of the signal energy in a typical setting` +
            (nn.median !== undefined ? ` (mean ${pct(nn.esr)})` : "") + ` · ${nn.renders} settings checked` +
            (nn.validate !== undefined ? ` · unseen combinations ${pct(nn.validate)}` : "") +
            (nn.outliers ? ` · ${nn.outliers} setting${nn.outliers === 1 ? "" : "s"} off by half the signal or more` : ""))),
        h("ul.model-summary", {}, ...(result.summary ?? []).map((line) => h("li", {}, line)),
          nn.spectralDb && h("li", { title: "Level of third-octave bands in 85 ms frames, compared with the original – ignores the phase, so it judges the sound rather than the waveform" },
            `Sound: the spectrum deviates by ${formatDb(nn.spectralDb.median)} in a typical setting (mean ${formatDb(nn.spectralDb.mean)}) – below about 1 dB the difference is hard to hear`)),
      );
      if (nn.worst.length) {
        const table = h("table.shape-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Largest deviations"), h("th", {}, "Error"))));
        const body = h("tbody");
        for (const w of nn.worst) body.appendChild(h("tr", {}, h("td", {}, w.label), h("td.num", {}, pct(w.esr))));
        table.appendChild(body);
        target.appendChild(table);
      }
    }
    const b = result.best;
    if (result.kind === "best" && b) {
      const pct = (e: number) => `${(e * 100).toFixed(e < 0.1 ? 1 : 0)} %`;
      const table = h("table.shape-table.compare-table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Clone"),
          h("th", { title: "Level of third-octave bands over time against the original (typical setting) – what the ear judges" }, "Sound deviation"),
          h("th", { title: "Error-to-signal ratio, sample by sample (typical setting) – what a waveform comparison sees" }, "Waveform error"),
          h("th", {}, ""))));
      const body = h("tbody");
      for (const c of b.candidates) {
        body.appendChild(h("tr", { class: c.chosen ? "chosen" : "" },
          h("td", {}, c.chosen ? h("strong", {}, `★ ${c.name}`) : c.name),
          h("td.num", {}, formatDb(c.spectralDb.median)),
          h("td.num", {}, pct(c.esr.median)),
          h("td", { class: "muted" }, c.missing.length ? `lacks ${c.missing.join(", ")}` : "")));
      }
      table.appendChild(body);
      target.append(
        h("div.verdict", { class: "neutral" },
          h("div.verdict-main", {}, `${b.chosen[0]!.toUpperCase()}${b.chosen.slice(1)} chosen`),
          h("div.verdict-sub", {}, b.explanation)),
        table,
        h("p.hint", {}, "Both clones were played the same random settings of every control. The sound deviation decides: it ignores the phase, so a reverb or chorus that sounds the same but differs sample by sample is not counted as wrong. " +
          "Both measurements are in the library; building from either one shows its own detailed report."),
      );
    }
    const x = result.distortion;
    if (result.kind === "distortion" && x) {
      target.append(
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
        target.appendChild(table);
      }
    }
    const v = result.verify;
    if (v) {
      target.append(
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
      target.appendChild(table);
      if (v.combined) {
        body.appendChild(h("tr", {}, h("td", {}, `Several bands at once (${v.combined.renders} settings)`), h("td.num", {}, formatDb(v.combined.rmsDb)),
          h("td", {}, h("span.pill", { class: verdictClass(v.combined.verdict) }, v.combined.verdict))));
      }
      if (v.limited) {
        target.appendChild(h("p.hint", {}, `Not reproduced exactly: ${v.limited.labels.join(", ")} (${v.limited.renders} settings, ${formatDb(v.limited.rmsDb)}).`));
      }
    }
    if (result.gui) {
      const g = result.gui;
      target.append(
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
    target.append(
      h("div.result-files", {},
        h("div", {}, h("strong", {}, result.pluginName), h("span.muted", {}, " · VST3 + LV2")),
        result.installed.length > 0
          ? h("div.muted", {}, `Installed: ${result.installed.join(", ")}`)
          : h("div.muted", {}, result.kind === "best"
            ? "Not installed – tick \"Install the chosen clone\" and run the comparison again, or open the folder."
            : "Not installed – tick \"Install after building\" and build again to install."),
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
