/**
 * Ducking delays: how far the echo is turned down at every moment, read off the probe tone of the `duck` segment
 * (see duckSegmentSpecs in capture/src/signals.ts), and the detector values that explain it.
 *
 * The probe runs through the delay all the time, far below any threshold. Its share in the output, minus the dry
 * path, is the echo of the probe – steady while nothing ducks. Relative to its level before the first trigger it
 * is the echo's gain: 0 dB while open, falling while the impulse and the bursts key the ducking.
 */
import { nelderMead } from "../dsp/optimize.ts";
import type { DelayParams } from "./model.ts";

export interface DuckInput {
  sampleRate: number;
  /** the whole test signal (mono): the model is run over all of it */
  signal: Float32Array;
  /** the duck segment within it (samples) */
  start: number;
  length: number;
  probeFrequency: number;
  probeAmplitude: number;
  /** the first trigger (samples from the segment's start): the echo's level is taken before it */
  triggerAt: number;
}

/** analysis windows (Hann) and their spacing: the bursts' band does not leak into the probe's */
const WINDOW_SECONDS = 0.02;
export const HOP_SECONDS = 0.005;
/** the echo's level is taken over this span before the trigger */
const REFERENCE_SECONDS = 0.5;
/** gains below this (dB) count as fully ducked: the probe's echo is then near the noise */
export const DUCK_FLOOR_DB = -40;
/** the probe's echo must be at least this loud relative to the probe for the gain to be read */
const MIN_ECHO_RELATIVE = 1e-3;

interface Windows {
  starts: number[];
  window: Float64Array;
  norm: number;
}
const windowCache = new Map<string, Windows>();
function windows(input: DuckInput): Windows {
  const key = `${input.sampleRate}:${input.start}:${input.length}`;
  const cached = windowCache.get(key);
  if (cached) return cached;
  const size = Math.round(WINDOW_SECONDS * input.sampleRate), hop = Math.round(HOP_SECONDS * input.sampleRate);
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / size));
  const norm = window.reduce((s, w) => s + w, 0);
  const starts: number[] = [];
  for (let at = 0; at + size <= input.length; at += hop) starts.push(at);
  const result = { starts, window, norm };
  windowCache.set(key, result);
  return result;
}

/**
 * A band next to the probe's, where the signal has nothing: a window with as much there as the probe's echo holds
 * something broadband (the echo of the loud impulse) and cannot be read.
 */
const GUARD_RATIO = 0.87;
/** a window counts as unreadable when its guard band holds this share of the probe's echo level */
const GUARD_SHARE = 0.3;

/** Complex amplitude at `frequency` (default: the probe's) in every window of `signal` (indices of the whole signal). */
function lockIn(signal: ArrayLike<number>, input: DuckInput, frequency = input.probeFrequency): { re: Float64Array; im: Float64Array } {
  const { starts, window, norm } = windows(input);
  const omega = (2 * Math.PI * frequency) / input.sampleRate;
  const re = new Float64Array(starts.length), im = new Float64Array(starts.length);
  starts.forEach((at, k) => {
    let a = 0, b = 0;
    for (let i = 0; i < window.length; i++) {
      const n = input.start + at + i;
      const v = (signal[n] ?? 0) * window[i]!;
      a += v * Math.cos(omega * n);
      b -= v * Math.sin(omega * n);
    }
    re[k] = (2 * a) / norm;
    im[k] = (2 * b) / norm;
  });
  return { re, im };
}

const probeCache = new WeakMap<Float32Array, { re: Float64Array; im: Float64Array }>();

/**
 * The echo's gain (dB, floored at DUCK_FLOOR_DB) in every window after the reference span, read off an output of
 * the whole test signal; `dry` is the dry path's gain (the impulse response's first sample). Undefined when the
 * probe's echo is too quiet to read (no echo, or one longer than the time before the trigger).
 */
export function duckTrack(output: ArrayLike<number>, input: DuckInput, dry: number): Float32Array | undefined {
  let probe = probeCache.get(input.signal);
  if (!probe) probeCache.set(input.signal, (probe = lockIn(input.signal, input)));
  const y = lockIn(output, input);
  const { starts, window } = windows(input);
  const wet = starts.map((_, k) => Math.hypot(y.re[k]! - dry * probe.re[k]!, y.im[k]! - dry * probe.im[k]!));
  const from = input.triggerAt - Math.round(REFERENCE_SECONDS * input.sampleRate);
  const reference = starts.map((at, k) => (at >= from && at + window.length <= input.triggerAt ? wet[k]! : NaN)).filter((v) => Number.isFinite(v));
  const level = reference.reduce((s, v) => s + v, 0) / Math.max(reference.length, 1);
  if (!(level > MIN_ECHO_RELATIVE * input.probeAmplitude)) return undefined;
  const first = starts.findIndex((at) => at + window.length > input.triggerAt);
  // the echo of the loud impulse is broadband and reaches into the probe's band: such windows show it in the
  // guard band too, and a gain above 0 dB is no gain either
  const guard = lockIn(output, input, input.probeFrequency * GUARD_RATIO);
  return Float32Array.from(wet.slice(first), (v, k) => {
    const db = 20 * Math.log10(v / level + 1e-12);
    const noise = Math.hypot(guard.re[first + k]!, guard.im[first + k]!);
    return db > MAX_GAIN_DB || noise > GUARD_SHARE * level ? NaN : Math.max(DUCK_FLOOR_DB, db);
  });
}

