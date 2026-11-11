import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { capture, CancelledError, DEFAULT_PLAN, pluginInfo, scanPlugins, type HostInfo, type PluginEntry } from "@vst-cloner/capture";
import { slugify, type Logger } from "./build.ts";
import { detectEq } from "./eq/mapping.ts";
import { eqPlanner } from "./eq/plan.ts";
import { cloneProfile, verdict } from "./workflow.ts";
import { detectDynamics, dynamicsPlanner } from "./dynamics/plan.ts";
import { cloneDynamicsProfile, dynamicsVerdict } from "./dynamics/workflow.ts";
import { detectDistortion, distortionPlanner } from "./distortion/plan.ts";
import { cloneDistortionProfile, distortionVerdict } from "./distortion/workflow.ts";

export type EffectClass = "eq" | "dynamics" | "distortion";
export const EFFECT_CLASSES: EffectClass[] = ["eq", "dynamics", "distortion"];

/**
 * Effect class of a plugin – the same order as the app uses: EQ (band parameters), compressor
 * (threshold + timing), distortion (drive control or category). Undefined with the reason when none fits.
 */
export function classifyPlugin(info: Pick<HostInfo, "parameters" | "plugin">): { effectClass?: EffectClass; reason: string } {
  const reasons: string[] = [];
  try {
    detectEq(info.parameters);
    return { effectClass: "eq", reason: "EQ-Bänder erkannt" };
  } catch (error) {
    reasons.push((error as Error).message);
  }
  try {
    detectDynamics(info.parameters, info.plugin.category);
    return { effectClass: "dynamics", reason: "Kompressor-Parameter erkannt" };
  } catch (error) {
    reasons.push((error as Error).message);
  }
  try {
    detectDistortion(info.parameters, info.plugin.category);
    return { effectClass: "distortion", reason: "Drive-Regler oder Verzerrer-Kategorie erkannt" };
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
  const first = lines[0] ?? "unbekannter Fehler";
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
  log("info", `${entries.length} Plugins werden geprüft (Klasse ${effectClass}) – Ergebnisse: ${join(out, "report.md")}`);

  let counted = 0;
  for (const entry of entries) {
    if (options.signal?.aborted) throw new CancelledError();
    if (options.limit !== undefined && counted >= options.limit) break;
    const done = report.rows.find((r) => r.plugin === entry.path);
    if (done && !options.force && done.status !== "timeout") {
      if (done.status !== "skipped") counted++;
      continue;
    }
    const row = await runOne(entry, options);
    report.rows = report.rows.filter((r) => r.plugin !== entry.path);
    report.rows.push(row);
    if (row.status !== "skipped") counted++;
    await save();
    const quality = row.quality ? ` – ${row.quality.text}` : "";
    const level = row.status === "failed" || row.status === "timeout" ? "warn" : "info";
    if (row.status === "skipped") log("detail", `${entry.name}: übersprungen (${row.error})`);
    else log(level, `${entry.name}: ${row.status === "ok" ? "OK" : row.status === "timeout" ? "Zeitlimit" : `Fehler beim Schritt ${row.stage}`}${quality}${row.error ? ` – ${row.error}` : ""} (${row.seconds.toFixed(0)} s)`);
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
      if (loading.signal.aborted && !signal.aborted) throw new Error("Plugin lädt nicht (keine Antwort nach 60 s)");
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
      row.error = effectClass ? `erkannt als ${effectClass}` : reason.slice(0, 200);
      return row;
    }

    row.stage = "capture";
    const profilePath = join(options.outputDir, "profiles", `${slug}.vcprofile`);
    const planner = { eq: eqPlanner, dynamics: dynamicsPlanner, distortion: distortionPlanner }[options.effectClass];
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
      if (v) row.quality = { value: v.overall.rmsDb, verdict: verdict(v.overall.rmsDb), text: `${v.overall.rmsDb.toFixed(2)} dB (${verdict(v.overall.rmsDb)})` };
      if (result.gui) row.gui = { controls: result.gui.controls, ...(result.gui.comparison ? { similarity: result.gui.comparison.similarity } : {}) };
    } else if (options.effectClass === "dynamics") {
      const result = await cloneDynamicsProfile(common);
      const v = result.verify;
      if (v) {
        row.quality = {
          value: v.overall.rmsDb, verdict: dynamicsVerdict(v.overall.rmsDb),
          text: `${v.overall.rmsDb.toFixed(2)} dB (${dynamicsVerdict(v.overall.rmsDb)})`,
          ...(v.validate ? { validate: v.validate.rmsDb } : {}),
        };
      }
      if (result.gui) row.gui = { controls: result.gui.controls, ...(result.gui.comparison ? { similarity: result.gui.comparison.similarity } : {}) };
    } else {
      const result = await cloneDistortionProfile(common);
      const v = result.verify;
      if (v) {
        row.quality = {
          value: v.overall.total, verdict: distortionVerdict(v.overall.total),
          text: `${v.overall.total.toFixed(2)} (${distortionVerdict(v.overall.total)}; Grundton ${v.overall.gainDb.toFixed(1)} dB, Oberwellen ${v.overall.harmonicsDb.toFixed(1)} dB, Fehler/Signal ${v.esrDb.toFixed(1)} dB)`,
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
    row.error = timedOut ? `Zeitlimit (${options.timeoutSeconds ?? 900} s) überschritten` : errorSummary(error);
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
  const tried = rows.filter((r) => r.status !== "skipped");
  const ok = tried.filter((r) => r.status === "ok");
  const lines = [
    `# Batch-Lauf ${report.effectClass} (${report.startedAt.slice(0, 16).replace("T", " ")})`,
    "",
    `${tried.length} Plugins der Klasse versucht · ${ok.length} geklont · ${tried.length - ok.length} fehlgeschlagen · ${rows.length - tried.length} übersprungen`,
    "",
  ];
  const verdicts = new Map<string, number>();
  for (const r of ok) if (r.quality) verdicts.set(r.quality.verdict, (verdicts.get(r.quality.verdict) ?? 0) + 1);
  if (verdicts.size) lines.push(`Bewertungen: ${[...verdicts].map(([v, n]) => `${n}× ${v}`).join(", ")}`, "");

  const failed = tried.filter((r) => r.status !== "ok");
  if (failed.length) {
    lines.push("## Fehlgeschlagen", "", "| Plugin | Format | Schritt | Fehler | Dauer |", "|---|---|---|---|---|");
    for (const r of failed) lines.push(`| ${r.name} | ${r.format} | ${r.stage} | ${(r.error ?? "").replace(/\|/g, "/")} | ${r.seconds.toFixed(0)} s |`);
    lines.push("");
  }
  if (ok.length) {
    lines.push("## Geklont", "", "| Plugin | Format | Klon vs. Original | Unbekannte Kombinationen | Oberfläche | Dauer |", "|---|---|---|---|---|---|");
    for (const r of [...ok].sort((a, b) => (b.quality?.value ?? 0) - (a.quality?.value ?? 0))) {
      const gui = r.gui ? `${r.gui.controls} Elemente${r.gui.similarity !== undefined ? `, ${Math.round(r.gui.similarity * 100)} %` : ""}` : "–";
      lines.push(`| ${r.name} | ${r.format} | ${r.quality?.text ?? "–"} | ${r.quality?.validate !== undefined ? r.quality.validate.toFixed(2) : "–"} | ${gui} | ${r.seconds.toFixed(0)} s |`);
    }
    lines.push("");
  }
  const skipped = rows.filter((r) => r.status === "skipped");
  if (skipped.length) {
    const other = new Map<string, string[]>();
    for (const r of skipped) {
      const key = r.detected ? `erkannt als ${r.detected}` : "keiner Klasse zugeordnet";
      other.set(key, [...(other.get(key) ?? []), r.name]);
    }
    lines.push("## Übersprungen", "");
    for (const [key, names] of other) lines.push(`- ${key} (${names.length}): ${names.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
