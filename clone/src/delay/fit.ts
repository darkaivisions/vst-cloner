import { decodeWav, type Profile } from "@vst-cloner/profile";
import { fft, nextPowerOfTwo } from "../dsp/fft.ts";
import { nelderMead } from "../dsp/optimize.ts";
import { pchip, tableAt, type Errors, type ParamTable } from "../dynamics/fit.ts";
import { renderCondition, SWITCH_STATES } from "../dynamics/plan.ts";
import { HP_OFF, hpActive, LP_OFF, lpActive, MAX_FEEDBACK_DB, OFF_DB, onePole, packDelay, processDelay, unpackDelay, type DelayParams, type DelayStructure } from "./model.ts";

export interface DelayInput {
  sampleRate: number;
  /** the impulse segment: start and length (samples), amplitude of the impulse */
  start: number;
  length: number;
  amplitude: number;
}

export interface DelayObservation {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  params: { index: number; value: number }[];
  kind?: string;
  sweepParameter?: number;
  /** impulse response (answer to the impulse, scaled to a unit impulse) */
  response: Float32Array;
}

export function delayInput(profile: Profile): DelayInput {
  const segment = profile.testSignals.segments.find((s) => s.id === "impulse" && s.kind === "impulse");
  if (!segment) throw new Error("Das Profil enthält keine Delay-Messung (Impuls-Segment fehlt)");
  return { sampleRate: profile.manifest.capture.sampleRate, start: segment.start, length: segment.length, amplitude: segment.params?.amplitude ?? 1 };
}

export function delayResponse(output: ArrayLike<number>, input: DelayInput): Float32Array {
  const h = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) h[i] = (output[input.start + i] ?? 0) / input.amplitude;
  return h;
}

export function delayObservations(profile: Profile, input: DelayInput): DelayObservation[] {
  return profile.captures.renders.map((r) => ({
    renderId: r.id,
    label: r.label ?? r.id,
    purpose: r.purpose === "validate" ? "validate" : "train",
    params: r.params.map((p) => ({ index: p.index, value: p.value })),
    kind: r.kind,
    ...(r.sweepParameter !== undefined ? { sweepParameter: r.sweepParameter } : {}),
    response: delayResponse(decodeWav(profile.files.get(r.file)!).channels[0]!, input),
  }));
}

// ---- comparison --------------------------------------------------------------------------------

/** Levels below this (dB re. the unit impulse, per window) count as silence. */
export const DELAY_SILENCE_DB = -80;
/** … and so does everything this far below the loudest window of the original */
const AUDIBLE_RANGE_DB = 50;
const WINDOW_SECONDS = 0.01;
/** band edges of the comparison (Hz): lows, mids, highs */
const SPLITS = [400, 3000];

/**
 * Energy (dB) of an impulse response in three frequency bands, in Hann-weighted windows of 20 ms that overlap by
 * half: a repeat that lies a few samples earlier or later changes its windows only slightly, wherever it falls.
 */
export function envelopes(h: ArrayLike<number>, sampleRate: number): Float64Array[] {
  const hop = Math.round(WINDOW_SECONDS * sampleRate), size = 2 * hop;
  const windows = Math.max(0, Math.floor(h.length / hop) - 1);
  const sums = [new Float64Array(windows + 1), new Float64Array(windows + 1), new Float64Array(windows + 1)];
  const weight = Float64Array.from({ length: size }, (_, t) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (t + 0.5)) / size));
  const a = SPLITS.map((f) => onePole(f, sampleRate));
  let low = 0, mid = 0;
  for (let i = 0; i < (windows + 1) * hop; i++) {
    const x = h[i] ?? 0;
    low += (1 - a[0]!) * (x - low);
    mid += (1 - a[1]!) * (x - mid);
    const energy = [low * low, (mid - low) * (mid - low), (x - mid) * (x - mid)];
    const w = Math.floor(i / hop), t = i - w * hop;
    for (let b = 0; b < 3; b++) {
      if (w < windows) sums[b]![w]! += weight[t]! * energy[b]!;
      if (w >= 1) sums[b]![w - 1]! += weight[t + hop]! * energy[b]!;
    }
  }
  return sums.map((band) => band.subarray(0, windows).map((v) => Math.max(DELAY_SILENCE_DB, 10 * Math.log10(v + 1e-30))));
}

