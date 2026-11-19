import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInfo, regenerateTestSignal, runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav, type Profile } from "@vst-cloner/profile";
import type { Logger } from "../build.ts";
import { cloneValue, dynamicsCloneParameters } from "../dynamics/params.ts";
import type { NeuralModel } from "./codegen.ts";

export interface NeuralVerifyReport {
  clone: string;
  renders: number;
  /** error-to-signal ratio clone vs. original, mean over the renders (0 = identical, 1 = as large as the signal) */
  esr: number;
  train?: number;
  validate?: number;
  worst: { label: string; esr: number }[];
}

/** ESR in dB (−20 dB = 1 % of the signal energy) – the number the app shows */
export const esrToDb = (esr: number) => 10 * Math.log10(Math.max(esr, 1e-10));

/**
 * Output quieter than this (mean square, dBFS) counts as silence: errors are measured against at least this power.
 * Otherwise a setting with the volume turned all the way down (Tal-Filter-2: −77 dB) makes inaudible residual noise
 * an error of thousands of percent that dominates the mean. The same floor in dsp/neural/train.py.
 */
const SILENCE_POWER = 10 ** (-60 / 10);

function esr(original: Float32Array, clone: Float32Array): number {
  const n = Math.min(original.length, clone.length);
  let e = 0, s = 0;
  for (let i = 0; i < n; i++) {
    e += (clone[i]! - original[i]!) ** 2;
    s += original[i]! ** 2;
  }
  return e / Math.max(s, n * SILENCE_POWER);
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

/** Renders the clone with every captured setting and compares it sample by sample with the original. */
export async function verifyNeuralClone(
  profile: Profile,
  model: NeuralModel,
  clonePath: string,
  options: { log: Logger; hostPath?: string; signal?: AbortSignal },
): Promise<NeuralVerifyReport> {
  const { log } = options;
  const sampleRate = profile.manifest.capture.sampleRate;
  const host = { ...(options.hostPath ? { hostPath: options.hostPath } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  const info = await pluginInfo(clonePath, { sampleRate, ...host });
  const cloneIndexByName = new Map(info.parameters.map((p) => [p.name, p.index]));
  const originals = new Map(profile.parameters.parameters.map((p) => [p.index, p]));
  const toClone = new Map<number, { index: number; convert: (value: number) => number }>();
  for (const param of dynamicsCloneParameters({ tables: model.parameters.map((index) => ({ index })) }, profile.parameters.parameters, profile.captures.renders)) {
    const index = cloneIndexByName.get(param.name);
    if (index === undefined) throw new Error(`The clone has no parameter "${param.name}"`);
    toClone.set(param.original, { index, convert: (value) => cloneValue(param, originals.get(param.original), value) });
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
      params: r.params.flatMap((p) => {
        const target = toClone.get(p.index);
        return target ? [{ index: target.index, value: target.convert(p.value) }] : [];
      }),
    })),
  };

  const workDir = await mkdtemp(join(tmpdir(), "vch-verify-"));
  try {
    const input = regenerateTestSignal(profile.testSignals).audio.channels[0]!;
    await writeFile(join(workDir, "input.wav"), encodeWav({ sampleRate, channels: [input] }));
    await writeFile(join(workDir, "job.json"), JSON.stringify(job));
    log("info", `Measuring the clone with ${renders.length} measured settings …`);
    await runHost(["render", join(workDir, "job.json")], host);

    const rows: { label: string; purpose: string; esr: number }[] = [];
    for (const r of renders) {
      const clone = decodeWav(await readFile(join(workDir, "out", `${r.id}.wav`))).channels[0]!;
      const original = decodeWav(profile.files.get(r.file)!).channels;
      // the clone is mono (one network per channel, the same for both): compared with every channel of the original
      const value = mean(original.map((channel) => esr(channel, clone)))!;
      if (!Number.isFinite(value)) throw new Error(`The clone gives no valid signal (NaN/inf) at "${r.label ?? r.id}"`);
      rows.push({ label: r.label ?? r.id, purpose: r.purpose ?? "train", esr: value });
    }
    const train = mean(rows.filter((r) => r.purpose === "train").map((r) => r.esr));
    const validate = mean(rows.filter((r) => r.purpose === "validate").map((r) => r.esr));
    return {
      clone: clonePath,
      renders: rows.length,
      esr: mean(rows.map((r) => r.esr))!,
      ...(train !== undefined ? { train } : {}),
      ...(validate !== undefined ? { validate } : {}),
      worst: [...rows].sort((a, b) => b.esr - a.esr).slice(0, 5).map((r) => ({ label: r.label, esr: r.esr })),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
