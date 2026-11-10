import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInfo, regenerateTestSignal, runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav, type Profile } from "@vst-cloner/profile";
import type { Logger } from "../build.ts";
import { compare, dynamicsInput, dynamicsObservations, predictModel, windowRmsDb, type DynamicsModel, type Errors } from "./fit.ts";
import { sampleGains, simulateGain } from "./model.ts";
import { dynamicsCloneParameters } from "./params.ts";

export interface DynamicsVerifyReport {
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

/** Renders the clone with every captured setting and compares the gain over time with the original. */
export async function verifyDynamicsClone(
  profile: Profile,
  model: DynamicsModel,
  clonePath: string,
  options: { log: Logger; hostPath?: string; signal?: AbortSignal },
): Promise<DynamicsVerifyReport> {
  const { log } = options;
  const sampleRate = profile.manifest.capture.sampleRate;
  const host = { ...(options.hostPath ? { hostPath: options.hostPath } : {}), ...(options.signal ? { signal: options.signal } : {}) };

  const info = await pluginInfo(clonePath, { sampleRate, ...host });
  const cloneIndexByName = new Map(info.parameters.map((p) => [p.name, p.index]));
  const toClone = new Map<number, number>();
  for (const param of dynamicsCloneParameters(model, profile.parameters.parameters, profile.captures.renders)) {
    const index = cloneIndexByName.get(param.name);
    if (index === undefined) throw new Error(`Der Klon hat keinen Parameter „${param.name}“`);
    toClone.set(param.original, index);
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
      params: r.params.flatMap((p) => (toClone.has(p.index) ? [{ index: toClone.get(p.index)!, value: p.value }] : [])),
    })),
  };

  const workDir = await mkdtemp(join(tmpdir(), "vch-verify-"));
  try {
    const { audio } = regenerateTestSignal(profile.testSignals);
    await writeFile(join(workDir, "input.wav"), encodeWav({ sampleRate: audio.sampleRate, channels: [audio.channels[0]!] }));
    await writeFile(join(workDir, "job.json"), JSON.stringify(job));
    log("info", `Klon wird mit ${renders.length} gemessenen Einstellungen nachgemessen …`);
    await runHost(["render", join(workDir, "job.json")], host);

    const input = dynamicsInput(profile);
    const signal = audio.channels[0]!;
    const observations = dynamicsObservations(profile, input);
    const rows: { label: string; purpose: string; errors: Errors }[] = [];
    let engineMaxDb = 0, engineWorst = "";
    for (const o of observations) {
      const output = decodeWav(await readFile(join(workDir, "out", `${o.renderId}.wav`))).channels[0]!;
      const cloneDb = windowRmsDb(output, input.windowDb.length).map((v, w) => v - input.windowDb[w]!);
      rows.push({ label: o.label, purpose: o.purpose, errors: compare(cloneDb, o.measuredDb) });

      // reference: the TypeScript model applied sample by sample (exactly what the plugin must do)
      const params = predictModel(model, new Map(o.params.map((p) => [p.index, p.value])));
      const gains = sampleGains(simulateGain(input.levels[model.structure.detector], params, model.structure, sampleRate), signal.length, params.makeupDb);
      const reference = windowRmsDb(signal.map((v, i) => v * gains[i]!), input.windowDb.length).map((v, w) => v - input.windowDb[w]!);
      const engine = compare(cloneDb, o.measuredDb.map((m, w) => (Number.isNaN(m) ? NaN : reference[w]!)));
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
