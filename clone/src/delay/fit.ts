import { readCapture, type Profile } from "@vst-cloner/profile";
import { fft, nextPowerOfTwo } from "../dsp/fft.ts";
import { nelderMead } from "../dsp/optimize.ts";
import { pchip, tableAt, type Errors, type ParamTable } from "../dynamics/fit.ts";
import { parameterPositions, positionOf, renderCondition, steppedParameter, SWITCH_STATES } from "../dynamics/plan.ts";
import { renderTestSignal, type MeasuredSteps } from "@vst-cloner/capture";
import { compareTracks, duckTrack, fitDuck, showsDucking, type DuckInput } from "./duck.ts";
import { DUCK_OFF_DB, HP_OFF, hpActive, LP_OFF, lpActive, MAX_FEEDBACK_DB, MOD_OFF, OFF_DB, onePole, packDelay, processDelay, unpackDelay, type DelayParams, type DelayStructure } from "./model.ts";
import { clickTaps, measureModulation, measurePhaser, measureTremolo, wrapPhase, type MeasuredModulation, type MeasuredPhaser, type MeasuredTremolo } from "./modulation.ts";

export interface DelayInput {
  sampleRate: number;
  /** the impulse segment: start and length (samples), amplitude of the impulse */
  start: number;
  length: number;
  amplitude: number;
  /** samples the plugin ran before the input began (pre-roll of the capture): the LFO's phase depends on it */
  preroll: number;
  /** the train of clicks of a modulation measurement (see modulationSegmentSpecs) */
  clicks?: { start: number; length: number; amplitude: number; period: number };
  /** the ducking probe (delays with ducking, see duck.ts) */
  duck?: DuckInput;
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
  /** answer to the clicks, scaled to unit clicks (modulation measurements) */
  clicks?: Float32Array;
  /** gain of the echo over the duck segment (dB, see duckTrack) */
  duck?: Float32Array;
  /** level of what the plugin plays before the impulse, relative to the impulse (dB) */
  residualDb?: number;
}

/**
 * A render whose output before the impulse is this loud relative to the impulse cannot be read: what circulates
 * there (a loop at full feedback keeping a switch-on click) would be taken for echoes. Its sweep point is left out.
 */
export const MAX_RESIDUAL_DB = -40;

/** RMS of an output before the impulse, relative to the impulse (dB). */
export function residualDb(output: ArrayLike<number>, input: DelayInput): number {
  let sum = 0;
  for (let i = 0; i < input.start; i++) sum += (output[i] ?? 0) ** 2;
  return 10 * Math.log10(sum / Math.max(input.start, 1) + 1e-30) - 20 * Math.log10(input.amplitude);
}

export function delayInput(profile: Profile): DelayInput {
  const segment = profile.testSignals.segments.find((s) => s.id === "impulse" && s.kind === "impulse");
  if (!segment) throw new Error("The profile holds no delay measurement (impulse segment missing)");
  const sampleRate = profile.manifest.capture.sampleRate;
  const clicks = profile.testSignals.segments.find((s) => s.kind === "clicks");
  const duck = profile.testSignals.segments.find((s) => s.kind === "duck");
  return {
    sampleRate, start: segment.start, length: segment.length, amplitude: segment.params?.amplitude ?? 1,
    preroll: Math.floor(profile.manifest.capture.prerollSeconds * sampleRate),
    ...(clicks ? { clicks: { start: clicks.start, length: clicks.length, amplitude: clicks.params?.amplitude ?? 1, period: Math.max(1, Math.round((clicks.params?.periodSeconds ?? 0.04) * sampleRate)) } } : {}),
    ...(duck ? {
      duck: {
        sampleRate, signal: renderTestSignal({ ...profile.testSignals, channels: 1 }).channels[0]!, start: duck.start, length: duck.length,
        probeFrequency: duck.params!.probeFrequency!, probeAmplitude: 10 ** (duck.params!.probeDb! / 20),
        triggerAt: Math.round(Math.min(duck.params!.impulseSeconds!, duck.params!.burstsSeconds!) * sampleRate),
      },
    } : {}),
  };
}

