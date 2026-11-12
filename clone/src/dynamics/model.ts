/**
 * Compressor model, evaluated at control rate (blocks of BLOCK samples); the gain is interpolated per sample.
 * IMPORTANT: plugin-template/dynamics must implement exactly the same steps.
 */

export const BLOCK = 32;

export type Detector = "peak" | "rms";
export type Topology = "feedforward" | "feedback";
/** compressor: reduction above the threshold; expander: reduction below it (downward expander, gate) */
export type Curve = "compressor" | "expander";

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
  /** slow stage: charge time constant (s); 0 = no slow stage.
   *  Expander curve (no slow stage there): decay time of the detector (s) – the level falls slowly after a
   *  signal ends, so the gate closes gradually along its curve */
  charge: number;
  /** slow stage decay rate (dB/s) while far above `slowKneeDb` */
  slow: number;
  /** below this amount of reduction the slow stage turns from constant dB/s into an exponential decay.
   *  Expander curve (no slow stage there): the range – the largest reduction of the closed gate (dB) */
  slowKneeDb: number;
  /** averaging time of the detector (s): the energy is smoothed before the static curve. Large level jumps
   *  therefore reach the curve faster (in dB) than small ones – a program-dependent attack */
  detectorTime: number;
  /** saturation after the gain reduction, before makeup: tanh(drive · x) / drive (0 = clean) */
  drive: number;
  /** detector ripple reaching the gain: a fast energy path (time constant, s) whose curve value differs from the
   *  smoothed one; this share of the difference modulates the gain (colours compressed signals with odd harmonics) */
  rippleTime: number;
  ripple: number;
}

export interface CompressorStructure {
  detector: Detector;
  topology: Topology;
  /** missing: compressor */
  curve?: Curve;
}

/**
 * Static curve: gain reduction (dB, ≥ 0) for a detector level.
 * Expander: (ratio − 1) dB of reduction per dB below the threshold, at most the range (`slowKneeDb`).
 */
export function staticReduction(
  levelDb: number,
  p: Pick<CompressorParams, "thresholdDb" | "ratio" | "kneeDb"> & Partial<Pick<CompressorParams, "slowKneeDb">>,
  curve: Curve = "compressor",
): number {
  const half = p.kneeDb / 2;
  if (curve === "expander") {
    const under = p.thresholdDb - levelDb;
    const steep = Math.max(p.ratio, 1) - 1;
    const range = p.slowKneeDb ?? Infinity;
    if (under <= -half) return 0;
    if (under >= half || p.kneeDb <= 0) return Math.min(range, steep * under);
    return Math.min(range, (steep * (under + half) ** 2) / (2 * p.kneeDb));
  }
  const over = levelDb - p.thresholdDb;
  const slope = 1 - 1 / Math.max(p.ratio, 1);
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
export function simulateGain(
  levels: Float64Array,
  p: CompressorParams,
  s: CompressorStructure,
  sampleRate: number,
  /** 10^(level/10) per block – pass it when simulating many times (fitting) */
  energies?: Float64Array,
): Float64Array {
  const attack = coefficient(p.attack, sampleRate);
  const release = coefficient(p.release, sampleRate);
  const charge = coefficient(p.charge, sampleRate);
  const slowStep = (p.slow * BLOCK) / sampleRate;
  const smoothing = coefficient(p.detectorTime, sampleRate);
  const rippleSmoothing = coefficient(p.rippleTime, sampleRate);
  const gains = new Float64Array(levels.length);
  const expander = s.curve === "expander";
  // outside the knee edge the curve is 0 – no logarithm needed there (compressor: below it, expander: above it)
  const kneeEdge = 10 ** ((p.thresholdDb + (expander ? p.kneeDb / 2 : -p.kneeDb / 2)) / 10);
  const curveAt = (energy: number) =>
    (expander ? energy >= kneeEdge : energy <= kneeEdge) ? 0 : staticReduction(10 * Math.log10(energy + 1e-24), p, s.curve);
  let fast = 0, slow = 0, reduction = 0, energy = 0, rippleEnergy = 0;
  for (let b = 0; b < levels.length; b++) {
    const e = energies ? energies[b]! : 10 ** (levels[b]! / 10);
    const raw = s.topology === "feedback" && !expander && reduction > 0 ? e * 10 ** (-reduction / 10) : e;
    // expander: the detector follows a falling level with its own (slower) time constant
    energy = expander && raw < energy ? charge * energy + (1 - charge) * raw : smoothing * energy + (1 - smoothing) * raw;
    rippleEnergy = rippleSmoothing * rippleEnergy + (1 - rippleSmoothing) * raw;
    const target = curveAt(energy);
    fast = target > fast ? attack * fast + (1 - attack) * target : release * fast + (1 - release) * target;
    if (p.charge > 0 && !expander) {
      if (fast > slow) slow = charge * slow + (1 - charge) * fast;
      // constant dB/s far above the knee, exponential close to zero: ds = −rate · s / (s + knee)
      else slow = Math.max(fast, slow - (slowStep * slow) / Math.max(slow + p.slowKneeDb, 1e-9));
    }
    reduction = Math.max(fast, slow);
    let applied = reduction;
    if (p.ripple > 0) {
      applied += p.ripple * (curveAt(rippleEnergy) - target);
    }
    gains[b] = -applied;
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

/** Odd-order saturation with unity small-signal gain. */
export function shape(v: number, drive: number): number {
  return drive > 1e-4 ? Math.tanh(drive * v) / drive : v;
}

/**
 * Output of the model for samples [from, to) of `signal`: gain reduction ramp (as sampleGains), saturation,
 * makeup. Exactly what the plugin computes per sample.
 */
export function renderModel(signal: Float32Array, blockGains: Float64Array, p: CompressorParams, from = 0, to = signal.length): Float32Array {
  const out = new Float32Array(to - from);
  const makeup = 10 ** (p.makeupDb / 20);
  for (let i = from; i < to; i++) {
    const b = Math.floor(i / BLOCK);
    const start = b >= 2 ? blockGains[b - 2]! : 0;
    const end = b >= 1 ? blockGains[b - 1]! : 0;
    const t = (i - b * BLOCK + 1) / BLOCK;
    out[i - from] = shape(signal[i]! * 10 ** ((start + (end - start) * t) / 20), p.drive) * makeup;
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
