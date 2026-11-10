import { regenerateTestSignal } from "@vst-cloner/capture";
import { decodeWav, type Profile } from "@vst-cloner/profile";
import { nelderMead } from "../dsp/optimize.ts";
import {
  appliedBlockGains,
  BLOCK,
  blockLevels,
  renderModel,
  simulateGain,
  type CompressorParams,
  type CompressorStructure,
  type Detector,
  type Topology,
} from "./model.ts";

/** Comparison windows: 8 blocks = 256 samples (5.3 ms at 48 kHz). */
export const WINDOW_BLOCKS = 8;
/** windows with a quieter input are ignored (noise floor) */
const MIN_INPUT_DB = -66;

export interface DynamicsObservation {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  params: { index: number; value: number }[];
  /** measured gain per window (dB), NaN where the input is too quiet */
  measuredDb: Float64Array;
  /** H3 and H5 relative to the fundamental (dB) per step of the harmonics segment */
  harmonicsDb?: Float64Array;
}

export interface DynamicsInput {
  sampleRate: number;
  levels: Record<Detector, Float64Array>;
  /** 10^(level/10) of `levels` */
  energies: Record<Detector, Float64Array>;
  /** input RMS per window (dB) */
  windowDb: Float64Array;
  signal: Float32Array;
  /** analysis windows of the harmonics segment (steady part of every level step) */
  harmonicWindows: { start: number; length: number; frequency: number }[];
}

/** Odd harmonics analysed for the saturation */
const HARMONICS = [3, 5];

/** H3, H5 relative to the fundamental (dB) for each analysis window. */
export function harmonicsDb(x: Float32Array, windows: DynamicsInput["harmonicWindows"], sampleRate: number, offset = 0): Float64Array {
  const out = new Float64Array(windows.length * HARMONICS.length);
  windows.forEach((w, k) => {
    const amp = (f: number) => {
      let re = 0, im = 0;
      for (let i = 0; i < w.length; i++) {
        const a = (2 * Math.PI * f * i) / sampleRate;
        const v = x[w.start - offset + i]!;
        re += v * Math.cos(a);
        im += v * Math.sin(a);
      }
      return Math.hypot(re, im);
    };
    const h1 = amp(w.frequency) + 1e-20;
    HARMONICS.forEach((h, j) => (out[k * HARMONICS.length + j] = 20 * Math.log10(amp(w.frequency * h) / h1 + 1e-12)));
  });
  return out;
}

export const windowRmsDb = (signal: Float32Array, windows: number) => {
  const size = BLOCK * WINDOW_BLOCKS;
  const out = new Float64Array(windows);
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    const end = Math.min(signal.length, (w + 1) * size);
    for (let i = w * size; i < end; i++) sum += signal[i]! * signal[i]!;
    out[w] = 10 * Math.log10(sum / Math.max(1, end - w * size) + 1e-24);
  }
  return out;
};

export function dynamicsInput(profile: Profile): DynamicsInput {
  const signal = regenerateTestSignal(profile.testSignals).audio.channels[0]!;
  const windows = Math.floor(signal.length / (BLOCK * WINDOW_BLOCKS));
  return {
    sampleRate: profile.manifest.capture.sampleRate,
    levels: { peak: blockLevels(signal, "peak"), rms: blockLevels(signal, "rms") },
    energies: {
      peak: blockLevels(signal, "peak").map((l) => 10 ** (l / 10)),
      rms: blockLevels(signal, "rms").map((l) => 10 ** (l / 10)),
    },
    windowDb: windowRmsDb(signal, windows),
    signal,
    harmonicWindows: harmonicWindows(profile),
  };
}

function harmonicWindows(profile: Profile): DynamicsInput["harmonicWindows"] {
  const segment = profile.testSignals.segments.find((s) => s.id === "harmonics");
  const p = segment?.params;
  if (!segment || !p?.stepSeconds || !p.frequency) return [];
  const sampleRate = profile.manifest.capture.sampleRate;
  const step = Math.round(p.stepSeconds * sampleRate);
  // last half of every step (whole periods), so that gain changes have settled
  const periods = Math.max(1, Math.floor((step / 2) * (p.frequency / sampleRate)));
  const length = Math.round((periods * sampleRate) / p.frequency);
  const count = Math.round(segment.length / step);
  return Array.from({ length: count }, (_, k) => ({ start: segment.start + (k + 1) * step - length - 16, length, frequency: p.frequency! }));
}

