import { existsSync } from "node:fs";
import { join } from "node:path";
import { readProfile, writeProfile, type Profile } from "@vst-cloner/profile";
import { strFromU8, strToU8 } from "fflate";
import { buildPlugin, slugify, type BuildResult, type Logger } from "../build.ts";
import { virtualDisplayAvailable } from "../gui/capture.ts";
import { generateGuiHeader } from "../gui/codegen.ts";
import type { GuiModel } from "../gui/model.ts";
import { captureGuiLayout, compareGui, GUI_MODEL_FILE, guiCacheDir, locatePlugin, type GuiComparison } from "../gui/workflow.ts";
import { generateDistortionHeader } from "./codegen.ts";
import { fitDistortion, type DistortionErrors, type DistortionModel } from "./fit.ts";
import { verifyDistortionClone, type DistortionVerifyReport } from "./verify.ts";

export const DISTORTION_MODEL_FILE = "model/distortion.json";
/** Raised whenever the distortion fit changes; older stored models are fitted again. */
export const DISTORTION_FIT_REVISION = 2; // 2: delay of the original

export function isDistortionProfile(profile: Profile): boolean {
  return profile.manifest.capture.plan?.planner === "distortion" || profile.files.has(DISTORTION_MODEL_FILE);
}

export function storedDistortionModel(profile: Profile): DistortionModel | undefined {
  const data = profile.files.get(DISTORTION_MODEL_FILE);
  if (!data) return undefined;
  const model = JSON.parse(strFromU8(data)) as DistortionModel & { fitRevision?: number };
  return (model.fitRevision ?? 0) >= DISTORTION_FIT_REVISION ? model : undefined;
}

/** Rating from the combined error of the measured characteristics (dB). */
export const distortionVerdict = (total: number) => (total < 1 ? "ausgezeichnet" : total < 2 ? "sehr gut" : total < 3 ? "gut" : total < 5 ? "brauchbar" : "ungenau");

const errorLine = (e: DistortionErrors) =>
  `Kleinsignal ${e.smallDb.toFixed(2)} dB, Grundton ${e.gainDb.toFixed(2)} dB, Oberwellen ${e.harmonicsDb.toFixed(1)} dB`;

const GROUP_NAMES: Record<string, string> = { input: "Eingang", pre: "Vorfilter", clip: "Kennlinie", post: "Klangregelung", output: "Ausgang" };

export function formatDistortionModel(model: DistortionModel): string[] {
  const p = model.base;
  const lines = [
    `Verzerrer: Vorfilter → Kennlinie (Härte ${p.hardness.toFixed(1)}, Asymmetrie ${(p.clipNeg / p.clipPos).toFixed(2)}) → Klangregelung` +
      (model.delay ? `, Verzögerung ${model.delay} Samples wie das Original` : ""),
    ...(model.report.groups ?? []).map((g) => `Regler ${g.name}: wirkt auf ${g.groups.map((x) => GROUP_NAMES[x] ?? x).join(" + ")}`),
  ];
  if (model.report.train) lines.push(`Modell vs. Original (Einzelregler): ${errorLine(model.report.train)} – ${distortionVerdict(model.report.train.total)}`);
  if (model.report.validate) lines.push(`Vorhersage unbekannter Kombinationen: ${errorLine(model.report.validate)} – ${distortionVerdict(model.report.validate.total)}`);
  return lines;
}

export function formatDistortionVerify(report: DistortionVerifyReport): string[] {
  const lines = [
    `Klon vs. Original (${report.renders} Einstellungen): ${errorLine(report.overall)} – ${distortionVerdict(report.overall.total)}`,
    `  Signalvergleich (lautes Rauschen): Fehler/Signal ${report.esrDb.toFixed(1)} dB`,
  ];
  if (report.validate) lines.push(`  davon unbekannte Kombinationen: ${errorLine(report.validate)}`);
  lines.push("Größte Abweichungen:", ...report.worst.map((w) => `  ${w.label}: ${w.total.toFixed(2)} (Fehler/Signal ${w.esrDb.toFixed(1)} dB)`));
  if (report.engineEsrDb > -60) lines.push(`Achtung: Plugin weicht vom Referenzmodell ab (Fehler/Signal ${report.engineEsrDb.toFixed(1)} dB, ${report.engineWorst})`);
  return lines;
}

