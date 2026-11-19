import { modActive } from "./model.ts";
import { join } from "node:path";
import { readProfile, writeProfile, type Profile } from "@vst-cloner/profile";
import { strFromU8, strToU8 } from "fflate";
import { buildPlugin, slugify, type BuildResult, type Logger } from "../build.ts";
import { generateGuiHeader } from "../gui/codegen.ts";
import { generateDelayHeader } from "./codegen.ts";
import { fitDelay, type DelayModel } from "./fit.ts";
import { hpActive, lpActive, OFF_DB } from "./model.ts";
import { verifyDelayClone, type DelayVerifyReport } from "./verify.ts";

export const DELAY_MODEL_FILE = "model/delay.json";
/** Raised whenever the delay fit changes; older stored models are fitted again. */
export const DELAY_FIT_REVISION = 2; // 2: models per switch position

export function isDelayProfile(profile: Profile): boolean {
  return profile.manifest.capture.plan?.planner === "delay" || profile.manifest.capture.plan?.planner === "modulation" || profile.files.has(DELAY_MODEL_FILE);
}

export function storedDelayModel(profile: Profile): DelayModel | undefined {
  const data = profile.files.get(DELAY_MODEL_FILE);
  if (!data) return undefined;
  const model = JSON.parse(strFromU8(data)) as DelayModel & { fitRevision?: number };
  return (model.fitRevision ?? 0) >= DELAY_FIT_REVISION ? model : undefined;
}

const db = (v: number) => `${v.toFixed(2)} dB`;
/** Rating of a delay clone: level of the impulse response over time and frequency band (dB). */
export const delayVerdict = (rms: number) => (rms < 1 ? "excellent" : rms < 2 ? "very good" : rms < 4 ? "good" : rms < 8 ? "usable" : "inaccurate");

const level = (v: number) => (v <= OFF_DB + 0.5 ? "off" : `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`);
const filter = (lp: number, hp: number) =>
  [hpActive(hp) ? `high-pass ${hp.toFixed(0)} Hz` : "", lpActive(lp) ? `low-pass ${lp.toFixed(0)} Hz` : ""].filter(Boolean).join(", ") || "no filter";

export function formatDelayModel(model: DelayModel): string[] {
  const p = model.base;
  const lines = [
    `Delay: ${(p.delaySeconds * 1000).toFixed(1)} ms, Feedback ${level(p.feedbackDb)}, dry ${level(p.dryDb)}, echo ${level(p.wetDb)} (${model.report.echoes} repeats measured)`,
    `Tone: echo – ${filter(p.wetLp, p.wetHp)}; feedback loop – ${filter(p.loopLp, p.loopHp)}`,
    ...(modActive(p) ? [`LFO: delay moves by ±${(p.modDepthSeconds! * 1000).toFixed(2)} ms at ${p.modRate!.toFixed(2)} Hz`] : []),
    `Parameter: ${model.tables.map((t) => t.name).join(", ")}`,
  ];
  if (model.variants?.length) lines.push(`Separate model for switch positions: ${model.variants.map((v) => v.name).join(", ")}`);
  if (model.report.echoes === 0) lines.push("Warning: no echo is audible in the base measurement – time, feedback and filters could not be determined");
  if (model.report.train) lines.push(`Model vs. original (single parameters): ${db(model.report.train.rmsDb)} (max ${model.report.train.maxDb.toFixed(1)}) – ${delayVerdict(model.report.train.rmsDb)}`);
  if (model.report.validate) lines.push(`Prediction of unseen combinations: ${db(model.report.validate.rmsDb)} (max ${model.report.validate.maxDb.toFixed(1)}) – ${delayVerdict(model.report.validate.rmsDb)}`);
  return lines;
}

export function formatDelayVerify(report: DelayVerifyReport): string[] {
  const lines = [`Clone vs. original (${report.renders} settings): ${db(report.overall.rmsDb)} (max ${report.overall.maxDb.toFixed(1)}) – ${delayVerdict(report.overall.rmsDb)}`];
  if (report.validate) lines.push(`  of which unseen combinations: ${db(report.validate.rmsDb)}`);
  lines.push("Largest deviations:", ...report.worst.map((w) => `  ${w.label}: ${db(w.rmsDb)} (max ${w.maxDb.toFixed(1)})`));
  if (report.engineMaxDb > 1) lines.push(`Warning: the plugin deviates from the reference model (max ${report.engineMaxDb.toFixed(2)} dB, ${report.engineWorst})`);
  return lines;
}

export interface DelayCloneOptions {
  profilePath: string;
  outputDir?: string;
  pluginName?: string;
  install?: boolean;
  refit?: boolean;
  skipVerify?: boolean;
  /** accepted like for the other classes; the editor of delays is not rebuilt yet */
  gui?: boolean;
  refitGui?: boolean;
  pluginPath?: string;
  log: Logger;
  signal?: AbortSignal;
  onStage?: (stage: "analyse" | "build" | "verify" | "save") => void;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface DelayCloneResult {
  model: DelayModel;
  build: BuildResult;
  verify?: DelayVerifyReport;
}

/** analyse → build → verify → store model and report in the profile */
export async function cloneDelayProfile(options: DelayCloneOptions): Promise<DelayCloneResult> {
  const { log } = options;
  const profile = await readProfile(options.profilePath);
  const pluginName = options.pluginName ?? `${profile.manifest.plugin.name} Clone`;
  const stage = options.onStage ?? (() => {});

  stage("analyse");
  let model = options.refit ? undefined : storedDelayModel(profile);
  if (model) log("info", "Using the model stored in the profile");
  else {
    log("info", `Analysing ${profile.captures.renders.length} measurements of ${profile.manifest.plugin.name} …`);
    model = fitDelay(profile, options.onProgress);
  }
  for (const line of formatDelayModel(model)) log("info", line);
  if (options.gui) log("warn", "The editor of delays is not rebuilt yet");

  const { header, params } = generateDelayHeader(model, profile.parameters.parameters, pluginName, profile.captures.renders);
  stage("build");
  const build = await buildPlugin({
    pluginName,
    modelHeader: header,
    guiHeader: generateGuiHeader(undefined, params),
    template: "delay",
    outputDir: options.outputDir ?? join(process.cwd(), slugify(pluginName)),
    ...(options.install ? { install: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });

  let verify: DelayVerifyReport | undefined;
  if (!options.skipVerify) {
    stage("verify");
    verify = await verifyDelayClone(profile, model, build.vst3, { log, ...(options.signal ? { signal: options.signal } : {}) });
    for (const line of formatDelayVerify(verify)) log("info", line);
  }

  stage("save");
  profile.files.set(DELAY_MODEL_FILE, strToU8(JSON.stringify({ ...model, fitRevision: DELAY_FIT_REVISION })));
  profile.files.set("report.json", strToU8(JSON.stringify({ createdAt: new Date().toISOString(), pluginName, model: model.report, ...(verify ? { verify } : {}) }, null, 1)));
  await writeProfile(options.profilePath, profile);
  log("info", `Model and report saved in the profile: ${options.profilePath}`);
  return { model, build, ...(verify ? { verify } : {}) };
}
