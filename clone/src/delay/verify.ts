import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInfo, regenerateTestSignal, runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav, type Profile } from "@vst-cloner/profile";
import type { Logger } from "../build.ts";
import type { Errors } from "../dynamics/fit.ts";
import { cloneValue, dynamicsCloneParameters, modelValue } from "../dynamics/params.ts";
import { clicksResponse, compareAnswers, delayInput, delayObservations, delayResponse, modelAnswer, predictDelayModel, type DelayModel } from "./fit.ts";

export interface DelayVerifyReport {
  clone: string;
  renders: number;
  /** clone vs. original over all renders */
  overall: Errors;
  train?: Errors;
  validate?: Errors;
  worst: { label: string; rmsDb: number; maxDb: number }[];
  /** clone vs. TypeScript model – differences between the C++ engine and the reference */
  engineMaxDb: number;
  engineWorst: string;
}

const mean = (rows: Errors[]): Errors | undefined =>
  rows.length ? { rmsDb: rows.reduce((s, r) => s + r.rmsDb, 0) / rows.length, maxDb: Math.max(...rows.map((r) => r.maxDb)) } : undefined;

/** Renders the clone with every captured setting and compares its impulse response with the original's. */
export async function verifyDelayClone(
  profile: Profile,
  model: DelayModel,
  clonePath: string,
  options: { log: Logger; hostPath?: string; signal?: AbortSignal },
): Promise<DelayVerifyReport> {
  const { log } = options;
  const sampleRate = profile.manifest.capture.sampleRate;
  const host = { ...(options.hostPath ? { hostPath: options.hostPath } : {}), ...(options.signal ? { signal: options.signal } : {}) };

  const info = await pluginInfo(clonePath, { sampleRate, ...host });
  const cloneIndexByName = new Map(info.parameters.map((p) => [p.name, p.index]));
  const toClone = new Map<number, number>();
  const convert = new Map<number, (value: number) => number>();
  const asModel = new Map<number, (value: number) => number>();
  const originals = new Map(profile.parameters.parameters.map((p) => [p.index, p]));
  for (const param of dynamicsCloneParameters(model, profile.parameters.parameters, profile.captures.renders)) {
    const index = cloneIndexByName.get(param.name);
    if (index === undefined) throw new Error(`The clone has no parameter "${param.name}"`);
    toClone.set(param.original, index);
    convert.set(param.original, (value) => cloneValue(param, originals.get(param.original), value));
    asModel.set(param.original, (value) => modelValue(param, originals.get(param.original), value));
  }

  const renders = profile.captures.renders;
  const job: RenderJob = {
    plugin: clonePath,
    sampleRate,
    blockSize: profile.manifest.capture.blockSize,
    channels: 1,
    // the pre-roll of the capture: an LFO is then in the same phase as the original's when the input begins
    prerollSeconds: profile.manifest.capture.prerollSeconds,
    tailSeconds: profile.manifest.capture.tailSeconds,
    input: "input.wav",
    renders: renders.map((r) => ({
      id: r.id,
      output: `out/${r.id}.wav`,
      params: r.params.flatMap((p) => (toClone.has(p.index) ? [{ index: toClone.get(p.index)!, value: convert.get(p.index)!(p.value) }] : [])),
    })),
  };

  const workDir = await mkdtemp(join(tmpdir(), "vch-verify-"));
  try {
    const { audio } = regenerateTestSignal(profile.testSignals);
    await writeFile(join(workDir, "input.wav"), encodeWav({ sampleRate: audio.sampleRate, channels: [audio.channels[0]!] }));
    await writeFile(join(workDir, "job.json"), JSON.stringify(job));
    log("info", `Measuring the clone with ${renders.length} measured settings …`);
    await runHost(["render", join(workDir, "job.json")], host);

    const input = delayInput(profile);
    const rows: { label: string; purpose: string; errors: Errors }[] = [];
    let engineMaxDb = 0, engineWorst = "";
    for (const o of delayObservations(profile, input)) {
      const output = decodeWav(await readFile(join(workDir, "out", `${o.renderId}.wav`))).channels[0]!;
      const response = delayResponse(output, input);
      if (response.some((v) => !Number.isFinite(v))) throw new Error(`The clone gives no valid signal (NaN/inf) at "${o.label}"`);
      const clicks = clicksResponse(output, input);
      const answer = { response, ...(clicks ? { clicks } : {}) };
      rows.push({ label: o.label, purpose: o.purpose, errors: compareAnswers(answer, o, input) });

      // reference: the TypeScript model (exactly what the plugin must do)
      const predicted = predictDelayModel(model, new Map(o.params.map((p) => [p.index, asModel.get(p.index)?.(p.value) ?? p.value])));
      const engine = compareAnswers(answer, modelAnswer(predicted.params, predicted.structure, input), input);
      if (engine.maxDb > engineMaxDb) {
        engineMaxDb = engine.maxDb;
        engineWorst = o.label;
      }
    }

    const train = mean(rows.filter((r) => r.purpose === "train").map((r) => r.errors));
    const validate = mean(rows.filter((r) => r.purpose === "validate").map((r) => r.errors));
    return {
      clone: clonePath,
      renders: rows.length,
      overall: mean(rows.map((r) => r.errors))!,
      ...(train ? { train } : {}),
      ...(validate ? { validate } : {}),
      worst: [...rows].sort((a, b) => b.errors.rmsDb - a.errors.rmsDb).slice(0, 5).map((r) => ({ label: r.label, ...r.errors })),
      engineMaxDb,
      engineWorst,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
