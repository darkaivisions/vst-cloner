import { CancelledError, regenerateTestSignal } from "@vst-cloner/capture";
import { decodeWav, type Profile } from "@vst-cloner/profile";
import { cascadeDb } from "../dsp/biquad.ts";
import { fft, nextPowerOfTwo } from "../dsp/fft.ts";
import { nelderMead } from "../dsp/optimize.ts";
import { tableAt, type ParamTable } from "../dynamics/fit.ts";
import { clip, ClipTable, postSections, preSections, processDistortion, processDistortionFast, type DistortionParams } from "./model.ts";

/** harmonics compared (relative to the fundamental) */
export const HARMONICS = [2, 3, 4, 5];
/** below this input level the harmonics are not compared (tiny artefacts of the original, inaudible) */
const MIN_HARMONIC_INPUT_DB = -24;
/** harmonics are compared where the fundamental is compressed by at least this much */
const MIN_COMPRESSION_DB = 0.5;
/** harmonics below this level are treated as equal */
const HARMONIC_FLOOR_DB = -70;

export interface StepMeasurement {
  frequency: number;
  levelDb: number;
  /** output fundamental relative to the input (dB) */
  gainDb: number;
  /** H2…H5 relative to the output fundamental (dB) */
  harmonicsDb: number[];
}

export interface DistortionObservation {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  params: { index: number; value: number }[];
  /** small-signal response (dB) on `grid` */
  smallDb: Float64Array;
  steps: StepMeasurement[];
}

export interface DistortionInput {
  sampleRate: number;
  signal: Float32Array;
  /** frequencies of the small-signal comparison (1/12 octave) */
  grid: Float64Array;
  /** level-step segments: frequency, start, step length, levels */
  stepSegments: { frequency: number; start: number; stepLength: number; levels: number[] }[];
  sweep: { start: number; length: number };
}

export function distortionInput(profile: Profile): DistortionInput {
  const sampleRate = profile.manifest.capture.sampleRate;
  const signal = regenerateTestSignal(profile.testSignals).audio.channels[0]!;
  const grid: number[] = [];
  for (let f = 30; f <= Math.min(16000, sampleRate * 0.4); f *= 2 ** (1 / 12)) grid.push(f);
  const segments = profile.testSignals.segments;
  const sweep = segments.find((s) => s.id === "sweep-quiet");
  if (!sweep) throw new Error("Das Profil enthält keine Distortion-Messung – bitte mit --class distortion aufnehmen");
  return {
    sampleRate,
    signal,
    grid: Float64Array.from(grid),
    sweep: { start: sweep.start, length: sweep.length },
    stepSegments: segments.filter((s) => s.kind === "levelSteps" && s.id.startsWith("steps-")).map((s) => {
      const p = s.params!;
      const stepLength = Math.round(p.stepSeconds! * sampleRate);
      const count = Math.round(s.length / stepLength);
      return { frequency: p.frequency!, start: s.start, stepLength, levels: Array.from({ length: count }, (_, k) => p.fromDb! + k * p.stepDb!) };
    }),
  };
}

/** Amplitude of frequency f in x[start, start + n) (rotating phasor instead of cos/sin per sample). */
function amplitude(x: ArrayLike<number>, start: number, n: number, f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const cw = Math.cos(w), sw = Math.sin(w);
  let c = 1, s = 0, re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const v = x[start + i]!;
    re += v * c;
    im += v * s;
    const nc = c * cw - s * sw;
    s = s * cw + c * sw;
    c = nc;
  }
  return (2 * Math.hypot(re, im)) / n;
}

/** Analysis window of the measurements: whole periods, about 60 ms */
const periodsWindow = (f: number, sampleRate: number) => Math.round((Math.max(4, Math.round(0.06 * f)) / f) * sampleRate);
/** shorter window for the model (steady state, no noise): whole periods, about 20 ms */
const modelWindow = (f: number, sampleRate: number) => Math.round((Math.max(2, Math.round(0.02 * f)) / f) * sampleRate);

