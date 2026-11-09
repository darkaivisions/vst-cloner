import { readProfile, writeProfile, type Profile } from "@vst-cloner/profile";
import { strFromU8, strToU8 } from "fflate";
import { join } from "node:path";
import { buildPlugin, slugify, type BuildResult, type Logger } from "./build.ts";
import { generateModelHeader } from "./eq/codegen.ts";
import { fitEq } from "./eq/fit.ts";
import type { EqModel, FitStats } from "./eq/model.ts";
import { verifyClone, type VerifyReport } from "./verify.ts";

export const MODEL_FILE = "model/eq.json";
export const REPORT_FILE = "report.json";

export function verdict(rmsDb: number): string {
  if (rmsDb < 0.25) return "ausgezeichnet";
  if (rmsDb < 0.5) return "sehr gut";
  if (rmsDb < 1) return "gut";
  if (rmsDb < 3) return "angenähert";
  return "abweichend";
}

export function storedModel(profile: Profile): EqModel | undefined {
  const data = profile.files.get(MODEL_FILE);
  return data ? (JSON.parse(strFromU8(data)) as EqModel) : undefined;
}

export function analyze(profile: Profile, log: Logger): EqModel {
  log("info", `${profile.captures.renders.length} Messungen von ${profile.manifest.plugin.name} werden analysiert …`);
  const model = fitEq(profile, (p) => log("detail", `Filterform ${p.index + 1}/${p.total}: ${p.shape}`));
  const bands = model.mapping.bands.length;
  log("info", `Parametrischer EQ erkannt: ${bands} ${bands === 1 ? "Band" : "Bänder"}, ${model.shapes.length} Filterform${model.shapes.length === 1 ? "" : "en"}`);
  return model;
}

const stat = (s: FitStats | undefined) => (s ? `${s.rmsDb.toFixed(2)} dB (max ${s.maxDb.toFixed(1)})` : "–");

export function formatModelReport(model: EqModel): string[] {
  const lines = ["Form           Filterdesign                      Fit-Fehler         Gegenprobe         Bewertung"];
  for (const r of model.report.shapes) {
    if (!r.fit) {
      lines.push(`${r.label.padEnd(14)} ${"–".padEnd(33)} ${"–".padEnd(18)} ${"–".padEnd(18)} ${r.note ?? ""}`);
      continue;
    }
    const f = r.fit;
    const parts = [f.design, `f×${f.freqScale.toFixed(3)}`, `Q×${f.qScale.toFixed(3)}`];
    if (f.qExponent !== undefined) parts.push(`Q^${f.qExponent.toFixed(2)}`);
    if (f.gainScale !== undefined) parts.push(`gain×${f.gainScale}`);
    if (f.qMode) parts.push(f.qMode);
    if (f.tiltOrder) parts.push(`order ${f.tiltOrder}`);
    const check = r.validate ?? r.train;
    lines.push(`${r.label.padEnd(14)} ${parts.join(" ").padEnd(33)} ${stat(r.train).padEnd(18)} ${stat(r.validate).padEnd(18)} ${check ? verdict(check.rmsDb) : ""}`);
    if (r.approximate) lines.push(`${"".padEnd(14)} ${r.note ?? "angenähert"}: ${stat(r.approximate)}`);
  }
  const flat = model.report.baselineFlatnessDb;
  lines.push(`Referenz (alle Bänder aus): Versatz ${model.baselineDb.toFixed(2)} dB, Welligkeit ${flat.toFixed(3)} dB`);
  const mapping = Math.max(0, ...model.report.mappingErrors.map((m) => m.maxRelativeError));
  lines.push(`Regelkurven: größte Abweichung der Anzeigetabelle ${(mapping * 100).toFixed(2)} %`);
  return lines;
}

export function formatVerifyReport(report: VerifyReport): string[] {
  const lines = [`Klon vs. Original (${report.overall.renders} Einstellungen): ${stat(report.overall)} – ${verdict(report.overall.rmsDb)}`];
  for (const s of report.shapes) lines.push(`  ${s.label.padEnd(14)} ${stat(s).padEnd(20)} ${verdict(s.rmsDb)}`);
  if (report.limited) {
    lines.push(`Nicht exakt nachgebildet (${report.limited.renders} Einstellungen: ${report.limited.labels.join(", ")}): ${stat(report.limited)}`);
  }
  lines.push("Größte Abweichungen:");
  for (const w of report.worst) lines.push(`  ${w.label}: ${w.rmsDb.toFixed(2)} dB (max ${w.maxDb.toFixed(1)})`);
  return lines;
}

export interface CloneOptions {
  profilePath: string;
  outputDir?: string;
  pluginName?: string;
  install?: boolean;
  /** refit even if the profile already contains a model */
  refit?: boolean;
  /** skip rendering the built clone */
  skipVerify?: boolean;
  log: Logger;
  signal?: AbortSignal;
  /** called when a new phase starts */
  onStage?: (stage: CloneStage) => void;
}

export type CloneStage = "analyse" | "build" | "verify" | "save";

export interface CloneResult {
  model: EqModel;
  build: BuildResult;
  verify?: VerifyReport;
}

/** Complete workflow: analyse → build → verify → store model and report in the profile. */
export async function cloneProfile(options: CloneOptions): Promise<CloneResult> {
  const { log } = options;
  const profile = await readProfile(options.profilePath);
  const pluginName = options.pluginName ?? `${profile.manifest.plugin.name} Clone`;

  const stage = options.onStage ?? (() => {});
  stage("analyse");
  let model = options.refit ? undefined : storedModel(profile);
  if (model) log("info", "Im Profil gespeichertes Modell wird verwendet");
  else {
    model = analyze(profile, log);
    for (const line of formatModelReport(model)) log("info", line);
  }

  const { header } = generateModelHeader(model, profile.parameters.parameters, pluginName);
  stage("build");
  const build = await buildPlugin({
    pluginName,
    modelHeader: header,
    outputDir: options.outputDir ?? join(process.cwd(), `${slugify(pluginName)}`),
    ...(options.install ? { install: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });

  let verify: VerifyReport | undefined;
  if (!options.skipVerify) {
    stage("verify");
    verify = await verifyClone(profile, model, build.vst3, { log, ...(options.signal ? { signal: options.signal } : {}) });
    for (const line of formatVerifyReport(verify)) log("info", line);
  }

  stage("save");
  profile.files.set(MODEL_FILE, strToU8(JSON.stringify(model, null, 1)));
  profile.files.set(
    REPORT_FILE,
    strToU8(JSON.stringify({ createdAt: new Date().toISOString(), pluginName, model: model.report, ...(verify ? { verify } : {}) }, null, 1)),
  );
  await writeProfile(options.profilePath, profile);
  log("info", `Modell und Bericht im Profil gespeichert: ${options.profilePath}`);

  return { model, build, ...(verify ? { verify } : {}) };
}
