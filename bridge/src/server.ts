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
  hostVersion,
  planCaptures,
  pluginInfo,
  type CaptureProgress,
} from "@vst-cloner/capture";
import { cloneProfile, detectEq, eqPlanner, planEq, slugify, verdict, type CloneStage, type LogLevel } from "@vst-cloner/clone";
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

/** Reads only the small JSON documents of a profile (fast, no checksum verification). */
async function summarizeProfile(path: string): Promise<ProfileSummary> {
  const entries = unzipSync(await readFile(path), { filter: (f) => f.name.endsWith(".json") && !f.name.startsWith("captures/") });
  const json = (name: string) => (entries[name] ? JSON.parse(strFromU8(entries[name]!)) : undefined);
  const manifest = json("manifest.json");
  const captures = json("captures.json");
  const report = json("report.json");
  const rms = report?.verify?.overall?.rmsDb as number | undefined;
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
    hasModel: Boolean(entries["model/eq.json"]),
    ...(rms !== undefined ? { rmsDb: rms, verdict: verdict(rms) } : {}),
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
      genericRenders,
    };
  },

  "capture.start"(params) {
    const plugin = str(params, "path");
    const mode = params.mode === "generic" ? "generic" : "eq";
    return startJob("capture", async (ctx) => {
      ctx.stage("capture", "Messen");
      await mkdir(profilesDir(), { recursive: true });
      const info = await pluginInfo(plugin, { signal: ctx.signal });
      const output = join(profilesDir(), `${slugify(info.plugin.name)}-${timestamp()}.vcprofile`);
      ctx.log("info", mode === "eq" ? "EQ-Messplan: jede Filterform bei mehreren Frequenzen, Gains und Güten" : "Allgemeiner Messplan: jeder Parameter einzeln + Zufallskombinationen");

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
        ...(mode === "eq" ? { planner: eqPlanner } : {}),
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
    return startJob("clone", async (ctx) => {
      const summary = await summarizeProfile(profilePath);
      const pluginName = `${summary.name} Clone`;
      const result = await cloneProfile({
        profilePath,
        outputDir: join(clonesDir(), slugify(pluginName)),
        pluginName,
        install,
        refit,
        signal: ctx.signal,
        onStage: (stage) => ctx.stage(stage, STAGE_TITLES[stage]),
        log: (level, message) => ctx.log(level, message),
      });
      const overall = result.verify?.overall;
      if (overall) ctx.log("success", `Klon fertig – Abweichung zum Original ${overall.rmsDb.toFixed(2)} dB (${verdict(overall.rmsDb)})`);
      return {
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