/** Small-signal response from the quiet sweep: |Y/X|, smoothed over 1/12 octave. */
function smallSignalDb(input: DistortionInput, output: Float32Array): Float64Array {
  const n = nextPowerOfTwo(input.sweep.length + 4096);
  const spectrum = (x: Float32Array) => {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < input.sweep.length + 2048; i++) re[i] = x[input.sweep.start + i] ?? 0;
    fft(re, im);
    return { re, im };
  };
  const X = spectrum(input.signal), Y = spectrum(output);
  return input.grid.map((f) => {
    const lo = Math.max(1, Math.floor((f * 2 ** (-1 / 24) * n) / input.sampleRate)), hi = Math.ceil((f * 2 ** (1 / 24) * n) / input.sampleRate);
    let py = 0, px = 0;
    for (let k = lo; k <= hi; k++) {
      py += Y.re[k]! ** 2 + Y.im[k]! ** 2;
      px += X.re[k]! ** 2 + X.im[k]! ** 2;
    }
    return 10 * Math.log10(py / (px + 1e-30) + 1e-20);
  });
}

function stepsOf(input: DistortionInput, output: ArrayLike<number>): StepMeasurement[] {
  const result: StepMeasurement[] = [];
  for (const s of input.stepSegments) {
    const n = periodsWindow(s.frequency, input.sampleRate);
    s.levels.forEach((levelDb, k) => {
      const start = s.start + (k + 1) * s.stepLength - n - 32;
      const inAmp = amplitude(input.signal, start, n, s.frequency, input.sampleRate);
      const h1 = amplitude(output, start, n, s.frequency, input.sampleRate) + 1e-20;
      result.push({
        frequency: s.frequency,
        levelDb,
        gainDb: 20 * Math.log10(h1 / inAmp),
        harmonicsDb: HARMONICS.map((h) => (s.frequency * h < input.sampleRate * 0.45 ? 20 * Math.log10(amplitude(output, start, n, s.frequency * h, input.sampleRate) / h1 + 1e-12) : NaN)),
      });
    });
  }
  return result;
}

/** Measurements of any output of the test signal (original or clone). */
export function measureOutput(input: DistortionInput, output: Float32Array): { smallDb: Float64Array; steps: StepMeasurement[] } {
  return { smallDb: smallSignalDb(input, output), steps: stepsOf(input, output) };
}

export function distortionObservations(profile: Profile, input: DistortionInput): DistortionObservation[] {
  return profile.captures.renders.map((r) => {
    const output = decodeWav(profile.files.get(r.file)!).channels[0]!;
    return {
      renderId: r.id,
      label: r.label ?? r.id,
      purpose: r.purpose === "validate" ? "validate" : "train",
      params: r.params.map((p) => ({ index: p.index, value: p.value })),
      smallDb: smallSignalDb(input, output),
      steps: stepsOf(input, output),
    };
  });
}

/** Model response: small-signal response and steady-state steps (short sines, simulated separately). */
export function modelMeasurements(input: DistortionInput, p: DistortionParams): { smallDb: Float64Array; steps: StepMeasurement[] } {
  const sr = input.sampleRate;
  const linear = cascadeDb([...preSections(p, sr), ...postSections(p, sr)], sr, input.grid);
  const smallDb = linear.map((v) => v + p.inputDb + p.outputDb);
  const steps: StepMeasurement[] = [];
  const table = new ClipTable(p);
  for (const s of input.stepSegments) {
    const n = modelWindow(s.frequency, sr);
    const warm = Math.round(0.025 * sr);
    for (const levelDb of s.levels) {
      const a = 10 ** (levelDb / 20);
      const sine = new Float64Array(warm + n);
      for (let i = 0; i < sine.length; i++) sine[i] = a * Math.sin((2 * Math.PI * s.frequency * i) / sr);
      const y = processDistortionFast(sine, p, sr, table);
      const h1 = amplitude(y, warm, n, s.frequency, sr) + 1e-20;
      steps.push({
        frequency: s.frequency,
        levelDb,
        gainDb: 20 * Math.log10(h1 / a),
        harmonicsDb: HARMONICS.map((h) => (s.frequency * h < sr * 0.45 ? 20 * Math.log10(amplitude(y, warm, n, s.frequency * h, sr) / h1 + 1e-12) : NaN)),
      });
    }
  }
  return { smallDb, steps };
}