export function dynamicsObservations(profile: Profile, input: DynamicsInput): DynamicsObservation[] {
  return profile.captures.renders.map((r) => {
    const output = decodeWav(profile.files.get(r.file)!).channels[0]!;
    const out = windowRmsDb(output, input.windowDb.length);
    const measured = out.map((v, w) => (input.windowDb[w]! > MIN_INPUT_DB ? v - input.windowDb[w]! : NaN));
    return {
      renderId: r.id,
      label: r.label ?? r.id,
      purpose: r.purpose === "validate" ? "validate" : "train",
      params: r.params.map((p) => ({ index: p.index, value: p.value })),
      measuredDb: measured,
      ...(input.harmonicWindows.length ? { harmonicsDb: harmonicsDb(output, input.harmonicWindows, input.sampleRate) } : {}),
    };
  });
}

/** Model gain per comparison window (dB, including makeup). */
export function modelWindowDb(input: DynamicsInput, p: CompressorParams, s: CompressorStructure): Float64Array {
  const applied = appliedBlockGains(simulateGain(input.levels[s.detector], p, s, input.sampleRate, input.energies[s.detector]));
  const out = new Float64Array(input.windowDb.length);
  for (let w = 0; w < out.length; w++) {
    let sum = 0;
    for (let b = w * WINDOW_BLOCKS; b < (w + 1) * WINDOW_BLOCKS; b++) sum += applied[b] ?? 0;
    out[w] = sum / WINDOW_BLOCKS + p.makeupDb;
  }
  return out;
}

export interface Errors {
  rmsDb: number;
  maxDb: number;
}

export function compare(model: Float64Array, measured: Float64Array): Errors {
  let sum = 0, n = 0, max = 0;
  for (let w = 0; w < measured.length; w++) {
    const m = measured[w]!;
    if (Number.isNaN(m)) continue;
    const d = Math.abs(model[w]! - m);
    sum += d * d;
    n++;
    if (d > max) max = d;
  }
  return { rmsDb: n ? Math.sqrt(sum / n) : 0, maxDb: max };
}

// ---- parameter vector (transformed so that the optimiser needs no bounds) ----

export const pack = (p: CompressorParams): number[] => [
  p.thresholdDb, Math.log(Math.max(p.ratio - 1, 1e-3)), Math.log(p.kneeDb + 0.1), p.makeupDb,
  Math.log(p.attack), Math.log(p.release), Math.log(p.charge), Math.log(p.slow), Math.log(p.slowKneeDb + 0.01),
  Math.log(p.detectorTime + 1e-4), p.drive, Math.log(p.rippleTime + 1e-5), Math.log(p.ripple + 1e-3),
];
export const unpack = (x: number[]): CompressorParams => ({
  thresholdDb: x[0]!, ratio: 1 + Math.exp(x[1]!), kneeDb: Math.max(0, Math.exp(x[2]!) - 0.1), makeupDb: x[3]!,
  attack: Math.exp(x[4]!), release: Math.exp(x[5]!), charge: Math.exp(x[6]!), slow: Math.exp(x[7]!),
  slowKneeDb: Math.max(0, Math.exp(x[8]!) - 0.01),
  detectorTime: Math.max(0, Math.exp(x[9]!) - 1e-4),
  drive: Math.max(0, x[10]!),
  rippleTime: Math.max(0, Math.exp(x[11]!) - 1e-5),
  ripple: Math.max(0, Math.exp(x[12]!) - 1e-3),
});

/** packed indices of the colouration (fitted on the harmonics, not on the level) */
const COLOUR = 3;

/** Rough start values from the static part (the rising level steps). */
export function initialGuess(o: DynamicsObservation, input: DynamicsInput, s: CompressorStructure): CompressorParams {
  const valid: [number, number][] = [];
  o.measuredDb.forEach((g, w) => { if (!Number.isNaN(g)) valid.push([input.windowDb[w]!, g]); });
  valid.sort((a, b) => a[0] - b[0]);
  const quiet = valid.filter(([l]) => l < -45).map(([, g]) => g);
  const makeupDb = quiet.length ? quiet.sort((a, b) => a - b)[quiet.length >> 1]! : 0;
  const compressed = valid.filter(([, g]) => g < makeupDb - 1);
  const thresholdDb = compressed.length ? Math.min(...compressed.map(([l]) => l)) + 3 : -10;
  return {
    thresholdDb, ratio: 4, kneeDb: 6, makeupDb,
    attack: 0.01, release: 0.1, charge: 0.3, slow: 4, slowKneeDb: 2, detectorTime: 0.005, drive: 0, rippleTime: 0.0015, ripple: 0,
  };
}

