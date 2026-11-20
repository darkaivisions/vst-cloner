import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { capture, CancelledError, DEFAULT_PLAN, pluginInfo, scanPlugins, type HostInfo, type PluginEntry } from "@vst-cloner/capture";
import { slugify, type Logger } from "./build.ts";
import { detectEq } from "./eq/mapping.ts";
import { eqPlanner } from "./eq/plan.ts";
import { cloneProfile, verdict } from "./workflow.ts";
import { detectDynamics, dynamicsPlanner, multibandReason, NotDynamicsError } from "./dynamics/plan.ts";
import { cloneDynamicsProfile, dynamicsVerdict } from "./dynamics/workflow.ts";
import { measuredCompression } from "./dynamics/fit.ts";
import { detectDistortion, distortionPlanner } from "./distortion/plan.ts";
import { cloneDistortionProfile, distortionVerdict } from "./distortion/workflow.ts";
import { delayPlanner, detectDelay, detectModulation, modulationPlanner } from "./delay/plan.ts";
import { modulationKind } from "./delay/fit.ts";
import { cloneDelayProfile, delayVerdict } from "./delay/workflow.ts";
import { detectReverb, reverbPlanner } from "./reverb/plan.ts";
import { cloneReverbProfile, reverbVerdict } from "./reverb/workflow.ts";

export type EffectClass = "eq" | "dynamics" | "distortion" | "delay" | "modulation" | "reverb";
export const EFFECT_CLASSES: EffectClass[] = ["eq", "dynamics", "distortion", "delay", "modulation", "reverb"];

/**
 * Effect class of a plugin – the same order as the app uses: EQ (band parameters), compressor
 * (threshold + timing), distortion (drive control or category). Undefined with the reason when none fits.
 */
export function classifyPlugin(info: Pick<HostInfo, "parameters" | "plugin"> & Partial<Pick<HostInfo, "mainInputChannels">>): { effectClass?: EffectClass; reason: string } {
  // synths have attack/release/drive controls too, but nothing to measure: they do not process an input
  if (info.plugin.isInstrument || info.mainInputChannels === 0 || /instrument|synth|generator/i.test(info.plugin.category)) {
    return { reason: "Instrument (does not process an input signal)" };
  }
  // delays and echoes say so in their category or name; their filter and level controls fit no other class
  try {
    detectDelay(info.parameters, info.plugin.category, info.plugin.name);
    return { effectClass: "delay", reason: "Delay detected" };
  } catch {
    // not a delay: the other classes follow
  }
  try {
    detectModulation(info.parameters, info.plugin.category, info.plugin.name);
    // tremolo and phaser engines exist, but the network was as good or better on every one measured: they are
    // compared by "engine vs. network" (vch best), not the default
    if (modulationKind(info.plugin.name, info.plugin.category) === "delay") return { effectClass: "modulation", reason: "Chorus, flanger or vibrato detected" };
  } catch {
    // not a modulated delay
  }
  try {
    detectReverb(info.parameters, info.plugin.category, info.plugin.name);
    return { effectClass: "reverb", reason: "Reverb detected" };
  } catch {
    // not a reverb
  }
  // per-band thresholds and ratios look like EQ bands or a compressor, but neither model fits
  const multiband = multibandReason(info.parameters);
  if (multiband) return { reason: multiband };
  const reasons: string[] = [];
  try {
    detectEq(info.parameters);
    return { effectClass: "eq", reason: "EQ bands detected" };
  } catch (error) {
    reasons.push((error as Error).message);
  }
  try {
    detectDynamics(info.parameters, info.plugin.category, info.plugin.name);
    return { effectClass: "dynamics", reason: "Compressor parameters detected" };
  } catch (error) {
    // a gate, expander or dynamic EQ is no distortion either, whatever its "gain" control suggests
    if (error instanceof NotDynamicsError && error.otherProcessor) return { reason: error.message };
    reasons.push((error as Error).message);
  }
  try {
    detectDistortion(info.parameters, info.plugin.category, info.plugin.name);
    return { effectClass: "distortion", reason: "Drive control or distortion category detected" };
  } catch (error) {
    reasons.push((error as Error).message);
  }
  return { reason: reasons.join(" · ") };
}

export type BatchStage = "info" | "classify" | "capture" | "clone";

export interface BatchRow {
  plugin: string;
  name: string;
  format: string;
  status: "ok" | "skipped" | "failed" | "timeout";
  /** last stage reached (where it failed) */
  stage: BatchStage;
  /** class the plugin was recognised as (skipped: another class or none) */
  detected?: EffectClass;
  error?: string;
  /** clone vs. original: main number of the class (dB) and its verdict */
  quality?: { value: number; verdict: string; text: string; validate?: number };
  gui?: { controls: number; similarity?: number };
  seconds: number;
  log: string;
}