/** windows read above this (dB) hold something else than the probe's echo and are left out */
const MAX_GAIN_DB = 3;

/** Two gain tracks against each other: RMS and largest difference over the windows both can read (dB). */
export function compareTracks(a: Float32Array, b: Float32Array): { rmsDb: number; maxDb: number } {
  const n = Math.min(a.length, b.length);
  let sum = 0, max = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (Number.isNaN(d)) continue;
    sum += d * d;
    max = Math.max(max, d);
    count++;
  }
  return { rmsDb: Math.sqrt(sum / Math.max(count, 1)), maxDb: max };
}

/**
 * For the fit, the detector runs on blocks of this many samples (their largest magnitude): ten times faster, and
 * the same within a fraction of a millisecond. The comparison with the original uses the exact model.
 */
const BLOCK = 16;

/** The ducking gain of the model's detector over the duck segment, per block (see processDelay in model.ts). */
function duckGains(peaks: Float32Array, input: DuckInput, thresholdDb: number, attack: number, release: number, smooth: number): Float32Array {
  const rate = input.sampleRate / BLOCK;
  const fall = Math.exp(-1 / (release * rate)), rise = 1 - Math.exp(-1 / (attack * rate)), glide = 1 - Math.exp(-1 / (smooth * rate));
  const threshold = 10 ** (thresholdDb / 20);
  const g = new Float32Array(peaks.length);
  let peak = 0, env = 0, duck = 1;
  for (let n = 0; n < peaks.length; n++) {
    peak = Math.max(peaks[n]!, peak * fall);
    env += rise * (peak - env);
    duck += glide * ((env > threshold ? 0 : 1) - duck);
    g[n] = duck;
  }
  return g;
}

/** The track duckTrack would read for a gain sequence (per block) over the segment (the probe's echo is steady). */
function gainTrack(g: Float32Array, input: DuckInput): Float32Array {
  const { starts, window } = windows(input);
  const first = starts.findIndex((at) => at + window.length > input.triggerAt);
  const out = new Float32Array(starts.length - first);
  const blocks = Math.floor(window.length / BLOCK);
  const weights = Float64Array.from({ length: blocks }, (_, j) => window[Math.min(window.length - 1, j * BLOCK + (BLOCK >> 1))]!);
  const total = weights.reduce((sum, w) => sum + w, 0);
  for (let k = first; k < starts.length; k++) {
    const at = Math.floor(starts[k]! / BLOCK);
    let sum = 0;
    for (let j = 0; j < blocks; j++) sum += weights[j]! * (g[at + j] ?? 1);
    out[k - first] = Math.max(DUCK_FLOOR_DB, 20 * Math.log10(sum / total + 1e-12));
  }
  return out;
}

const peakCache = new WeakMap<Float32Array, Float32Array>();
/** largest magnitude of the input in every block of the duck segment */
const segmentPeaks = (input: DuckInput) => {
  let m = peakCache.get(input.signal);
  if (!m) {
    m = new Float32Array(Math.ceil(input.length / BLOCK));
    for (let i = 0; i < input.length; i++) m[Math.floor(i / BLOCK)] = Math.max(m[Math.floor(i / BLOCK)]!, Math.abs(input.signal[input.start + i]!));
    peakCache.set(input.signal, m);
  }
  return m;
};

/** a render shows ducking when its echo falls this far somewhere */
export const DUCKS_DB = -6;
export const showsDucking = (track: Float32Array) => track.some((v) => v < DUCKS_DB);

/**
 * Detector values that explain a measured gain track: threshold, attack, release – and the glide's time constant
 * where `smooth` is not given. A track that never ducks puts the threshold above the loudest trigger.
 */
/**
 * Start values (the base render's detector) are kept where they explain a render nearly as well as the best values
 * do: a sweep that shows little about a detector value (a threshold above all but one trigger, a release that
 * outlasts the segment) then leaves it alone instead of moving it at random – each such move adds up in
 * combinations. "Nearly": within this much track error (dB).
 */
