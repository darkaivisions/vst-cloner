import { regenerateTestSignal } from "@vst-cloner/capture";
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
  o.steps.forEach((m, k) => {
    const x = model.steps[k]!;
    g += (x.gainDb - m.gainDb) ** 2;
    if (m.levelDb < MIN_HARMONIC_INPUT_DB) return;
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
  Math.log(p.clipPos), Math.log(p.clipNeg), Math.log(p.hardness),
  Math.log(p.postBellFreq), p.postBellDb, Math.log(p.postBellQ), Math.log(p.shelfFreq), p.shelfDb, Math.log(p.postLp), Math.log(p.postHp),
  p.outputDb,
];

export const unpackDistortion = (x: number[]): DistortionParams => ({
  inputDb: x[0]!, preHp: Math.exp(x[1]!), preBellFreq: Math.exp(x[2]!), preBellDb: x[3]!, preBellQ: Math.exp(x[4]!), preLp: Math.exp(x[5]!),
  clipPos: Math.exp(x[6]!), clipNeg: Math.exp(x[7]!), hardness: Math.exp(x[8]!),
  postBellFreq: Math.exp(x[9]!), postBellDb: x[10]!, postBellQ: Math.exp(x[11]!), shelfFreq: Math.exp(x[12]!), shelfDb: x[13]!,
  postLp: Math.exp(x[14]!), postHp: Math.exp(x[15]!), outputDb: x[16]!,
});

const STEP = [6, 0.7, 0.7, 4, 0.5, 0.7, 0.7, 0.7, 0.4, 0.7, 4, 0.5, 0.7, 4, 0.7, 0.7, 4];

/** Start values from the measurements: level from the small-signal gain, a moderate clipper. */
export function initialDistortion(o: DistortionObservation, input: DistortionInput): DistortionParams {
  const at1k = o.smallDb[input.grid.findIndex((f) => f >= 1000)] ?? 0;
  return {
    inputDb: 20, preHp: 60, preBellFreq: 800, preBellDb: 0, preBellQ: 0.7, preLp: 12000,
    clipPos: 0.5, clipNeg: 0.5, hardness: 3,
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
const CHANGE_PENALTY = 0.05;

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
  base: DistortionParams;
  baseValues: { index: number; value: number }[];
  tables: ParamTable[];
  report: { renders: DistortionRenderReport[]; train?: DistortionErrors; validate?: DistortionErrors };
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

/** Base model (full fit), every sweep render (penalised change from the base), tables, predictions. */
export function fitDistortion(profile: Profile, onProgress?: (done: number, total: number, label: string) => void): DistortionModel {
  const input = distortionInput(profile);
  const observations = distortionObservations(profile, input);
  const parameters = profile.parameters.parameters;
  const base = observations.find((o) => o.params.length === 0) ?? observations[0]!;
  const train = observations.filter((o) => o.purpose === "train" && o !== base && o.params.length === 1);
  const total = train.length + 1;

  onProgress?.(0, total, "Grundeinstellung");
  const baseFit = fitDistortionRender(base, input);
  const x0 = packDistortion(baseFit.params);

  const baseValues = new Map(parameters.map((p) => [p.index, p.value ?? p.default]));
  const tables = new Map<number, ParamTable>();
  train.forEach((o, i) => {
    onProgress?.(i + 1, total, o.label);
    const cost = (x: number[]) => {
      const e = compareDistortion(modelMeasurements(input, unpackDistortion(x)), o).total;
      let change = 0;
      for (let k = 0; k < x.length; k++) change += ((x[k]! - x0[k]!) / STEP[k]!) ** 2;
      return e + CHANGE_PENALTY * change;
    };
    let x = x0, value = cost(x0);
    for (let round = 0; round < 3; round++) {
      const r = nelderMead(cost, x, { step: STEP.map((s) => s * (round === 0 ? 0.5 : 0.25)), maxEvaluations: 1500 });
      if (r.value >= value - 1e-4 && round > 0) break;
      x = r.x;
      value = r.value;
    }
    const p = o.params[0]!;
    const info = parameters.find((q) => q.index === p.index)!;
    const table = tables.get(p.index) ?? { index: p.index, name: info.name, discrete: info.discrete, points: [{ value: baseValues.get(p.index)!, packed: x0 }] };
    table.points.push({ value: p.value, packed: x });
    tables.set(p.index, table);
  });
  for (const table of tables.values()) table.points.sort((a, b) => a.value - b.value);

  const model: DistortionModel = {
    type: "distortion",
    version: 1,
    sampleRate: input.sampleRate,
    base: baseFit.params,
    baseValues: [...tables.keys()].map((index) => ({ index, value: baseValues.get(index)! })),
    tables: [...tables.values()],
    report: { renders: [] },
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
