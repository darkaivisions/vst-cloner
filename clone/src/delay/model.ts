/**
 * Delay model: one delay line with feedback. Filters (one-pole low-pass and high-pass each) sit in the feedback
 * loop – they colour every further repeat – and on the wet output.
 *   tap  = line[n − delay]
 *   line[n] = x + feedback · loopFilter(tap)
 *   y    = dry · x + wet · wetFilter(tap)
 * IMPORTANT: plugin-template/delay must implement exactly the same steps.
 */

export interface DelayParams {
  delaySeconds: number;
  /** levels in dB; OFF_DB and below mean "off" */
  dryDb: number;
  wetDb: number;
  feedbackDb: number;
  /** cutoff frequencies (Hz); a low-pass at LP_OFF or above and a high-pass at HP_OFF or below are bypassed */
  loopLp: number;
  loopHp: number;
  wetLp: number;
  wetHp: number;
}

/** Polarities (±1): they do not change with the controls of the plugins measured so far. */
export interface DelayStructure {
  drySign: number;
  wetSign: number;
  feedbackSign: number;
}

export const OFF_DB = -80;
export const LP_OFF = 20000;
export const HP_OFF = 20;
/** packed values pass through logarithms: "off" needs a little tolerance */
export const lpActive = (frequency: number) => frequency < LP_OFF * 0.999;
export const hpActive = (frequency: number) => frequency > HP_OFF * 1.001;
/** longest delay the engine provides (seconds) */
export const MAX_DELAY_SECONDS = 10;
/** the loop stays stable below 0 dB of feedback */
export const MAX_FEEDBACK_DB = -0.1;

export const delayGain = (db: number) => (db <= OFF_DB + 0.5 ? 0 : 10 ** (db / 20));

/** Packed model values: additive changes of them are what single controls do (times and levels multiply). */
export const NUM_DELAY_PACKED = 8;
export const packDelay = (p: DelayParams): number[] => [
  Math.log(p.delaySeconds), p.dryDb, p.wetDb, p.feedbackDb, Math.log(p.loopLp), Math.log(p.loopHp), Math.log(p.wetLp), Math.log(p.wetHp),
];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const unpackDelay = (x: number[]): DelayParams => ({
  delaySeconds: clamp(Math.exp(x[0]!), 1e-4, MAX_DELAY_SECONDS),
  dryDb: clamp(x[1]!, OFF_DB, 24),
  wetDb: clamp(x[2]!, OFF_DB, 24),
  feedbackDb: clamp(x[3]!, OFF_DB, MAX_FEEDBACK_DB),
  loopLp: clamp(Math.exp(x[4]!), 20, LP_OFF),
  loopHp: clamp(Math.exp(x[5]!), HP_OFF, 20000),
  wetLp: clamp(Math.exp(x[6]!), 20, LP_OFF),
  wetHp: clamp(Math.exp(x[7]!), HP_OFF, 20000),
});

/** Coefficient of a one-pole low-pass: state += (1 − a) · (x − state). */
export const onePole = (frequency: number, sampleRate: number) => Math.exp((-2 * Math.PI * frequency) / sampleRate);

/** Output of the model for `signal` (as long as `length`; the signal is continued with silence). */
export function processDelay(signal: ArrayLike<number>, p: DelayParams, s: DelayStructure, sampleRate: number, length = signal.length): Float32Array {
  const out = new Float32Array(length);
  const delay = clamp(p.delaySeconds * sampleRate, 1, MAX_DELAY_SECONDS * sampleRate);
  const whole = Math.floor(delay), frac = delay - whole;
  const size = whole + 2;
  const line = new Float64Array(size);
  const dry = s.drySign * delayGain(p.dryDb), wet = s.wetSign * delayGain(p.wetDb), feedback = s.feedbackSign * delayGain(p.feedbackDb);
  const loopLp = lpActive(p.loopLp) ? onePole(p.loopLp, sampleRate) : -1, loopHp = hpActive(p.loopHp) ? onePole(p.loopHp, sampleRate) : -1;
  const wetLp = lpActive(p.wetLp) ? onePole(p.wetLp, sampleRate) : -1, wetHp = hpActive(p.wetHp) ? onePole(p.wetHp, sampleRate) : -1;
  let loopLow = 0, loopHigh = 0, wetLow = 0, wetHigh = 0, write = 0;
  for (let n = 0; n < length; n++) {
    const x = n < signal.length ? signal[n]! : 0;
    let read = write - whole;
    if (read < 0) read += size;
    const before = read === 0 ? size - 1 : read - 1;
    // linear interpolation between the samples `whole` and `whole + 1` steps back
    const tap = line[read]! * (1 - frac) + line[before]! * frac;
    let f = tap;
    if (loopLp >= 0) { loopLow += (1 - loopLp) * (f - loopLow); f = loopLow; }
    if (loopHp >= 0) { loopHigh += (1 - loopHp) * (f - loopHigh); f -= loopHigh; }
    line[write] = x + feedback * f;
    let g = tap;
    if (wetLp >= 0) { wetLow += (1 - wetLp) * (g - wetLow); g = wetLow; }
    if (wetHp >= 0) { wetHigh += (1 - wetHp) * (g - wetHigh); g -= wetHigh; }
    out[n] = dry * x + wet * g;
    write = write + 1 === size ? 0 : write + 1;
  }
  return out;
}