export interface DistortionCloneOptions {
  profilePath: string;
  outputDir?: string;
  pluginName?: string;
  install?: boolean;
  refit?: boolean;
  skipVerify?: boolean;
  gui?: boolean;
  refitGui?: boolean;
  pluginPath?: string;
  log: Logger;
  signal?: AbortSignal;
  onStage?: (stage: "analyse" | "gui" | "build" | "verify" | "gui-verify" | "save") => void;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface DistortionCloneResult {
  model: DistortionModel;
  build: BuildResult;
  verify?: DistortionVerifyReport;
  gui?: { controls: number; comparison?: GuiComparison };
}

/** analyse → (editor) → build → verify → store model and report in the profile */
export async function cloneDistortionProfile(options: DistortionCloneOptions): Promise<DistortionCloneResult> {
  const { log } = options;
  const profile = await readProfile(options.profilePath);
  const pluginName = options.pluginName ?? `${profile.manifest.plugin.name} Clone`;
  const stage = options.onStage ?? (() => {});

  stage("analyse");
  let model = options.refit ? undefined : storedDistortionModel(profile);
  if (model) log("info", "Im Profil gespeichertes Modell wird verwendet");
  else {
    log("info", `${profile.captures.renders.length} Messungen von ${profile.manifest.plugin.name} werden analysiert (alle Kerne) …`);
    model = await fitDistortion(profile, options.onProgress);
  }
  for (const line of formatDistortionModel(model)) log("info", line);

  const stored = profile.files.get(GUI_MODEL_FILE);
  let guiModel = options.refitGui || !stored ? undefined : (JSON.parse(strFromU8(stored)) as GuiModel);
  let originalRaw = join(guiCacheDir(profile), "pass2", "base.rgba");
  if (guiModel) log("info", "Im Profil gespeicherte Oberfläche wird verwendet");
  else if (options.gui) {
    stage("gui");
    if (!virtualDisplayAvailable()) log("warn", "Oberfläche wird nicht nachgebaut: Xvfb fehlt (sudo pacman -S xorg-server-xvfb)");
    else {
      const pluginPath = options.pluginPath ?? (await locatePlugin(profile));
      if (!pluginPath) log("warn", "Oberfläche wird nicht nachgebaut: Original-Plugin nicht gefunden");
      else {
        const captured = await captureGuiLayout(profile, pluginPath, {
          log,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
        guiModel = captured.model;
        originalRaw = captured.originalRaw;
        profile.files.set(GUI_MODEL_FILE, strToU8(JSON.stringify(guiModel)));
      }
    }
  }

  const { header, params } = generateDistortionHeader(model, profile.parameters.parameters, pluginName, profile.captures.renders);
  stage("build");
  const build = await buildPlugin({
    pluginName,
    modelHeader: header,
    guiHeader: generateGuiHeader(guiModel, params),
    template: "distortion",
    outputDir: options.outputDir ?? join(process.cwd(), slugify(pluginName)),
    ...(options.install ? { install: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });

  let verify: DistortionVerifyReport | undefined;
  if (!options.skipVerify) {
    stage("verify");
    verify = await verifyDistortionClone(profile, model, build.vst3, { log, ...(options.signal ? { signal: options.signal } : {}) });
    for (const line of formatDistortionVerify(verify)) log("info", line);
  }

  let gui: DistortionCloneResult["gui"];
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
        log("warn", `Oberflächen-Vergleich nicht möglich: ${(error as Error).message}`);
      }
    }
  }

  stage("save");
  profile.files.set(DISTORTION_MODEL_FILE, strToU8(JSON.stringify({ ...model, fitRevision: DISTORTION_FIT_REVISION })));
  profile.files.set("report.json", strToU8(JSON.stringify({ createdAt: new Date().toISOString(), pluginName, model: model.report, ...(verify ? { verify } : {}) }, null, 1)));
  await writeProfile(options.profilePath, profile);
  log("info", `Modell und Bericht im Profil gespeichert: ${options.profilePath}`);
  return { model, build, ...(verify ? { verify } : {}), ...(gui ? { gui } : {}) };
}
