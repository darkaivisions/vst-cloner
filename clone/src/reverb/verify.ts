import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInfo, regenerateTestSignal, runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav, type Profile } from "@vst-cloner/profile";
import type { Logger } from "../build.ts";
import type { Errors } from "../dynamics/fit.ts";
import { cloneValue, dynamicsCloneParameters, modelValue } from "../dynamics/params.ts";
import { tailCorrelation, compareReverbs, describeModel, describeResponse, predictReverb, reverbInput, reverbObservations, reverbResponse, type ReverbModel } from "./fit.ts";

export interface ReverbVerifyReport {
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
  /** stereo width: mean difference of the tails' side-to-mid energy, clone against original (dB) */
  widthDb?: number;
}

const mean = (rows: Errors[]): Errors | undefined =>
  rows.length ? { rmsDb: rows.reduce((s, r) => s + r.rmsDb, 0) / rows.length, maxDb: Math.max(...rows.map((r) => r.maxDb)) } : undefined;

/** Renders the clone with every captured setting and compares its tail (level and decay per band) with the original's. */
export async function verifyReverbClone(
  profile: Profile,
  model: ReverbModel,
  clonePath: string,
  options: { log: Logger; hostPath?: string; signal?: AbortSignal },
): Promise<ReverbVerifyReport> {
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
    // two channels (the same input on both): the stereo width of the tails is compared too
    channels: 2,
    prerollSeconds: 0.1,
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
    await writeFile(join(workDir, "input.wav"), encodeWav({ sampleRate: audio.sampleRate, channels: [audio.channels[0]!, audio.channels[0]!] }));
    await writeFile(join(workDir, "job.json"), JSON.stringify(job));
    log("info", `Measuring the clone with ${renders.length} measured settings …`);
    await runHost(["render", join(workDir, "job.json")], host);

    const input = reverbInput(profile);
    const rows: { label: string; purpose: string; errors: Errors }[] = [];
    let engineMaxDb = 0, engineWorst = "";
    const widths: number[] = [];
    for (const o of reverbObservations(profile, input)) {
      const outputs = decodeWav(await readFile(join(workDir, "out", `${o.renderId}.wav`))).channels;
      const output = outputs[0]!;
      const response = reverbResponse(output, input);
      if (outputs.length > 1 && o.measured.correlation !== undefined) {
        // side-to-mid energy of a tail of this correlation (dB), clone against original
        const sideDb = (r: number) => 10 * Math.log10(Math.max(1e-4, 1 - r) / Math.max(1e-4, 1 + r));
        const own = tailCorrelation(response, reverbResponse(outputs[1]!, input), input.sampleRate, o.measured.onsetSeconds + 0.02);
        widths.push(Math.abs(sideDb(own) - sideDb(o.measured.correlation)));
      }
      if (response.some((x) => !Number.isFinite(x))) throw new Error(`The clone gives no valid signal (NaN/inf) at "${o.label}"`);
      const clone = describeResponse(response, sampleRate);
      rows.push({ label: o.label, purpose: o.purpose, errors: compareReverbs(clone, o.measured) });

      // reference: the TypeScript model (exactly what the plugin must do)
      const params = predictReverb(model, new Map(o.params.map((p) => [p.index, asModel.get(p.index)?.(p.value) ?? p.value])));
      const engine = compareReverbs(clone, describeModel(params, model.structure, input));
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
      ...(widths.length ? { widthDb: widths.reduce((a, b) => a + b, 0) / widths.length } : {}),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
