import { join } from "node:path";
import { readProfile, writeProfile, type Profile } from "@vst-cloner/profile";
import { strFromU8, strToU8 } from "fflate";
import { buildPlugin, slugify, type BuildResult, type Logger } from "../build.ts";
import { generateDynamicsHeader } from "./codegen.ts";
import { CancelledError } from "@vst-cloner/capture";
import { measuredCompression, predictModel, type DynamicsModel } from "./fit.ts";
import { isGate, staticReduction } from "./model.ts";
import { verifyDynamicsClone, type DynamicsVerifyReport } from "./verify.ts";
import { existsSync } from "node:fs";
import { generateGuiHeader } from "../gui/codegen.ts";
import { virtualDisplayAvailable } from "../gui/capture.ts";
import type { GuiModel } from "../gui/model.ts";
import { captureGuiLayout, compareGui, GUI_MODEL_FILE, guiCacheDir, locatePlugin, type GuiComparison } from "../gui/workflow.ts";

export const DYNAMICS_MODEL_FILE = "model/dynamics.json";
export const DYNAMICS_REPORT_FILE = "report.json";
/** Raised whenever the dynamics fit changes; older stored models are fitted again. */
export const DYNAMICS_FIT_REVISION = 5; // 2: detector averaging time, 3: saturation and detector ripple, 4: anchored sweep fits, expander curve, 5: models per switch position

/** Whether a profile was captured with the dynamics plan (or already holds a dynamics model). */
export function isDynamicsProfile(profile: Profile): boolean {
  return profile.manifest.capture.plan?.planner === "dynamics" || profile.files.has(DYNAMICS_MODEL_FILE);
}

export function storedDynamicsModel(profile: Profile): DynamicsModel | undefined {
  const data = profile.files.get(DYNAMICS_MODEL_FILE);
  if (!data) return undefined;
  const model = JSON.parse(strFromU8(data)) as DynamicsModel & { fitRevision?: number };
  return (model.fitRevision ?? 0) >= DYNAMICS_FIT_REVISION ? model : undefined;
}

const db = (v: number) => `${v.toFixed(2)} dB`;
/** Rating of a compressor clone (level over time; naturally less exact than an EQ's frequency response). */
export const dynamicsVerdict = (rms: number) => (rms < 0.5 ? "excellent" : rms < 1 ? "very good" : rms < 2 ? "good" : rms < 4 ? "usable" : "inaccurate");
const verdict = dynamicsVerdict;

export function formatDynamicsModel(model: DynamicsModel): string[] {
  const p = model.base;
  const expander = isGate(model.structure);
  const lines = [
    `${expander ? "Gate/Expander" : "Compressor"}: ${model.structure.detector === "rms" ? "RMS" : "peak"} detector${expander ? "" : `, ${model.structure.topology === "feedforward" ? "Feed-forward" : "Feedback"}`}`,
    `Base setting: threshold ${p.thresholdDb.toFixed(1)} dB, ratio ${expander ? `1:${p.ratio.toFixed(2)}` : `${p.ratio.toFixed(2)}:1`}, knee ${p.kneeDb.toFixed(1)} dB, ` +
      `${expander ? `maximum attenuation ${p.slowKneeDb.toFixed(1)} dB, ` : ""}level ${p.makeupDb >= 0 ? "+" : ""}${p.makeupDb.toFixed(1)} dB`,
    // the model's attack is the time in which the reduction grows: for a gate that is its closing
    `Timing: detector ${(p.detectorTime * 1000).toFixed(1)} ms, ${expander ? "close" : "attack"} ${(p.attack * 1000).toFixed(1)} ms, ${expander ? "open" : "release"} ${(p.release * 1000).toFixed(0)} ms` +
      (p.charge > 0 && !expander ? `, memory charges in ${(p.charge * 1000).toFixed(0)} ms, discharges at ${p.slow.toFixed(1)} dB/s` : ""),
    `Tone: saturation ${p.drive > 0 ? `drive ${p.drive.toFixed(2)}` : "off"}, detector ripple ${(p.ripple * 100).toFixed(1)} % (${(p.rippleTime * 1000).toFixed(1)} ms)`,
    `Parameter: ${model.tables.map((t) => t.name).join(", ")}`,
  ];
  if (model.variants?.length) lines.push(`Separate model for switch positions: ${model.variants.map((v) => `${v.name} (${v.structure.curve ?? "compressor"})`).join(", ")}`);
  if (model.report.train) lines.push(`Model vs. original (single parameters): ${db(model.report.train.rmsDb)} (max ${model.report.train.maxDb.toFixed(1)}) – ${verdict(model.report.train.rmsDb)}`);
  if (model.report.validate) lines.push(`Prediction of unseen combinations: ${db(model.report.validate.rmsDb)} (max ${model.report.validate.maxDb.toFixed(1)}) – ${verdict(model.report.validate.rmsDb)}`);
  if (!measuredCompression(model)) {
    lines.push(`Warning: no compression at the working point of the measurement (${db(model.report.compressionDb ?? 0)}) – the clone mostly changes the level, the error figures say little about the compressor`);
  }
  return lines;
}

