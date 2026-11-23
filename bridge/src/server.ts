import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { checkYabridge } from "./yabridge.ts";
import { basename, delimiter, join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import {
  capture,
  CancelledError,
  DEFAULT_PLAN,
  findHost,
  generateTestSignal,
  hostVersion,
  planCaptures,
  pluginInfo,
  type CaptureProgress,
} from "@vst-cloner/capture";
import {
  checkToolchain,
  cloneNeuralProfile,
  esrToDb,
  formatNeuralModel,
  neuralControls,
  neuralPlanner,
  neuralPython,
  neuralRenderCounts,
  neuralReportVerdict,
  neuralVerdict,
  setupNeuralEnvironment,
  cloneBest,
  ENGINE_NAMES,
  modulationPlanner,
  detectModulation,
  cloneDelayProfile,
  cloneDistortionProfile,
  cloneDynamicsProfile,
  cloneReverbProfile,
  delayPlanner,
  delaySurvey,
  delayVerdict,
  detectDelay,
  detectReverb,
  formatDelayModel,
  formatReverbModel,
  planDelay,
  planReverb,
  reverbPlanner,
  reverbVerdict,
  detectDistortion,
  distortionPlanner,
  planDistortion,
  classifyPlugin,
  cloneProfile,
  detectDynamics,
  bandGroups,
  detectEq,
  dynamicsPlanner,
  dynamicsVerdict,
  eqPlanner,
  formatDynamicsModel,
  formatDistortionModel,
  formatModelReport,
  distortionVerdict,
  guiCacheRoot,
  renderSvg,
  planDynamics,
  planEq,
  slugify,
  verdict,
  type CloneStage,
  type GuiModel,
  type LogLevel,
} from "@vst-cloner/clone";
import {
  configPath,
  discoverProviders,
  findProvider,
  listModels,
  loadCatalog,
  loadConfig,
  PRESETS,
  providerFromPreset,
  removeProvider,
  resolveApiKey,
  resolveModel,
  saveConfig,
  storeApiKey,
  deleteApiKey,
  testModel,
  upsertProvider,
  ROLES,
  ROLE_NAMES,
  isRoleName,
  parseModelRef,
} from "@vst-cloner/agent";
import { clonesDir, dataDir, fileSize, profilesDir, scanPlugins } from "./paths.ts";
import { pluginKinds, profileKind } from "./kinds.ts";
import { replayFrame, replayInfo } from "./replay.ts";
import { jobPreview } from "./preview.ts";

// ---- protocol -----------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function send(message: Json): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

interface Job {
  id: string;
  controller: AbortController;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

interface JobContext {
  id: string;
  signal: AbortSignal;
  log: (level: LogLevel | "success" | "error", message: string) => void;
  stage: (stage: string, title: string) => void;
  progress: (done: number, total: number, label?: string) => void;
}

/** Starts a long-running job; events are streamed, the request returns the job id at once. */
function startJob(kind: string, run: (ctx: JobContext) => Promise<unknown>): { job: string } {
  const id = `${kind}-${++jobCounter}`;
  const controller = new AbortController();
  jobs.set(id, { id, controller });

  const event = (data: Json) => send({ type: "event", job: id, time: Date.now(), ...data });
  const ctx: JobContext = {
    id,
    signal: controller.signal,
    log: (level, message) => event({ kind: "log", level, message }),
    stage: (stage, title) => event({ kind: "stage", stage, title }),
    progress: (done, total, label) => event({ kind: "progress", done, total, ...(label ? { label } : {}) }),
  };

  // pictures of an editor capture inside this job reach the app as live previews
  const preview = (src: string, label: string) => event({ kind: "preview", src, label });
  void jobPreview.run(preview, async () => {
    try {
      const result = await run(ctx);
      event({ kind: "done", result: (result ?? null) as Json });
    } catch (error) {
      const cancelled = error instanceof CancelledError || controller.signal.aborted;
      event({ kind: "failed", cancelled, error: cancelled ? "Cancelled" : (error as Error).message });
    } finally {
      jobs.delete(id);
    }
  });

  return { job: id };
}

const str = (params: Json, key: string): string => {
  const value = params[key];
  if (typeof value !== "string" || !value) throw new Error(`Parameter "${key}" is missing`);
  return value;
};

// ---- helpers -------------------------------------------------------------------------------------

const onPath = (exe: string) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => existsSync(join(dir, process.platform === "win32" ? `${exe}.exe` : exe)));

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

interface ProfileSummary {
  path: string;
  file: string;
  bytes: number;
  name: string;
  manufacturer: string;
  format: string;
  createdAt: string;
  renders: number;
  planner: string;
  /** what kind of effect the plugin is (see kinds.ts) and its badge text */
  kind: string;
  kindLabel: string;
  engine: boolean;
  hasModel: boolean;
  verdict?: string;
  rmsDb?: number;
  /** rmsDb as text in the unit of the measurement */
  deviation?: string;
  pluginName?: string;
}

/** Where the editor probe of a profile lies, and the editor model stored in it. */
async function replaySource(path: string): Promise<{ dir: string; model?: GuiModel }> {
  const entries = unzipSync(await readFile(path), { filter: (f) => f.name === "manifest.json" || f.name === "model/gui.json" });
  const manifest = entries["manifest.json"] ? JSON.parse(strFromU8(entries["manifest.json"]!)) : undefined;
  if (!manifest?.id) throw new Error("The profile has no id");
  const model = entries["model/gui.json"] ? (JSON.parse(strFromU8(entries["model/gui.json"]!)) as GuiModel) : undefined;
  return { dir: join(guiCacheRoot(), manifest.id), ...(model ? { model } : {}) };
}

/** PNG from the local cache as data URL (the app shows it without file access). */
async function imageDataUrl(path: string | undefined): Promise<string | undefined> {
  if (!path || !existsSync(path)) return undefined;
  return `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
}

const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const SEGMENT_NAMES: Record<string, string> = {
  silence: "Silence", impulse: "Impulse", logSweep: "Sweep", noise: "Noise", levelSteps: "Level steps", toneBurst: "Tone burst",
};
async function guiResult(gui: { controls: number; comparison?: { similarity: number; colorSimilarity: number; comparePng?: string } } | undefined) {
  if (!gui) return undefined;
  const c = gui.comparison;
  return {
    controls: gui.controls,
    ...(c ? { similarity: c.similarity, colorSimilarity: c.colorSimilarity, ...(c.comparePng ? { comparePng: c.comparePng, preview: await imageDataUrl(c.comparePng) } : {}) } : {}),
  };
}

const PLANNER_NAMES: Record<string, string> = {
  eq: "EQ measurement", dynamics: "Dynamics measurement", distortion: "Distortion measurement", delay: "Delay measurement", modulation: "Modulation measurement", reverb: "Reverb measurement", neural: "Universal measurement", generic: "General measurement",
};
/** Rating of the main number in a report, by the measurement the profile was captured with. */
const VERDICTS: Record<string, (value: number) => string> = { dynamics: dynamicsVerdict, distortion: distortionVerdict, delay: delayVerdict, modulation: delayVerdict, reverb: reverbVerdict, neural: neuralVerdict };
/** The main number of a report as text: dB for the class models, the error share for the universal clone. */
const deviationText = (planner: unknown, value: number) => (planner === "neural" ? `${(value * 100).toFixed(value < 0.1 ? 2 : 1)} % error (${esrToDb(value).toFixed(1)} dB)` : `${value.toFixed(2)} dB`);
const verdictFor = (planner: unknown) => VERDICTS[planner as string] ?? verdict;
const MODEL_FILES = ["model/eq.json", "model/dynamics.json", "model/distortion.json", "model/delay.json", "model/reverb.json", "model/neural.json"];
const MODES = ["eq", "dynamics", "distortion", "delay", "modulation", "reverb", "neural", "generic"] as const;
type Mode = (typeof MODES)[number];
const PLANNERS = { eq: eqPlanner, dynamics: dynamicsPlanner, distortion: distortionPlanner, delay: delayPlanner, modulation: modulationPlanner, reverb: reverbPlanner, neural: neuralPlanner };
const PLAN_NOTES: Record<Mode, string> = {
  eq: "EQ plan: every filter shape at several frequencies, gains and Q values",
  dynamics: "Compressor plan: every control on its own (dense near the ends) + random combinations as a cross-check, test signal with level staircase, bursts and long pauses",
  distortion: "Distortion plan: every control on its own + random combinations as a cross-check, test signal with sine level staircases at several frequencies, noise and a quiet sweep",
  delay: "Delay plan: every control on its own + random combinations as a cross-check, test signal with an impulse, long silence and a noise burst",
  modulation: "Modulation plan: every control on its own + random combinations as a cross-check, test signal with an impulse, a train of clicks (the LFO) and a noise burst",
  reverb: "Reverb plan: every control on its own + random combinations as a cross-check, test signal with an impulse and its decay",
  neural: "Universal plan: all controls at random in every setting (the network learns how they act together), test signal with noise, sweeps, level steps, a tone burst and an impulse",
  generic: "General plan: every parameter on its own + random combinations",
};

/** Everything the library shows about a profile: plugin, capture, signal, model, editor layout. */
async function profileDetails(path: string) {
  const entries = unzipSync(await readFile(path), { filter: (f) => f.name.endsWith(".json") && !f.name.startsWith("captures/") });
  const json = (name: string) => (entries[name] ? JSON.parse(strFromU8(entries[name]!)) : undefined);
  const manifest = json("manifest.json");
  const parameters = (json("parameters.json")?.parameters ?? []) as { index: number; name: string; default: number; value?: number; texts?: { value: number; text: string }[]; discrete: boolean; label?: string }[];
  const captures = (json("captures.json")?.renders ?? []) as { kind: string; purpose?: string; params: { index: number }[] }[];
  const signals = json("test-signals.json");
  const report = json("report.json");
  const planner = manifest?.capture?.plan?.planner ?? "generic";

  const measured = new Set<number>(manifest?.capture?.plan?.selectedParameters ?? captures.flatMap((r) => r.params.map((p) => p.index)));
  // value text: interpolated between numeric texts (with their decimals), otherwise the nearest text
  const textAt = (p: (typeof parameters)[number], value: number) => {
    const texts = [...(p.texts ?? [])].sort((a, b) => a.value - b.value);
    if (!texts.length) return value.toFixed(2);
    const number = (t: string) => /^\s*[+-]?\d+(?:[.,]\d+)?/.exec(t)?.[0];
    const upper = texts.findIndex((t) => t.value >= value);
    const a = texts[Math.max(0, upper - 1)]!, b = texts[upper < 0 ? texts.length - 1 : upper]!;
    const na = number(a.text), nb = number(b.text);
    if (p.discrete || na === undefined || nb === undefined || b.value === a.value) {
      return (Math.abs(a.value - value) <= Math.abs(b.value - value) ? a : b).text;
    }
    const decimals = (na.split(/[.,]/)[1] ?? "").length;
    const v = Number(na.replace(",", ".")) + ((value - a.value) / (b.value - a.value)) * (Number(nb.replace(",", ".")) - Number(na.replace(",", ".")));
    const unit = a.text.slice(na.length);
    return `${v.toFixed(decimals)}${unit}`;
  };
  const count = (f: (r: (typeof captures)[number]) => boolean) => captures.filter(f).length;

  let model: { kind: string; summary: string[] } | undefined;
  try {
    const eq = json("model/eq.json"), dyn = json("model/dynamics.json"), dist = json("model/distortion.json");
    const delay = json("model/delay.json"), reverb = json("model/reverb.json"), neural = json("model/neural.json");
    if (neural) model = { kind: "neural", summary: formatNeuralModel(neural) };
    else if (reverb) model = { kind: "reverb", summary: formatReverbModel(reverb) };
    else if (delay) model = { kind: "delay", summary: formatDelayModel(delay) };
    else if (dist) model = { kind: "distortion", summary: formatDistortionModel(dist) };
    else if (dyn) model = { kind: "dynamics", summary: formatDynamicsModel(dyn) };
    else if (eq) model = { kind: "eq", summary: formatModelReport(eq) };
  } catch {
    model = undefined;
  }
  const gui = json("model/gui.json");
  const cache = manifest?.id ? join(guiCacheRoot(), manifest.id) : undefined;
  const rms = report?.verify?.overall?.rmsDb ?? report?.verify?.overall?.total ?? report?.verify?.esr;

  return {
    path,
    file: basename(path),
    bytes: await fileSize(path),
    plugin: {
      name: manifest?.plugin?.name ?? basename(path),
      manufacturer: manifest?.plugin?.manufacturer ?? "",
      version: manifest?.plugin?.version ?? "",
      format: manifest?.plugin?.format ?? "",
      category: manifest?.plugin?.category ?? "",
      file: manifest?.plugin?.file?.name ?? "",
      channels: `${manifest?.plugin?.mainInputChannels ?? "?"} → ${manifest?.plugin?.mainOutputChannels ?? "?"}`,
      latency: manifest?.plugin?.latencySamples ?? 0,
      parameters: parameters.length,
    },
    capture: {
      createdAt: manifest?.createdAt ?? "",
      planner,
      plannerName: PLANNER_NAMES[planner] ?? planner,
      sampleRate: manifest?.capture?.sampleRate ?? 0,
      blockSize: manifest?.capture?.blockSize ?? 0,
      host: `${manifest?.capture?.host?.name ?? ""} ${manifest?.capture?.host?.version ?? ""}`.trim(),
      os: manifest?.capture?.os ?? "",
      renders: captures.length,
      sweeps: count((r) => r.kind === "sweep"),
      random: count((r) => r.kind === "random"),
      train: count((r) => r.purpose === "train"),
      validate: count((r) => r.purpose === "validate"),
      notes: manifest?.notes ?? "",
    },
    signal: signals
      ? {
          seconds: signals.length / signals.sampleRate,
          segments: (signals.segments as { id: string; kind: string; length: number }[])
            .filter((s) => s.kind !== "silence")
            .map((s) => ({ id: s.id, kind: SEGMENT_NAMES[s.kind] ?? s.kind, seconds: s.length / signals.sampleRate })),
        }
      : undefined,
    parameters: parameters.filter((p) => measured.has(p.index)).map((p) => ({
      name: p.name,
      from: textAt(p, 0),
      to: textAt(p, 1),
      initial: textAt(p, p.value ?? p.default),
      discrete: p.discrete,
    })),
    model,
    verdict: rms !== undefined ? { value: rms, text: verdictFor(planner)(rms), deviation: deviationText(planner, rms), pluginName: report?.pluginName } : undefined,
    gui: gui
      ? {
          layout: svgDataUrl(renderSvg(gui)),
          controls: gui.controls?.length ?? 0,
          width: gui.width,
          height: gui.height,
          compare: cache ? await imageDataUrl(join(cache, "compare.png")) : undefined,
        }
      : undefined,
  };
}

/** Reads only the small JSON documents of a profile (fast, no checksum verification). */
async function summarizeProfile(path: string): Promise<ProfileSummary> {
  const entries = unzipSync(await readFile(path), { filter: (f) => f.name.endsWith(".json") && !f.name.startsWith("captures/") });
  const json = (name: string) => (entries[name] ? JSON.parse(strFromU8(entries[name]!)) : undefined);
  const manifest = json("manifest.json");
  const captures = json("captures.json");
  const report = json("report.json");
  const kind = profileKind(manifest, json("parameters.json")?.parameters ?? []);
  // EQ/compressor: rms deviation (dB); distortion: combined error of its characteristics
  // (the universal clone is judged by its typical setting, the median, where the report has one)
  const rms = (report?.verify?.overall?.rmsDb ?? report?.verify?.overall?.total ?? report?.verify?.median ?? report?.verify?.esr) as number | undefined;
  return {
    path,
    file: basename(path),
    bytes: await fileSize(path),
    name: manifest?.plugin?.name ?? basename(path),
    manufacturer: manifest?.plugin?.manufacturer ?? "",
    format: manifest?.plugin?.format ?? "",
    createdAt: manifest?.createdAt ?? "",
    renders: captures?.renders?.length ?? 0,
    planner: manifest?.capture?.plan?.planner ?? "generic",
    kind: kind.group,
    kindLabel: kind.label,
    engine: kind.engine,
    hasModel: MODEL_FILES.some((file) => entries[file]),
    ...(rms !== undefined
      ? { rmsDb: rms, verdict: verdictFor(manifest?.capture?.plan?.planner)(rms), deviation: deviationText(manifest?.capture?.plan?.planner, rms) }
      : {}),
    ...(report?.pluginName ? { pluginName: report.pluginName } : {}),
  };
}

/** Titles of the steps before the planned renders; the app shows them while nothing can be counted yet. */
const CAPTURE_STEPS = {
  repeat: "Checking repeatability",
  probe: "Looking for a working point",
  survey: "Looking for switch positions",
} as const;

function captureMessage(event: CaptureProgress, names: Map<number, string>): string | undefined {
  switch (event.stage) {
    case "info": return `Loading plugin: ${event.plugin}`;
    case "begin": return `${CAPTURE_STEPS[event.step]} – ${event.renders} preliminary renders`;
    case "repeat":
      return event.repeatable
        ? "The plugin gives the same signal for the same setting"
        : "Not repeatable: the plugin keeps a state between renders – every setting is measured with a fresh instance (takes longer)";
    case "probe":
      return `Working point chosen (${event.chosen + 1} of ${event.candidates})` +
        (event.workingPoint.length ? `: ${event.workingPoint.map((v) => `${names.get(v.index) ?? `#${v.index}`} = ${v.value.toFixed(2)}`).join(", ")}` : "");
    case "survey":
      return event.stepped.length
        ? `Detected as switches: ${event.stepped.map((s) => `${names.get(s.index) ?? `#${s.index}`} (${s.positions} positions)`).join(", ")}`
        : "No hidden switches found";
    case "retry": return `Repeating render: ${event.reason}`;
    case "settle": return `The plugin settles after loading (switch-on click) – pre-roll extended to ${event.prerollSeconds.toFixed(1)} s`;
    case "plan": return `${event.parameters} parameters found, ${event.selected} measured – ${event.renders} settings`;
    case "write": return `Saving profile: ${event.path}`;
    default: return undefined;
  }
}

const STAGE_TITLES: Record<CloneStage, string> = {
  analyse: "Analysis",
  gui: "Capture editor",
  build: "Plugin build",
  verify: "Comparison with the original",
  "gui-verify": "Editor comparison",
  save: "Save",
};

// ---- methods -------------------------------------------------------------------------------------

const methods: Record<string, (params: Json) => Promise<unknown> | unknown> = {
  ping: () => ({ pong: true }),

  async "app.info"() {
    let host: { found: boolean; path?: string; version?: string } = { found: false };
    try {
      const path = findHost();
      host = { found: true, path, version: await hostVersion(path) };
    } catch {
      // reported below
    }
    const toolchain = checkToolchain();
    const found = (id: string) => toolchain.some((t) => t.id === id && t.found);
    return {
      version: "0.1.0",
      platform: process.platform,
      node: process.version,
      dataDir: dataDir(),
      profilesDir: profilesDir(),
      clonesDir: clonesDir(),
      llmConfig: configPath(),
      host,
      tools: { cmake: found("cmake"), compiler: found("compiler") },
      toolchain,
      // Python with PyTorch for the universal clone
      neural: { python: neuralPython() ?? null },
    };
  },

  /** The tools a clone is built with, with install hints (checked again after installing). */
  "system.toolchain": () => checkToolchain(),

  "plugins.scan": () => scanPlugins(),

  /** What kind of effect each plugin is (cached per bundle; loading a plugin takes ~40 ms natively). */
  "plugins.kinds": (params) => pluginKinds(Array.isArray(params.paths) ? params.paths.filter((p): p is string => typeof p === "string") : []),

  /** Whether a Windows plugin already runs through yabridge (one second of audio through it). */
  "plugins.yabridge": (params) => checkYabridge(str(params, "path")),

  async "plugins.info"(params) {
    const path = str(params, "path");
    const info = await pluginInfo(path);
    // one classification for app and batch: instruments, dynamic EQs, multiband compressors … get no class
    const effectClass = classifyPlugin(info).effectClass;
    let eq: { bands: number; shapes: string[]; renders: number; groups: number; fixedBands: number; sliders: number } | undefined;
    try {
      if (effectClass !== "eq") throw new Error("not an EQ");
      const mapping = detectEq(info.parameters);
      const groups = bandGroups(mapping);
      eq = {
        bands: mapping.bands.length,
        shapes: [...new Set(groups.flatMap((g) => g.shapes?.map((s) => s.label) ?? []))],
        renders: planEq(info.parameters, { seed: 1 }).renders.length,
        groups: groups.length,
        // bands without a shape control, and among them the sliders of a graphic EQ (no frequency control either)
        fixedBands: mapping.bands.filter((b) => !groups[b.group ?? 0]?.shapes?.length).length,
        sliders: mapping.bands.filter((b) => b.params.frequency === undefined).length,
      };
    } catch {
      eq = undefined;
    }
    let dynamics: { roles: string[]; renders: number } | undefined;
    if (effectClass === "dynamics") {
      try {
        const mapping = detectDynamics(info.parameters, info.plugin.category, info.plugin.name);
        dynamics = { roles: Object.keys(mapping.roles), renders: planDynamics(info.parameters, { ...DEFAULT_PLAN }).renders.length };
      } catch {
        dynamics = undefined;
      }
    }
    let distortion: { roles: string[]; renders: number; signalSeconds: number } | undefined;
    if (effectClass === "distortion") {
      try {
        const mapping = detectDistortion(info.parameters, info.plugin.category, info.plugin.name);
        distortion = {
          roles: Object.keys(mapping.roles),
          renders: planDistortion(info.parameters, { ...DEFAULT_PLAN }, info.plugin.category, info.plugin.name).renders.length,
          signalSeconds: Math.round(generateTestSignal({ sampleRate: 1000, channels: 1, preset: "distortion" }).set.length / 1000),
        };
      } catch {
        distortion = undefined;
      }
    }
    const signalSeconds = (preset: "delay" | "modulation" | "reverb") => Math.round(generateTestSignal({ sampleRate: 1000, channels: 1, preset }).set.length / 1000);
    let delay: { roles: string[]; renders: number; signalSeconds: number; survey: number } | undefined;
    if (effectClass === "delay") {
      try {
        const plan = planDelay(info.parameters, { ...DEFAULT_PLAN }, info.plugin.category, info.plugin.name);
        // renders of the search for hidden switches; every switch found adds renders to the plan
        const survey = delaySurvey(info.parameters, { ...DEFAULT_PLAN }, info.plugin.category, info.plugin.name)?.renders.length ?? 0;
        delay = { roles: Object.keys(plan.mapping.roles), renders: plan.renders.length, signalSeconds: signalSeconds("delay"), survey };
      } catch {
        delay = undefined;
      }
    }
    let modulation: { renders: number; signalSeconds: number } | undefined;
    if (effectClass === "modulation") {
      try {
        const plan = modulationPlanner.plan(info, { ...DEFAULT_PLAN });
        modulation = { renders: plan.renders.length, signalSeconds: signalSeconds("modulation") };
      } catch {
        modulation = undefined;
      }
    }
    let reverb: { renders: number; signalSeconds: number } | undefined;
    if (effectClass === "reverb") {
      try {
        detectReverb(info.parameters, info.plugin.category, info.plugin.name);
        reverb = { renders: planReverb(info.parameters, { ...DEFAULT_PLAN }, info.plugin.category, info.plugin.name).renders.length, signalSeconds: signalSeconds("reverb") };
      } catch {
        reverb = undefined;
      }
    }
    // a class engine to compare with the network: the plugin's class, or the modulation engine for tremolos and phasers
    let engineClass = effectClass;
    if (!engineClass) {
      try {
        detectModulation(info.parameters, info.plugin.category, info.plugin.name);
        engineClass = "modulation";
      } catch {
        // no engine
      }
    }
    // the universal clone works for every plugin: how many settings its plan measures
    const controls = neuralControls(info.parameters);
    const counts = neuralRenderCounts(controls.length);
    const neural = {
      controls: controls.length,
      skipped: Math.max(0, info.parameters.filter((p) => p.automatable && !p.meta).length - controls.length),
      renders: 1 + counts.train + counts.validate,
      signalSeconds: Math.round(generateTestSignal({ sampleRate: 1000, channels: 1, preset: "neural" }).set.length / 1000),
    };
    let genericRenders: number;
    try {
      genericRenders = planCaptures(info.parameters, { ...DEFAULT_PLAN, maxRenders: Number.MAX_SAFE_INTEGER }).renders.length;
    } catch {
      genericRenders = 0;
    }
    return {
      path,
      name: info.plugin.name,
      manufacturer: info.plugin.manufacturer,
      version: info.plugin.version,
      format: info.plugin.format,
      category: info.plugin.category,
      inputs: info.mainInputChannels,
      outputs: info.mainOutputChannels,
      latency: info.latencySamples,
      parameters: info.parameters.length,
      eq,
      dynamics,
      distortion,
      delay,
      modulation,
      reverb,
      neural,
      genericRenders,
      // a class with an engine of its own: the app can build both clones and keep the better one
      ...(engineClass && ENGINE_NAMES[engineClass] ? { engine: ENGINE_NAMES[engineClass] } : {}),
    };
  },

  "capture.start"(params) {
    const plugin = str(params, "path");
    const mode: Mode = MODES.find((m) => m === params.mode) ?? "eq";
    return startJob("capture", async (ctx) => {
      ctx.stage("capture", "Measure");
      await mkdir(profilesDir(), { recursive: true });
      const info = await pluginInfo(plugin, { signal: ctx.signal });
      const output = join(profilesDir(), `${slugify(info.plugin.name)}-${timestamp()}.vcprofile`);
      ctx.log("info", PLAN_NOTES[mode]);
      const names = new Map(info.parameters.map((p) => [p.index, p.name]));
      let isolated = false, retries = 0;
      let stepped: { name: string; positions: number }[] = [];

      const started = Date.now();
      const profile = await capture({
        plugin,
        output,
        sampleRate: 48000,
        blockSize: 512,
        channels: 2,
        prerollSeconds: 0.5,
        tailSeconds: mode === "eq" ? 0.25 : mode === "neural" ? 0.5 : 2,
        plan: { ...DEFAULT_PLAN },
        ...(mode === "generic" ? {} : { planner: PLANNERS[mode] }),
        signal: ctx.signal,
        onProgress: (event) => {
          if (event.stage === "render") ctx.progress(event.done, event.total, event.id);
          else if (event.stage === "step") ctx.progress(Math.min(event.done, event.total), event.total, CAPTURE_STEPS[event.step]);
          else if (event.stage === "begin") ctx.stage(event.step, CAPTURE_STEPS[event.step]);
          else if (event.stage === "plan") ctx.stage("render", "Measuring settings");
          else if (event.stage === "repeat") isolated = !event.repeatable;
          else if (event.stage === "survey") stepped = event.stepped.map((s) => ({ name: names.get(s.index) ?? `#${s.index}`, positions: s.positions }));
          else if (event.stage === "retry") retries++;
          const message = captureMessage(event, names);
          if (message) ctx.log(event.stage === "retry" || (event.stage === "repeat" && !event.repeatable) ? "warn" : "info", message);
        },
      });
      const bytes = await fileSize(output);
      ctx.log("success", `${profile.captures.renders.length} settings measured in ${((Date.now() - started) / 1000).toFixed(1)} s (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
      return { profile: output, renders: profile.captures.renders.length, bytes, name: info.plugin.name, isolated, stepped, retries };
    });
  },

  async "profiles.list"() {
    await mkdir(profilesDir(), { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(profilesDir())).filter((f) => f.endsWith(".vcprofile"));
    const result: ProfileSummary[] = [];
    for (const file of files) {
      try {
        result.push(await summarizeProfile(join(profilesDir(), file)));
      } catch {
        // skip unreadable files
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  "profiles.summary": (params) => summarizeProfile(str(params, "path")),

  "profiles.details": (params) => profileDetails(str(params, "path")),

  /** Replay of the editor recognition of a profile: segments and recognised elements (frames: gui.frame). */
  async "gui.replay"(params) {
    const { dir, model } = await replaySource(str(params, "profile"));
    return replayInfo(dir, model);
  },

  async "gui.frame"(params) {
    const { dir } = await replaySource(str(params, "profile"));
    return { src: await replayFrame(dir, Number(params.segment) || 0, Number(params.index) || 0) };
  },

  async "profiles.import"(params) {
    const source = str(params, "path");
    await mkdir(profilesDir(), { recursive: true });
    const target = join(profilesDir(), basename(source));
    if (existsSync(target)) throw new Error(`The library already contains ${basename(source)}`);
    await summarizeProfile(source);
    await copyFile(source, target);
    return { path: target };
  },

  async "profiles.export"(params) {
    await copyFile(str(params, "path"), str(params, "target"));
    return { path: params.target };
  },

  async "profiles.delete"(params) {
    const path = str(params, "path");
    if (!path.startsWith(profilesDir())) throw new Error("Only profiles in the library can be deleted");
    await rm(path);
    return {};
  },

  "clone.start"(params) {
    const profilePath = str(params, "profile");
    const install = params.install === true;
    const refit = params.refit === true;
    // rebuild the editor of the original unless switched off (needs the original plugin once);
    // refitGui captures it again instead of using the layout stored in the profile
    const refitGui = params.refitGui === true;
    const gui = params.gui !== false || refitGui;
    const pluginPath = typeof params.plugin === "string" && params.plugin ? params.plugin : undefined;
    return startJob("clone", async (ctx) => {
      const summary = await summarizeProfile(profilePath);
      const pluginName = `${summary.name} Clone`;
      if (summary.planner === "neural") {
        const result = await cloneNeuralProfile({
          profilePath,
          outputDir: join(clonesDir(), slugify(pluginName)),
          pluginName,
          ...(install ? { install: true } : {}),
          ...(refit ? { refit: true } : {}),
          gui,
          ...(refitGui ? { refitGui: true } : {}),
          ...(pluginPath ? { pluginPath } : {}),
          ...(typeof params.minutes === "number" ? { minutes: params.minutes } : {}),
          signal: ctx.signal,
          onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
          onProgress: (done, total, label) => ctx.progress(done, total, label),
          log: (level, message) => ctx.log(level, message),
        });
        const v = result.verify;
        if (v) ctx.log("success", `Clone ready – typical setting ${deviationText("neural", v.median)} (${neuralReportVerdict(v)})`);
        return {
          kind: "neural",
          pluginName,
          vst3: result.build.vst3,
          lv2: result.build.lv2,
          installed: result.build.installed,
          shapes: [],
          summary: formatNeuralModel(result.model),
          neural: v
            ? {
                esr: v.esr,
                median: v.median,
                outliers: v.outliers,
                ...(v.spectralDb ? { spectralDb: v.spectralDb } : {}),
                ...(v.validate !== undefined ? { validate: v.validate } : {}),
                worst: v.worst,
                verdict: neuralReportVerdict(v),
                renders: v.renders,
              }
            : undefined,
          gui: await guiResult(result.gui),
        };
      }
      if (summary.planner === "distortion") {
        const result = await cloneDistortionProfile({
          profilePath,
          outputDir: join(clonesDir(), slugify(pluginName)),
          pluginName,
          ...(install ? { install: true } : {}),
          ...(refit ? { refit: true } : {}),
          gui,
          ...(refitGui ? { refitGui: true } : {}),
          ...(pluginPath ? { pluginPath } : {}),
          signal: ctx.signal,
          onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
          onProgress: (done, total, label) => ctx.progress(done, total, label),
          log: (level, message) => ctx.log(level, message),
        });
        const v = result.verify;
        if (v) ctx.log("success", `Clone ready – deviation from the original ${v.overall.total.toFixed(2)} (${distortionVerdict(v.overall.total)})`);
        return {
          kind: "distortion",
          pluginName,
          vst3: result.build.vst3,
          lv2: result.build.lv2,
          installed: result.build.installed,
          shapes: [],
          summary: formatDistortionModel(result.model),
          distortion: v
            ? {
                overall: v.overall,
                ...(v.validate ? { validate: v.validate } : {}),
                esrDb: v.esrDb,
                worst: v.worst,
                verdict: distortionVerdict(v.overall.total),
                renders: v.renders,
              }
            : undefined,
          gui: await guiResult(result.gui),
        };
      }
      if (summary.planner === "delay" || summary.planner === "modulation" || summary.planner === "reverb") {
        // same shape of result as a compressor: level deviation in dB, overall and on unknown combinations
        const kind = summary.planner;
        const options = {
          profilePath,
          outputDir: join(clonesDir(), slugify(pluginName)),
          pluginName,
          ...(install ? { install: true } : {}),
          ...(refit ? { refit: true } : {}),
          signal: ctx.signal,
          onStage: (stage: CloneStage) => ctx.stage(stage, STAGE_TITLES[stage]),
          onProgress: (done: number, total: number, label: string) => ctx.progress(done, total, label),
          log: (level: LogLevel, message: string) => ctx.log(level, message),
        };
        let v, modelSummary: string[], measured: boolean;
        let build;
        if (kind === "delay" || kind === "modulation") {
          const result = await cloneDelayProfile(options);
          ({ verify: v, build } = result);
          modelSummary = formatDelayModel(result.model);
          measured = result.model.report.echoes > 0;
        } else {
          const result = await cloneReverbProfile(options);
          ({ verify: v, build } = result);
          modelSummary = formatReverbModel(result.model);
          measured = Boolean(result.model.report.tail);
        }
        // nothing to hear in the base render: the small error says nothing about the effect
        const judged = !v ? "" : measured ? VERDICTS[kind]!(v.overall.rmsDb) : kind === "reverb" ? "no reverb tail measured" : "no echo measured";
        if (v) ctx.log(measured ? "success" : "warn", `Clone ready – deviation from the original ${v.overall.rmsDb.toFixed(2)} dB (${judged})`);
        return {
          kind,
          pluginName,
          vst3: build.vst3,
          lv2: build.lv2,
          installed: build.installed,
          shapes: [],
          summary: modelSummary,
          levels: v ? { overall: v.overall, ...(v.validate ? { validate: v.validate } : {}), worst: v.worst, verdict: judged, renders: v.renders } : undefined,
        };
      }
      if (summary.planner === "dynamics") {
        const result = await cloneDynamicsProfile({
          profilePath,
          outputDir: join(clonesDir(), slugify(pluginName)),
          pluginName,
          ...(install ? { install: true } : {}),
          ...(refit ? { refit: true } : {}),
          gui,
          ...(refitGui ? { refitGui: true } : {}),
          ...(pluginPath ? { pluginPath } : {}),
          signal: ctx.signal,
          onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
          onProgress: (done, total, label) => ctx.progress(done, total, label),
          log: (level, message) => ctx.log(level, message),
        });
        const v = result.verify;
        if (v) ctx.log("success", `Clone ready – deviation from the original ${v.overall.rmsDb.toFixed(2)} dB (${dynamicsVerdict(v.overall.rmsDb)})`);
        return {
          kind: "dynamics",
          pluginName,
          vst3: result.build.vst3,
          lv2: result.build.lv2,
          installed: result.build.installed,
          shapes: [],
          summary: formatDynamicsModel(result.model),
          dynamics: v
            ? {
                overall: v.overall,
                ...(v.validate ? { validate: v.validate } : {}),
                worst: v.worst,
                verdict: dynamicsVerdict(v.overall.rmsDb),
                renders: v.renders,
              }
            : undefined,
          gui: result.gui
            ? {
                controls: result.gui.controls,
                ...(result.gui.comparison
                  ? { similarity: result.gui.comparison.similarity, colorSimilarity: result.gui.comparison.colorSimilarity, comparePng: result.gui.comparison.comparePng,
                    preview: await imageDataUrl(result.gui.comparison.comparePng) }
                  : {}),
              }
            : undefined,
        };
      }
      const result = await cloneProfile({
        profilePath,
        outputDir: join(clonesDir(), slugify(pluginName)),
        pluginName,
        install,
        refit,
        gui,
        ...(refitGui ? { refitGui: true } : {}),
        ...(pluginPath ? { pluginPath } : {}),
        signal: ctx.signal,
        onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
        onProgress: (done, total, label) => ctx.progress(done, total, label),
        log: (level, message) => ctx.log(level, message),
      });
      const overall = result.verify?.overall;
      if (overall) ctx.log("success", `Clone ready – deviation from the original ${overall.rmsDb.toFixed(2)} dB (${verdict(overall.rmsDb)})`);
      return {
        kind: "eq",
        pluginName,
        vst3: result.build.vst3,
        lv2: result.build.lv2,
        installed: result.build.installed,
        shapes: result.model.report.shapes.map((s) => ({
          label: s.label,
          kind: s.kind,
          supported: Boolean(s.fit),
          note: s.note,
          check: (s.validate ?? s.train)?.rmsDb,
        })),
        gui: result.gui
          ? {
              controls: result.gui.controls,
              ...(result.gui.comparison
                ? {
                    similarity: result.gui.comparison.similarity,
                    colorSimilarity: result.gui.comparison.colorSimilarity,
                    comparePng: result.gui.comparison.comparePng,
                    preview: await imageDataUrl(result.gui.comparison.comparePng),
                  }
                : {}),
            }
          : undefined,
        verify: result.verify
          ? {
              overall: result.verify.overall,
              limited: result.verify.limited,
              ...(result.verify.combined ? { combined: { ...result.verify.combined, verdict: verdict(result.verify.combined.rmsDb) } } : {}),
              shapes: result.verify.shapes.map((s) => ({ ...s, verdict: verdict(s.rmsDb) })),
              verdict: verdict(result.verify.overall.rmsDb),
            }
          : undefined,
      };
    });
  },

  "job.cancel"(params) {
    const job = jobs.get(str(params, "job"));
    job?.controller.abort();
    return { cancelled: Boolean(job) };
  },

  // ---- language models ----

  /** Clones a plugin with the engine of its class and as a network, compares both and keeps the better one. */
  "best.start"(params) {
    const plugin = str(params, "path");
    const install = params.install === true;
    const minutes = typeof params.minutes === "number" ? params.minutes : undefined;
    return startJob("best", async (ctx) => {
      const info = await pluginInfo(plugin, { signal: ctx.signal });
      const pluginName = `${info.plugin.name} Clone`;
      const result = await cloneBest({
        plugin,
        outputDir: join(clonesDir(), slugify(pluginName)),
        profileDir: profilesDir(),
        profileSuffix: `-${timestamp()}`,
        ...(minutes ? { minutes } : {}),
        install,
        signal: ctx.signal,
        log: (level, message) => ctx.log(level, message),
        onStep: (step, title) => ctx.stage(step, title),
        onProgress: (done, total, label) => ctx.progress(done, total, label),
      });
      ctx.log("success", `Clone ready – ${result.best.name} chosen`);
      return {
        kind: "best",
        pluginName,
        vst3: result.vst3,
        lv2: result.lv2,
        installed: result.installed,
        shapes: [],
        best: {
          chosen: result.best.name,
          explanation: result.explanation,
          profiles: result.profiles,
          candidates: result.results.map((r) => ({ name: r.name, spectralDb: r.spectralDb, esr: r.esr, missing: r.missing, chosen: r === result.best })),
        },
      };
    });
  },

  async "llm.status"() {
    const config = await loadConfig();
    const providers = [];
    for (const p of config.providers) {
      let key: string;
      if (p.local) key = "local";
      else {
        try {
          key = (await resolveApiKey(p)).source;
        } catch {
          key = "error";
        }
      }
      providers.push({ id: p.id, name: p.name, local: p.local, baseURL: p.baseURL, key });
    }
    const discovered = await discoverProviders();
    return {
      providers,
      roles: ROLE_NAMES.map((role) => ({ role, description: ROLES[role].description, model: config.roles[role] ?? null })),
      discovered,
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, description: p.description, local: p.local, needsBaseURL: id === "custom" })),
    };
  },

  async "llm.add"(params) {
    const provider = providerFromPreset(str(params, "preset"), {
      ...(typeof params.id === "string" && params.id ? { id: params.id } : {}),
      ...(typeof params.baseURL === "string" && params.baseURL ? { baseURL: params.baseURL } : {}),
    });
    await saveConfig(upsertProvider(await loadConfig(), provider));
    return { id: provider.id };
  },

  async "llm.remove"(params) {
    const id = str(params, "provider");
    await saveConfig(removeProvider(await loadConfig(), id));
    await deleteApiKey(id).catch(() => false);
    return {};
  },

  async "llm.setKey"(params) {
    const config = await loadConfig();
    const provider = findProvider(config, str(params, "provider"));
    const key = str(params, "key").trim();
    await storeApiKey(provider.id, key);
    const models = await listModels(provider, key);
    return { models: models.length };
  },

  async "llm.models"(params) {
    const config = await loadConfig();
    const provider = findProvider(config, str(params, "provider"));
    const key = await resolveApiKey(provider);
    await loadCatalog();
    return listModels(provider, key.key);
  },

  async "llm.setRole"(params) {
    const role = str(params, "role");
    if (!isRoleName(role)) throw new Error(`Unknown role ${role}`);
    const config = await loadConfig();
    const ref = params.model === null ? null : str(params, "model");
    if (ref === null) delete config.roles[role];
    else {
      findProvider(config, parseModelRef(ref).providerId);
      config.roles[role] = ref;
    }
    await saveConfig(config);
    return {};
  },

  /** Creates the Python environment with PyTorch that the universal clone trains with (several GB). */
  "neural.setup"() {
    return startJob("neural-setup", async (ctx) => {
      ctx.stage("setup", "Setting up training");
      const python = await setupNeuralEnvironment((level, message) => ctx.log(level, message), ctx.signal);
      ctx.log("success", `Training environment ready: ${python}`);
      return { python };
    });
  },

  "llm.test"(params) {
    const ref = str(params, "model");
    return startJob("llm-test", async (ctx) => {
      ctx.stage("test", `Test: ${ref}`);
      const target = await resolveModel(await loadConfig(), ref, { detailed: true });
      ctx.log("info", "Three short checks: text answer, tool call, structured output");
      const report = await testModel(target);
      for (const r of report.results) ctx.log(r.ok ? "success" : "warn", `${r.name}: ${r.detail} (${(r.milliseconds / 1000).toFixed(1)} s)`);
      return report;
    });
  },
};

// ---- main loop -----------------------------------------------------------------------------------

export function serve(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      send({ type: "response", id: null, ok: false, error: "invalid JSON" });
      return;
    }
    const { id } = request;
    const method = typeof request.method === "string" ? methods[request.method] : undefined;
    if (!method) {
      send({ type: "response", id, ok: false, error: `unknown method ${String(request.method)}` });
      return;
    }
    try {
      const result = await method((request.params ?? {}) as Json);
      send({ type: "response", id, ok: true, result: result ?? null });
    } catch (error) {
      send({ type: "response", id, ok: false, error: (error as Error).message });
    }
  });
  rl.on("close", () => {
    for (const job of jobs.values()) job.controller.abort();
    setTimeout(() => process.exit(0), 200);
  });
  send({ type: "ready", version: "0.1.0" });
}
