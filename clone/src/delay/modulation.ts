import { fft } from "../dsp/fft.ts";

/**
 * Reading an LFO off a train of clicks (see modulationSegmentSpecs): every click's repeat comes after the delay
 * time of that moment, so the times of the repeats trace delay(t) = centre + depth · sin(ω t + ψ).
 */

export interface ClickResponse {
  /** answer to the clicks, scaled to unit clicks */
  h: Float32Array;
  /** samples between clicks */
  period: number;
}

export interface MeasuredModulation {
  /** centre and depth of the delay time (seconds), rate (Hz) */
  centre: number;
  depth: number;
  rate: number;
  /** LFO phase at the first click (radians) */
  phase: number;
  /** clicks whose repeat was found */
  taps: number;
  /** median gain of the repeats (signed sum over the samples a fractional delay spreads a repeat over) */
  gain: number;
  /** RMS deviation of the repeats' times from the fitted sine (samples) */
  residual: number;
}

/** the repeat must stand this far from the click (samples): closer it merges with the dry signal */
const MIN_TAP_SAMPLES = 3;
/** below this depth (samples) the delay does not move */
const MIN_DEPTH_SAMPLES = 0.3;
/** LFO rates searched (Hz); the clicks sample the LFO at 25 Hz, so the top is below half of that */
const MIN_RATE = 0.03, MAX_RATE = 11;

/** time (samples, fractional) and size of the strongest repeat after each click */
export function clickTaps(response: ClickResponse): { at: number; time: number; level: number; gain: number }[] {
  const { h, period } = response;
  const taps: { at: number; time: number; level: number; gain: number }[] = [];
  for (let start = 0, k = 0; start + period <= h.length; start += period, k++) {
    let best = -1, top = 0;
    for (let i = start + MIN_TAP_SAMPLES; i < start + period - 1; i++) {
      const a = Math.abs(h[i]!);
      if (a > top) {
        top = a;
        best = i;
      }
    }
    if (best < 0) continue;
    // centre of the repeat: a fractional delay spreads it over two samples (linear interpolation) or a few more
    const a = Math.abs(h[best - 1]!), b = top, c = Math.abs(h[best + 1]!);
    const curvature = a - 2 * b + c;
    const offset = curvature !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature)) : 0;
    let gain = 0;
    for (let i = best - 2; i <= best + 2; i++) gain += h[i] ?? 0;
    taps.push({ at: k * period, time: best - start + offset, level: top, gain });
  }
  return taps;
}

/** least squares of y ≈ c + s·sin(ωt) + q·cos(ωt): returns the residual and the coefficients */
function fitSine(t: number[], y: number[], omega: number): { residual: number; c: number; s: number; q: number } {
  let n = 0, S = 0, C = 0, SS = 0, CC = 0, SC = 0, Y = 0, YS = 0, YC = 0;
  for (let i = 0; i < t.length; i++) {
    const sn = Math.sin(omega * t[i]!), cs = Math.cos(omega * t[i]!), v = y[i]!;
    n++; S += sn; C += cs; SS += sn * sn; CC += cs * cs; SC += sn * cs; Y += v; YS += v * sn; YC += v * cs;
  }
  // normal equations of [1, sin, cos]
  const m = [[n, S, C], [S, SS, SC], [C, SC, CC]], r = [Y, YS, YC];
  const solved = solve3(m, r);
  if (!solved) return { residual: Infinity, c: 0, s: 0, q: 0 };
  const [c, s, q] = solved;
  let residual = 0;
  for (let i = 0; i < t.length; i++) residual += (y[i]! - c - s * Math.sin(omega * t[i]!) - q * Math.cos(omega * t[i]!)) ** 2;
  return { residual, c, s, q };
}

function solve3(m: number[][], r: number[]): [number, number, number] | undefined {
  const det = (a: number[][]) =>
    a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return undefined;
  const column = (k: number) => m.map((row, i) => row.map((v, j) => (j === k ? r[i]! : v)));
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
}

/**
 * The LFO of a modulated delay from its answer to the clicks, or undefined when the delay time does not move
 * (or no repeat is heard). Times in samples are turned into seconds with `sampleRate`.
 */