export interface DistortionErrors {
  /** small-signal response (dB rms) */
  smallDb: number;
  /** fundamental gain over level and frequency (dB rms) */
  gainDb: number;
  /** harmonics of the loud steps (dB rms, floor −70 dB) */
  harmonicsDb: number;
  /** combined error used by the fit */
  total: number;
}

export function compareDistortion(model: { smallDb: Float64Array; steps: StepMeasurement[] }, o: DistortionObservation): DistortionErrors {
  let s = 0;
  for (let i = 0; i < o.smallDb.length; i++) s += (model.smallDb[i]! - o.smallDb[i]!) ** 2;
  const smallDb = Math.sqrt(s / o.smallDb.length);
  let g = 0, h = 0, hn = 0;
  // gain of the quietest step per frequency: reference for the compression
  const quiet = new Map<number, number>();
  for (const m of o.steps) if (!quiet.has(m.frequency)) quiet.set(m.frequency, m.gainDb);
  o.steps.forEach((m, k) => {
    const x = model.steps[k]!;
    g += (x.gainDb - m.gainDb) ** 2;
    // harmonics count where the original really clips (its quiet-signal artefacts are not modelled)
    if (m.levelDb < MIN_HARMONIC_INPUT_DB || quiet.get(m.frequency)! - m.gainDb < MIN_COMPRESSION_DB) return;
    m.harmonicsDb.forEach((v, j) => {
      const w = x.harmonicsDb[j]!;
      if (Number.isNaN(v) || Number.isNaN(w)) return;
      h += (Math.max(w, HARMONIC_FLOOR_DB) - Math.max(v, HARMONIC_FLOOR_DB)) ** 2;
      hn++;
    });
  });
  const gainDb = Math.sqrt(g / o.steps.length);
  const harmonicsDb = hn ? Math.sqrt(h / hn) : 0;
  return { smallDb, gainDb, harmonicsDb, total: Math.sqrt((smallDb ** 2 + gainDb ** 2 + 0.25 * harmonicsDb ** 2) / 2.25) };
}

// ---- parameter vector (log for frequencies, Q, limits; dB linear) ----

export const packDistortion = (p: DistortionParams): number[] => [
  p.inputDb, Math.log(p.preHp), Math.log(p.preBellFreq), p.preBellDb, Math.log(p.preBellQ), Math.log(p.preLp),
  Math.log(p.clipNeg), Math.log(p.hardness),
  Math.log(p.preBell2Freq), p.preBell2Db, Math.log(p.preBell2Q), Math.log(p.railPos), Math.log(p.railNeg),
  Math.log(p.postBellFreq), p.postBellDb, Math.log(p.postBellQ), Math.log(p.shelfFreq), p.shelfDb, Math.log(p.postLp), Math.log(p.postHp),
  p.outputDb,
];
// (order above: input, pre-filter, clipper, second pre-bell, rails, post-filter, output)

export const unpackDistortion = (x: number[]): DistortionParams => ({
  inputDb: x[0]!, preHp: Math.exp(x[1]!), preBellFreq: Math.exp(x[2]!), preBellDb: x[3]!, preBellQ: Math.exp(x[4]!), preLp: Math.exp(x[5]!),
  clipPos: 1, clipNeg: Math.exp(x[6]!), hardness: Math.exp(x[7]!),
  preBell2Freq: Math.exp(x[8]!), preBell2Db: x[9]!, preBell2Q: Math.exp(x[10]!), railPos: Math.exp(x[11]!), railNeg: Math.exp(x[12]!),
  postBellFreq: Math.exp(x[13]!), postBellDb: x[14]!, postBellQ: Math.exp(x[15]!), shelfFreq: Math.exp(x[16]!), shelfDb: x[17]!,
  postLp: Math.exp(x[18]!), postHp: Math.exp(x[19]!), outputDb: x[20]!,
});
// The positive clipping limit is fixed at 1: input gain and limits would otherwise trade off exactly
// (gain × a, limits × a), and the parameter tables would wander along that line.

export const STEP = [6, 0.7, 0.7, 4, 0.5, 0.7, 0.4, 0.4, 0.7, 4, 0.5, 0.7, 0.7, 0.7, 4, 0.5, 0.7, 4, 0.7, 0.7, 4];