export interface BatchReport {
  effectClass: EffectClass;
  startedAt: string;
  rows: BatchRow[];
}

export interface BatchOptions {
  effectClass: EffectClass;
  /** profiles, clones, logs and the report go here */
  outputDir: string;
  /** plugins to try (default: every plugin in the standard folders) */
  plugins?: string[];
  /** only plugins whose name matches */
  match?: RegExp;
  /** include Windows plugins bridged by yabridge (slow to load) */
  yabridge?: boolean;
  /** rebuild the editors as well */
  gui?: boolean;
  /** run plugins again that already have a result in the report */
  force?: boolean;
  /** stop after this many plugins of the class */
  limit?: number;
  /** VST3 and LV2 of the same plugin both (default: VST3 only) */
  allFormats?: boolean;
  /** per plugin (default 15 min) */
  timeoutSeconds?: number;
  log: Logger;
  signal?: AbortSignal;
}

const REPORT_FILE = "report.json";

/** Short error text for the table: the first meaningful line, plus the tool's last error lines. */
function errorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "unknown error";
  const errorLines = lines.filter((l) => /error|fehler|\*\*\*/i.test(l) && l !== first).slice(-2);
  return [first, ...errorLines].join(" | ").slice(0, 400);
}

/**
 * Captures and clones every plugin of one effect class, one after another, and writes a report after each
 * plugin (a stopped run continues where it ended). Nothing is installed.
 */
export async function runBatch(options: BatchOptions): Promise<BatchReport> {
  const { log, effectClass } = options;
  const out = options.outputDir;
  for (const dir of ["profiles", "clones", "logs"]) await mkdir(join(out, dir), { recursive: true });
  const reportPath = join(out, REPORT_FILE);
  const previous: BatchReport | undefined = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, "utf8")) : undefined;
  const report: BatchReport = {
    effectClass,
    startedAt: previous?.effectClass === effectClass ? previous.startedAt : new Date().toISOString(),
    rows: previous?.effectClass === effectClass ? previous.rows : [],
  };
  const save = async () => {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await writeFile(join(out, "report.md"), formatBatchMarkdown(report));
  };

  let entries: Pick<PluginEntry, "path" | "name" | "format">[];
  if (options.plugins?.length) {
    entries = options.plugins.map((path) => ({ path, name: path.replace(/^.*[\\/]/, "").replace(/\.(vst3|lv2)$/i, ""), format: /\.lv2$/i.test(path) ? "LV2" : "VST3" }));
  } else {
    entries = (await scanPlugins()).filter((e) => !e.clone && (options.yabridge || e.source !== "yabridge"));
  }
  if (options.match) entries = entries.filter((e) => options.match!.test(e.name));
  if (!options.allFormats) {
    // the same plugin as VST3 and LV2: one is enough (VST3)
    const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const vst3 = new Set(entries.filter((e) => e.format === "VST3").map((e) => key(e.name)));
    entries = entries.filter((e) => e.format === "VST3" || !vst3.has(key(e.name)));
  }
  log("info", `Checking ${entries.length} plugins (class ${effectClass}) – results: ${join(out, "report.md")}`);

  let counted = 0;
  for (const entry of entries) {
    if (options.signal?.aborted) throw new CancelledError();
    if (options.limit !== undefined && counted >= options.limit) break;
    const done = report.rows.find((r) => r.plugin === entry.path);
    if (done && !options.force && done.status !== "timeout") {
      if (done.status !== "skipped" && done.stage !== "info") counted++;
      continue;
    }
    const row = await runOne(entry, options);
    report.rows = report.rows.filter((r) => r.plugin !== entry.path);
    report.rows.push(row);
    if (row.status !== "skipped" && row.stage !== "info") counted++;
    await save();
    const quality = row.quality ? ` – ${row.quality.text}` : "";
    const level = row.status === "failed" || row.status === "timeout" ? "warn" : "info";
    if (row.status === "skipped") log("detail", `${entry.name}: skipped (${row.error})`);
    else log(level, `${entry.name}: ${row.status === "ok" ? "OK" : row.status === "timeout" ? "time limit" : `failed at step ${row.stage}`}${quality}${row.error ? ` – ${row.error}` : ""} (${row.seconds.toFixed(0)} s)`);
  }
  await save();
  return report;
}