export function measureModulation(response: ClickResponse, sampleRate: number): MeasuredModulation | undefined {
  const all = clickTaps(response);
  if (all.length < 8) return undefined;
  const loudest = Math.max(...all.map((t) => t.level));
  if (loudest < 1e-4) return undefined;
  // repeats lost in the noise or in the dry signal (a flanger sweeping through zero) say nothing about the time
  const taps = all.filter((t) => t.level > 0.1 * loudest);
  if (taps.length < 8) return undefined;
  const t = taps.map((x) => x.at), y = taps.map((x) => x.time);
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const flat = y.reduce((a, b) => a + (b - mean) ** 2, 0);
  let best = { residual: Infinity, c: mean, s: 0, q: 0, omega: 0 };
  // a coarse logarithmic grid of rates, then a finer one around the best
  const toOmega = (hz: number) => (2 * Math.PI * hz) / sampleRate;
  const grid = (from: number, to: number, steps: number) => {
    for (let i = 0; i <= steps; i++) {
      const hz = from * (to / from) ** (i / steps);
      const fit = fitSine(t, y, toOmega(hz));
      if (fit.residual < best.residual) best = { ...fit, omega: toOmega(hz) };
    }
  };
  grid(MIN_RATE, MAX_RATE, 800);
  const hz = (best.omega * sampleRate) / (2 * Math.PI);
  grid(hz * 0.98, hz * 1.02, 200);
  const depth = Math.hypot(best.s, best.q);
  // the sine must explain most of the movement, and the movement must be real
  if (depth < MIN_DEPTH_SAMPLES || best.residual > 0.3 * flat) return undefined;
  return {
    centre: best.c / sampleRate,
    depth: depth / sampleRate,
    rate: (best.omega * sampleRate) / (2 * Math.PI),
    // s·sin + q·cos = depth · sin(ωt + atan2(q, s))
    phase: Math.atan2(best.q, best.s),
    taps: taps.length,
    gain: [...taps.map((x) => x.gain)].sort((a, b) => a - b)[taps.length >> 1]!,
    residual: Math.sqrt(best.residual / taps.length),
  };
}

/** angle in [−π, π) */
export const wrapPhase = (x: number) => x - 2 * Math.PI * Math.floor((x + Math.PI) / (2 * Math.PI));

// ---- tremolo and phaser ---------------------------------------------------------------------------

/** A sine fitted to values sampled at the clicks: rate (Hz), phase at the first click, mean, amplitude, quality. */
function sineOfTrace(t: number[], y: number[], sampleRate: number): { rate: number; phase: number; mean: number; amplitude: number; residual: number; flat: number } | undefined {
  if (t.length < 8) return undefined;
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const flat = y.reduce((a, b) => a + (b - mean) ** 2, 0);
  let best = { residual: Infinity, c: mean, s: 0, q: 0, omega: 0 };
  const toOmega = (hz: number) => (2 * Math.PI * hz) / sampleRate;
  const grid = (from: number, to: number, steps: number) => {
    for (let i = 0; i <= steps; i++) {
      const hz = from * (to / from) ** (i / steps);
      const fit = fitSine(t, y, toOmega(hz));
      if (fit.residual < best.residual) best = { ...fit, omega: toOmega(hz) };
    }
  };
  grid(MIN_RATE, MAX_RATE, 800);
  const hz = (best.omega * sampleRate) / (2 * Math.PI);
  grid(hz * 0.98, hz * 1.02, 200);
  return {
    rate: (best.omega * sampleRate) / (2 * Math.PI), phase: Math.atan2(best.q, best.s), mean: best.c,
    amplitude: Math.hypot(best.s, best.q), residual: Math.sqrt(best.residual / t.length), flat: Math.sqrt(flat / t.length),
  };
}

export interface MeasuredTremolo {
  rate: number;
  /** LFO phase at the first click, in the convention of the model (gain = level · (1 − depth · (½ + ½ sin))) */
  phase: number;
  depth: number;
  /** level at the top of the LFO (linear, signed like the dry path) */
  level: number;
  /** phase uncertainty (radians) */
  error: number;
}

/** A tremolo from the clicks: the dry part of each click is the level of that moment. */
export function measureTremolo(response: ClickResponse, sampleRate: number): MeasuredTremolo | undefined {
  const { h, period } = response;
  const t: number[] = [], y: number[] = [];
  for (let start = 0; start + period <= h.length; start += period) {
    t.push(start);
    y.push(h[start]!);
  }
  const sign = y.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
  const fit = sineOfTrace(t, y.map((v) => v * sign), sampleRate);
  if (!fit || fit.mean <= 1e-6) return undefined;
  const top = fit.mean + fit.amplitude;
  const depth = (2 * fit.amplitude) / top;
  if (depth < 0.03 || fit.residual > 0.5 * fit.flat) return undefined;
  // measured: mean + amplitude · sin(ψ); model: top · (1 − depth/2 − depth/2 · sin θ) – θ = ψ + π
  return { rate: fit.rate, phase: wrapPhase(fit.phase + Math.PI), depth: Math.min(1, depth), level: sign * top, error: fit.residual / Math.max(fit.amplitude, 1e-9) };
}

export interface MeasuredPhaser {
  rate: number;
  phase: number;
  stages: number;
  /** corner frequency at the middle of the sweep (Hz) and the sweep (± octaves) */
  centre: number;
  octaves: number;
  feedback: number;
  /** dry and wet gains (linear, signed) */
  dry: number;
  wet: number;
  error: number;
}

const PHASER_FREQS = Array.from({ length: 48 }, (_, i) => 80 * (12000 / 80) ** (i / 47));
const PHASER_CORNERS = Array.from({ length: 72 }, (_, i) => 40 * (10000 / 40) ** (i / 71));

