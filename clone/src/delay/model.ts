/**
 * Delay model: one delay line with feedback. Filters (one-pole low-pass and high-pass each) sit in the feedback
 * loop – they colour every further repeat – and on the wet output. An LFO can move the delay time (chorus,
 * flanger, vibrato): delay(n) = delay + depth · sin(phase + 2π · rate · (n + start) / sampleRate), where `start`
 * counts the samples since the plugin was set up (the LFO of the plugins measured runs from there and is not
 * restarted by a reset).
 *   tap  = line[n − delay(n)]
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
  /** LFO on the delay time: depth (seconds, MOD_OFF and below: none), rate (Hz), phase at the start (radians) */
  modDepthSeconds?: number;
  modRate?: number;
  modPhase?: number;
}

/** Polarities (±1): they do not change with the controls of the plugins measured so far. */
export interface DelayStructure {
  drySign: number;
  wetSign: number;
  feedbackSign: number;
  /**
   * Samples the plugin's LFO ran before its reset point (it may start when the plugin is set up, before the
   * pre-roll): at a reset the LFO starts at modPhase + 2π · rate · modLead / sampleRate.
   */
  modLead?: number;
}

export const OFF_DB = -80;
export const LP_OFF = 20000;
export const HP_OFF = 20;
/** packed values pass through logarithms: "off" needs a little tolerance */
export const lpActive = (frequency: number) => frequency < LP_OFF * 0.999;
export const hpActive = (frequency: number) => frequency > HP_OFF * 1.001;
/** longest delay the engine provides (seconds) */
export const MAX_DELAY_SECONDS = 10;
/** an LFO depth at or below this is none */
export const MOD_OFF = 1e-6;
export const modActive = (p: DelayParams) => (p.modDepthSeconds ?? 0) > MOD_OFF * 1.01;
/** the loop stays stable below 0 dB of feedback */
export const MAX_FEEDBACK_DB = -0.1;

export const delayGain = (db: number) => (db <= OFF_DB + 0.5 ? 0 : 10 ** (db / 20));

/** Packed model values: additive changes of them are what single controls do (times and levels multiply). */
export const NUM_DELAY_PACKED = 11;
export const packDelay = (p: DelayParams): number[] => [
  Math.log(p.delaySeconds), p.dryDb, p.wetDb, p.feedbackDb, Math.log(p.loopLp), Math.log(p.loopHp), Math.log(p.wetLp), Math.log(p.wetHp),
  Math.log(Math.max(p.modDepthSeconds ?? MOD_OFF, MOD_OFF)), Math.log(Math.max(p.modRate ?? 1, 0.01)), p.modPhase ?? 0,
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
  // (models fitted before the LFO have 8 values)
  modDepthSeconds: clamp(Math.exp(x[8] ?? Math.log(MOD_OFF)), MOD_OFF, MAX_MOD_DEPTH_SECONDS),
  modRate: clamp(Math.exp(x[9] ?? 0), 0.01, 50),
  modPhase: x[10] ?? 0,
});
/** deepest LFO the engine provides (seconds) */
export const MAX_MOD_DEPTH_SECONDS = 0.05;

/** Coefficient of a one-pole low-pass: state += (1 − a) · (x − state). */
export const onePole = (frequency: number, sampleRate: number) => Math.exp((-2 * Math.PI * frequency) / sampleRate);

/** Output of the model for `signal` (as long as `length`; the signal is continued with silence). */
export function processDelay(signal: ArrayLike<number>, p: DelayParams, s: DelayStructure, sampleRate: number, length = signal.length, start = 0): Float32Array {
  const out = new Float32Array(length);
  const centre = clamp(p.delaySeconds * sampleRate, 1, MAX_DELAY_SECONDS * sampleRate);
  const depth = modActive(p) ? Math.min(p.modDepthSeconds! * sampleRate, MAX_MOD_DEPTH_SECONDS * sampleRate) : 0;
  const omega = (2 * Math.PI * (p.modRate ?? 0)) / sampleRate, phase = p.modPhase ?? 0;
  const size = Math.floor(centre + depth) + 3;
  const line = new Float64Array(size);
  const dry = s.drySign * delayGain(p.dryDb), wet = s.wetSign * delayGain(p.wetDb), feedback = s.feedbackSign * delayGain(p.feedbackDb);
  const loopLp = lpActive(p.loopLp) ? onePole(p.loopLp, sampleRate) : -1, loopHp = hpActive(p.loopHp) ? onePole(p.loopHp, sampleRate) : -1;
  const wetLp = lpActive(p.wetLp) ? onePole(p.wetLp, sampleRate) : -1, wetHp = hpActive(p.wetHp) ? onePole(p.wetHp, sampleRate) : -1;
  let loopLow = 0, loopHigh = 0, wetLow = 0, wetHigh = 0, write = 0;
  for (let n = 0; n < length; n++) {
    const x = n < signal.length ? signal[n]! : 0;
    const delay = depth > 0 ? Math.max(1, centre + depth * Math.sin(phase + omega * (n + start + (s.modLead ?? 0)))) : centre;
    const whole = Math.floor(delay), frac = delay - whole;
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
