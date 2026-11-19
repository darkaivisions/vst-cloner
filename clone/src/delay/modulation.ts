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
