/**
 * Compressor model, evaluated at control rate (blocks of BLOCK samples); the gain is interpolated per sample.
 * IMPORTANT: plugin-template/dynamics must implement exactly the same steps.
 */

export const BLOCK = 32;

export type Detector = "peak" | "rms";
export type Topology = "feedforward" | "feedback";

export interface CompressorParams {
  /** threshold (dBFS of the detector level) */
  thresholdDb: number;
  ratio: number;
  /** total width of the soft knee (dB) */
  kneeDb: number;
  /** output gain applied after the compressor (dB) */
  makeupDb: number;
  /** attack time constant (s) */
  attack: number;
  /** fast release time constant (s) */
  release: number;
  /** slow stage: charge time constant (s); 0 = no slow stage */
  charge: number;
  /** slow stage decay rate (dB/s) while far above `slowKneeDb` */
  slow: number;
  /** below this amount of reduction the slow stage turns from constant dB/s into an exponential decay */
  slowKneeDb: number;
}

export interface CompressorStructure {
  detector: Detector;
  topology: Topology;
}

/** Static curve: gain reduction (dB, ≥ 0) for a detector level. */
export function staticReduction(levelDb: number, p: Pick<CompressorParams, "thresholdDb" | "ratio" | "kneeDb">): number {
  const over = levelDb - p.thresholdDb;
  const slope = 1 - 1 / Math.max(p.ratio, 1);
  const half = p.kneeDb / 2;
  if (over <= -half) return 0;
  if (over >= half || p.kneeDb <= 0) return slope * over;
  return (slope * (over + half) ** 2) / (2 * p.kneeDb);
}

const coefficient = (seconds: number, sampleRate: number) => (seconds > 0 ? Math.exp(-BLOCK / (seconds * sampleRate)) : 0);

/** Detector levels of a signal per block (dBFS): peak or RMS. */
export function blockLevels(signal: Float32Array, detector: Detector): Float64Array {
  const blocks = Math.ceil(signal.length / BLOCK);
  const out = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let peak = 0, sum = 0;
    const end = Math.min(signal.length, (b + 1) * BLOCK);
    for (let i = b * BLOCK; i < end; i++) {
      const v = signal[i]!;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    // RMS of a sine is 3 dB below its peak: +3 dB keeps both detectors on the same scale for sines
    out[b] = detector === "peak" ? 20 * Math.log10(peak + 1e-12) : 10 * Math.log10(sum / (end - b * BLOCK) + 1e-24) + 3.0103;
  }
  return out;
}

/**
 * Runs the gain computer over block levels; returns the gain (dB) at the end of every block
 * (before makeup). Feedback detects the output of the previous block.
 */
export function simulateGain(levels: Float64Array, p: CompressorParams, s: CompressorStructure, sampleRate: number): Float64Array {
  const attack = coefficient(p.attack, sampleRate);
  const release = coefficient(p.release, sampleRate);
  const charge = coefficient(p.charge, sampleRate);
  const slowStep = (p.slow * BLOCK) / sampleRate;
  const gains = new Float64Array(levels.length);
  let fast = 0, slow = 0, reduction = 0;
  for (let b = 0; b < levels.length; b++) {
    const level = s.topology === "feedback" ? levels[b]! - reduction : levels[b]!;
    const target = staticReduction(level, p);
    fast = target > fast ? attack * fast + (1 - attack) * target : release * fast + (1 - release) * target;
    if (p.charge > 0) {
      if (fast > slow) slow = charge * slow + (1 - charge) * fast;
      // constant dB/s far above the knee, exponential close to zero: ds = −rate · s / (s + knee)
      else slow = Math.max(fast, slow - (slowStep * slow) / (slow + p.slowKneeDb));
    }
    reduction = Math.max(fast, slow);
    gains[b] = -reduction;
  }
  return gains;
}

/**
 * Linear gain per sample, causal: during block b the gain moves linearly from the result of block b−2 to the
 * result of block b−1 (the plugin only knows a block's level once the block is complete). Plus makeup.
 */
export function sampleGains(blockGains: Float64Array, length: number, makeupDb: number): Float32Array {
  const out = new Float32Array(length);
  let from = 0, to = 0;
  for (let b = 0; b * BLOCK < length; b++) {
    const end = Math.min(length, (b + 1) * BLOCK);
    for (let i = b * BLOCK; i < end; i++) {
      const t = (i - b * BLOCK + 1) / BLOCK;
      out[i] = 10 ** ((from + (to - from) * t + makeupDb) / 20);
    }
    from = to;
    to = blockGains[b] ?? to;
  }
  return out;
}

/** Gain (dB) per block as applied (causal, see sampleGains): mean of the ramp from block b−2 to b−1. */
export function appliedBlockGains(blockGains: Float64Array): Float64Array {
  const out = new Float64Array(blockGains.length);
  for (let b = 0; b < blockGains.length; b++) {
    const from = b >= 2 ? blockGains[b - 2]! : 0;
    const to = b >= 1 ? blockGains[b - 1]! : 0;
    out[b] = (from + to) / 2;
  }
  return out;
}