/** magnitude (dB) of the answer to one click at PHASER_FREQS */
function clickSpectrum(h: Float32Array, from: number, length: number, sampleRate: number): number[] {
  const size = 8192;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < length && i < size; i++) re[i] = h[from + i] ?? 0;
  fft(re, im);
  return PHASER_FREQS.map((f) => {
    const k = Math.round((f / sampleRate) * size);
    return 10 * Math.log10(re[k]! ** 2 + im[k]! ** 2 + 1e-12);
  });
}

/** first-order digital allpass at frequency f with corner fc: complex response */
function allpassAt(f: number, fc: number, sampleRate: number): [number, number] {
  const t = Math.tan((Math.PI * Math.min(fc, sampleRate * 0.49)) / sampleRate), a = (t - 1) / (t + 1);
  const w = (2 * Math.PI * f) / sampleRate, c = Math.cos(w), s = -Math.sin(w);
  // (a + z⁻¹) / (1 + a z⁻¹), z⁻¹ = c + i s
  const nr = a + c, ni = s, dr = 1 + a * c, di = a * s;
  const den = dr * dr + di * di;
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den];
}

/**
 * A phaser from the clicks: each click's answer is the dry signal plus an allpass chain whose corner the LFO moves –
 * its spectrum has notches where the chain turns the phase by an odd multiple of 180°. The number of stages, the
 * feedback and the mix are found for all clicks together, the corner for each click; the corners trace the LFO.
 */
export function measurePhaser(response: ClickResponse, sampleRate: number): MeasuredPhaser | undefined {
  const { h, period } = response;
  const clicks: { at: number; spectrum: number[] }[] = [];
  for (let start = 0; start + period <= h.length; start += period) clicks.push({ at: start, spectrum: clickSpectrum(h, start, period, sampleRate) });
  if (clicks.length < 8) return undefined;
  // allpass responses for every corner and frequency, once
  const single = PHASER_CORNERS.map((fc) => PHASER_FREQS.map((f) => allpassAt(f, fc, sampleRate)));
  const pow = (z: [number, number], n: number): [number, number] => {
    const r = Math.hypot(z[0], z[1]) ** n, a = Math.atan2(z[1], z[0]) * n;
    return [r * Math.cos(a), r * Math.sin(a)];
  };
  /** model magnitude (dB, without the overall level) for a corner index */
  const shape = (stages: number, feedback: number, ratio: number) => single.map((row) => row.map((z) => {
    const a = pow(z, stages);
    // wet = A / (1 − fb·A)
    const dr = 1 - feedback * a[0], di = -feedback * a[1], den = dr * dr + di * di;
    const wr = (a[0] * dr + a[1] * di) / den, wi = (a[1] * dr - a[0] * di) / den;
    return 10 * Math.log10((1 + ratio * wr) ** 2 + (ratio * wi) ** 2 + 1e-12);
  }));
  const fitClick = (model: number[][], spectrum: number[]) => {
    let best = { error: Infinity, corner: 0, offset: 0 };
    model.forEach((m, c) => {
      let offset = 0;
      for (let i = 0; i < m.length; i++) offset += spectrum[i]! - m[i]!;
      offset /= m.length;
      let error = 0;
      for (let i = 0; i < m.length; i++) error += Math.min(400, (spectrum[i]! - m[i]! - offset) ** 2);
      if (error < best.error) best = { error, corner: c, offset };
    });
    return best;
  };
  // the structure on every fourth click, then the corners of all clicks
  const sample = clicks.filter((_, i) => i % 4 === 0);
  let structure = { error: Infinity, stages: 4, feedback: 0, ratio: 1, model: [] as number[][] };
  for (const stages of [2, 4, 6, 8, 10, 12]) for (const feedback of [-0.6, -0.3, 0, 0.3, 0.6]) for (const ratio of [-1.4, -1, -0.7, 0.7, 1, 1.4]) {
    const model = shape(stages, feedback, ratio);
    const error = sample.reduce((sum, c) => sum + fitClick(model, c.spectrum).error, 0);
    if (error < structure.error) structure = { error, stages, feedback, ratio, model };
  }
  const fits = clicks.map((c) => ({ at: c.at, ...fitClick(structure.model, c.spectrum) }));
  // a notch must actually move: flat spectra (no phaser) leave the corner at random
  const trace = sineOfTrace(fits.map((f) => f.at), fits.map((f) => Math.log2(PHASER_CORNERS[f.corner]!)), sampleRate);
  const meanError = fits.reduce((a, f) => a + f.error, 0) / fits.length / PHASER_FREQS.length;
  if (!trace || trace.amplitude < 0.15 || trace.residual > 0.6 * trace.flat || meanError > 25) return undefined;
  const level = 10 ** ((fits.reduce((a, f) => a + f.offset, 0) / fits.length) / 20);
  return {
    rate: trace.rate, phase: trace.phase, stages: structure.stages,
    centre: 2 ** trace.mean, octaves: trace.amplitude, feedback: structure.feedback,
    dry: level, wet: level * structure.ratio, error: trace.residual / Math.max(trace.amplitude, 1e-9),
  };
}