export function formatDynamicsVerify(report: DynamicsVerifyReport): string[] {
  const lines = [`Clone vs. original (${report.renders} settings): ${db(report.overall.rmsDb)} (max ${report.overall.maxDb.toFixed(1)}) – ${verdict(report.overall.rmsDb)}`];
  if (report.validate) lines.push(`  of which unseen combinations: ${db(report.validate.rmsDb)} (max ${report.validate.maxDb.toFixed(1)})`);
  lines.push("Largest deviations:", ...report.worst.map((w) => `  ${w.label}: ${db(w.rmsDb)} (max ${w.maxDb.toFixed(1)})`));
  if (report.engineMaxDb > 0.1) lines.push(`Warning: the plugin deviates from the reference model (max ${report.engineMaxDb.toFixed(2)} dB, ${report.engineWorst})`);
  return lines;
}

/** The compressor fit on a worker thread: progress arrives while it runs, cancelling stops it at once. */
export async function fitDynamicsInWorker(
  profilePath: string,
  onProgress?: (done: number, total: number, label: string) => void,
  signal?: AbortSignal,
): Promise<DynamicsModel> {
  if (signal?.aborted) throw new CancelledError();
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { profilePath } });
  let cancel: () => void = () => {};
  try {
    return await new Promise<DynamicsModel>((resolve, reject) => {
      cancel = () => reject(new CancelledError());
      signal?.addEventListener("abort", cancel, { once: true });
      worker.on("message", (message: { model?: DynamicsModel; progress?: { done: number; total: number; label: string } }) => {
        if (message.progress) onProgress?.(message.progress.done, message.progress.total, message.progress.label);
        if (message.model) resolve(message.model);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Compressor fit ended without a result (code ${code})`)));
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
    await worker.terminate();
  }
}

export interface DynamicsCloneOptions {
  profilePath: string;
  outputDir?: string;
  pluginName?: string;
  install?: boolean;
  refit?: boolean;
  skipVerify?: boolean;
  log: Logger;
  signal?: AbortSignal;
  onStage?: (stage: "analyse" | "gui" | "build" | "verify" | "gui-verify" | "save") => void;
  onProgress?: (done: number, total: number, label: string) => void;
  /** capture and rebuild the editor of the original (needs the original plugin once) */
  gui?: boolean;
  /** capture the editor again even if the profile already has a layout */
  refitGui?: boolean;
  /** path of the original plugin (otherwise searched in the standard plugin folders) */
  pluginPath?: string;
}

export interface DynamicsCloneResult {
  model: DynamicsModel;
  build: BuildResult;
  verify?: DynamicsVerifyReport;
  gui?: { controls: number; comparison?: GuiComparison };
}

/** analyse → build → verify → store model and report in the profile */
export async function cloneDynamicsProfile(options: DynamicsCloneOptions): Promise<DynamicsCloneResult> {
  const { log } = options;
  const profile = await readProfile(options.profilePath);
  const pluginName = options.pluginName ?? `${profile.manifest.plugin.name} Clone`;
  const stage = options.onStage ?? (() => {});

  stage("analyse");
  let model = options.refit ? undefined : storedDynamicsModel(profile);
  if (model) log("info", "Using the model stored in the profile");
  else {
    log("info", `Analysing ${profile.captures.renders.length} measurements of ${profile.manifest.plugin.name} …`);
    model = await fitDynamicsInWorker(options.profilePath, options.onProgress, options.signal);
  }
  for (const line of formatDynamicsModel(model)) log("info", line);

  // editor layout: stored in the profile, captured on request
  const stored = profile.files.get(GUI_MODEL_FILE);
  let guiModel = options.refitGui || !stored ? undefined : (JSON.parse(strFromU8(stored)) as GuiModel);
  let originalRaw = join(guiCacheDir(profile), "pass2", "base.rgba");
  if (guiModel) log("info", "Using the editor layout stored in the profile");
  else if (options.gui) {
    stage("gui");
    if (!virtualDisplayAvailable()) log("warn", "Editor not rebuilt: Xvfb is missing (sudo pacman -S xorg-server-xvfb)");
    else {
      const pluginPath = options.pluginPath ?? (await locatePlugin(profile));
      if (!pluginPath) log("warn", "Editor not rebuilt: original plugin not found");
      else {
        const baseParams = predictModel(model, new Map());
        const captured = await captureGuiLayout(profile, pluginPath, {
          log,
          // steady state for a sine: the detector level equals its peak level
          meterReduction: (levelDb) => staticReduction(levelDb, baseParams, model.structure.curve),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
        if (captured) {
          guiModel = captured.model;
          originalRaw = captured.originalRaw;
          profile.files.set(GUI_MODEL_FILE, strToU8(JSON.stringify(guiModel)));
        }
      }
    }
  }

  const { header, params } = generateDynamicsHeader(model, profile.parameters.parameters, pluginName, profile.captures.renders);
  stage("build");
  const build = await buildPlugin({
    pluginName,
    modelHeader: header,
    guiHeader: generateGuiHeader(guiModel, params, profile.manifest.plugin.name),
    template: "dynamics",
    outputDir: options.outputDir ?? join(process.cwd(), slugify(pluginName)),
    ...(options.install ? { install: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });

  let verify: DynamicsVerifyReport | undefined;
  if (!options.skipVerify) {
    stage("verify");
    verify = await verifyDynamicsClone(profile, model, build.vst3, { log, ...(options.signal ? { signal: options.signal } : {}) });
    for (const line of formatDynamicsVerify(verify)) log("info", line);
  }

  let gui: DynamicsCloneResult["gui"];
  if (guiModel) {
    gui = { controls: guiModel.controls.length };
    if (virtualDisplayAvailable()) {
      stage("gui-verify");
      try {
        const comparison = await compareGui(profile, build.vst3, existsSync(originalRaw) ? originalRaw : undefined, guiModel, {
          log,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (comparison) gui.comparison = comparison;
      } catch (error) {
        log("warn", `Editor comparison not possible: ${(error as Error).message}`);
      }
    }
  }

  stage("save");
  profile.files.set(DYNAMICS_MODEL_FILE, strToU8(JSON.stringify({ ...model, fitRevision: DYNAMICS_FIT_REVISION })));
  profile.files.set(DYNAMICS_REPORT_FILE, strToU8(JSON.stringify({ createdAt: new Date().toISOString(), pluginName, model: model.report, ...(verify ? { verify } : {}) }, null, 1)));
  await writeProfile(options.profilePath, profile);
  log("info", `Model and report saved in the profile: ${options.profilePath}`);
  return { model, build, ...(verify ? { verify } : {}), ...(gui ? { gui } : {}) };
}