/** Start values from the measurements: level from the small-signal gain, a moderate clipper. */
export function initialDistortion(o: DistortionObservation, input: DistortionInput): DistortionParams {
  const at1k = o.smallDb[input.grid.findIndex((f) => f >= 1000)] ?? 0;
  return {
    inputDb: 20, preHp: 60, preBellFreq: 800, preBellDb: 0, preBellQ: 0.7, preLp: 12000,
    clipPos: 1, clipNeg: 1, hardness: 3,
    preBell2Freq: 200, preBell2Db: 0, preBell2Q: 0.7, railPos: 8, railNeg: 8,
    postBellFreq: 1000, postBellDb: 0, postBellQ: 0.7, shelfFreq: 3000, shelfDb: 0, postLp: 14000, postHp: 30,
    outputDb: at1k - 20,
  };
}

/** Full fit of one render (Nelder–Mead with restarts). */
export function fitDistortionRender(o: DistortionObservation, input: DistortionInput, start?: DistortionParams, maxEvaluations = 3000) {
  const cost = (x: number[]) => compareDistortion(modelMeasurements(input, unpackDistortion(x)), o).total;
  let x = packDistortion(start ?? initialDistortion(o, input));
  let value = cost(x);
  for (let round = 0; round < 4; round++) {
    const scale = round === 0 ? 1 : 0.4;
    const r = nelderMead(cost, x, { step: STEP.map((s) => s * scale), maxEvaluations: round === 0 ? maxEvaluations : maxEvaluations / 2 });
    if (r.value >= value - 1e-4 && round > 0) break;
    x = r.x;
    value = r.value;
  }
  const params = unpackDistortion(x);
  return { params, errors: compareDistortion(modelMeasurements(input, params), o) };
}

export { clip, processDistortion };

// ---- complete fit with parameter tables ---------------------------------------------------------

/** Penalty on changes against the base model (per STEP unit²): a control only changes what it must. */
const CHANGE_PENALTY = 0.02;

export interface DistortionRenderReport {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  errors: DistortionErrors;
}

export interface DistortionModel {
  type: "distortion";
  version: 1;
  sampleRate: number;
  /** delay of the original (samples) – not reported as latency by it, so the clone does not either */
  delay: number;
  base: DistortionParams;
  baseValues: { index: number; value: number }[];
  tables: ParamTable[];
  report: {
    renders: DistortionRenderReport[];
    train?: DistortionErrors;
    validate?: DistortionErrors;
    /** which part of the model each control acts on (chosen by the fit) */
    groups?: { index: number; name: string; groups: GroupName[] }[];
  };
}

/** Packed model for a combination of plugin values (base + change of each control on its own). */
export function predictDistortion(model: Pick<DistortionModel, "base" | "baseValues" | "tables">, values: Map<number, number>): DistortionParams {
  const packed = packDistortion(model.base);
  const baseValues = new Map(model.baseValues.map((v) => [v.index, v.value]));
  for (const table of model.tables) {
    const reference = baseValues.get(table.index);
    const value = values.get(table.index) ?? reference;
    if (value === undefined || reference === undefined) continue;
    const at = tableAt(table, value), ref = tableAt(table, reference);
    for (let i = 0; i < packed.length; i++) packed[i]! += at[i]! - ref[i]!;
  }
  return unpackDistortion(packed);
}

const meanErrors = (rows: DistortionErrors[]): DistortionErrors | undefined => {
  if (!rows.length) return undefined;
  const avg = (k: keyof DistortionErrors) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  return { smallDb: avg("smallDb"), gainDb: avg("gainDb"), harmonicsDb: avg("harmonicsDb"), total: avg("total") };
};

/** Delay of the original against the model: lag of the best correlation on the quiet sweep and the noise. */
export function estimateDelay(profile: Profile, input: DistortionInput, base: DistortionObservation, p: DistortionParams, maxLag = 2048): number {
  const render = profile.captures.renders.find((r) => r.id === base.renderId)!;
  const original = decodeWav(profile.files.get(render.file)!).channels[0]!;
  const model = processDistortion(input.signal, p, input.sampleRate);
  const ranges = profile.testSignals.segments.filter((s) => s.id === "sweep-quiet" || s.id.startsWith("noise")).map((s) => [s.start, s.start + s.length] as const);
  let best = { lag: 0, c: -Infinity };
  for (let lag = 0; lag <= maxLag; lag++) {
    let xy = 0;
    for (const [from, to] of ranges) for (let i = from + maxLag; i < to; i++) xy += original[i]! * model[i - lag]!;
    if (xy > best.c) best = { lag, c: xy };
  }
  return best.lag;
}

