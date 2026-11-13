/**
 * Reverb model: a feedback delay network (8 lines, Householder feedback) behind a pre-delay. What it reproduces
 * is the tail as it is heard – its level and its decay time in three frequency bands (lows, mids, highs) – not
 * the single reflections of the original.
 *   d      = x delayed by the pre-delay
 *   line_i = d + absorb_i(out_i − 2/N · Σ out)        absorb: a gain per band, from the band's decay time
 *   y      = dry · x + bandGains(Σ ±out_i)             band gains: from the band's level
 * IMPORTANT: plugin-template/reverb must implement exactly the same steps.
 */

export interface ReverbParams {
  predelaySeconds: number;
  /** level of the dry signal (dB); OFF_DB and below mean "off" */
  dryDb: number;
  /** output gain of the network per band (dB): lows, mids, highs. The fit sets the gains and decay times so
   *  that the model's own response shows the measured levels and decay times */
  gainDb: [number, number, number];
  /** decay time (RT60, seconds) per band */
  rt: [number, number, number];
}

export interface ReverbStructure {
  drySign: number;
}

export const REVERB_OFF_DB = -100;
/** band edges (Hz) of the model and of the comparison */
export const REVERB_SPLITS = [400, 3000];
/** delay line lengths (samples at 48 kHz): mutually prime, the shortest gives an early onset */
export const REVERB_LINES = [149, 311, 557, 809, 1049, 1361, 1657, 1973];
/** output signs of the lines for the two channels (decorrelated tails) */
export const REVERB_SIGNS = [
  [1, -1, 1, -1, 1, -1, 1, -1],
  [1, 1, -1, -1, 1, 1, -1, -1],
];
export const MAX_PREDELAY_SECONDS = 1;
export const MIN_RT = 0.05, MAX_RT = 30;
/**
 * Tail energy per band of the bare network (band gains 1) for a unit impulse: about A · RT + B, with RT the decay
 * time in seconds – measured on the model itself. The fit starts from it (see fit.ts) and then corrects the
 * gains on the model's own response.
 */
export const REVERB_ENERGY: { a: [number, number, number]; b: [number, number, number] } = { a: [0.6418, 3.0555, 12.971], b: [0.1925, 0.9629, 4.0775] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const NUM_REVERB_PACKED = 8;
/**
 * Packed model values: additive changes of them are what single controls do (pre-delay in seconds, levels in dB,
 * decay times as logarithms).
 */
export const packReverb = (p: ReverbParams): number[] => [
  p.predelaySeconds, p.dryDb, p.gainDb[0], p.gainDb[1], p.gainDb[2], Math.log(p.rt[0]), Math.log(p.rt[1]), Math.log(p.rt[2]),
];
const fromLog = (x: number) => clamp(Math.exp(Math.min(x, 10)), MIN_RT, MAX_RT);
export const unpackReverb = (x: number[]): ReverbParams => ({
  predelaySeconds: clamp(x[0]!, 0, MAX_PREDELAY_SECONDS),
  dryDb: clamp(x[1]!, REVERB_OFF_DB, 24),
  gainDb: [clamp(x[2]!, REVERB_OFF_DB, 40), clamp(x[3]!, REVERB_OFF_DB, 40), clamp(x[4]!, REVERB_OFF_DB, 40)],
  rt: [fromLog(x[5]!), fromLog(x[6]!), fromLog(x[7]!)],
});

const gainOf = (db: number) => (db <= REVERB_OFF_DB + 0.5 ? 0 : 10 ** (db / 20));
const onePole = (frequency: number, sampleRate: number) => Math.exp((-2 * Math.PI * frequency) / sampleRate);

/** Line lengths at a sample rate. */
export const reverbLines = (sampleRate: number) => REVERB_LINES.map((n) => Math.max(1, Math.round((n * sampleRate) / 48000)));

/** Linear output gain per band. */
export const reverbBandGains = (p: ReverbParams): number[] => p.gainDb.map(gainOf);

/**
 * Output of the model for `signal` (as long as `length`; the signal is continued with silence), for one output
 * channel (0 or 1: the sign set of the tail).
 */
export function processReverb(
  signal: ArrayLike<number>,
  p: ReverbParams,
  s: ReverbStructure,
  sampleRate: number,
  length = signal.length,
  channel = 0,
): Float32Array {
  const out = new Float32Array(length);
  const lengths = reverbLines(sampleRate);
  const count = lengths.length;
  const lines = lengths.map((n) => new Float64Array(n));
  const position = new Int32Array(count);
  const aLow = onePole(REVERB_SPLITS[0]!, sampleRate), aHigh = onePole(REVERB_SPLITS[1]!, sampleRate);
  // absorption per line and band: −60 dB after the band's decay time
  const absorb = lengths.map((n) => p.rt.map((rt) => 10 ** ((-3 * n) / (sampleRate * rt))));
  const low = new Float64Array(count), high = new Float64Array(count), tap = new Float64Array(count);
  const signs = REVERB_SIGNS[channel]!;
  const gains = reverbBandGains(p);
  const dry = s.drySign * gainOf(p.dryDb);
  const predelay = Math.round(clamp(p.predelaySeconds, 0, MAX_PREDELAY_SECONDS) * sampleRate);
  const wait = new Float64Array(predelay + 1);
  let waitAt = 0, outLow = 0, outHigh = 0;
  for (let n = 0; n < length; n++) {
    const x = n < signal.length ? signal[n]! : 0;
    // pre-delay (a line of predelay + 1 samples: read the oldest, then overwrite it)
    wait[waitAt] = x;
    waitAt = waitAt === predelay ? 0 : waitAt + 1;
    const d = wait[waitAt]!;
    let sum = 0, wet = 0;
    for (let i = 0; i < count; i++) {
      const o = lines[i]![position[i]!]!;
      tap[i] = o;
      sum += o;
      wet += signs[i]! * o;
    }
    const mix = (2 / count) * sum;
    for (let i = 0; i < count; i++) {
      const f = tap[i]! - mix;
      low[i] = low[i]! + (1 - aLow) * (f - low[i]!);
      high[i] = high[i]! + (1 - aHigh) * (f - high[i]!);
      const g = absorb[i]!;
      lines[i]![position[i]!] = d + g[0]! * low[i]! + g[1]! * (high[i]! - low[i]!) + g[2]! * (f - high[i]!);
      position[i] = position[i]! + 1 === lengths[i]! ? 0 : position[i]! + 1;
    }
    outLow += (1 - aLow) * (wet - outLow);
    outHigh += (1 - aHigh) * (wet - outHigh);
    out[n] = dry * x + gains[0]! * outLow + gains[1]! * (outHigh - outLow) + gains[2]! * (wet - outHigh);
  }
  return out;
}