/** The answer of a plugin (original or clone) to the test signal: impulse response, clicks, ducking. */
export function answerOf(output: ArrayLike<number>, input: DelayInput): DelayAnswer {
  const response = delayResponse(output, input);
  const clicks = clicksResponse(output, input);
  const duck = input.duck ? duckTrack(output, input.duck, response[0] ?? 0) : undefined;
  return { response, ...(clicks ? { clicks } : {}), ...(duck ? { duck } : {}) };
}

export function clicksResponse(output: ArrayLike<number>, input: DelayInput): Float32Array | undefined {
  const c = input.clicks;
  if (!c) return undefined;
  return Float32Array.from({ length: c.length }, (_, i) => (output[c.start + i] ?? 0) / c.amplitude);
}

export function delayResponse(output: ArrayLike<number>, input: DelayInput): Float32Array {
  const h = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) h[i] = (output[input.start + i] ?? 0) / input.amplitude;
  return h;
}

/** Answers of the given channel (the second exists for stereo captures; mono ones repeat the first). */
export function delayObservations(profile: Profile, input: DelayInput, channelIndex = 0): DelayObservation[] {
  return profile.captures.renders.map((r) => {
    const channels = readCapture(profile, r).channels;
    const output = channels[Math.min(channelIndex, channels.length - 1)]!;
    const answer = answerOf(output, input);
    return {
      renderId: r.id,
      label: r.label ?? r.id,
      purpose: r.purpose === "validate" ? "validate" : "train",
      params: r.params.map((p) => ({ index: p.index, value: p.value })),
      kind: r.kind,
      ...(r.sweepParameter !== undefined ? { sweepParameter: r.sweepParameter } : {}),
      ...answer,
      residualDb: residualDb(output, input),
    };
  });
}

/** side-to-mid energy (dB) above which a capture counts as stereo: the right channel gets a model of its own */
export const STEREO_SIDE_DB = -30;