export function fitRender(o: DynamicsObservation, input: DynamicsInput, s: CompressorStructure, start?: CompressorParams, maxEvaluations = 600) {
  const initial = start ?? initialGuess(o, input, s);
  // the colouration (last packed values) hardly changes the level over time – it is fitted separately
  const packed = pack(initial);
  const colour = packed.slice(-COLOUR);
  const full = (x: number[]) => unpack([...x, ...colour]);
  const cost = (x: number[]) => compare(modelWindowDb(input, full(x), s), o.measuredDb).rmsDb;
  const result = nelderMead(cost, packed.slice(0, -COLOUR), { step: [6, 0.7, 0.7, 2, 0.7, 0.7, 0.7, 0.7, 1, 1], maxEvaluations });
  // a restart from the result escapes most early collapses of the simplex
  const again = nelderMead(cost, result.x, { step: [2, 0.3, 0.3, 0.5, 0.3, 0.3, 0.3, 0.3, 0.5, 0.5], maxEvaluations: maxEvaluations / 2 });
  const params = full(again.x);
  return { params, errors: compare(modelWindowDb(input, params, s), o.measuredDb) };
}

/** Static part only (threshold, ratio, knee, makeup); the timing stays as given. */
export function fitStatic(o: DynamicsObservation, input: DynamicsInput, s: CompressorStructure, timing: CompressorParams, maxEvaluations = 400) {
  const guess = initialGuess(o, input, s);
  const make = (x: number[]): CompressorParams => ({
    ...timing,
    thresholdDb: x[0]!, ratio: 1 + Math.exp(x[1]!), kneeDb: Math.max(0, Math.exp(x[2]!) - 0.1), makeupDb: x[3]!,
  });
  const cost = (x: number[]) => compare(modelWindowDb(input, make(x), s), o.measuredDb).rmsDb;
  // start from the timing render's static values, but with this render's level
  const start = [timing.thresholdDb, Math.log(Math.max(timing.ratio - 1, 1e-3)), Math.log(timing.kneeDb + 0.1), guess.makeupDb];
  const first = nelderMead(cost, start, { step: [6, 0.7, 0.7, 2], maxEvaluations });
  const second = nelderMead(cost, first.x, { step: [2, 0.3, 0.3, 0.5], maxEvaluations: maxEvaluations / 2 });
  const params = make(second.x);
  return { params, errors: compare(modelWindowDb(input, params, s), o.measuredDb) };
}

