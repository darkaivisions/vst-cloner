import { join } from "node:path";
import { readProfile, writeProfile, type Profile } from "@vst-cloner/profile";
import { strFromU8, strToU8 } from "fflate";
import { buildPlugin, slugify, type BuildResult, type Logger } from "../build.ts";
import { generateDynamicsHeader } from "./codegen.ts";
import { fitDynamics, type DynamicsModel } from "./fit.ts";
import { verifyDynamicsClone, type DynamicsVerifyReport } from "./verify.ts";

export const DYNAMICS_MODEL_FILE = "model/dynamics.json";
export const DYNAMICS_REPORT_FILE = "report.json";
/** Raised whenever the dynamics fit changes; older stored models are fitted again. */
export const DYNAMICS_FIT_REVISION = 3; // 2: detector averaging time, 3: saturation and detector ripple

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
const verdict = (rms: number) => (rms < 0.5 ? "ausgezeichnet" : rms < 1 ? "sehr gut" : rms < 2 ? "gut" : rms < 4 ? "brauchbar" : "ungenau");

export function formatDynamicsModel(model: DynamicsModel): string[] {
  const p = model.base;
  const lines = [
    `Kompressor: ${model.structure.detector === "rms" ? "RMS" : "Spitzenwert"}-Detektor, ${model.structure.topology === "feedforward" ? "Feed-forward" : "Feedback"}`,
    `Grundeinstellung: Schwelle ${p.thresholdDb.toFixed(1)} dB, Verhältnis ${p.ratio.toFixed(2)}:1, Knick ${p.kneeDb.toFixed(1)} dB, Pegel ${p.makeupDb >= 0 ? "+" : ""}${p.makeupDb.toFixed(1)} dB`,
    `Zeitverhalten: Detektor ${(p.detectorTime * 1000).toFixed(1)} ms, Attack ${(p.attack * 1000).toFixed(1)} ms, Release ${(p.release * 1000).toFixed(0)} ms` +
      (p.charge > 0 ? `, Speicher lädt in ${(p.charge * 1000).toFixed(0)} ms, baut mit ${p.slow.toFixed(1)} dB/s ab` : ""),
    `Klangfarbe: Sättigung ${p.drive > 0 ? `Drive ${p.drive.toFixed(2)}` : "aus"}, Detektor-Welligkeit ${(p.ripple * 100).toFixed(1)} % (${(p.rippleTime * 1000).toFixed(1)} ms)`,
    `Parameter: ${model.tables.map((t) => t.name).join(", ")}`,
  ];
  if (model.report.train) lines.push(`Modell vs. Original (Einzelparameter): ${db(model.report.train.rmsDb)} (max ${model.report.train.maxDb.toFixed(1)}) – ${verdict(model.report.train.rmsDb)}`);
  if (model.report.validate) lines.push(`Vorhersage unbekannter Kombinationen: ${db(model.report.validate.rmsDb)} (max ${model.report.validate.maxDb.toFixed(1)}) – ${verdict(model.report.validate.rmsDb)}`);
  return lines;
}

export function formatDynamicsVerify(report: DynamicsVerifyReport): string[] {
  const lines = [`Klon vs. Original (${report.renders} Einstellungen): ${db(report.overall.rmsDb)} (max ${report.overall.maxDb.toFixed(1)}) – ${verdict(report.overall.rmsDb)}`];
  if (report.validate) lines.push(`  davon unbekannte Kombinationen: ${db(report.validate.rmsDb)} (max ${report.validate.maxDb.toFixed(1)})`);
  lines.push("Größte Abweichungen:", ...report.worst.map((w) => `  ${w.label}: ${db(w.rmsDb)} (max ${w.maxDb.toFixed(1)})`));
  if (report.engineMaxDb > 0.1) lines.push(`Achtung: Plugin weicht vom Referenzmodell ab (max ${report.engineMaxDb.toFixed(2)} dB, ${report.engineWorst})`);
  return lines;
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
  onStage?: (stage: "analyse" | "build" | "verify" | "save") => void;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface DynamicsCloneResult {
  model: DynamicsModel;
  build: BuildResult;
  verify?: DynamicsVerifyReport;
}

/** analyse → build → verify → store model and report in the profile */
export async function cloneDynamicsProfile(options: DynamicsCloneOptions): Promise<DynamicsCloneResult> {
  const { log } = options;
  const profile = await readProfile(options.profilePath);
  const pluginName = options.pluginName ?? `${profile.manifest.plugin.name} Clone`;
  const stage = options.onStage ?? (() => {});

  stage("analyse");
  let model = options.refit ? undefined : storedDynamicsModel(profile);
  if (model) log("info", "Im Profil gespeichertes Modell wird verwendet");
  else {
    log("info", `${profile.captures.renders.length} Messungen von ${profile.manifest.plugin.name} werden analysiert …`);
    model = fitDynamics(profile, options.onProgress);
  }
  for (const line of formatDynamicsModel(model)) log("info", line);

  const { header } = generateDynamicsHeader(model, profile.parameters.parameters, pluginName, profile.captures.renders);
  stage("build");
  const build = await buildPlugin({
    pluginName,
    modelHeader: header,
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

  stage("save");
  profile.files.set(DYNAMICS_MODEL_FILE, strToU8(JSON.stringify({ ...model, fitRevision: DYNAMICS_FIT_REVISION })));
  profile.files.set(DYNAMICS_REPORT_FILE, strToU8(JSON.stringify({ createdAt: new Date().toISOString(), pluginName, model: model.report, ...(verify ? { verify } : {}) }, null, 1)));
  await writeProfile(options.profilePath, profile);
  log("info", `Modell und Bericht im Profil gespeichert: ${options.profilePath}`);
  return { model, build, ...(verify ? { verify } : {}) };
}