/** Groups of packed model values: a control usually acts on one part of the circuit only. */
export const GROUPS = {
  input: [0],
  pre: [1, 2, 3, 4, 5, 8, 9, 10],
  clip: [6, 7, 11, 12],
  post: [13, 14, 15, 16, 17, 18, 19],
  output: [20],
} as const;
export type GroupName = keyof typeof GROUPS;

/** Candidate sets, simplest first; the last one leaves everything free. */
export const GROUP_CANDIDATES: GroupName[][] = [
  ["output"],
  ["post", "output"],
  ["input", "output"],
  ["input", "pre", "output"],
  ["input", "clip", "output"],
  ["input", "pre", "post", "output"],
  ["input", "pre", "clip", "post", "output"],
];

/**
 * Fit of a sweep point: start at the base model, only the values of `groups` may change, and changes are
 * penalised. Returns the packed model and its error (without penalty).
 */
export function fitSweepPoint(o: DistortionObservation, input: DistortionInput, x0: number[], groups: GroupName[] = GROUP_CANDIDATES[GROUP_CANDIDATES.length - 1]!): { x: number[]; error: number } {
  const free = groups.flatMap((g) => [...GROUPS[g]]).sort((a, b) => a - b);
  const full = (y: number[]) => {
    const x = [...x0];
    free.forEach((k, i) => (x[k] = y[i]!));
    return x;
  };
  const error = (x: number[]) => compareDistortion(modelMeasurements(input, unpackDistortion(x)), o).total;
  const cost = (y: number[]) => {
    let change = 0;
    free.forEach((k, i) => (change += ((y[i]! - x0[k]!) / STEP[k]!) ** 2));
    return error(full(y)) + CHANGE_PENALTY * change;
  };
  let y = free.map((k) => x0[k]!), value = cost(y);
  for (let round = 0; round < 3; round++) {
    const r = nelderMead(cost, y, { step: free.map((k) => STEP[k]! * (round === 0 ? 0.5 : 0.25)), maxEvaluations: 120 * free.length + 200 });
    if (r.value >= value - 1e-4 && round > 0) break;
    y = r.x;
    value = r.value;
  }
  const x = full(y);
  return { x, error: error(x) };
}

/** Start points of the base fit (run in parallel, the best wins). */
export function baseStarts(o: DistortionObservation, input: DistortionInput): DistortionParams[] {
  const p = initialDistortion(o, input);
  return [
    p,
    { ...p, inputDb: 10, outputDb: p.outputDb + 10, hardness: 2 },
    { ...p, inputDb: 30, outputDb: p.outputDb - 10, hardness: 6 },
    { ...p, clipNeg: 1.6, hardness: 4 },
  ];
}

export type DistortionJob =
  | { kind: "base"; observation: DistortionObservation; start: DistortionParams }
  | { kind: "sweep"; observation: DistortionObservation; x0: number[]; groups: GroupName[] };

export interface JobResult {
  x: number[];
  error: number;
}

/** Runs jobs on worker threads (one per core, at most `jobs.length`). */
async function runJobs(input: DistortionInput, jobs: DistortionJob[], onDone: (done: number) => void, signal?: AbortSignal): Promise<JobResult[]> {
  if (signal?.aborted) throw new CancelledError();
  const { Worker } = await import("node:worker_threads");
  const { availableParallelism } = await import("node:os");
  const count = Math.max(1, Math.min(jobs.length, availableParallelism() - 1));
  const results: JobResult[] = new Array(jobs.length);
  let next = 0, done = 0;
  const workers: import("node:worker_threads").Worker[] = [];
  // cancelling stops every worker at once
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      for (const w of workers) void w.terminate();
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
  cancelled.catch(() => {});
  const all = Promise.all(Array.from({ length: count }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
    workers.push(worker);
    const feed = () => {
      if (next >= jobs.length) {
        void worker.terminate();
        resolve();
        return;
      }
      const k = next++;
      worker.once("message", (result: JobResult) => {
        results[k] = result;
        onDone(++done);
        feed();
      });
      worker.postMessage(jobs[k]);
    };
    worker.once("error", reject);
    feed();
  })));
  try {
    await Promise.race([all, cancelled]);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  return results;
}