/** Error (dB) between modelled and measured odd harmonics; levels below −100 dB are ignored (noise). */
export function harmonicsError(model: Float64Array, measured: Float64Array): number {
  let sum = 0, n = 0;
  for (let i = 0; i < measured.length; i++) {
    const m = measured[i]!;
    if (m < -100) continue;
    sum += (Math.max(model[i]!, -100) - m) ** 2;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Harmonics of the model output for one parameter set (only the harmonics segment is rendered). */
function modelHarmonics(input: DynamicsInput, p: CompressorParams, s: CompressorStructure): Float64Array {
  const windows = input.harmonicWindows;
  const gains = simulateGain(input.levels[s.detector], p, s, input.sampleRate, input.energies[s.detector]);
  const from = windows[0]!.start, to = windows[windows.length - 1]!.start + windows[windows.length - 1]!.length;
  return harmonicsDb(renderModel(input.signal, gains, p, from, to), windows, input.sampleRate, from);
}

/**
 * Colouration that reproduces the measured odd harmonics: saturation drive and, where the render compresses,
 * the detector ripple (time constant and share). Returns the parameters with these values replaced.
 */
export function fitColour(o: DynamicsObservation, input: DynamicsInput, p: CompressorParams, s: CompressorStructure, withRipple: boolean): { params: CompressorParams; errorDb: number } {
  if (!o.harmonicsDb || !input.harmonicWindows.length) return { params: { ...p, drive: 0 }, errorDb: 0 };
  const make = (x: number[]): CompressorParams => ({
    ...p,
    drive: Math.max(0, Math.exp(x[0]!) - 0.01),
    ...(withRipple ? { rippleTime: Math.max(1e-5, Math.exp(x[1]!)), ripple: Math.max(0, Math.exp(x[2]!) - 1e-3) } : {}),
  });
  const cost = (x: number[]) => harmonicsError(modelHarmonics(input, make(x), s), o.harmonicsDb!);
  const starts = withRipple
    ? [[Math.log(0.01), Math.log(0.0015), Math.log(0.05)], [Math.log(1.5), Math.log(0.0015), Math.log(0.05)]]
    : [[Math.log(0.01)], [Math.log(1.5)]];
  let best: { x: number[]; value: number } | undefined;
  for (const start of starts) {
    const r = nelderMead(cost, start, { step: withRipple ? [1, 0.5, 0.7] : [1], maxEvaluations: withRipple ? 150 : 40 });
    if (!best || r.value < best.value) best = r;
  }
  const params = make(best!.x);
  // no measurable saturation: keep the clean path (exactly linear)
  const clean = harmonicsError(modelHarmonics(input, { ...params, drive: 0 }, s), o.harmonicsDb);
  return clean <= best!.value + 0.05 ? { params: { ...params, drive: 0 }, errorDb: clean } : { params, errorDb: best!.value };
}

/** Penalty (dB of harmonics error per unit of drive²) that keeps unidentifiable drive changes at zero. */
const DRIVE_PENALTY = 0.1;
/** smaller drive changes are treated as noise of the fit */
const MIN_DRIVE_CHANGE = 0.3;

function golden(cost: (x: number) => number, lo: number, hi: number, iterations = 30): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = cost(c), fd = cost(d);
  for (let i = 0; i < iterations; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = cost(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = cost(d); }
  }
  return (a + b) / 2;
}

/**
 * Drive of the saturation for the base state and every sweep point. Where a render compresses strongly the
 * drive hardly changes its harmonics, so changes are penalised: a parameter only alters the drive when the
 * measurements demand it, and the base value is set by the renders where the saturation is audible.
 */
export function fitDrives(
  input: DynamicsInput,
  s: CompressorStructure,
  baseParams: CompressorParams,
  base: DynamicsObservation,
  points: { o: DynamicsObservation; params: CompressorParams }[],
): { base: number; changes: number[] } {
  const windows = input.harmonicWindows;
  const all = [{ o: base, params: baseParams }, ...points].filter((x) => x.o.harmonicsDb);
  if (!windows.length || !all.length) return { base: 0, changes: points.map(() => 0) };
  const from = windows[0]!.start, to = windows[windows.length - 1]!.start + windows[windows.length - 1]!.length;
  // the gain reduction does not depend on the drive: simulate once per render
  const gains = all.map((x) => simulateGain(input.levels[s.detector], x.params, s, input.sampleRate, input.energies[s.detector]));
  const error = (k: number, drive: number) =>
    harmonicsError(harmonicsDb(renderModel(input.signal, gains[k]!, { ...all[k]!.params, drive: Math.max(0, drive) }, from, to), windows, input.sampleRate, from), all[k]!.o.harmonicsDb!);

  let baseDrive = 0;
  const changes = new Array<number>(all.length).fill(0);
  for (let iteration = 0; iteration < 3; iteration++) {
    baseDrive = golden((d) => all.reduce((sum, _, k) => sum + error(k, d + changes[k]!), 0), 0, 12);
    for (let k = 1; k < all.length; k++) {
      changes[k] = golden((c) => error(k, baseDrive + c) + DRIVE_PENALTY * c * c, -baseDrive, 12 - baseDrive);
      if (Math.abs(changes[k]!) < MIN_DRIVE_CHANGE) changes[k] = 0;
    }
  }
  const byObservation = new Map(all.map((x, k) => [x.o, changes[k]!]));
  return { base: baseDrive, changes: points.map((p) => byObservation.get(p.o) ?? 0) };
}

/** How much of a render is compressed (share of windows with ≥ 3 dB reduction below its makeup level). */
export function compressedShare(o: DynamicsObservation, makeupDb: number): number {
  let compressed = 0, valid = 0;
  for (const g of o.measuredDb) {
    if (Number.isNaN(g)) continue;
    valid++;
    if (g < makeupDb - 3) compressed++;
  }
  return valid ? compressed / valid : 0;
}

export const STRUCTURES: CompressorStructure[] = (["peak", "rms"] as Detector[]).flatMap((detector) =>
  (["feedforward", "feedback"] as Topology[]).map((topology) => ({ detector, topology })));

// ---- parameter conditioning ------------------------------------------------------------------

/** Model parameters at the sweep points of one plugin parameter. */
export interface ParamTable {
  index: number;
  name: string;
  discrete: boolean;
  /** plugin value (normalised) → fitted model parameters (packed, see pack()) */
  points: { value: number; packed: number[] }[];
}

/**
 * Monotone cubic (PCHIP, Fritsch–Carlson) interpolation of one component at `x`; constant outside the points.
 * Follows bent control curves without overshooting. Same in plugin-template/dynamics/src/DynamicsEngine.h.
 */
export function pchip(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let k = 0;
  while (xs[k + 1]! < x) k++;
  const h = (i: number) => xs[i + 1]! - xs[i]!;
  const d = (i: number) => (ys[i + 1]! - ys[i]!) / h(i);
  const slope = (i: number) => {
    if (i === 0) return d(0);
    if (i === n - 1) return d(n - 2);
    const a = d(i - 1), b = d(i);
    if (a * b <= 0) return 0;
    const w1 = 2 * h(i) + h(i - 1), w2 = h(i) + 2 * h(i - 1);
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const hk = h(k), t = (x - xs[k]!) / hk, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[k]! + (t3 - 2 * t2 + t) * hk * slope(k) + (-2 * t3 + 3 * t2) * ys[k + 1]! + (t3 - t2) * hk * slope(k + 1);
}

/** Packed model at plugin value `value`: nearest point for discrete parameters, PCHIP otherwise. */
export function tableAt(table: ParamTable, value: number): number[] {
  const pts = table.points;
  if (table.discrete || pts.length === 1) {
    return pts.reduce((best, p) => (Math.abs(p.value - value) < Math.abs(best.value - value) ? p : best)).packed;
  }
  const xs = pts.map((p) => p.value);
  return pts[0]!.packed.map((_, i) => pchip(xs, pts.map((p) => p.packed[i]!), value));
}

/**
 * Model parameters for a combination of plugin values: base model plus the change each parameter causes
 * on its own (additive in the packed domain: dB, log ratio, log times).
 */
export function predictParams(base: CompressorParams, baseValues: Map<number, number>, tables: ParamTable[], values: Map<number, number>): CompressorParams {
  const packed = pack(base);
  for (const table of tables) {
    const value = values.get(table.index) ?? baseValues.get(table.index);
    const reference = baseValues.get(table.index);
    if (value === undefined || reference === undefined) continue;
    const at = tableAt(table, value), ref = tableAt(table, reference);
    for (let i = 0; i < packed.length; i++) packed[i]! += at[i]! - ref[i]!;
  }
  return unpack(packed);
}

// ---- complete fit ------------------------------------------------------------------------------

/** Below this share of compressed windows the timing of a render cannot be identified. */
const MIN_COMPRESSED_FOR_TIMING = 0.3;

export interface DynamicsRenderReport {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  /** error of the model predicted from the tables (what the clone will do) */
  rmsDb: number;
  maxDb: number;
  /** error of the odd harmonics (dB) */
  harmonicsDb?: number;
}

export interface DynamicsModel {
  type: "compressor";
  version: 1;
  sampleRate: number;
  structure: CompressorStructure;
  /** model of the plugin in its initial state */
  base: CompressorParams;
  /** plugin parameter values of the initial state (normalised) */
  baseValues: { index: number; value: number }[];
  tables: ParamTable[];
  report: {
    structures: { structure: CompressorStructure; rmsDb: number }[];
    renders: DynamicsRenderReport[];
    train?: Errors;
    validate?: Errors;
  };
}

const summarize = (rows: DynamicsRenderReport[]): Errors | undefined =>
  rows.length ? { rmsDb: rows.reduce((s, r) => s + r.rmsDb, 0) / rows.length, maxDb: Math.max(...rows.map((r) => r.maxDb)) } : undefined;

export function predictModel(model: DynamicsModel, values: Map<number, number>): CompressorParams {
  return predictParams(model.base, new Map(model.baseValues.map((v) => [v.index, v.value])), model.tables, values);
}

/**
 * Fits a compressor model: structure and full model on the initial state, then every single-parameter
 * sweep (static values; timing only where the render compresses enough), tables per parameter, and
 * finally predicts every render from the tables (validation renders were never used for fitting).
 */
export function fitDynamics(profile: Profile, onProgress?: (done: number, total: number, label: string) => void): DynamicsModel {
  const input = dynamicsInput(profile);
  const observations = dynamicsObservations(profile, input);
  const parameters = profile.parameters.parameters;
  const base = observations.find((o) => o.params.length === 0) ?? observations[0]!;
  const train = observations.filter((o) => o.purpose === "train" && o !== base && o.params.length === 1);
  const total = STRUCTURES.length + train.length;

  const structures = STRUCTURES.map((structure, i) => {
    onProgress?.(i, total, `Struktur ${structure.detector}/${structure.topology}`);
    return { structure, ...fitRender(base, input, structure) };
  }).sort((a, b) => a.errors.rmsDb - b.errors.rmsDb);
  const structure = structures[0]!.structure;
  // reference in the same regime as the sweep points (static refit with the base timing)
  const baseFit = fitStatic(base, input, structure, structures[0]!.params);
  baseFit.params = fitColour(base, input, baseFit.params, structure, true).params;

  const baseValues = new Map(parameters.map((p) => [p.index, p.value ?? p.default]));
  const tables = new Map<number, ParamTable>();
  const points: { o: DynamicsObservation; params: CompressorParams }[] = [];
  train.forEach((o, i) => {
    onProgress?.(STRUCTURES.length + i, total, o.label);
    let fit = fitStatic(o, input, structure, baseFit.params);
    if (compressedShare(o, fit.params.makeupDb) > MIN_COMPRESSED_FOR_TIMING) {
      const full = fitRender(o, input, structure, fit.params);
      if (full.errors.rmsDb < fit.errors.rmsDb * 0.8) fit = full;
    }
    fit.params = { ...fit.params, rippleTime: baseFit.params.rippleTime, ripple: baseFit.params.ripple };
    points.push({ o, params: fit.params });
    const p = o.params[0]!;
    const info = parameters.find((x) => x.index === p.index)!;
    const table = tables.get(p.index)
      ?? { index: p.index, name: info.name, discrete: info.discrete, points: [{ value: baseValues.get(p.index)!, packed: pack(baseFit.params) }] };
    table.points.push({ value: p.value, packed: pack(fit.params) });
    tables.set(p.index, table);
  });

  // saturation drive, jointly: base value + a (penalised) change per sweep point
  onProgress?.(total - 1, total, "Sättigung");
  const drives = fitDrives(input, structure, baseFit.params, base, points);
  baseFit.params.drive = drives.base;
  const DRIVE = 10;
  for (const table of tables.values()) table.points[0]!.packed[DRIVE] = drives.base; // the base point
  points.forEach((point, i) => {
    const table = tables.get(point.o.params[0]!.index)!;
    const entry = table.points.find((e) => e.value === point.o.params[0]!.value && e !== table.points[0]);
    if (entry) entry.packed[DRIVE] = drives.base + drives.changes[i]!;
  });
  for (const table of tables.values()) table.points.sort((a, b) => a.value - b.value);

  const model: DynamicsModel = {
    type: "compressor",
    version: 1,
    sampleRate: input.sampleRate,
    structure,
    base: baseFit.params,
    baseValues: [...tables.keys()].map((index) => ({ index, value: baseValues.get(index)! })),
    tables: [...tables.values()],
    report: { structures: structures.map((s) => ({ structure: s.structure, rmsDb: s.errors.rmsDb })), renders: [] },
  };

  model.report.renders = observations.map((o) => {
    const predicted = predictModel(model, new Map(o.params.map((p) => [p.index, p.value])));
    const e = compare(modelWindowDb(input, predicted, structure), o.measuredDb);
    let harmonics: number | undefined;
    const windows = input.harmonicWindows;
    if (o.harmonicsDb && windows.length) {
      const gains = simulateGain(input.levels[structure.detector], predicted, structure, input.sampleRate, input.energies[structure.detector]);
      const from = windows[0]!.start, to = windows[windows.length - 1]!.start + windows[windows.length - 1]!.length;
      harmonics = harmonicsError(harmonicsDb(renderModel(input.signal, gains, predicted, from, to), windows, input.sampleRate, from), o.harmonicsDb);
    }
    return { renderId: o.renderId, label: o.label, purpose: o.purpose, rmsDb: e.rmsDb, maxDb: e.maxDb, ...(harmonics !== undefined ? { harmonicsDb: harmonics } : {}) };
  });
  const trainStats = summarize(model.report.renders.filter((r) => r.purpose === "train"));
  const validateStats = summarize(model.report.renders.filter((r) => r.purpose === "validate"));
  if (trainStats) model.report.train = trainStats;
  if (validateStats) model.report.validate = validateStats;
  return model;
}