/**
 * Difference of two impulse responses: level per 10 ms window and band (dB), over all windows in which either
 * one is above silence. Echo times, levels, decay and colour all show in it.
 */
export function compareResponses(model: ArrayLike<number>, measured: ArrayLike<number>, sampleRate: number): Errors {
  const a = envelopes(model, sampleRate), b = envelopes(measured, sampleRate);
  // what lies far below the loudest part of the original is inaudible next to it: both are raised to that floor
  let top = DELAY_SILENCE_DB;
  for (const band of b) for (const v of band) if (v > top) top = v;
  const floor = Math.max(DELAY_SILENCE_DB, top - AUDIBLE_RANGE_DB);
  let sum = 0, n = 0, max = 0;
  for (let band = 0; band < 3; band++) {
    for (let w = 0; w < b[band]!.length; w++) {
      const x = Math.max(a[band]![w]!, floor), y = Math.max(b[band]![w]!, floor);
      if (x <= floor && y <= floor) continue;
      const d = Math.abs(x - y);
      sum += d * d;
      n++;
      if (d > max) max = d;
    }
  }
  return { rmsDb: n ? Math.sqrt(sum / n) : 0, maxDb: max };
}

// ---- analysis of one impulse response -----------------------------------------------------------

/** analysis bands (Hz, logarithmic) */
const BANDS = Array.from({ length: 25 }, (_, i) => 60 * (16000 / 60) ** (i / 24));
/**
 * Repeats quieter than this are not analysed: relative to the loudest sample of the response – an output level
 * turned far down makes everything quiet, not the echo inaudible – and absolutely, where only rounding is left.
 */
const MIN_ECHO_RELATIVE = 1e-3;
const MIN_LEVEL = 2e-6;
/** a further repeat this far below the first one is the end of the tail */
const MIN_REPEAT_RELATIVE = 3e-3;
/** the dry signal ends, and the first repeat can begin, after this time */
const DRY_SECONDS = 0.0015;

/** Level (dB) per analysis band of the part of `h` that starts at `start`; NaN where the window has no bin. */
function bandLevels(h: ArrayLike<number>, start: number, length: number, sampleRate: number): Float64Array {
  const size = nextPowerOfTwo(Math.max(length, 256));
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < length; i++) re[i] = h[start + i] ?? 0;
  fft(re, im);
  const out = new Float64Array(BANDS.length - 1);
  for (let b = 0; b < out.length; b++) {
    const from = Math.ceil((BANDS[b]! * size) / sampleRate), to = Math.floor((BANDS[b + 1]! * size) / sampleRate);
    let sum = 0, n = 0;
    for (let k = from; k <= to; k++) {
      sum += re[k]! * re[k]! + im[k]! * im[k]!;
      n++;
    }
    out[b] = n ? 10 * Math.log10(sum / n + 1e-30) : NaN;
  }
  return out;
}

/** Magnitude (dB) of the one-pole low-pass/high-pass pair of the model at the centre of every analysis band. */
function filterLevels(lp: number, hp: number, sampleRate: number): Float64Array {
  const out = new Float64Array(BANDS.length - 1);
  const response = (a: number, w: number): [number, number] => {
    // (1 − a) / (1 − a e^{−jw})
    const dr = 1 - a * Math.cos(w), di = a * Math.sin(w), d = dr * dr + di * di;
    return [((1 - a) * dr) / d, (-(1 - a) * di) / d];
  };
  for (let b = 0; b < out.length; b++) {
    const w = (2 * Math.PI * Math.sqrt(BANDS[b]! * BANDS[b + 1]!)) / sampleRate;
    let re = 1, im = 0;
    if (lpActive(lp)) [re, im] = response(onePole(lp, sampleRate), w);
    if (hpActive(hp)) {
      const [lr, li] = response(onePole(hp, sampleRate), w);
      // multiply by (1 − low-pass)
      const hr = 1 - lr, hi = -li;
      [re, im] = [re * hr - im * hi, re * hi + im * hr];
    }
    out[b] = 10 * Math.log10(re * re + im * im + 1e-30);
  }
  return out;
}