/** Base model (best of several starts), every sweep render (penalised change from the base), tables, predictions. */
export async function fitDistortion(
  profile: Profile,
  onProgress?: (done: number, total: number, label: string) => void,
  signal?: AbortSignal,
): Promise<DistortionModel> {
  const input = distortionInput(profile);
  const observations = distortionObservations(profile, input);
  const parameters = profile.parameters.parameters;
  const base = observations.find((o) => o.params.length === 0) ?? observations[0]!;
  const train = observations.filter((o) => o.purpose === "train" && o !== base && o.params.length === 1);
  const starts = baseStarts(base, input);
  const total = starts.length + train.length;

  onProgress?.(0, total, "Grundeinstellung");
  const baseResults = await runJobs(input, starts.map((start) => ({ kind: "base", observation: base, start })), (d) => onProgress?.(d, total, "Grundeinstellung"), signal);
  const x0 = baseResults.reduce((best, r) => (r.error < best.error ? r : best)).x;
  const baseParams = unpackDistortion(x0);

  // every sweep point with every candidate group set (in parallel); per control the simplest set that fits
  const jobs: { o: DistortionObservation; candidate: number }[] = [];
  for (const o of train) GROUP_CANDIDATES.forEach((_, candidate) => jobs.push({ o, candidate }));
  const fits = await runJobs(input, jobs.map((j) => ({ kind: "sweep", observation: j.o, x0, groups: GROUP_CANDIDATES[j.candidate]! })),
    (d) => onProgress?.(starts.length + Math.round((d / jobs.length) * train.length), total, "Regler"), signal);

  const baseValues = new Map(parameters.map((p) => [p.index, p.value ?? p.default]));
  const tables = new Map<number, ParamTable>();
  const controls = [...new Set(train.map((o) => o.params[0]!.index))];
  const chosenGroups: { index: number; name: string; groups: GroupName[] }[] = [];
  for (const index of controls) {
    const points = train.filter((o) => o.params[0]!.index === index);
    const errorOf = (candidate: number) =>
      points.reduce((s, o) => s + fits[jobs.findIndex((j) => j.o === o && j.candidate === candidate)]!.error, 0) / points.length;
    const best = errorOf(GROUP_CANDIDATES.length - 1);
    const candidate = GROUP_CANDIDATES.findIndex((_, c) => errorOf(c) <= best * 1.1 + 0.03);
    const info = parameters.find((q) => q.index === index)!;
    chosenGroups.push({ index, name: info.name, groups: GROUP_CANDIDATES[candidate]! });
    const table: ParamTable = { index, name: info.name, discrete: info.discrete, points: [{ value: baseValues.get(index)!, packed: x0 }] };
    for (const o of points) table.points.push({ value: o.params[0]!.value, packed: fits[jobs.findIndex((j) => j.o === o && j.candidate === candidate)]!.x });
    tables.set(index, table);
  }
  for (const table of tables.values()) table.points.sort((a, b) => a.value - b.value);

  const model: DistortionModel = {
    type: "distortion",
    version: 1,
    sampleRate: input.sampleRate,
    delay: estimateDelay(profile, input, base, baseParams),
    base: baseParams,
    baseValues: [...tables.keys()].map((index) => ({ index, value: baseValues.get(index)! })),
    tables: [...tables.values()],
    report: { renders: [], groups: chosenGroups },
  };
  model.report.renders = observations.map((o) => ({
    renderId: o.renderId,
    label: o.label,
    purpose: o.purpose,
    errors: compareDistortion(modelMeasurements(input, predictDistortion(model, new Map(o.params.map((p) => [p.index, p.value])))), o),
  }));
  const trainErrors = meanErrors(model.report.renders.filter((r) => r.purpose === "train").map((r) => r.errors));
  const validateErrors = meanErrors(model.report.renders.filter((r) => r.purpose === "validate").map((r) => r.errors));
  if (trainErrors) model.report.train = trainErrors;
  if (validateErrors) model.report.validate = validateErrors;
  return model;
}
