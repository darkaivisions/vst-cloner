import { existsSync } from "node:fs";
import { join } from "node:path";
import { readProfile, writeProfile, type Profile } from "@vst-cloner/profile";
import { strFromU8, strToU8 } from "fflate";
import { buildPlugin, slugify, type BuildResult, type Logger } from "../build.ts";
import { generateGuiHeader } from "../gui/codegen.ts";
import { virtualDisplayAvailable } from "../gui/capture.ts";
import type { GuiModel } from "../gui/model.ts";
import { captureGuiLayout, compareGui, GUI_MODEL_FILE, guiCacheDir, locatePlugin, type GuiComparison } from "../gui/workflow.ts";
import { generateNeuralHeader, type NeuralModel } from "./codegen.ts";
import { trainNeural } from "./train.ts";
import { esrToDb, verifyNeuralClone, type NeuralVerifyReport } from "./verify.ts";

export const NEURAL_MODEL_FILE = "model/neural.json";
export const NEURAL_REPORT_FILE = "report.json";
/** Raised whenever the network or its training changes; older stored models are trained again. */
export const NEURAL_REVISION = 1;

/** Whether a profile was captured with the neural plan (or already holds a network). */
export function isNeuralProfile(profile: Profile): boolean {
  return profile.manifest.capture.plan?.planner === "neural" || profile.files.has(NEURAL_MODEL_FILE);
}

export function storedNeuralModel(profile: Profile): (NeuralModel & { trainEsr?: number; validateEsr?: number }) | undefined {
  const data = profile.files.get(NEURAL_MODEL_FILE);
  if (!data) return undefined;
  const model = JSON.parse(strFromU8(data)) as NeuralModel & { revision?: number };
  return (model.revision ?? 0) >= NEURAL_REVISION ? model : undefined;
}

/**
 * Rating of a universal clone by its error-to-signal ratio (energy of the difference to the original against
 * the energy of the original). Below 1 % the difference is hard to hear on most material.
 */
export function neuralVerdict(esr: number): string {
  if (esr < 0.01) return "excellent";
  if (esr < 0.03) return "very good";
  if (esr < 0.07) return "good";
  if (esr < 0.15) return "usable";
  return "inaccurate";
}

const percent = (esr: number) => `${(esr * 100).toFixed(esr < 0.1 ? 2 : 1)} % (${esrToDb(esr).toFixed(1)} dB)`;

export function formatNeuralModel(model: NeuralModel & { trainEsr?: number; validateEsr?: number }): string[] {
  const lines = [
    `Universal clone: recurrent network (LSTM, ${model.hidden} units) conditioned on ${model.parameters.length} control${model.parameters.length === 1 ? "" : "s"}` +
      (model.names.length ? ` (${model.names.join(", ")})` : ""),
  ];
  if (model.trainEsr !== undefined) lines.push(`Model vs. original (training settings): error ${percent(model.trainEsr)} – ${neuralVerdict(model.trainEsr)}`);
  if (model.validateEsr !== undefined) lines.push(`Prediction of unseen combinations: error ${percent(model.validateEsr)} – ${neuralVerdict(model.validateEsr)}`);
  return lines;
}

/**
 * Verdict on a verified clone: by the typical setting (median), so that one setting with the resonance at
 * self-oscillation does not decide it; the mean and the outliers are reported next to it.
 */
export const neuralReportVerdict = (report: { esr: number; median?: number }): string => neuralVerdict(report.median ?? report.esr);

export function formatNeuralVerify(report: NeuralVerifyReport): string[] {
  const lines = [`Clone vs. original (${report.renders} settings): typical setting ${percent(report.median)} – ${neuralReportVerdict(report)}`];
  lines.push(`  mean ${percent(report.esr)}` + (report.outliers ? `; ${report.outliers} setting${report.outliers === 1 ? "" : "s"} off by half the signal or more` : ""));
  if (report.spectralDb) lines.push(`  sound (spectrum over time, phase-blind): typical setting ${report.spectralDb.median.toFixed(2)} dB, mean ${report.spectralDb.mean.toFixed(2)} dB`);
  if (report.validate !== undefined) lines.push(`  of which unseen combinations: error ${percent(report.validate)}`);
  lines.push("Largest deviations:", ...report.worst.map((w) => `  ${w.label}: ${percent(w.esr)}`));
  return lines;
}

