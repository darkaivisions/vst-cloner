import { digitize, prototypes, type DigitalSection } from "../dsp/biquad.ts";

/**
 * Wiener–Hammerstein model of a distortion stage: linear pre-filter → static clipping curve → linear post-filter.
 * The filters use the biquad prototypes of the EQ engine (matched design), so the plugin can reuse EqEngine.h.
 * IMPORTANT: plugin-template/distortion must implement exactly the same steps.
 */
export interface DistortionParams {
  /** gain before the clipper (dB) – mainly the drive */
  inputDb: number;
  /** pre-filter: high-pass (Hz), bell (Hz, dB, Q), low-pass (Hz) */
  preHp: number;
  preBellFreq: number;
  preBellDb: number;
  preBellQ: number;
  /** second bell of the pre-filter (drive controls often reshape the input response) */
  preBell2Freq: number;
  preBell2Db: number;
  preBell2Q: number;
  preLp: number;
  /** clipping curve: output limit for positive / negative input, hardness (2 soft … 10 hard) */
  clipPos: number;
  clipNeg: number;
  hardness: number;
  /** supply rails after the clipper (hard, asymmetric): even harmonics that only appear when clipping hard */
  railPos: number;
  railNeg: number;
  /** post-filter (tone): bell (Hz, dB, Q), high shelf (Hz, dB), low-pass and high-pass (Hz) */
  postBellFreq: number;
  postBellDb: number;
  postBellQ: number;
  shelfFreq: number;
  shelfDb: number;
  postLp: number;
  postHp: number;
  /** gain after the post-filter (dB) – mainly the level control */
  outputDb: number;
}

/** Highest filter frequency relative to the sample rate (matched design is fine up to Nyquist). */
const clampFreq = (f: number, sampleRate: number) => Math.min(Math.max(f, 5), sampleRate * 0.49);

export function preSections(p: DistortionParams, sampleRate: number): DigitalSection[] {
  return [
    digitize(prototypes.highPass1(clampFreq(p.preHp, sampleRate)), "matched", sampleRate),
    digitize(prototypes.bell(clampFreq(p.preBellFreq, sampleRate), p.preBellDb, Math.max(p.preBellQ, 0.1)), "matched", sampleRate),
    digitize(prototypes.bell(clampFreq(p.preBell2Freq, sampleRate), p.preBell2Db, Math.max(p.preBell2Q, 0.1)), "matched", sampleRate),
    digitize(prototypes.lowPass1(clampFreq(p.preLp, sampleRate)), "matched", sampleRate),
  ];
}

export function postSections(p: DistortionParams, sampleRate: number): DigitalSection[] {
  return [
    digitize(prototypes.bell(clampFreq(p.postBellFreq, sampleRate), p.postBellDb, Math.max(p.postBellQ, 0.1)), "matched", sampleRate),
    digitize(prototypes.highShelf(clampFreq(p.shelfFreq, sampleRate), p.shelfDb, Math.SQRT1_2), "matched", sampleRate),
    digitize(prototypes.lowPass2(clampFreq(p.postLp, sampleRate), Math.SQRT1_2), "matched", sampleRate),
    digitize(prototypes.highPass1(clampFreq(p.postHp, sampleRate)), "matched", sampleRate),
  ];
}

/** Hardness of the supply rails */
export const RAIL_HARDNESS = 8;

function softLimit(v: number, positive: number, negative: number, hardness: number): number {
  const limit = v >= 0 ? positive : negative;
  const k = Math.max(hardness, 0.5);
  return v / (1 + Math.abs(v / limit) ** k) ** (1 / k);
}

/**
 * Clipping stage with unity slope at zero: v / (1 + |v/limit|^k)^(1/k) with separate limits per polarity,
 * followed by the (harder, asymmetric) supply rails.
 */
export function clip(v: number, p: Pick<DistortionParams, "clipPos" | "clipNeg" | "hardness" | "railPos" | "railNeg">): number {
  return softLimit(softLimit(v, p.clipPos, p.clipNeg, p.hardness), p.railPos, p.railNeg, RAIL_HARDNESS);
}

/** Transposed direct form II biquad chain state. */
class Chain {
  private z1: Float64Array;
  private z2: Float64Array;
  private readonly sections: DigitalSection[];
  constructor(sections: DigitalSection[]) {
    this.sections = sections;
    this.z1 = new Float64Array(sections.length);
    this.z2 = new Float64Array(sections.length);
  }
  process(x: number): number {
    for (let s = 0; s < this.sections.length; s++) {
      const c = this.sections[s]!;
      const y = c.b0 * x + this.z1[s]!;
      this.z1[s] = c.b1 * x - c.a1 * y + this.z2[s]!;
      this.z2[s] = c.b2 * x - c.a2 * y;
      x = y;
    }
    return x;
  }
}

/** Runs the model over a signal (from silence). */
export function processDistortion(signal: Float32Array | Float64Array, p: DistortionParams, sampleRate: number, delay = 0): Float64Array {
  const pre = new Chain(preSections(p, sampleRate));
  const post = new Chain(postSections(p, sampleRate));
  const gIn = 10 ** (p.inputDb / 20), gOut = 10 ** (p.outputDb / 20);
  const out = new Float64Array(signal.length);
  // the delay of the original is applied at the input (the model is time-invariant)
  for (let i = delay; i < signal.length; i++) out[i] = gOut * post.process(clip(pre.process(signal[i - delay]! * gIn), p));
  return out;
}

/** The clipping curve as a table (for fitting only – the plugin computes the curve exactly). */
export class ClipTable {
  private readonly table: Float64Array;
  private readonly range: number;
  private readonly scale: number;
  constructor(p: Pick<DistortionParams, "clipPos" | "clipNeg" | "hardness" | "railPos" | "railNeg">, size = 4096) {
    // beyond ±range the curve is flat to well below 0.1 % (limit · 16)
    this.range = 16 * Math.max(p.clipPos, p.clipNeg);
    this.table = new Float64Array(size + 1);
    for (let i = 0; i <= size; i++) this.table[i] = clip(-this.range + (2 * this.range * i) / size, p);
    this.scale = size / (2 * this.range);
  }
  at(v: number): number {
    const x = (Math.min(Math.max(v, -this.range), this.range) + this.range) * this.scale;
    const i = Math.min(Math.floor(x), this.table.length - 2);
    const t = x - i;
    return this.table[i]! + (this.table[i + 1]! - this.table[i]!) * t;
  }
}

/** Fast variant for fitting (clip curve from a table). */
export function processDistortionFast(signal: Float64Array, p: DistortionParams, sampleRate: number, table = new ClipTable(p)): Float64Array {
  const pre = new Chain(preSections(p, sampleRate));
  const post = new Chain(postSections(p, sampleRate));
  const gIn = 10 ** (p.inputDb / 20), gOut = 10 ** (p.outputDb / 20);
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = gOut * post.process(table.at(pre.process(signal[i]! * gIn)));
  return out;
}
