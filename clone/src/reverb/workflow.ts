import { join } from "node:path";
import { readProfile, writeProfile, type Profile } from "@vst-cloner/profile";
import { strFromU8, strToU8 } from "fflate";
import { buildPlugin, slugify, type BuildResult, type Logger } from "../build.ts";
import { generateGuiHeader } from "../gui/codegen.ts";
import { generateReverbHeader } from "./codegen.ts";
import { fitReverb, type ReverbModel } from "./fit.ts";
import { REVERB_OFF_DB } from "./model.ts";
import { verifyReverbClone, type ReverbVerifyReport } from "./verify.ts";

export const REVERB_MODEL_FILE = "model/reverb.json";
/** Raised whenever the reverb fit changes; older stored models are fitted again. */
export const REVERB_FIT_REVISION = 1;

export function isReverbProfile(profile: Profile): boolean {
  return profile.manifest.capture.plan?.planner === "reverb" || profile.files.has(REVERB_MODEL_FILE);
}

export function storedReverbModel(profile: Profile): ReverbModel | undefined {
  const data = profile.files.get(REVERB_MODEL_FILE);
  if (!data) return undefined;
  const model = JSON.parse(strFromU8(data)) as ReverbModel & { fitRevision?: number };
  return (model.fitRevision ?? 0) >= REVERB_FIT_REVISION ? model : undefined;
}

const db = (v: number) => `${v.toFixed(2)} dB`;
/** Rating of a reverb clone: decay curves per band (dB). A tail is matched as it is heard, not sample by sample. */
export const reverbVerdict = (rms: number) => (rms < 1 ? "excellent" : rms < 2 ? "very good" : rms < 4 ? "good" : rms < 8 ? "usable" : "inaccurate");

export function formatReverbModel(model: ReverbModel): string[] {
  const p = model.base;
  const lines = [
    `Reverb: decay time ${p.rt.map((t) => `${t.toFixed(2)} s`).join(" / ")} (low / mid / high), pre-delay ${(p.predelaySeconds * 1000).toFixed(0)} ms, ` +
      `dry ${p.dryDb <= REVERB_OFF_DB + 0.5 ? "off" : `${p.dryDb.toFixed(1)} dB`}`,
    `Parameter: ${model.tables.map((t) => t.name).join(", ")}`,
  ];
  if (!model.report.tail) lines.push("Warning: no reverb tail is audible in the base measurement – the reverb could not be determined");
  if (model.report.train) lines.push(`Model vs. original (single parameters): ${db(model.report.train.rmsDb)} (max ${model.report.train.maxDb.toFixed(1)}) – ${reverbVerdict(model.report.train.rmsDb)}`);
  if (model.report.validate) lines.push(`Prediction of unseen combinations: ${db(model.report.validate.rmsDb)} (max ${model.report.validate.maxDb.toFixed(1)}) – ${reverbVerdict(model.report.validate.rmsDb)}`);
  return lines;
}

export function formatReverbVerify(report: ReverbVerifyReport): string[] {
  const lines = [`Clone vs. original (${report.renders} settings): ${db(report.overall.rmsDb)} (max ${report.overall.maxDb.toFixed(1)}) – ${reverbVerdict(report.overall.rmsDb)}`];
  if (report.validate) lines.push(`  of which unseen combinations: ${db(report.validate.rmsDb)}`);
  lines.push("Largest deviations:", ...report.worst.map((w) => `  ${w.label}: ${db(w.rmsDb)} (max ${w.maxDb.toFixed(1)})`));
  if (report.widthDb !== undefined) lines.push(`  Stereo width: the tails' side signal deviates by ${report.widthDb.toFixed(1)} dB on average`);
  if (report.engineMaxDb > 1) lines.push(`Warning: the plugin deviates from the reference model (max ${report.engineMaxDb.toFixed(2)} dB, ${report.engineWorst})`);
  return lines;
}

export interface ReverbCloneOptions {
  profilePath: string;
  outputDir?: string;
  pluginName?: string;
  install?: boolean;
  refit?: boolean;
  skipVerify?: boolean;
  /** accepted like for the other classes; the editor of reverbs is not rebuilt yet */
  gui?: boolean;
  refitGui?: boolean;
  pluginPath?: string;
  log: Logger;
  signal?: AbortSignal;
  onStage?: (stage: "analyse" | "build" | "verify" | "save") => void;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface ReverbCloneResult {
  model: ReverbModel;
  build: BuildResult;
  verify?: ReverbVerifyReport;
}

/** analyse → build → verify → store model and report in the profile */
export async function cloneReverbProfile(options: ReverbCloneOptions): Promise<ReverbCloneResult> {
  const { log } = options;
  const profile = await readProfile(options.profilePath);
  const pluginName = options.pluginName ?? `${profile.manifest.plugin.name} Clone`;
  const stage = options.onStage ?? (() => {});

  stage("analyse");
  let model = options.refit ? undefined : storedReverbModel(profile);
  if (model) log("info", "Using the model stored in the profile");
  else {
    log("info", `Analysing ${profile.captures.renders.length} measurements of ${profile.manifest.plugin.name} …`);
    model = fitReverb(profile, options.onProgress);
  }
  for (const line of formatReverbModel(model)) log("info", line);
  if (options.gui) log("warn", "The editor of reverbs is not rebuilt yet");

  const { header, params } = generateReverbHeader(model, profile.parameters.parameters, pluginName, profile.captures.renders);
  stage("build");
  const build = await buildPlugin({
    pluginName,
    modelHeader: header,
    guiHeader: generateGuiHeader(undefined, params),
    template: "reverb",
    outputDir: options.outputDir ?? join(process.cwd(), slugify(pluginName)),
    ...(options.install ? { install: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });

  let verify: ReverbVerifyReport | undefined;
  if (!options.skipVerify) {
    stage("verify");
    verify = await verifyReverbClone(profile, model, build.vst3, { log, ...(options.signal ? { signal: options.signal } : {}) });
    for (const line of formatReverbVerify(verify)) log("info", line);
  }

  stage("save");
  profile.files.set(REVERB_MODEL_FILE, strToU8(JSON.stringify({ ...model, fitRevision: REVERB_FIT_REVISION })));
  profile.files.set("report.json", strToU8(JSON.stringify({ createdAt: new Date().toISOString(), pluginName, model: model.report, ...(verify ? { verify } : {}) }, null, 1)));
  await writeProfile(options.profilePath, profile);
  log("info", `Model and report saved in the profile: ${options.profilePath}`);
  return { model, build, ...(verify ? { verify } : {}) };
}
