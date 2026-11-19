import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8 } from "fflate";
import { pluginInfo, regenerateTestSignal, runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav, readCapture, type Profile } from "@vst-cloner/profile";
import type { Logger } from "./build.ts";
import { cloneValue, dynamicsCloneParameters } from "./dynamics/params.ts";
import { spectralDeviationDb } from "./dsp/spectral.ts";
import { median } from "./neural/verify.ts";

/** A built clone and the profile it was built from (its stored model tells which controls it has). */
export interface CloneCandidate {
  name: string;
  clonePath: string;
  profile: Profile;
}

export interface CloneComparison {
  name: string;
  clonePath: string;
  /** error-to-signal ratio, sample by sample */
  esr: { mean: number; median: number };
  /** level difference of third-octave bands over time (spectralDeviationDb) */
  spectralDb: { mean: number; median: number };
  /** controls of the original the clone does not have (left at the clone's default) */
  missing: string[];
}

/** model files with the controls a clone was built with, in the order they are looked for */
const MODEL_FILES = ["model/neural.json", "model/delay.json", "model/reverb.json", "model/dynamics.json", "model/distortion.json"];

type Tables = { tables: { index: number }[]; variants?: { index: number; tables: { index: number }[] }[] };

function cloneTables(profile: Profile): Tables {
  for (const file of MODEL_FILES) {
    const data = profile.files.get(file);
    if (!data) continue;
    const model = JSON.parse(strFromU8(data));
    return file === "model/neural.json" ? { tables: (model.parameters as number[]).map((index) => ({ index })) } : model;
  }
  throw new Error(`${profile.manifest.plugin.name}: the profile holds no model of a clone that can be compared (neural, delay, reverb, dynamics, distortion)`);
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

/**
 * Renders every candidate with the settings of a reference profile (best: one captured for the universal clone,
 * all controls at random) and measures each against the original – the same settings and measures for all, so
 * a class clone and a network can be weighed against each other.
 */
export async function compareClones(
  reference: Profile,
  candidates: CloneCandidate[],
  options: { log: Logger; hostPath?: string; signal?: AbortSignal },
): Promise<CloneComparison[]> {
  const { log } = options;
  const sampleRate = reference.manifest.capture.sampleRate;
  const host = { ...(options.hostPath ? { hostPath: options.hostPath } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  const originals = new Map(reference.parameters.parameters.map((p) => [p.index, p]));
  const renders = reference.captures.renders;
  const results: CloneComparison[] = [];
  for (const candidate of candidates) {
    const info = await pluginInfo(candidate.clonePath, { sampleRate, ...host });
    const cloneIndexByName = new Map(info.parameters.map((p) => [p.name, p.index]));
    const toClone = new Map<number, { index: number; convert: (value: number) => number }>();
    for (const param of dynamicsCloneParameters(cloneTables(candidate.profile), candidate.profile.parameters.parameters, candidate.profile.captures.renders)) {
      const index = cloneIndexByName.get(param.name);
      if (index === undefined) throw new Error(`${candidate.name}: the clone has no parameter "${param.name}"`);
      toClone.set(param.original, { index, convert: (value) => cloneValue(param, originals.get(param.original), value) });
    }
    const varied = new Set(renders.flatMap((r) => r.params.map((p) => p.index)));
    const missing = [...varied].filter((index) => !toClone.has(index)).map((index) => originals.get(index)?.name ?? String(index));

    const job: RenderJob = {
      plugin: candidate.clonePath,
      sampleRate,
      blockSize: reference.manifest.capture.blockSize,
      channels: 1,
      prerollSeconds: 0.1,
      tailSeconds: reference.manifest.capture.tailSeconds,
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
    const workDir = await mkdtemp(join(tmpdir(), "vch-compare-"));
    try {
      const input = regenerateTestSignal(reference.testSignals).audio.channels[0]!;
      await writeFile(join(workDir, "input.wav"), encodeWav({ sampleRate, channels: [input] }));
      await writeFile(join(workDir, "job.json"), JSON.stringify(job));
      log("info", `${candidate.name}: rendering ${renders.length} settings …`);
      await runHost(["render", join(workDir, "job.json")], host);
      const esrs: number[] = [], spectral: number[] = [];
      for (const r of renders) {
        const clone = decodeWav(await readFile(join(workDir, "out", `${r.id}.wav`))).channels[0]!;
        const original = readCapture(reference, r).channels;
        esrs.push(mean(original.map((channel) => esr(channel, clone))));
        spectral.push(mean(original.map((channel) => spectralDeviationDb(channel, clone, sampleRate))));
      }
      results.push({
        name: candidate.name,
        clonePath: candidate.clonePath,
        esr: { mean: mean(esrs), median: median(esrs) },
        spectralDb: { mean: mean(spectral), median: median(spectral) },
        missing,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  return results;
}

/** the same measure as the universal clone's verification (silence floor −60 dBFS) */
function esr(original: Float32Array, clone: Float32Array): number {
  const n = Math.min(original.length, clone.length);
  let e = 0, s = 0;
  for (let i = 0; i < n; i++) {
    e += (clone[i]! - original[i]!) ** 2;
    s += original[i]! ** 2;
  }
  return e / Math.max(s, n * 1e-6);
}

/**
 * The candidate that sounds closest: the smallest spectral deviation of the typical setting (the phase-blind
 * measure, so a reverb is judged by its sound, not its exact noise); a clone missing controls loses ties.
 */
export function bestClone(results: CloneComparison[]): CloneComparison | undefined {
  return [...results].sort((a, b) => a.spectralDb.median - b.spectralDb.median || a.missing.length - b.missing.length)[0];
}

export function formatComparison(results: CloneComparison[]): string[] {
  const best = bestClone(results);
  const percent = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)} %`;
  return [
    "Clone comparison on the same settings (typical setting / mean):",
    ...results.map((r) =>
      `  ${r === best ? "★" : " "} ${r.name}: spectrum ${r.spectralDb.median.toFixed(2)} / ${r.spectralDb.mean.toFixed(2)} dB, ` +
      `error ${percent(r.esr.median)} / ${percent(r.esr.mean)}` + (r.missing.length ? ` – lacks ${r.missing.join(", ")}` : "")),
    ...(best ? [`Best: ${best.name}`] : []),
  ];
}
