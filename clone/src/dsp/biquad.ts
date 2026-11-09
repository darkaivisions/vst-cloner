/**
 * Analog prototypes and their digitization.
 *
 * Analog sections are written in normalized s' = s / ω0 with coefficients for (1, s', s'²).
 * First-order sections have b2 = a2 = 0.
 *
 * Two digitizations:
 *  - "bilinear": bilinear transform prewarped at ω0 (classic cookbook filters, cramped near Nyquist)
 *  - "matched":  poles by matched-z (exact analog decay), zeros by matching the analog magnitude
 *                at DC, Nyquist and one inner frequency (M. Vicanek, "Matched Second Order Digital Filters", 2016)
 *
 * IMPORTANT: clone/src/eq/faust.ts implements the same formulas in Faust. Keep both in sync.
 */

export type Design = "bilinear" | "matched";

export interface AnalogSection {
  /** numerator coefficients for 1, s', s'² */
  b: [number, number, number];
  /** denominator coefficients for 1, s', s'² */
  a: [number, number, number];
  /** cutoff/center frequency in Hz */
  f0: number;
}

export interface DigitalSection {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export const IDENTITY: DigitalSection = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

const isFirstOrder = (s: AnalogSection) => s.a[2] === 0 && s.b[2] === 0;

/** |H(jΩ)|² of an analog section at normalized frequency Ω = f / f0. */
export function analogMagnitudeSquared(section: AnalogSection, omega: number): number {
  const [b0, b1, b2] = section.b;
  const [a0, a1, a2] = section.a;
  const w2 = omega * omega;
  const num = (b0 - b2 * w2) ** 2 + (b1 * omega) ** 2;
  const den = (a0 - a2 * w2) ** 2 + (a1 * omega) ** 2;
  return num / den;
}

function bilinear(section: AnalogSection, sampleRate: number): DigitalSection {
  const k = Math.tan((Math.PI * section.f0) / sampleRate);
  const [b0, b1, b2] = section.b;
  const [a0, a1, a2] = section.a;

  if (isFirstOrder(section)) {
    const norm = a1 + a0 * k;
    return { b0: (b1 + b0 * k) / norm, b1: (b0 * k - b1) / norm, b2: 0, a1: (a0 * k - a1) / norm, a2: 0 };
  }

  const kk = k * k;
  const norm = a2 + a1 * k + a0 * kk;
  return {
    b0: (b2 + b1 * k + b0 * kk) / norm,
    b1: (2 * (b0 * kk - b2)) / norm,
    b2: (b2 - b1 * k + b0 * kk) / norm,
    a1: (2 * (a0 * kk - a2)) / norm,
    a2: (a2 - a1 * k + a0 * kk) / norm,
  };
}

function matched(section: AnalogSection, sampleRate: number): DigitalSection {
  const w0T = (2 * Math.PI * section.f0) / sampleRate;
  const [a0, a1, a2] = section.a;
  const nyquistOmega = sampleRate / 2 / section.f0;

  if (isFirstOrder(section)) {
    const pole = Math.exp((-a0 / a1) * w0T);
    const da1 = -pole;
    const p = Math.sqrt(analogMagnitudeSquared(section, 0)) * (1 + da1);
    const q = Math.sqrt(analogMagnitudeSquared(section, nyquistOmega)) * (1 - da1);
    return { b0: (p + q) / 2, b1: (p - q) / 2, b2: 0, a1: da1, a2: 0 };
  }

  // poles: roots of a2 s'² + a1 s' + a0, mapped by z = exp(s T) with s = ω0 s'
  const disc = a1 * a1 - 4 * a2 * a0;
  let da1: number;
  let da2: number;
  if (disc < 0) {
    const alpha = (a1 / (2 * a2)) * w0T;
    const beta = (Math.sqrt(-disc) / (2 * a2)) * w0T;
    da1 = -2 * Math.exp(-alpha) * Math.cos(beta);
    da2 = Math.exp(-2 * alpha);
  } else {
    const r = Math.sqrt(disc);
    const p1 = ((-a1 + r) / (2 * a2)) * w0T;
    const p2 = ((-a1 - r) / (2 * a2)) * w0T;
    da1 = -(Math.exp(p1) + Math.exp(p2));
    da2 = Math.exp(p1 + p2);
  }

  // |A|² = A0 φ0 + A1 φ1 + A2 φ2 with φ1 = sin²(ω/2), φ0 = 1 − φ1, φ2 = 4 φ0 φ1
  const A0 = (1 + da1 + da2) ** 2;
  const A1 = (1 - da1 + da2) ** 2;
  const A2 = -4 * da2;

  const wm = Math.min(w0T, 0.9 * Math.PI);
  const phi1 = Math.sin(wm / 2) ** 2;
  const phi0 = 1 - phi1;
  const phi2 = 4 * phi0 * phi1;

  // pure s'² numerator (high-pass): keep the double zero at DC, b0 (1 − z⁻¹)², matched at ωm
  if (section.b[0] === 0 && section.b[1] === 0) {
    const b0 = Math.sqrt(analogMagnitudeSquared(section, wm / w0T) * (A0 * phi0 + A1 * phi1 + A2 * phi2)) / (4 * phi1);
    return { b0, b1: -2 * b0, b2: b0, a1: da1, a2: da2 };
  }

  const B0 = analogMagnitudeSquared(section, 0) * A0;
  const B1 = analogMagnitudeSquared(section, nyquistOmega) * A1;
  const target = analogMagnitudeSquared(section, wm / w0T) * (A0 * phi0 + A1 * phi1 + A2 * phi2);
  const B2 = (target - B0 * phi0 - B1 * phi1) / phi2;

  const sqrtB0 = Math.sqrt(Math.max(B0, 0));
  const sqrtB1 = Math.sqrt(Math.max(B1, 0));
  const W = (sqrtB0 + sqrtB1) / 2;
  const b0 = (W + Math.sqrt(Math.max(W * W + B2, 0))) / 2;
  const b1 = (sqrtB0 - sqrtB1) / 2;
  const b2 = b0 > 0 ? -B2 / (4 * b0) : 0;

  return { b0, b1, b2, a1: da1, a2: da2 };
}

export function digitize(section: AnalogSection, design: Design, sampleRate: number): DigitalSection {
  return design === "matched" ? matched(section, sampleRate) : bilinear(section, sampleRate);
}

/** Magnitude in dB of a cascade of digital sections at the given frequencies. */
export function cascadeDb(sections: DigitalSection[], sampleRate: number, frequencies: Float64Array): Float64Array {
  const result = new Float64Array(frequencies.length);
  for (let i = 0; i < frequencies.length; i++) {
    const w = (2 * Math.PI * frequencies[i]!) / sampleRate;
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    let db = 0;
    for (const s of sections) {
      const nr = s.b0 + s.b1 * c1 + s.b2 * c2;
      const ni = -(s.b1 * s1 + s.b2 * s2);
      const dr = 1 + s.a1 * c1 + s.a2 * c2;
      const di = -(s.a1 * s1 + s.a2 * s2);
      db += 10 * Math.log10(Math.max(nr * nr + ni * ni, 1e-30) / Math.max(dr * dr + di * di, 1e-30));
    }
    result[i] = db;
  }
  return result;
}

// ---- analog prototypes (RBJ conventions; A = 10^(dB/40)) -------------------------------------

export const prototypes = {
  bell: (f0: number, gainDb: number, q: number): AnalogSection => {
    const A = 10 ** (gainDb / 40);
    return { b: [1, A / q, 1], a: [1, 1 / (A * q), 1], f0 };
  },
  lowShelf: (f0: number, gainDb: number, q: number): AnalogSection => {
    const A = 10 ** (gainDb / 40);
    const s = Math.sqrt(A) / q;
    return { b: [A * A, A * s, A], a: [1, s, A], f0 };
  },
  highShelf: (f0: number, gainDb: number, q: number): AnalogSection => {
    const A = 10 ** (gainDb / 40);
    const s = Math.sqrt(A) / q;
    return { b: [A, A * s, A * A], a: [A, s, 1], f0 };
  },
  /** Second-order tilt: high shelf scaled so that low end = −dB/2 and high end = +dB/2. */
  tilt2: (f0: number, gainDb: number, q: number): AnalogSection => {
    const A = 10 ** (gainDb / 40);
    const s = Math.sqrt(A) / q;
    return { b: [1, s, A], a: [A, s, 1], f0 };
  },
  /** First-order tilt around f0 (0 dB at f0). */
  tilt1: (f0: number, gainDb: number): AnalogSection => {
    const g = Math.sqrt(10 ** (gainDb / 20));
    return { b: [1, g, 0], a: [g, 1, 0], f0 };
  },
  lowPass2: (f0: number, q: number): AnalogSection => ({ b: [1, 0, 0], a: [1, 1 / q, 1], f0 }),
  highPass2: (f0: number, q: number): AnalogSection => ({ b: [0, 0, 1], a: [1, 1 / q, 1], f0 }),
  lowPass1: (f0: number): AnalogSection => ({ b: [1, 0, 0], a: [1, 1, 0], f0 }),
  highPass1: (f0: number): AnalogSection => ({ b: [0, 1, 0], a: [1, 1, 0], f0 }),
  bandPass: (f0: number, q: number): AnalogSection => ({ b: [0, 1 / q, 0], a: [1, 1 / q, 1], f0 }),
  notch: (f0: number, q: number): AnalogSection => ({ b: [1, 0, 1], a: [1, 1 / q, 1], f0 }),
};

/** Butterworth section Qs for an order-N filter (plus one first-order section if N is odd). */
export function butterworthQs(order: number): { qs: number[]; firstOrder: boolean } {
  const odd = order % 2 === 1;
  const qs: number[] = [];
  for (let k = 1; k <= Math.floor(order / 2); k++) {
    const angle = odd ? (k * Math.PI) / order : ((2 * k - 1) * Math.PI) / (2 * order);
    qs.push(1 / (2 * Math.cos(angle)));
  }
  return { qs, firstOrder: odd };
}
