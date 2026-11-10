import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
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
  cloneDistortionProfile,
  cloneDynamicsProfile,
  detectDistortion,
  distortionPlanner,
  planDistortion,
  cloneProfile,
  detectDynamics,
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

  void (async () => {
    try {
      const result = await run(ctx);
      event({ kind: "done", result: (result ?? null) as Json });
    } catch (error) {
      const cancelled = error instanceof CancelledError || controller.signal.aborted;
      event({ kind: "failed", cancelled, error: cancelled ? "Abgebrochen" : (error as Error).message });
    } finally {
      jobs.delete(id);
    }
  })();

  return { job: id };
}

const str = (params: Json, key: string): string => {
  const value = params[key];
  if (typeof value !== "string" || !value) throw new Error(`Parameter „${key}“ fehlt`);
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
  hasModel: boolean;
  verdict?: string;
  rmsDb?: number;
  pluginName?: string;
}

/** PNG from the local cache as data URL (the app shows it without file access). */
async function imageDataUrl(path: string | undefined): Promise<string | undefined> {
  if (!path || !existsSync(path)) return undefined;
  return `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
}

const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const SEGMENT_NAMES: Record<string, string> = {
  silence: "Pause", impulse: "Impuls", logSweep: "Sweep", noise: "Rauschen", levelSteps: "Pegeltreppe", toneBurst: "Ton-Burst",
};
async function guiResult(gui: { controls: number; comparison?: { similarity: number; colorSimilarity: number; comparePng?: string } } | undefined) {
  if (!gui) return undefined;
  const c = gui.comparison;
  return {
    controls: gui.controls,
    ...(c ? { similarity: c.similarity, colorSimilarity: c.colorSimilarity, ...(c.comparePng ? { comparePng: c.comparePng, preview: await imageDataUrl(c.comparePng) } : {}) } : {}),
  };
}

const PLANNER_NAMES: Record<string, string> = { eq: "EQ-Messung", dynamics: "Kompressor-Messung", distortion: "Verzerrer-Messung", generic: "Allgemeine Messung" };

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
    if (dist) model = { kind: "distortion", summary: formatDistortionModel(dist) };
    else if (dyn) model = { kind: "dynamics", summary: formatDynamicsModel(dyn) };
    else if (eq) model = { kind: "eq", summary: formatModelReport(eq) };
  } catch {
    model = undefined;
  }
  const gui = json("model/gui.json");
  const cache = manifest?.id ? join(guiCacheRoot(), manifest.id) : undefined;
  const rms = report?.verify?.overall?.rmsDb ?? report?.verify?.overall?.total;

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
    verdict: rms !== undefined ? { value: rms, text: planner === "dynamics" ? dynamicsVerdict(rms) : planner === "distortion" ? distortionVerdict(rms) : verdict(rms), pluginName: report?.pluginName } : undefined,
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
  // EQ/compressor: rms deviation (dB); distortion: combined error of its characteristics
  const rms = (report?.verify?.overall?.rmsDb ?? report?.verify?.overall?.total) as number | undefined;
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
    hasModel: Boolean(entries["model/eq.json"] || entries["model/dynamics.json"] || entries["model/distortion.json"]),
    ...(rms !== undefined
      ? { rmsDb: rms, verdict: ({ dynamics: dynamicsVerdict, distortion: distortionVerdict }[manifest?.capture?.plan?.planner as string] ?? verdict)(rms) }
      : {}),
    ...(report?.pluginName ? { pluginName: report.pluginName } : {}),
  };
}

function captureMessage(event: CaptureProgress): string | undefined {
  switch (event.stage) {
    case "info": return `Plugin wird geladen: ${event.plugin}`;
    case "plan": return `${event.parameters} Parameter gefunden, ${event.selected} werden gemessen – ${event.renders} Einstellungen`;
    case "write": return `Profil wird gespeichert: ${event.path}`;
    default: return undefined;
  }
}

const STAGE_TITLES: Record<CloneStage, string> = {
  analyse: "Analyse",
  gui: "Oberfläche erfassen",
  build: "Plugin-Build",
  verify: "Vergleich mit dem Original",
  "gui-verify": "Oberflächen-Vergleich",
  save: "Speichern",
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
    const compiler = process.platform === "win32" ? onPath("cl") || onPath("clang++") : onPath("c++") || onPath("g++") || onPath("clang++");
    return {
      version: "0.1.0",
      platform: process.platform,
      node: process.version,
      dataDir: dataDir(),
      profilesDir: profilesDir(),
      clonesDir: clonesDir(),
      llmConfig: configPath(),
      host,
      tools: { cmake: onPath("cmake"), compiler },
    };
  },

  "plugins.scan": () => scanPlugins(),

  async "plugins.info"(params) {
    const path = str(params, "path");
    const info = await pluginInfo(path);
    let eq: { bands: number; shapes: string[]; renders: number } | undefined;
    try {
      const mapping = detectEq(info.parameters);
      eq = { bands: mapping.bands.length, shapes: mapping.shapes?.map((s) => s.label) ?? [], renders: planEq(info.parameters, { seed: 1 }).renders.length };
    } catch {
      eq = undefined;
    }
    let dynamics: { roles: string[]; renders: number } | undefined;
    if (!eq) {
      try {
        const mapping = detectDynamics(info.parameters, info.plugin.category);
        dynamics = { roles: Object.keys(mapping.roles), renders: planDynamics(info.parameters, { ...DEFAULT_PLAN }).renders.length };
      } catch {
        dynamics = undefined;
      }
    }
    let distortion: { roles: string[]; renders: number; signalSeconds: number } | undefined;
    if (!eq && !dynamics) {
      try {
        const mapping = detectDistortion(info.parameters, info.plugin.category);
        distortion = {
          roles: Object.keys(mapping.roles),
          renders: planDistortion(info.parameters, { ...DEFAULT_PLAN }, info.plugin.category).renders.length,
          signalSeconds: Math.round(generateTestSignal({ sampleRate: 1000, channels: 1, preset: "distortion" }).set.length / 1000),
        };
      } catch {
        distortion = undefined;
      }
    }
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
      genericRenders,
    };
  },

  "capture.start"(params) {
    const plugin = str(params, "path");
    const mode = params.mode === "generic" ? "generic" : params.mode === "dynamics" ? "dynamics" : params.mode === "distortion" ? "distortion" : "eq";
    return startJob("capture", async (ctx) => {
      ctx.stage("capture", "Messen");
      await mkdir(profilesDir(), { recursive: true });
      const info = await pluginInfo(plugin, { signal: ctx.signal });
      const output = join(profilesDir(), `${slugify(info.plugin.name)}-${timestamp()}.vcprofile`);
      ctx.log("info", mode === "eq"
        ? "EQ-Messplan: jede Filterform bei mehreren Frequenzen, Gains und Güten"
        : mode === "dynamics"
          ? "Kompressor-Messplan: jeder Regler einzeln (dicht an den Enden) + Zufallskombinationen zur Gegenprobe, Messsignal mit Pegeltreppe, Bursts und langen Pausen"
          : mode === "distortion"
            ? "Verzerrer-Messplan: jeder Regler einzeln + Zufallskombinationen zur Gegenprobe, Messsignal mit Sinus-Pegeltreppen bei mehreren Frequenzen, Rauschen und leisem Sweep"
            : "Allgemeiner Messplan: jeder Parameter einzeln + Zufallskombinationen");

      const started = Date.now();
      const profile = await capture({
        plugin,
        output,
        sampleRate: 48000,
        blockSize: 512,
        channels: 2,
        prerollSeconds: 0.5,
        tailSeconds: mode === "eq" ? 0.25 : 2,
        plan: { ...DEFAULT_PLAN },
        ...(mode === "eq" ? { planner: eqPlanner } : mode === "dynamics" ? { planner: dynamicsPlanner } : mode === "distortion" ? { planner: distortionPlanner } : {}),
        signal: ctx.signal,
        onProgress: (event) => {
          if (event.stage === "render") ctx.progress(event.done, event.total, event.id);
          const message = captureMessage(event);
          if (message) ctx.log("info", message);
        },
      });
      const bytes = await fileSize(output);
      ctx.log("success", `${profile.captures.renders.length} Einstellungen gemessen in ${((Date.now() - started) / 1000).toFixed(1)} s (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
      return { profile: output, renders: profile.captures.renders.length, bytes, name: info.plugin.name };
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

  async "profiles.import"(params) {
    const source = str(params, "path");
    await mkdir(profilesDir(), { recursive: true });
    const target = join(profilesDir(), basename(source));
    if (existsSync(target)) throw new Error(`In der Bibliothek gibt es bereits ${basename(source)}`);
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
    if (!path.startsWith(profilesDir())) throw new Error("Nur Profile aus der Bibliothek können gelöscht werden");
    await rm(path);
    return {};
  },

  "clone.start"(params) {
    const profilePath = str(params, "profile");
    const install = params.install === true;
    const refit = params.refit === true;
    // rebuild the editor of the original unless switched off (needs the original plugin once)
    const gui = params.gui !== false;
    const pluginPath = typeof params.plugin === "string" && params.plugin ? params.plugin : undefined;
    return startJob("clone", async (ctx) => {
      const summary = await summarizeProfile(profilePath);
      const pluginName = `${summary.name} Clone`;
      if (summary.planner === "distortion") {
        const result = await cloneDistortionProfile({
          profilePath,
          outputDir: join(clonesDir(), slugify(pluginName)),
          pluginName,
          ...(install ? { install: true } : {}),
          ...(refit ? { refit: true } : {}),
          gui,
          ...(pluginPath ? { pluginPath } : {}),
          signal: ctx.signal,
          onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
          onProgress: (done, total, label) => ctx.progress(done, total, label),
          log: (level, message) => ctx.log(level, message),
        });
        const v = result.verify;
        if (v) ctx.log("success", `Klon fertig – Abweichung zum Original ${v.overall.total.toFixed(2)} (${distortionVerdict(v.overall.total)})`);
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
      if (summary.planner === "dynamics") {
        const result = await cloneDynamicsProfile({
          profilePath,
          outputDir: join(clonesDir(), slugify(pluginName)),
          pluginName,
          ...(install ? { install: true } : {}),
          ...(refit ? { refit: true } : {}),
          gui,
          ...(pluginPath ? { pluginPath } : {}),
          signal: ctx.signal,
          onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
          onProgress: (done, total, label) => ctx.progress(done, total, label),
          log: (level, message) => ctx.log(level, message),
        });
        const v = result.verify;
        if (v) ctx.log("success", `Klon fertig – Abweichung zum Original ${v.overall.rmsDb.toFixed(2)} dB (${dynamicsVerdict(v.overall.rmsDb)})`);
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
        ...(pluginPath ? { pluginPath } : {}),
        signal: ctx.signal,
        onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
        onProgress: (done, total, label) => ctx.progress(done, total, label),
        log: (level, message) => ctx.log(level, message),
      });
      const overall = result.verify?.overall;
      if (overall) ctx.log("success", `Klon fertig – Abweichung zum Original ${overall.rmsDb.toFixed(2)} dB (${verdict(overall.rmsDb)})`);
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
    if (!isRoleName(role)) throw new Error(`Unbekannte Rolle ${role}`);
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

  "llm.test"(params) {
    const ref = str(params, "model");
    return startJob("llm-test", async (ctx) => {
      ctx.stage("test", `Test: ${ref}`);
      const target = await resolveModel(await loadConfig(), ref, { detailed: true });
      ctx.log("info", "Drei kurze Prüfungen: Textantwort, Werkzeugaufruf, strukturierte Ausgabe");
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