const KEEP_START_DB = 0.25;
/** how close to the start values counts, for that choice: one unit is a factor e in attack or release, 20 dB in threshold */
const THRESHOLD_UNIT_DB = 20;
const PULL_WEIGHT_DB = 0.3;
const clampLn = (v: number) => Math.exp(Math.min(Math.log(5), Math.max(Math.log(5e-4), v)));
/** a threshold must lie above the probe (else the probe alone keys the ducking and nothing is seen): this far */
const ABOVE_PROBE_DB = 6;
/** grid of attack and release (seconds) searched */
const TIMES = [0.003, 0.01, 0.03, 0.1, 0.3, 1].flatMap((a) => [0.02, 0.05, 0.1, 0.2, 0.4, 0.7, 1.2, 2, 3.5].map((r) => [Math.log(a), Math.log(r)]));

export function fitDuck(track: Float32Array, input: DuckInput, smooth?: number, start?: DelayParams): { thresholdDb: number; attack: number; release: number; smooth: number; error: number } {
  const magnitudes = segmentPeaks(input);
  const lowest = 20 * Math.log10(input.probeAmplitude) + ABOVE_PROBE_DB;
  const clampThreshold = (db: number) => Math.min(6, Math.max(lowest, db));
  let top = 0;
  for (const m of magnitudes) top = Math.max(top, m);
  const loudest = 20 * Math.log10(top + 1e-12);
  const prior = start?.duckThresholdDb !== undefined && start.duckAttack !== undefined && start.duckRelease !== undefined
    ? [start.duckThresholdDb, Math.log(start.duckAttack), Math.log(start.duckRelease)] : undefined;
  if (!prior && !showsDucking(track)) return { thresholdDb: Math.min(6, loudest + 3), attack: 0.1, release: 0.1, smooth: smooth ?? 0.1, error: 0 };
  const errorOf = (x: number[]) => {
    const [thresholdDb, lnAttack, lnRelease, lnSmooth] = x as [number, number, number, number?];
    const model = gainTrack(duckGains(magnitudes, input, clampThreshold(thresholdDb), clampLn(lnAttack), clampLn(lnRelease), smooth ?? clampLn(lnSmooth!)), input);
    return compareTracks(model, track).rmsDb;
  };
  const pull = (x: number[]) => (prior ? ((x[0]! - prior[0]!) / THRESHOLD_UNIT_DB) ** 2 + (x[1]! - prior[1]!) ** 2 + (x[2]! - prior[2]!) ** 2 : 0);
  const pulled = (x: number[]) => errorOf(x) + PULL_WEIGHT_DB * pull(x);

  // The threshold's error is flat between the trigger levels, and attack and release nearly trade places on an
  // impulse (with the threshold moved): a grid first, then the simplex from the best few points.
  const extra = smooth === undefined ? [Math.log(0.1)] : [];
  const times = prior ? [...TIMES, ...[-1.4, 0, 1.4].flatMap((a) => [-1.4, 0, 1.4].map((r) => [prior[1]! + a, prior[2]! + r]))] : TIMES;
  const points: { x: number[]; error: number; pull: number }[] = [];
  const add = (x: number[]) => points.push({ x, error: errorOf(x), pull: pull(x) });
  if (prior) add([...prior, ...extra]);
  for (let thresholdDb = Math.ceil(lowest); thresholdDb <= 0; thresholdDb += 3) for (const [a, r] of times) add([thresholdDb, a!, r!, ...extra]);
  const step = [3, 0.7, 0.7, ...(smooth === undefined ? [0.5] : [])];
  const best = (f: (x: number[]) => number, from: number[][]) =>
    from.map((x) => nelderMead(f, x, { step, maxEvaluations: 250 })).reduce((p, q) => (q.value < p.value ? q : p));
  const free = best(errorOf, [...points].sort((p, q) => p.error - q.error).slice(0, 5).map((p) => p.x));
  let chosen = free.x;
  if (prior) {
    const near = best(pulled, [...points].sort((p, q) => p.error + PULL_WEIGHT_DB * p.pull - q.error - PULL_WEIGHT_DB * q.pull).slice(0, 2).map((p) => p.x));
    if (errorOf(near.x) <= free.value + KEEP_START_DB) chosen = near.x;
  }
  const [thresholdDb, lnAttack, lnRelease, lnSmooth] = chosen as [number, number, number, number?];
  return {
    thresholdDb: clampThreshold(thresholdDb), attack: clampLn(lnAttack), release: clampLn(lnRelease),
    smooth: smooth ?? clampLn(lnSmooth!), error: errorOf(chosen),
  };
}

/** The gain track the fit's (block-wise) detector gives for detector values – for checks against the exact model. */
export const fitTrack = (input: DuckInput, thresholdDb: number, attack: number, release: number, smooth: number): Float32Array =>
  gainTrack(duckGains(segmentPeaks(input), input, thresholdDb, attack, release, smooth), input);