/** The low-pass stays this factor above the high-pass: crossed, the pair is only a (misleading) attenuator. */
const MIN_PASSBAND = 4;
const crossed = (lp: number, hp: number) => lpActive(lp) && hpActive(hp) && lp < MIN_PASSBAND * hp;

/** Level and filter (low-pass, high-pass) whose response matches band levels best. */
function fitFilter(levels: Float64Array, sampleRate: number): { db: number; lp: number; hp: number; error: number } {
  const valid = [...levels.keys()].filter((b) => !Number.isNaN(levels[b]!));
  const evaluate = (lp: number, hp: number) => {
    const model = filterLevels(lp, hp, sampleRate);
    // median and absolute deviations: bands in which the original's filter is steeper than a one-pole (far
    // below a high-pass, far above a low-pass) must not pull the level of the pass band down
    const diffs = valid.map((b) => levels[b]! - model[b]!).sort((x, y) => x - y);
    const db = diffs.length ? diffs[diffs.length >> 1]! : OFF_DB;
    const error = diffs.reduce((sum, d) => sum + Math.min(Math.abs(d - db), 12), 0) / Math.max(diffs.length, 1);
    return { db, error };
  };
  let best = { lp: LP_OFF, hp: HP_OFF, ...evaluate(LP_OFF, HP_OFF) };
  for (const lp of [100, 300, 1000, 3000, 8000, LP_OFF]) {
    for (const hp of [HP_OFF, 100, 500, 2000, 8000]) {
      if (crossed(lp, hp)) continue;
      const e = evaluate(lp, hp);
      if (e.error < best.error - 1e-9) best = { lp, hp, ...e };
    }
  }
  // a filter must earn its place: without a clear gain the path stays flat
  const flat = evaluate(LP_OFF, HP_OFF);
  const cost = (x: number[]) => {
    const lp = Math.min(LP_OFF, Math.exp(x[0]!)), hp = Math.max(HP_OFF, Math.exp(x[1]!));
    return crossed(lp, hp) ? 1e6 : evaluate(lp, hp).error;
  };
  const refined = nelderMead(cost, [Math.log(best.lp), Math.log(best.hp)], { step: [0.5, 0.5], maxEvaluations: 300 });
  const lp = Math.min(LP_OFF, Math.max(20, Math.exp(refined.x[0]!))), hp = Math.min(20000, Math.max(HP_OFF, Math.exp(refined.x[1]!)));
  const result = { lp, hp, ...evaluate(lp, hp) };
  return flat.error < result.error + 0.3 ? { lp: LP_OFF, hp: HP_OFF, ...flat } : result;
}

const peakIn = (h: ArrayLike<number>, from: number, to: number) => {
  let at = from, top = 0;
  for (let i = Math.max(0, from); i < Math.min(h.length, to); i++) {
    const a = Math.abs(h[i]!);
    if (a > top) {
      top = a;
      at = i;
    }
  }
  return { at, value: h[at] ?? 0, abs: top };
};

/**
 * Where the repeats begin: the first millisecond (after the dry signal) whose level rises clearly above what came
 * in the 30 ms before. A dry path with filters or tubes rings on for a while – that tail only falls, and is no
 * repeat, however loud it is next to a quiet echo. Returns −1 if nothing rises.
 */
function repeatOnset(h: ArrayLike<number>, guard: number, sampleRate: number, audible: number): number {
  const block = Math.max(1, Math.round(0.001 * sampleRate)), recent = 30;
  const first = Math.ceil(guard / block), count = Math.floor(h.length / block);
  const level = (b: number) => peakIn(h, b * block, (b + 1) * block).abs;
  const levels: number[] = [];
  for (let b = first; b < count; b++) {
    const current = level(b);
    // right after the guard there is nothing to compare with: a repeat only if no dry signal came before
    let before = levels.length ? 0 : peakIn(h, 0, first * block).abs > audible ? Infinity : 0;
    for (let k = Math.max(0, levels.length - recent); k < levels.length; k++) before = Math.max(before, levels[k]!);
    if (current > audible && current > 2 * before) return b * block;
    levels.push(current);
  }
  return -1;
}

