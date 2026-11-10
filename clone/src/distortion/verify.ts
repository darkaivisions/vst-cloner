import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInfo, runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav, type Profile } from "@vst-cloner/profile";
import type { Logger } from "../build.ts";
import { cloneValue, dynamicsCloneParameters, modelValue } from "../dynamics/params.ts";
import {
  compareDistortion,
  distortionInput,
  distortionObservations,
  measureOutput,
  predictDistortion,
  processDistortion,
  type DistortionErrors,
  type DistortionModel,
} from "./fit.ts";

export interface DistortionVerifyReport {
  clone: string;
  renders: number;
  overall: DistortionErrors;
  train?: DistortionErrors;
  validate?: DistortionErrors;
  /** time-domain error-to-signal ratio clone vs. original on the loud noise (dB; −20 dB = 1 %) */
  esrDb: number;
  worst: { label: string; total: number; esrDb: number }[];
  /** clone vs. TypeScript model, ESR (dB) – differences between the C++ engine and the reference */
  engineEsrDb: number;
  engineWorst: string;
}

const esrDb = (reference: ArrayLike<number>, other: ArrayLike<number>, from: number, to: number) => {
  let e = 0, s = 0;
  for (let i = from; i < to; i++) {
    e += (other[i]! - reference[i]!) ** 2;
    s += reference[i]! ** 2;
  }
  return 10 * Math.log10(e / (s + 1e-30) + 1e-20);
};

const mean = (rows: DistortionErrors[]): DistortionErrors | undefined => {
  if (!rows.length) return undefined;
  const avg = (k: keyof DistortionErrors) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  return { smallDb: avg("smallDb"), gainDb: avg("gainDb"), harmonicsDb: avg("harmonicsDb"), total: avg("total") };
};

/** Renders the clone with every captured setting and compares it with the original. */
export async function verifyDistortionClone(
  profile: Profile,
  model: DistortionModel,
  clonePath: string,
  options: { log: Logger; hostPath?: string; signal?: AbortSignal },
): Promise<DistortionVerifyReport> {
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
    if (index === undefined) throw new Error(`Der Klon hat keinen Parameter „${param.name}“`);
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
    const input = distortionInput(profile);
    await writeFile(join(workDir, "input.wav"), encodeWav({ sampleRate, channels: [input.signal] }));
    await writeFile(join(workDir, "job.json"), JSON.stringify(job));
    log("info", `Klon wird mit ${renders.length} gemessenen Einstellungen nachgemessen …`);
    await runHost(["render", join(workDir, "job.json")], host);

    const observations = distortionObservations(profile, input);
    const noise = profile.testSignals.segments.find((s) => s.id === "noise-loud");
    const from = noise?.start ?? 0, to = noise ? noise.start + noise.length : input.signal.length;
    const rows: { label: string; purpose: string; errors: DistortionErrors; esrDb: number }[] = [];
    let engineEsrDb = -Infinity, engineWorst = "";
    for (const o of observations) {
      const clone = decodeWav(await readFile(join(workDir, "out", `${o.renderId}.wav`))).channels[0]!;
      const original = decodeWav(profile.files.get(renders.find((r) => r.id === o.renderId)!.file)!).channels[0]!;
      rows.push({ label: o.label, purpose: o.purpose, errors: compareDistortion(measureOutput(input, clone), o), esrDb: esrDb(original, clone, from, to) });
      const reference = processDistortion(input.signal, predictDistortion(model, new Map(o.params.map((p) => [p.index, asModel.get(p.index)?.(p.value) ?? p.value]))), sampleRate, model.delay ?? 0);
      const engine = esrDb(reference, clone, 0, Math.min(reference.length, clone.length));
      if (engine > engineEsrDb) {
        engineEsrDb = engine;
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
      esrDb: 10 * Math.log10(rows.reduce((s, r) => s + 10 ** (r.esrDb / 10), 0) / rows.length),
      worst: [...rows].sort((a, b) => b.errors.total - a.errors.total).slice(0, 5).map((r) => ({ label: r.label, total: r.errors.total, esrDb: r.esrDb })),
      engineEsrDb,
      engineWorst,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