async function runOne(entry: Pick<PluginEntry, "path" | "name" | "format">, options: BatchOptions): Promise<BatchRow> {
  const started = Date.now();
  const slug = `${slugify(entry.name)}-${entry.format.toLowerCase()}`;
  const logFile = join(options.outputDir, "logs", `${slug}.log`);
  await rm(logFile, { force: true });
  const writeLog = (level: string, message: string) => appendFile(logFile, `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${level.padEnd(6)} ${message}\n`).catch(() => {});
  const row: BatchRow = { plugin: entry.path, name: entry.name, format: entry.format, status: "failed", stage: "info", seconds: 0, log: logFile };

  // each plugin gets its own time limit; cancelling the whole run cancels it as well
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (options.timeoutSeconds ?? 900) * 1000);
  const forward = () => controller.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  const signal = controller.signal;
  const log: Logger = (level, message) => void writeLog(level, message);

  try {
    // loading gets its own short limit: a plugin that hangs while loading should not block the run
    const loading = new AbortController();
    const loadTimer = setTimeout(() => loading.abort(), 60_000);
    const stopLoading = () => loading.abort();
    signal.addEventListener("abort", stopLoading, { once: true });
    let info: HostInfo;
    try {
      info = await pluginInfo(entry.path, { signal: loading.signal });
    } catch (error) {
      if (loading.signal.aborted && !signal.aborted) throw new Error("Plugin does not load (no answer after 60 s)");
      throw error;
    } finally {
      clearTimeout(loadTimer);
      signal.removeEventListener("abort", stopLoading);
    }
    row.name = info.plugin.name || entry.name;
    void writeLog("info", `${info.plugin.name} · ${info.plugin.manufacturer} · ${info.plugin.category} · ${info.parameters.length} Parameter · ${info.mainInputChannels}→${info.mainOutputChannels}`);

    row.stage = "classify";
    const { effectClass, reason } = classifyPlugin(info);
    if (effectClass) row.detected = effectClass;
    if (effectClass !== options.effectClass) {
      row.status = "skipped";
      row.error = effectClass ? `detected as ${effectClass}` : reason.slice(0, 200);
      return row;
    }

    row.stage = "capture";
    const profilePath = join(options.outputDir, "profiles", `${slug}.vcprofile`);
    const planner = { eq: eqPlanner, dynamics: dynamicsPlanner, distortion: distortionPlanner, delay: delayPlanner, modulation: modulationPlanner, reverb: reverbPlanner }[options.effectClass];
    await capture({
      plugin: entry.path,
      output: profilePath,
      sampleRate: 48000,
      blockSize: 512,
      channels: 2,
      prerollSeconds: 0.5,
      tailSeconds: options.effectClass === "eq" ? 0.25 : 2,
      plan: { ...DEFAULT_PLAN },
      planner,
      signal,
      onProgress: (event) => void writeLog("detail", JSON.stringify(event).slice(0, 300)),
    });

    row.stage = "clone";
    const common = {
      profilePath,
      outputDir: join(options.outputDir, "clones", slug),
      pluginName: `${row.name} Clone`,
      gui: options.gui ?? false,
      pluginPath: entry.path,
      signal,
      log,
    };
    if (options.effectClass === "eq") {
      const result = await cloneProfile(common);
      const v = result.verify;
      if (v) row.quality = { value: v.overall.rmsDb, verdict: verdict(v.overall.rmsDb), text: `${v.overall.rmsDb.toFixed(2)} dB (${verdict(v.overall.rmsDb)})`, ...(v.combined ? { validate: v.combined.rmsDb } : {}) };
      if (result.gui) row.gui = { controls: result.gui.controls, ...(result.gui.comparison ? { similarity: result.gui.comparison.similarity } : {}) };
    } else if (options.effectClass === "dynamics") {
      const result = await cloneDynamicsProfile(common);
      const v = result.verify;
      if (v) {
        // nothing compressed at the centre of the measurement: the small error is that of a level change, not of a compressor
        const judged = measuredCompression(result.model) ? dynamicsVerdict(v.overall.rmsDb) : "no compression measured";
        row.quality = {
          value: v.overall.rmsDb, verdict: judged,
          text: `${v.overall.rmsDb.toFixed(2)} dB (${judged})`,
          ...(v.validate ? { validate: v.validate.rmsDb } : {}),
        };
      }
      if (result.gui) row.gui = { controls: result.gui.controls, ...(result.gui.comparison ? { similarity: result.gui.comparison.similarity } : {}) };
    } else if (options.effectClass === "delay" || options.effectClass === "modulation") {
      const result = await cloneDelayProfile(common);
      const v = result.verify;
      if (v) {
        // without an echo in the base render there was nothing to measure: the error says nothing about a delay
        const judged = result.model.report.echoes > 0 ? delayVerdict(v.overall.rmsDb) : "no echo measured";
        row.quality = { value: v.overall.rmsDb, verdict: judged, text: `${v.overall.rmsDb.toFixed(2)} dB (${judged})`, ...(v.validate ? { validate: v.validate.rmsDb } : {}) };
      }
    } else if (options.effectClass === "reverb") {
      const result = await cloneReverbProfile(common);
      const v = result.verify;
      if (v) {
        const judged = result.model.report.tail ? reverbVerdict(v.overall.rmsDb) : "no reverb tail measured";
        const width = v.widthDb !== undefined ? `, width ${v.widthDb.toFixed(1)} dB` : "";
        row.quality = { value: v.overall.rmsDb, verdict: judged, text: `${v.overall.rmsDb.toFixed(2)} dB (${judged}${width})`, ...(v.validate ? { validate: v.validate.rmsDb } : {}) };
      }
    } else {
      const result = await cloneDistortionProfile(common);
      const v = result.verify;
      if (v) {
        row.quality = {
          value: v.overall.total, verdict: distortionVerdict(v.overall.total),
          text: `${v.overall.total.toFixed(2)} (${distortionVerdict(v.overall.total)}; fundamental ${v.overall.gainDb.toFixed(1)} dB, harmonics ${v.overall.harmonicsDb.toFixed(1)} dB, error/signal ${v.esrDb.toFixed(1)} dB)`,
          ...(v.validate ? { validate: v.validate.total } : {}),
        };
      }
      if (result.gui) row.gui = { controls: result.gui.controls, ...(result.gui.comparison ? { similarity: result.gui.comparison.similarity } : {}) };
    }
    row.status = "ok";
    return row;
  } catch (error) {
    const timedOut = signal.aborted && !options.signal?.aborted;
    if (options.signal?.aborted) throw error;
    row.status = timedOut ? "timeout" : "failed";
    row.error = timedOut ? `time limit (${options.timeoutSeconds ?? 900} s) exceeded` : errorSummary(error);
    void writeLog("error", error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
    return row;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forward);
    row.seconds = (Date.now() - started) / 1000;
  }
}