/** Whether the original answers differently on its two channels (ping-pong, stereo chorus …), from a few renders. */
export function isStereoCapture(profile: Profile): boolean {
  let side = 0, mid = 0;
  for (const r of profile.captures.renders.filter((x) => !x.mono).slice(0, 12)) {
    const channels = readCapture(profile, r).channels;
    if (channels.length < 2) continue;
    const [left, right] = channels as [Float32Array, Float32Array];
    for (let i = 0; i < left.length; i++) {
      side += (left[i]! - right[i]!) ** 2;
      mid += (left[i]! + right[i]!) ** 2;
    }
  }
  return mid > 0 && 10 * Math.log10(side / mid + 1e-30) > STEREO_SIDE_DB;
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
  let first = onset < 0 ? { at: guard, value: 0, abs: 0 } : peakIn(h, onset, h.length);
  if (onset >= 0) {
    // Feedback at or above unity makes later repeats louder than the first. The loudest peak is one of those
    // if it lies at a multiple of the time of the peak at the onset – then that one is the first repeat.
    const early = peakIn(h, onset, onset + Math.round(0.02 * sampleRate));
    const multiple = first.at / Math.max(early.at, 1);
    if (early.abs >= audible && Math.round(multiple) >= 2 && Math.abs(multiple - Math.round(multiple)) < 0.03 * Math.round(multiple)) first = early;
  }
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
  /** stereo originals (ping-pong, stereo LFOs): the model of the right channel; the main one is the left */
  right?: DelayTables & { variants?: DelayVariant[] };
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

/**
 * Ducking: a control's table keeps only the detector values it clearly moves (threshold by more than 6 dB, attack
 * or release by more than a factor of 2, not counting the outermost point at either end); smaller moves along a sweep make up for what the model misses (a long
 * attack) and add up wrongly in combinations (Gxduck_delay: the attack sweep stretched the release by 35 %, an
 * echo then stayed ducked). The others are set to the base render's.
 */
const DUCK_OWN = [[15, 6], [16, Math.log(2)], [17, Math.log(2)]] as const;
export function ownDuckValues(table: ParamTable, base: number[]): void {
  for (const [k, range] of DUCK_OWN) {
    // the spread without the outermost point at either end: one failed fit does not make a control move a value
    const values = table.points.map((pt) => pt.packed[k] ?? base[k]!).sort((x, y) => x - y);
    const inner = values.length >= 4 ? values.slice(1, -1) : values;
    if (inner[inner.length - 1]! - inner[0]! > range) continue;
    for (const pt of table.points) if (pt.packed.length > k) pt.packed[k] = base[k]!;
  }
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
    // (tables of models fitted before the LFO have fewer values)
    for (let i = 0; i < packed.length; i++) packed[i]! += (at[i] ?? ref[i] ?? 0) - (ref[i] ?? 0);
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

/** Impulse response of the model, as long as the measured ones (to an impulse as loud as the measured one: ducking depends on it). */
export const modelResponse = (p: DelayParams, s: DelayStructure, input: DelayInput) =>
  processDelay([input.amplitude], p, s, input.sampleRate, input.length, input.preroll + input.start).map((v) => v / input.amplitude);

/** Answer of the model to the clicks (modulation measurements). */
export function modelClicks(p: DelayParams, s: DelayStructure, input: DelayInput): Float32Array | undefined {
  const c = input.clicks;
  if (!c) return undefined;
  const signal = new Float32Array(c.length);
  for (let i = 0; i < c.length; i += c.period) signal[i] = 1;
  return processDelay(signal, p, s, input.sampleRate, c.length, input.preroll + c.start);
}

export interface DelayAnswer {
  response: Float32Array;
  clicks?: Float32Array;
  duck?: Float32Array;
}

/** The model's answer to the measurement signal: impulse response and, for modulation measurements, the clicks. */
export function modelAnswer(p: DelayParams, s: DelayStructure, input: DelayInput): DelayAnswer {
  const clicks = modelClicks(p, s, input);
  const response = modelResponse(p, s, input);
  // ducking: the model over the whole test signal, read like the original
  const duck = input.duck ? duckTrack(processDelay(input.duck.signal, p, s, input.sampleRate, input.duck.start + input.duck.length, input.preroll), input.duck, response[0] ?? 0) : undefined;
  return { response, ...(clicks ? { clicks } : {}), ...(duck ? { duck } : {}) };
}

/** Two answers against each other: the impulse response and, where measured, the answer to the clicks (the LFO). */
export function compareAnswers(a: DelayAnswer, b: DelayAnswer, input: DelayInput): Errors {
  const impulse = compareResponses(a.response, b.response, input.sampleRate);
  if (input.duck && (a.duck || b.duck)) {
    // ducking: the gain tracks; one side without a readable echo is compared with an open echo (0 dB)
    const open = new Float32Array((a.duck ?? b.duck)!.length);
    const duck = compareTracks(a.duck ?? open, b.duck ?? open);
    return { rmsDb: (impulse.rmsDb + duck.rmsDb) / 2, maxDb: Math.max(impulse.maxDb, duck.maxDb) };
  }
  if (!a.clicks || !b.clicks || !input.clicks) return impulse;
  const lfo = compareClicks(a.clicks, b.clicks, input.sampleRate, input.clicks.period);
  return { rmsDb: (impulse.rmsDb + lfo.rmsDb) / 2, maxDb: Math.max(impulse.maxDb, lfo.maxDb) };
}

/** Model against a measured render. */
export const compareDelay = (p: DelayParams, s: DelayStructure, input: DelayInput, measured: DelayAnswer): Errors => compareAnswers(modelAnswer(p, s, input), measured, input);

/**
 * Difference of two answers to the clicks: the envelope comparison of the whole answer, and how far apart the
 * two LFOs move the delay time – centre, depth and rate, with the phase aligned (the phase of an LFO when the
 * music starts is arbitrary and inaudible). 0.5 ms of deviation counts as 6 dB.
 */
function compareClicks(model: Float32Array, measured: Float32Array, sampleRate: number, period: number): Errors {
  const envelope = compareResponses(model, measured, sampleRate);
  const deviation = lfoDeviation(measureModulation({ h: model, period }, sampleRate), measureModulation({ h: measured, period }, sampleRate), measured.length / sampleRate);
  const lfoDb = 20 * Math.log10(1 + deviation / 0.0005);
  return { rmsDb: (envelope.rmsDb + lfoDb) / 2, maxDb: Math.max(envelope.maxDb, lfoDb) };
}

/** RMS distance (seconds) of two delay curves centre + depth · sin(2π rate t + phase) over `seconds`, the phase of the first aligned to the second */
export function lfoDeviation(a: MeasuredModulation | undefined, b: MeasuredModulation | undefined, seconds: number): number {
  if (!a && !b) return 0;
  const curve = (m: MeasuredModulation | undefined, shift: number) => (t: number) => (m ? m.centre + m.depth * Math.sin(2 * Math.PI * m.rate * t + m.phase + shift) : 0);
  // without an LFO on one side: the other's depth (its centre is the plain delay, compared by the envelopes)
  if (!a || !b) return (a ?? b)!.depth / Math.SQRT2;
  const steps = 400, shifts = 64;
  let best = Infinity;
  for (let k = 0; k < shifts; k++) {
    const f = curve(a, (2 * Math.PI * k) / shifts), g = curve(b, 0);
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * seconds;
      sum += (f(t) - g(t)) ** 2;
    }
    best = Math.min(best, Math.sqrt(sum / steps));
  }
  return best;
}

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
 * Start of the LFO, common to all renders: phase φ0 and lead L (samples before the reset point) such that the
 * phase at the first click of every render is φ0 + ω · (L + pre-roll + start of the clicks). With a single rate
 * the lead cannot be told from the phase; it is then 0.
 */
/** What a measured LFO says about its start: rate (Hz), phase at the first click, uncertainty of the phase (rad). */
export interface LfoReading {
  rate: number;
  phase: number;
  error: number;
}

/** The phase error of a sine fitted to repeat times is about its residual over its depth. */
export const delayReading = (m: MeasuredModulation, sampleRate: number): LfoReading =>
  ({ rate: m.rate, phase: m.phase, error: m.residual / Math.max(m.depth * sampleRate, 1e-9) });

/** What the LFO moves in a modulation effect: the delay time (chorus, flanger, vibrato), the level, or a phaser. */
export type ModulationKind = "delay" | "tremolo" | "phaser";
export function modulationKind(name: string, category = ""): ModulationKind {
  const text = `${name} ${category}`;
  if (/phas/i.test(text)) return "phaser";
  if (/trem/i.test(text)) return "tremolo";
  return "delay";
}

/** The LFO of an answer to the clicks, as the measurement of that kind sees it. */
function readLfo(kind: ModulationKind, h: Float32Array, input: DelayInput): LfoReading | undefined {
  const response = { h, period: input.clicks!.period };
  if (kind === "tremolo") return measureTremolo(response, input.sampleRate);
  if (kind === "phaser") return measurePhaser(response, input.sampleRate);
  const m = measureModulation(response, input.sampleRate);
  return m ? delayReading(m, input.sampleRate) : undefined;
}

export function lfoStart(readings: LfoReading[], input: DelayInput): { phase: number; lead: number } {
  const offset = input.preroll + (input.clicks?.start ?? 0);
  // weighted by how sure each phase is
  const items = readings.map((m) => {
    const omega = (2 * Math.PI * m.rate) / input.sampleRate;
    return { omega, r: m.phase - omega * offset, w: 1 / (0.01 + m.error * m.error) };
  });
  return phaseAndLead(items, -input.preroll, input.sampleRate);
}

/** φ and L (whole samples in [from, to]) with r ≈ φ + ω · L for all items, weighted (a circular fit) */
function phaseAndLead(items: { omega: number; r: number; w: number }[], from: number, to: number): { phase: number; lead: number } {
  const score = (lead: number) => {
    let re = 0, im = 0;
    for (const { omega, r, w } of items) {
      re += w * Math.cos(r - omega * lead);
      im += w * Math.sin(r - omega * lead);
    }
    return { length: Math.hypot(re, im), phase: Math.atan2(im, re) };
  };
  let best = { lead: 0, ...score(0) };
  for (let lead = from; lead <= to; lead++) {
    const s = score(lead);
    if (s.length > best.length * (1 + 1e-9)) best = { lead, ...s };
  }
  return { phase: wrapPhase(best.phase), lead: best.lead };
}

/**
 * The phase the clicks show is not quite the phase of the delay line's LFO (a repeat leaves the line after the
 * delay it was read with, and plugins differ in when they read it). The model is therefore measured the way the
 * original was, and its LFO start is moved by the difference – in phase, and in lead where it grows with the rate.
 */
function calibrateLfo(model: DelayTables & { variants?: DelayVariant[] }, observations: DelayObservation[], readings: Map<string, LfoReading>, kind: ModulationKind, input: DelayInput): void {
  if (!input.clicks) return;
  const items: { omega: number; r: number; w: number }[] = [];
  for (const o of observations) {
    const original = readings.get(o.renderId);
    if (!original || o.purpose !== "train") continue;
    const predicted = predictDelayModel(model, new Map(o.params.map((p) => [p.index, p.value])));
    const own = readLfo(kind, modelClicks(predicted.params, predicted.structure, input)!, input);
    if (!own || Math.abs(Math.log(own.rate / original.rate)) > 0.01) continue;
    items.push({ omega: (2 * Math.PI * original.rate) / input.sampleRate, r: wrapPhase(original.phase - own.phase), w: 1 / (0.01 + original.error * original.error) });
  }
  if (items.length === 0) return;
  const shift = phaseAndLead(items, -Math.round(0.1 * input.sampleRate), Math.round(0.1 * input.sampleRate));
  for (const tables of [model, ...(model.variants ?? [])]) {
    tables.base = { ...tables.base, modPhase: wrapPhase((tables.base.modPhase ?? 0) + shift.phase) };
    for (const table of tables.tables) for (const point of table.points) if (point.packed.length > 10) point.packed[10]! += shift.phase;
    tables.structure = { ...tables.structure, modLead: (tables.structure.modLead ?? 0) + shift.lead };
  }
}

/**
 * Fits the delay model: base render in full, then every single-parameter sweep (a table of model values per
 * plugin parameter); a model of its own for switch positions the main model predicts badly; finally predicts
 * every render (validation renders – random combinations – were never used for fitting).
 */
/**
 * Fits the delay model; an original that answers differently on its two channels gets a second model for the right
 * channel (fitted the same way on that channel), and the report covers both.
 */
export function fitDelay(profile: Profile, onProgress?: (done: number, total: number, label: string) => void): DelayModel {
  const left = fitDelayChannel(profile, onProgress, 0);
  // (VCH_DELAY_MONO: one model for both channels, as before – for comparisons)
  if (process.env.VCH_DELAY_MONO || !isStereoCapture(profile)) return left;
  const right = fitDelayChannel(profile, undefined, 1);
  const { type: _t, version: _v, sampleRate: _s, report: rightReport, right: _r, ...rightTables } = right;
  const byId = new Map(rightReport.renders.map((r) => [r.renderId, r]));
  const renders = left.report.renders.map((r) => {
    const other = byId.get(r.renderId);
    return other ? { ...r, rmsDb: (r.rmsDb + other.rmsDb) / 2, maxDb: Math.max(r.maxDb, other.maxDb) } : r;
  });
  const model: DelayModel = { ...left, right: rightTables, report: { ...left.report, renders } };
  delete model.report.train;
  delete model.report.validate;
  const trainStats = summarize(renders.filter((r) => r.purpose === "train"));
  const validateStats = summarize(renders.filter((r) => r.purpose === "validate"));
  if (trainStats) model.report.train = trainStats;
  if (validateStats) model.report.validate = validateStats;
  return model;
}

/** Every table and switch of both channels: the controls the clone needs (the right channel may use others). */
export const delayParamSource = (model: DelayModel): { tables: { index: number }[]; variants?: { index: number; tables: { index: number }[] }[] } => ({
  tables: [...model.tables, ...(model.right?.tables ?? [])],
  variants: [...(model.variants ?? []), ...(model.right?.variants ?? [])],
});

/** The tables of the model for one channel: the right one where the original is stereo. */
export const channelModel = (model: DelayModel, channel: number): DelayTables & { variants?: DelayVariant[] } =>
  (channel === 1 && model.right ? model.right : model);

function fitDelayChannel(profile: Profile, onProgress: ((done: number, total: number, label: string) => void) | undefined, channel: number): DelayModel {
  const input = delayInput(profile);
  const observations = delayObservations(profile, input, channel);
  const parameters = profile.parameters.parameters;
  const working = new Map(((profile.manifest.capture.plan?.workingPoint as { index: number; value: number }[] | undefined) ?? []).map((w) => [w.index, w.value]));
  const baseValues = new Map(parameters.map((p) => [p.index, working.get(p.index) ?? p.value ?? p.default]));
  // controls that move in steps: declared, measured by the survey, or told by their value texts (as in the plan)
  const measuredSteps = (profile.manifest.capture.plan?.steps as MeasuredSteps[] | undefined) ?? [];
  const stepped = new Map(parameters.flatMap((p) => {
    const found = parameterPositions(p, measuredSteps);
    return found ? [[p.index, found] as const] : [];
  }));
  const base = observations.find((o) => o.kind === "default") ?? observations.find((o) => o.params.length === 0) ?? observations[0]!;
  const swept = (o: DelayObservation) =>
    o.sweepParameter !== undefined ? o.params.find((p) => p.index === o.sweepParameter) : o.params.length === 1 ? o.params[0] : undefined;
  const train = observations.filter((o) => o.purpose === "train" && o !== base && o.kind !== "random" && swept(o) !== undefined);
  const condition = (o: DelayObservation) => renderCondition(o.params, swept(o)!.index, baseValues);
  let done = 0;

  // LFO (modulation measurements): read off every render's clicks; the phase at the LFO's start is the same for
  // all of them, but when that start lies before the pre-roll (the plugin's set-up) the phase at the input depends
  // on the rate – the lead is found as the one that lines all renders up
  const kind = modulationKind(profile.manifest.plugin.name, profile.manifest.plugin.category ?? "");
  const measured = new Map<string, MeasuredModulation>();
  const tremolos = new Map<string, MeasuredTremolo>();
  const phasers = new Map<string, MeasuredPhaser>();
  for (const o of observations) {
    if (!o.clicks || !input.clicks) continue;
    const response = { h: o.clicks, period: input.clicks.period };
    if (kind === "tremolo") {
      const m = measureTremolo(response, input.sampleRate);
      if (m) tremolos.set(o.renderId, m);
    } else if (kind === "phaser") {
      const m = measurePhaser(response, input.sampleRate);
      if (m) phasers.set(o.renderId, m);
    } else {
      const m = measureModulation(response, input.sampleRate);
      if (m) measured.set(o.renderId, m);
    }
  }
  // the number of allpass stages is the plugin's: the most frequent one
  const stageCounts = new Map<number, number>();
  for (const m of phasers.values()) stageCounts.set(m.stages, (stageCounts.get(m.stages) ?? 0) + 1);
  const phaserStages = [...stageCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  // A repeat later than the spacing of the clicks lands after the next click: the clicks show the time modulo the
  // spacing. The impulse response shows the whole time; the clicks' centre is moved by whole spacings to lie
  // nearest to it, and the phase with it (the repeat seen after click k + w belongs to click k).
  const periodSeconds = (input.clicks?.period ?? 1) / input.sampleRate;
  const unwrapped = (m: MeasuredModulation | undefined, analysis: DelayAnalysis): MeasuredModulation | undefined => {
    if (!m || analysis.echoes === 0) return m;
    const wraps = Math.max(0, Math.round((analysis.params.delaySeconds - m.centre) / periodSeconds));
    if (wraps === 0) return m;
    return { ...m, centre: m.centre + wraps * periodSeconds, phase: m.phase + 2 * Math.PI * m.rate * wraps * periodSeconds };
  };
  for (const o of observations) {
    const m = measured.get(o.renderId);
    if (m) measured.set(o.renderId, unwrapped(m, analyseResponse(o.response, input.sampleRate))!);
  }
  const readings = new Map<string, LfoReading>([
    ...[...measured].map(([id, m]) => [id, delayReading(m, input.sampleRate)] as const),
    ...tremolos, ...phasers,
  ]);
  const lfo = readings.size ? lfoStart([...readings.values()], input) : undefined;
  /** the impulse response's analysis, with the LFO of the render where it has one */
  const analyse = (o: DelayObservation, fallback?: DelayParams): DelayAnalysis => {
    const analysis = analyseResponse(o.response, input.sampleRate, fallback);
    if (!lfo) return analysis;
    const db = (v: number) => Math.max(OFF_DB, 20 * Math.log10(Math.abs(v) + 1e-12));
    if (kind === "tremolo") {
      // the level the LFO moves; no echoes
      const t = tremolos.get(o.renderId);
      const params: DelayParams = {
        ...analysis.params, wetDb: OFF_DB, feedbackDb: OFF_DB, modDepthSeconds: MOD_OFF, modPhase: lfo.phase,
        modRate: t?.rate ?? fallback?.modRate ?? 1, tremDepth: t?.depth ?? 0, ...(t ? { dryDb: db(t.level) } : {}),
      };
      const structure = { ...analysis.structure, ...(t ? { drySign: t.level < 0 ? -1 : 1 } : {}), modLead: lfo.lead };
      return { ...analysis, params, structure, echoes: 1 };
    }
    if (kind === "phaser" && phaserStages) {
      // dry plus the allpass chain the LFO sweeps
      const ph = phasers.get(o.renderId);
      const params: DelayParams = {
        ...analysis.params, feedbackDb: OFF_DB, modDepthSeconds: MOD_OFF, modPhase: lfo.phase,
        modRate: ph?.rate ?? fallback?.modRate ?? 1,
        phaserCentre: ph?.centre ?? fallback?.phaserCentre ?? 1000, phaserOctaves: ph?.octaves ?? 0,
        phaserFeedback: ph?.feedback ?? fallback?.phaserFeedback ?? 0,
        ...(ph ? { dryDb: db(ph.dry), wetDb: db(ph.wet) } : {}),
      };
      const drySign = analysis.structure.drySign;
      const structure = { ...analysis.structure, ...(ph ? { wetSign: Math.sign(ph.wet / ph.dry) * drySign } : {}), phaserStages, modLead: lfo.lead };
      return { ...analysis, params, structure, echoes: 1 };
    }
    const m = measured.get(o.renderId);
    // a repeat that falls on the dry signal at the moment of the impulse (a flanger near zero) is not seen in the
    // impulse response: its level is then that of the clicks' repeats
    const wet = m && analysis.echoes === 0 && Math.abs(m.gain) > 1e-4 ? { wetDb: 20 * Math.log10(Math.abs(m.gain)) } : {};
    const structure = m && analysis.echoes === 0 && m.gain < 0 ? { ...analysis.structure, wetSign: -1 } : analysis.structure;
    const params: DelayParams = m
      ? { ...analysis.params, ...wet, delaySeconds: m.centre, modDepthSeconds: m.depth, modRate: m.rate, modPhase: lfo.phase }
      : { ...analysis.params, modDepthSeconds: MOD_OFF, modRate: fallback?.modRate ?? 1, modPhase: lfo.phase };
    return { ...analysis, params, structure: { ...structure, modLead: lfo.lead }, echoes: m ? Math.max(1, analysis.echoes) : analysis.echoes };
  };

  // Ducking: the time constant with which the echo's gain glides is the plugin's – fitted on a few renders that
  // duck – and the detector (threshold, attack, release) is fitted per render with it.
  let duckSmooth: number | undefined;
  if (input.duck) {
    const ducking = observations.filter((o) => o.purpose === "train" && o.duck && showsDucking(o.duck)).slice(0, 3);
    const smooths = ducking.map((o) => fitDuck(o.duck!, input.duck!).smooth).sort((x, y) => x - y);
    if (smooths.length) duckSmooth = smooths[smooths.length >> 1];
  }
  const analyseRender = (o: DelayObservation, fallback?: DelayParams): DelayAnalysis => {
    const analysis = analyse(o, fallback);
    if (!duckSmooth || !input.duck) return analysis;
    const fitted = o.duck ? fitDuck(o.duck, input.duck, duckSmooth, fallback) : undefined;
    const duck: Partial<DelayParams> = fitted
      ? { duckThresholdDb: fitted.thresholdDb, duckAttack: fitted.attack, duckRelease: fitted.release }
      : { duckThresholdDb: fallback?.duckThresholdDb ?? DUCK_OFF_DB, duckAttack: fallback?.duckAttack ?? 0.1, duckRelease: fallback?.duckRelease ?? 0.1 };
    return { ...analysis, params: { ...analysis.params, ...duck }, structure: { ...analysis.structure, duckSmoothSeconds: duckSmooth } };
  };

  /** tables from the sweeps around one base render */
  const fitTables = (baseObservation: DelayObservation, sweeps: DelayObservation[], fallback?: DelayParams): DelayTables & { echoes: number } => {
    const baseFit = analyseRender(baseObservation, fallback);
    const tables = new Map<number, ParamTable>();
    /** per table: plugin values whose render shows a repeat */
    const visible = new Map<number, Set<number>>();
    for (const o of sweeps) {
      onProgress?.(done++, train.length, o.label);
      if ((o.residualDb ?? -Infinity) > MAX_RESIDUAL_DB) continue;
      const p = swept(o)!;
      const info = parameters.find((x) => x.index === p.index)!;
      const fit = analyseRender(o, baseFit.params);
      const table = tables.get(p.index)
        ?? { index: p.index, name: info.name, discrete: stepped.has(p.index), points: [{ value: baseValues.get(p.index)!, packed: packDelay(baseFit.params) }] };
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
        // a position holds over its whole range: a point at either end, so that the nearest point is the right one
        // (declared steps are measured at their exact values and need none)
        const steps = steppedParameter(parameters.find((x) => x.index === index)!) ? undefined : stepped.get(index);
        if (steps) {
          table.points = table.points.flatMap((pt) => {
            const [from, to] = steps.bounds[positionOf(steps, pt.value)]!;
            return from === to ? [{ ...pt, value: from }] : [{ ...pt, value: from }, { value: to, packed: [...pt.packed] }];
          }).filter((pt, i, all) => all.findIndex((other) => Math.abs(other.value - pt.value) < 1e-9) === i);
        }
        table.points.sort((a, b) => a.value - b.value);
        refineTimeTable(table, (value) => visible.get(index)!.has(value));
        if (duckSmooth) ownDuckValues(table, packDelay(baseFit.params));
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
    return compareDelay(predicted.params, predicted.structure, input, o);
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
    const switchLike = new Set([...stepped].filter(([, steps]) => steps.values.length <= SWITCH_STATES).map(([index]) => index));
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
    // the position applies from half way to its neighbours; the outer ones to the ends of the control
    const steps = stepped.get(position.index);
    const at = steps ? positionOf(steps, position.value) : -1;
    const range: [number, number] = steps
      ? [at === 0 ? -1 : (steps.bounds[at - 1]![1] + steps.bounds[at]![0]) / 2, at === steps.values.length - 1 ? 2 : (steps.bounds[at]![1] + steps.bounds[at + 1]![0]) / 2]
      : [position.value - 0.5 / Math.max(info.numSteps - 1, 1), position.value + 0.5 / Math.max(info.numSteps - 1, 1)];
    variants.push({
      ...own, index: position.index, value: position.value, name: `${info.name} = ${start.label.split(" = ").pop()}`,
      range,
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
  if (lfo) calibrateLfo(model, observations, readings, kind, input);
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