export interface DelayAnalysis {
  params: DelayParams;
  structure: DelayStructure;
  /** number of repeats found */
  echoes: number;
}

/**
 * Reads the model values off an impulse response: dry level at the start, delay time from the first repeat, its
 * level and colour (wet path), level and colour of every further repeat relative to the one before (feedback
 * loop). What a response does not show (no repeat: time and loop; one repeat: the loop filter) is taken from
 * `fallback` – for sweep renders the base model, so that the control changes nothing it cannot be seen to change.
 */
export function analyseResponse(h: ArrayLike<number>, sampleRate: number, fallback?: DelayParams): DelayAnalysis {
  const off: DelayParams = fallback ?? { delaySeconds: 0.25, dryDb: OFF_DB, wetDb: OFF_DB, feedbackDb: OFF_DB, loopLp: LP_OFF, loopHp: HP_OFF, wetLp: LP_OFF, wetHp: HP_OFF };
  const guard = Math.round(DRY_SECONDS * sampleRate);
  const dry = peakIn(h, 0, guard);
  const top = peakIn(h, 0, h.length).abs;
  const audible = Math.max(MIN_LEVEL, MIN_ECHO_RELATIVE * top);
  const dryDb = dry.abs > audible ? Math.max(OFF_DB, 20 * Math.log10(dry.abs)) : OFF_DB;
  const structure: DelayStructure = { drySign: dry.value < 0 ? -1 : 1, wetSign: 1, feedbackSign: 1 };
  const onset = repeatOnset(h, guard, sampleRate, audible);
  const first = onset < 0 ? { at: guard, value: 0, abs: 0 } : peakIn(h, onset, h.length);
  if (first.abs < audible) return { params: { ...off, dryDb, wetDb: OFF_DB }, structure, echoes: 0 };

  // the first repeat is the loudest one; an earlier, quieter one would be a pre-echo of a multi-tap delay
  const delay = first.at;
  structure.wetSign = first.value < 0 ? -1 : 1;
  const pre = Math.min(32, Math.floor(delay * 0.05));
  const length = Math.max(64, Math.min(8192, Math.floor(delay * 0.9)));
  const levelsOf = (k: number) => bandLevels(h, k * delay - pre, length, sampleRate);
  const wet = fitFilter(levelsOf(1), sampleRate);

  // further repeats: level and colour relative to the repeat before, averaged over those above the noise
  const ratios: Float64Array[] = [];
  let echoes = 1, previous = first;
  for (let k = 2; k * delay + length < h.length && k <= 6; k++) {
    const peak = peakIn(h, k * delay - pre, k * delay + Math.min(length, Math.floor(delay / 2)));
    if (peak.abs < Math.max(MIN_LEVEL, MIN_REPEAT_RELATIVE * first.abs)) break;
    if (k === 2) structure.feedbackSign = peak.value * previous.value < 0 ? -1 : 1;
    const a = levelsOf(k - 1), b = levelsOf(k);
    ratios.push(b.map((v, i) => v - a[i]!));
    previous = peak;
    echoes = k;
  }
  let feedbackDb = OFF_DB, loopLp = off.loopLp, loopHp = off.loopHp;
  if (ratios.length) {
    const mean = ratios[0]!.map((_, i) => ratios.reduce((sum, r) => sum + r[i]!, 0) / ratios.length);
    const loop = fitFilter(mean, sampleRate);
    feedbackDb = Math.min(MAX_FEEDBACK_DB, loop.db);
    loopLp = loop.lp;
    loopHp = loop.hp;
  }
  const params: DelayParams = { delaySeconds: delay / sampleRate, dryDb, wetDb: wet.db, feedbackDb, loopLp, loopHp, wetLp: wet.lp, wetHp: wet.hp };

  // the peak of a filtered repeat lies a little after its start: shift the delay until the model's first repeat
  // lines up with the measured one
  const span = Math.min(length, 2048);
  const model = processDelay([1], { ...params, dryDb: OFF_DB, feedbackDb: OFF_DB }, { ...structure, drySign: 1 }, sampleRate, delay + span);
  let bestShift = 0, bestScore = -Infinity;
  for (let shift = -48; shift <= 48; shift++) {
    let score = 0;
    for (let i = 0; i < span; i++) score += (model[delay - pre + i] ?? 0) * (h[delay - pre + i + shift] ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }
  params.delaySeconds = Math.max(1, delay + bestShift) / sampleRate;
  return { params, structure, echoes };
}

// ---- complete fit ------------------------------------------------------------------------------

export interface DelayRenderReport {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  rmsDb: number;
  maxDb: number;
}

/** Base model values and one table of model values per plugin parameter. */
export interface DelayTables {
  structure: DelayStructure;
  base: DelayParams;
  baseValues: { index: number; value: number }[];
  tables: ParamTable[];
  /**
   * How the times of several controls combine. Missing: they multiply (a tempo and a note value) – the changes
   * of the packed (logarithmic) value add up. "sum": the changes in seconds add up (a delay and an offset).
   */
  timeRule?: "sum";
}

/**
 * Model of its own for one position of a switch (see SWITCH_STATES in dynamics/plan.ts): it applies while the
 * switch's value lies in `range`, and replaces the main model entirely.
 */
export interface DelayVariant extends DelayTables {
  index: number;
  value: number;
  /** normalised values of the switch for which this variant applies: from ≤ value < to */
  range: [number, number];
  name: string;
}

export interface DelayModel extends DelayTables {
  type: "delay";
  version: 1;
  sampleRate: number;
  variants?: DelayVariant[];
  report: {
    /** repeats found in the base render */
    echoes: number;
    renders: DelayRenderReport[];
    train?: Errors;
    validate?: Errors;
  };
}

/** a control moves the delay time if the longest measured time is this much longer than the shortest */
const TIME_CONTROL_RATIO = 1.2;
/** points added between two sweep points of a time control */
const TIME_STEPS = 8;

/**
 * Table of a delay-time control, made exact enough for echoes to line up:
 * - Sweep points without a visible repeat (time so short that it merges with the dry signal, or longer than the
 *   measurement) say nothing about time and levels. Their time is continued from the neighbouring points, the
 *   rest is taken from the nearest point that shows a repeat.
 * - A control that is linear in seconds (or, a tempo, in the rate) bends in the logarithmic packed value, sharply
 *   near zero. Where the measured points lie on a line on such a scale rather than in log seconds, points on that
 *   line are added between them, so the interpolation of the table (the same in the plugin) follows it.
 */
export function refineTimeTable(table: ParamTable, visible: (value: number) => boolean): void {
  if (table.discrete) return;
  const pts = table.points;
  const seen = pts.filter((pt) => visible(pt.value));
  if (seen.length < 3) return;
  const times = seen.map((pt) => pt.packed[0]!);
  if (Math.max(...times) - Math.min(...times) < Math.log(TIME_CONTROL_RATIO)) return;

  // which scale is the control linear in – seconds, their logarithm, or the rate (a tempo control)? Each inner
  // point is predicted from its neighbours on every scale.
  const xs = seen.map((pt) => pt.value);
  const scales: { name: string; to: (logSeconds: number) => number; from: (v: number) => number }[] = [
    { name: "log", to: (l) => l, from: (v) => v },
    { name: "seconds", to: (l) => Math.exp(l), from: (v) => Math.log(Math.max(v, 1e-4)) },
    { name: "rate", to: (l) => Math.exp(-l), from: (v) => -Math.log(Math.max(v, 1e-2)) },
  ];
  const errorOn = (scale: (typeof scales)[number]) => {
    let error = 0;
    for (let i = 1; i < seen.length - 1; i++) {
      const t = (xs[i]! - xs[i - 1]!) / (xs[i + 1]! - xs[i - 1]!);
      const a = scale.to(times[i - 1]!), b = scale.to(times[i + 1]!);
      error += Math.abs(scale.from(a + t * (b - a)) - times[i]!);
    }
    return error;
  };
  const chosen = scales.reduce((best, scale) => (errorOn(scale) < errorOn(best) - 1e-12 ? scale : best));
  const linear = chosen.name !== "log";
  const scale = chosen.to, unscale = chosen.from;
  const ys = times.map(scale);
  /** time on the control's scale: interpolated between the visible points, continued along the outer two beyond */
  const timeAt = (value: number) => {
    const n = xs.length;
    if (value < xs[0]!) return ys[0]! + ((value - xs[0]!) * (ys[1]! - ys[0]!)) / (xs[1]! - xs[0]!);
    if (value > xs[n - 1]!) return ys[n - 1]! + ((value - xs[n - 1]!) * (ys[n - 1]! - ys[n - 2]!)) / (xs[n - 1]! - xs[n - 2]!);
    return pchip(xs, ys, value);
  };

  for (const pt of pts) {
    if (visible(pt.value)) continue;
    const nearest = seen.reduce((best, other) => (Math.abs(other.value - pt.value) < Math.abs(best.value - pt.value) ? other : best));
    pt.packed = [unscale(timeAt(pt.value)), ...nearest.packed.slice(1)];
  }
  if (!linear) return;
  const original: ParamTable = { ...table, points: pts.map((pt) => ({ value: pt.value, packed: [...pt.packed] })) };
  const dense: ParamTable["points"] = [];
  for (let i = 0; i < pts.length; i++) {
    dense.push(pts[i]!);
    if (i === pts.length - 1) break;
    for (let k = 1; k < TIME_STEPS; k++) {
      const value = pts[i]!.value + (k / TIME_STEPS) * (pts[i + 1]!.value - pts[i]!.value);
      dense.push({ value, packed: [unscale(timeAt(value)), ...tableAt(original, value).slice(1)] });
    }
  }
  table.points = dense;
}

const summarize = (rows: DelayRenderReport[]): Errors | undefined =>
  rows.length ? { rmsDb: rows.reduce((s, r) => s + r.rmsDb, 0) / rows.length, maxDb: Math.max(...rows.map((r) => r.maxDb)) } : undefined;

/** The variant that applies to plugin values, if any. */
export function activeVariant<V extends { index: number; range: [number, number] }>(variants: V[] | undefined, values: Map<number, number>): V | undefined {
  return variants?.find((v) => {
    const value = values.get(v.index);
    return value !== undefined && value >= v.range[0] && value < v.range[1];
  });
}

const combine = (model: DelayTables, values: Map<number, number>): DelayParams => {
  const packed = packDelay(model.base);
  let seconds = Math.exp(packed[0]!);
  const baseValues = new Map(model.baseValues.map((v) => [v.index, v.value]));
  for (const table of model.tables) {
    const reference = baseValues.get(table.index);
    const value = values.get(table.index) ?? reference;
    if (value === undefined || reference === undefined) continue;
    const at = tableAt(table, value), ref = tableAt(table, reference);
    for (let i = 0; i < packed.length; i++) packed[i]! += at[i]! - ref[i]!;
    seconds += Math.exp(at[0]!) - Math.exp(ref[0]!);
  }
  if (model.timeRule === "sum") packed[0] = Math.log(Math.max(seconds, 1e-4));
  return unpackDelay(packed);
};

/**
 * Model values for a combination of plugin values: base plus the change each parameter causes on its own – of
 * the model for the current switch position where there is one.
 */
export function predictDelayModel(model: DelayTables & { variants?: DelayVariant[] }, values: Map<number, number>): { params: DelayParams; structure: DelayStructure } {
  const variant = activeVariant(model.variants, values);
  return { params: combine(variant ?? model, values), structure: (variant ?? model).structure };
}
export const predictDelay = (model: DelayTables & { variants?: DelayVariant[] }, values: Map<number, number>): DelayParams => predictDelayModel(model, values).params;

/** Impulse response of the model, as long as the measured ones. */
export const modelResponse = (p: DelayParams, s: DelayStructure, input: DelayInput) => processDelay([1], p, s, input.sampleRate, input.length);

/**
 * A model for a switch position must predict the check renders of that position better than the main model: by
 * this much on average (dB), and by half of it in the median – one lucky render must not decide.
 */
const MIN_VARIANT_GAIN_DB = 1;
const variantGain = (before: number[], after: number[]): boolean => {
  if (!before.length) return false;
  const gains = before.map((b, i) => b - after[i]!).sort((x, y) => x - y);
  const mean = gains.reduce((sum, g) => sum + g, 0) / gains.length;
  return mean >= MIN_VARIANT_GAIN_DB && gains[gains.length >> 1]! >= MIN_VARIANT_GAIN_DB / 2;
};

/**
 * Fits the delay model: base render in full, then every single-parameter sweep (a table of model values per
 * plugin parameter); a model of its own for switch positions the main model predicts badly; finally predicts
 * every render (validation renders – random combinations – were never used for fitting).
 */
export function fitDelay(profile: Profile, onProgress?: (done: number, total: number, label: string) => void): DelayModel {
  const input = delayInput(profile);
  const observations = delayObservations(profile, input);
  const parameters = profile.parameters.parameters;
  const working = new Map(((profile.manifest.capture.plan?.workingPoint as { index: number; value: number }[] | undefined) ?? []).map((w) => [w.index, w.value]));
  const baseValues = new Map(parameters.map((p) => [p.index, working.get(p.index) ?? p.value ?? p.default]));
  const base = observations.find((o) => o.kind === "default") ?? observations.find((o) => o.params.length === 0) ?? observations[0]!;
  const swept = (o: DelayObservation) =>
    o.sweepParameter !== undefined ? o.params.find((p) => p.index === o.sweepParameter) : o.params.length === 1 ? o.params[0] : undefined;
  const train = observations.filter((o) => o.purpose === "train" && o !== base && o.kind !== "random" && swept(o) !== undefined);
  const condition = (o: DelayObservation) => renderCondition(o.params, swept(o)!.index, baseValues);
  let done = 0;

  /** tables from the sweeps around one base render */
  const fitTables = (baseObservation: DelayObservation, sweeps: DelayObservation[], fallback?: DelayParams): DelayTables & { echoes: number } => {
    const baseFit = analyseResponse(baseObservation.response, input.sampleRate, fallback);
    const tables = new Map<number, ParamTable>();
    /** per table: plugin values whose render shows a repeat */
    const visible = new Map<number, Set<number>>();
    for (const o of sweeps) {
      onProgress?.(done++, train.length, o.label);
      const p = swept(o)!;
      const info = parameters.find((x) => x.index === p.index)!;
      const fit = analyseResponse(o.response, input.sampleRate, baseFit.params);
      const table = tables.get(p.index)
        ?? { index: p.index, name: info.name, discrete: info.discrete, points: [{ value: baseValues.get(p.index)!, packed: packDelay(baseFit.params) }] };
      table.points.push({ value: p.value, packed: packDelay(fit.params) });
      tables.set(p.index, table);
      const shown = visible.get(p.index) ?? new Set(baseFit.echoes > 0 ? [baseValues.get(p.index)!] : []);
      if (fit.echoes > 0) shown.add(p.value);
      visible.set(p.index, shown);
    }
    for (const [index, table] of tables) {
      // points at the same plugin value carry no information and break the interpolation (see fitDynamics)
      table.points = table.points.filter((pt, i, all) => all.findIndex((other) => Math.abs(other.value - pt.value) < 1e-9) === i);
      // a control that changes nothing needs no table
      const moves = table.points.some((pt) => pt.packed.some((v, k) => Math.abs(v - table.points[0]!.packed[k]!) > 1e-6));
      if (table.points.length < 2 || !moves) tables.delete(index);
      else {
        table.points.sort((a, b) => a.value - b.value);
        refineTimeTable(table, (value) => visible.get(index)!.has(value));
      }
    }
    return {
      structure: baseFit.structure,
      base: baseFit.params,
      baseValues: [...tables.keys()].map((index) => ({ index, value: baseValues.get(index)! })),
      tables: [...tables.values()],
      echoes: baseFit.echoes,
    };
  };
  const errorOf = (tables: DelayTables, o: DelayObservation) => {
    const predicted = predictDelayModel(tables, new Map(o.params.map((p) => [p.index, p.value])));
    return compareResponses(modelResponse(predicted.params, predicted.structure, input), o.response, input.sampleRate);
  };

  const { echoes, ...fitted } = fitTables(base, train.filter((o) => !condition(o)));
  const main: DelayTables = fitted;

  // Several controls that move the delay time: do their changes multiply or add up? Decided on the combinations
  // measured for the fit, by the time of the first repeat alone.
  const timeTables = main.tables.filter((t) => {
    const times = t.points.map((pt) => pt.packed[0]!);
    return Math.max(...times) - Math.min(...times) > Math.log(TIME_CONTROL_RATIO);
  });
  if (timeTables.length >= 2) {
    const switchLike = new Set(parameters.filter((p) => p.discrete && p.numSteps >= 2 && p.numSteps <= SWITCH_STATES).map((p) => p.index));
    const mixes = observations.filter((o) => o.purpose === "train" && o.kind === "random"
      && o.params.every((p) => !switchLike.has(p.index) || Math.abs(p.value - (baseValues.get(p.index) ?? p.value)) < 1e-4));
    const errors = { product: [] as number[], sum: [] as number[] };
    for (const o of mixes) {
      const values = new Map(o.params.map((p) => [p.index, p.value]));
      const product = combine(main, values), sum = combine({ ...main, timeRule: "sum" }, values);
      for (const [rule, predicted] of [["product", product], ["sum", sum]] as const) {
        const seen = analyseResponse(o.response, input.sampleRate, predicted);
        if (seen.echoes > 0) errors[rule].push(Math.abs(Math.log(seen.params.delaySeconds / predicted.delaySeconds)));
      }
    }
    const median = (list: number[]) => [...list].sort((a, b) => a - b)[list.length >> 1] ?? Infinity;
    // the sum must be clearly better where the product is clearly wrong (more than 1 % in time)
    if (errors.sum.length >= 4 && errors.product.length >= 4 && median(errors.product) > 0.01 && median(errors.sum) < 0.5 * median(errors.product)) {
      main.timeRule = "sum";
    }
  }

  // switch positions: a model of its own where it predicts the renders of that position clearly better
  const variants: DelayVariant[] = [];
  const positions = new Map<string, { index: number; value: number; sweeps: DelayObservation[] }>();
  for (const o of train) {
    const c = condition(o);
    if (!c) continue;
    const key = `${c.index}:${c.value.toFixed(6)}`;
    (positions.get(key) ?? positions.set(key, { ...c, sweeps: [] }).get(key)!).sweeps.push(o);
  }
  for (const position of positions.values()) {
    const start = train.find((o) => !condition(o) && swept(o)!.index === position.index && Math.abs(swept(o)!.value - position.value) < 1e-4);
    if (!start) continue;
    const { echoes: _, ...own }: DelayTables & { echoes: number } = { ...fitTables(start, position.sweeps, main.base), ...(main.timeRule ? { timeRule: main.timeRule } : {}) };
    // Tables reproduce their own sweep points by construction, so a better fit of those proves nothing. The
    // decision is made on the random combinations measured in this position, which no table has seen.
    const checks = observations.filter((o) => o.purpose === "train" && o.kind === "random" && o.params.some((p) => p.index === position.index && Math.abs(p.value - position.value) < 1e-4));
    const errors = (tables: DelayTables) => checks.map((o) => errorOf(tables, o).rmsDb);
    if (!variantGain(errors(main), errors(own))) continue;
    const info = parameters.find((x) => x.index === position.index)!;
    const step = 1 / Math.max(info.numSteps - 1, 1);
    variants.push({
      ...own, index: position.index, value: position.value, name: `${info.name} = ${start.label.split(" = ").pop()}`,
      range: [position.value - step / 2, position.value + step / 2],
    });
  }

  const model: DelayModel = {
    type: "delay",
    version: 1,
    sampleRate: input.sampleRate,
    ...main,
    ...(variants.length ? { variants } : {}),
    report: { echoes, renders: [] },
  };
  model.report.renders = observations.map((o) => {
    const e = errorOf(model, o);
    return { renderId: o.renderId, label: o.label, purpose: o.purpose, rmsDb: e.rmsDb, maxDb: e.maxDb };
  });
  const trainStats = summarize(model.report.renders.filter((r) => r.purpose === "train"));
  const validateStats = summarize(model.report.renders.filter((r) => r.purpose === "validate"));
  if (trainStats) model.report.train = trainStats;
  if (validateStats) model.report.validate = validateStats;
  return model;
}