/** The report as a Markdown table: failures first, then results from worst to best, skipped plugins last. */
export function formatBatchMarkdown(report: BatchReport): string {
  const rows = report.rows;
  // plugins that do not even load never showed their class: listed apart, not counted as plugins of the class
  const unloadable = rows.filter((r) => r.status !== "skipped" && r.stage === "info");
  const tried = rows.filter((r) => r.status !== "skipped" && r.stage !== "info");
  const ok = tried.filter((r) => r.status === "ok");
  const lines = [
    `# Batch run ${report.effectClass} (${report.startedAt.slice(0, 16).replace("T", " ")})`,
    "",
    `${tried.length} plugins of the class tried · ${ok.length} cloned · ${tried.length - ok.length} failed · ${rows.length - tried.length - unloadable.length} skipped · ${unloadable.length} not loadable`,
    "",
  ];
  const verdicts = new Map<string, number>();
  for (const r of ok) if (r.quality) verdicts.set(r.quality.verdict, (verdicts.get(r.quality.verdict) ?? 0) + 1);
  if (verdicts.size) lines.push(`Ratings: ${[...verdicts].map(([v, n]) => `${n}× ${v}`).join(", ")}`, "");

  const failed = tried.filter((r) => r.status !== "ok");
  if (failed.length) {
    lines.push("## Failed", "", "| Plugin | Format | Step | Error | Time |", "|---|---|---|---|---|");
    for (const r of failed) lines.push(`| ${r.name} | ${r.format} | ${r.stage} | ${(r.error ?? "").replace(/\|/g, "/")} | ${r.seconds.toFixed(0)} s |`);
    lines.push("");
  }
  if (ok.length) {
    lines.push("## Cloned", "", "| Plugin | Format | Clone vs. original | Unseen combinations | Editor | Time |", "|---|---|---|---|---|---|");
    for (const r of [...ok].sort((a, b) => (b.quality?.value ?? 0) - (a.quality?.value ?? 0))) {
      const gui = r.gui ? `${r.gui.controls} controls${r.gui.similarity !== undefined ? `, ${Math.round(r.gui.similarity * 100)} %` : ""}` : "–";
      lines.push(`| ${r.name} | ${r.format} | ${r.quality?.text ?? "–"} | ${r.quality?.validate !== undefined ? r.quality.validate.toFixed(2) : "–"} | ${gui} | ${r.seconds.toFixed(0)} s |`);
    }
    lines.push("");
  }
  const skipped = rows.filter((r) => r.status === "skipped");
  if (skipped.length) {
    const other = new Map<string, string[]>();
    for (const r of skipped) {
      const key = r.detected ? `detected as ${r.detected}` : "no class";
      other.set(key, [...(other.get(key) ?? []), r.name]);
    }
    lines.push("## Skipped", "");
    for (const [key, names] of other) lines.push(`- ${key} (${names.length}): ${names.join(", ")}`);
    lines.push("");
  }
  if (unloadable.length) {
    lines.push("## Not loadable", "", "| Plugin | Format | Error |", "|---|---|---|");
    for (const r of unloadable) lines.push(`| ${r.name} | ${r.format} | ${(r.error ?? "").replace(/\|/g, "/")} |`);
    lines.push("");
  }
  return lines.join("\n");
}