export interface NeuralCloneOptions {
  profilePath: string;
  outputDir?: string;
  pluginName?: string;
  install?: boolean;
  refit?: boolean;
  skipVerify?: boolean;
  /** training time budget in minutes (default 20: ZamComp with 400 settings 17 % after 6 min, 4 % after 20) */
  minutes?: number;
  log: Logger;
  signal?: AbortSignal;
  onStage?: (stage: "analyse" | "gui" | "build" | "verify" | "gui-verify" | "save") => void;
  onProgress?: (done: number, total: number, label: string) => void;
  gui?: boolean;
  refitGui?: boolean;
  pluginPath?: string;
}

export interface NeuralCloneResult {
  model: NeuralModel & { trainEsr?: number; validateEsr?: number };
  build: BuildResult;
  verify?: NeuralVerifyReport;
  gui?: { controls: number; comparison?: GuiComparison };
}

/** train → (editor) → build → verify → store network and report in the profile */
export async function cloneNeuralProfile(options: NeuralCloneOptions): Promise<NeuralCloneResult> {
  const { log } = options;
  const profile = await readProfile(options.profilePath);
  const pluginName = options.pluginName ?? `${profile.manifest.plugin.name} Clone`;
  const stage = options.onStage ?? (() => {});
  if (profile.manifest.capture.plan?.planner !== "neural") {
    log("warn", "This profile was not measured for the universal clone (all controls at random) – the network learns from what is there, but unseen combinations will be less exact");
  }

  stage("analyse");
  let model = options.refit ? undefined : storedNeuralModel(profile);
  if (model) log("info", "Using the network stored in the profile");
  else {
    log("info", `Training the network on ${profile.captures.renders.length} measurements of ${profile.manifest.plugin.name} (${options.minutes ?? 20} min) …`);
    const trained = await trainNeural(profile, {
      log,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.minutes ? { minutes: options.minutes } : {}),
    });
    model = { ...trained.model, trainEsr: trained.trainEsr, ...(trained.validateEsr !== undefined ? { validateEsr: trained.validateEsr } : {}) };
  }
  for (const line of formatNeuralModel(model)) log("info", line);

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
        const captured = await captureGuiLayout(profile, pluginPath, {
          log,
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

  const { header, params } = generateNeuralHeader(model, profile.parameters.parameters, pluginName, profile.captures.renders);
  stage("build");
  const build = await buildPlugin({
    pluginName,
    modelHeader: header,
    guiHeader: generateGuiHeader(guiModel, params, profile.manifest.plugin.name),
    template: "neural",
    outputDir: options.outputDir ?? join(process.cwd(), slugify(pluginName)),
    ...(options.install ? { install: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });

  let verify: NeuralVerifyReport | undefined;
  if (!options.skipVerify) {
    stage("verify");
    verify = await verifyNeuralClone(profile, model, build.vst3, { log, ...(options.signal ? { signal: options.signal } : {}) });
    for (const line of formatNeuralVerify(verify)) log("info", line);
  }

  let gui: NeuralCloneResult["gui"];
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
  profile.files.set(NEURAL_MODEL_FILE, strToU8(JSON.stringify({ ...model, revision: NEURAL_REVISION })));
  profile.files.set(NEURAL_REPORT_FILE, strToU8(JSON.stringify({
    createdAt: new Date().toISOString(),
    pluginName,
    model: { trainEsr: model.trainEsr, validateEsr: model.validateEsr, hidden: model.hidden, parameters: model.names },
    ...(verify ? { verify } : {}),
  }, null, 1)));
  await writeProfile(options.profilePath, profile);
  log("info", `Model and report saved in the profile: ${options.profilePath}`);
  return { model, build, ...(verify ? { verify } : {}), ...(gui ? { gui } : {}) };
}
