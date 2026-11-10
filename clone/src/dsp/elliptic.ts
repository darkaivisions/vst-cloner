import type { AnalogSection } from "./biquad.ts";

/**
 * Elliptic (Cauer) lowpass prototype, passband edge at 1 rad/s.
 * Design after S. J. Orfanidis, "Lecture Notes on Elliptic Filter Design" (Landen transformations).
 * Only used at fit time: the normalised sections are stored in the model, the plugin merely shifts
 * them to the cutoff frequency.
 */

type C = [number, number];

const add = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const sub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const scale = (a: C, s: number): C => [a[0] * s, a[1] * s];
const csqrt = (a: C): C => {
  const r = Math.hypot(a[0], a[1]);
  const re = Math.sqrt(Math.max(0, (r + a[0]) / 2));
  const im = Math.sqrt(Math.max(0, (r - a[0]) / 2));
  return [re, a[1] < 0 ? -im : im];
};
const clog = (a: C): C => [Math.log(Math.hypot(a[0], a[1])), Math.atan2(a[1], a[0])];
/** asin z = −i · ln(i z + √(1 − z²)) */
const casin = (z: C): C => {
  const w = clog(add(mul([0, 1], z), csqrt(sub([1, 0], mul(z, z)))));
  return [w[1], -w[0]];
};
const ccos = (a: C): C => [Math.cos(a[0]) * Math.cosh(a[1]), -Math.sin(a[0]) * Math.sinh(a[1])];
const csin = (a: C): C => [Math.sin(a[0]) * Math.cosh(a[1]), Math.cos(a[0]) * Math.sinh(a[1])];

/** Descending Landen sequence of the modulus k. */
function landen(k: number, steps = 8): number[] {
  const v: number[] = [];
  for (let i = 0; i < steps; i++) {
    k = (k / (1 + Math.sqrt(1 - k * k))) ** 2;
    v.push(k);
  }
  return v;
}

/** cd(u·K, k) for complex u (u normalised to the quarter period K). */
function cde(u: C, k: number): C {
  const v = landen(k);
  let w = ccos(scale(u, Math.PI / 2));
  for (let n = v.length - 1; n >= 0; n--) w = div(scale(w, 1 + v[n]!), add([1, 0], scale(mul(w, w), v[n]!)));
  return w;
}

/** sn(u·K, k) for complex u. */
function sne(u: C, k: number): C {
  const v = landen(k);
  let w = csin(scale(u, Math.PI / 2));
  for (let n = v.length - 1; n >= 0; n--) w = div(scale(w, 1 + v[n]!), add([1, 0], scale(mul(w, w), v[n]!)));
  return w;
}

/** Inverse of sne: u with sn(u·K, k) = w. */
function asne(w: C, k: number): C {
  const v = landen(k);
  const previous = [k, ...v.slice(0, -1)];
  for (let n = 0; n < v.length; n++) {
    const root = csqrt(sub([1, 0], scale(mul(w, w), previous[n]! ** 2)));
    w = scale(div(w, add([1, 0], root)), 2 / (1 + v[n]!));
  }
  return scale(casin(w), 2 / Math.PI);
}

/** Solves the degree equation: selectivity k for order N and discrimination k1. */
function ellipdeg(order: number, k1: number): number {
  const half = Math.floor(order / 2);
  const k1p = Math.sqrt(1 - k1 * k1);
  let kp = k1p ** order;
  for (let i = 1; i <= half; i++) kp *= sne([(2 * i - 1) / order, 0], k1p)[0] ** 4;
  return Math.sqrt(1 - kp * kp);
}

export interface EllipticPrototype {
  order: number;
  /** passband ripple (dB) */
  passbandDb: number;
  /** stopband attenuation (dB) */
  stopbandDb: number;
  /** stopband edge relative to the passband edge (1/k) */
  stopbandEdge: number;
  /** lowpass sections, s normalised to the passband edge */
  sections: AnalogSection[];
}

/** Elliptic lowpass prototype of the given order, ripple and attenuation (passband edge = 1). */
export function ellipticLowpass(order: number, passbandDb: number, stopbandDb: number): EllipticPrototype {
  const ep = Math.sqrt(10 ** (passbandDb / 10) - 1);
  const es = Math.sqrt(10 ** (stopbandDb / 10) - 1);
  const k1 = ep / es;
  const k = ellipdeg(order, k1);
  const half = Math.floor(order / 2);
  const odd = order % 2 === 1;

  // v0 = −j · asne(j/ep, k1) / N  (real)
  const v0 = scale(mul([0, -1], asne([0, 1 / ep], k1)), 1 / order);
  const sections: AnalogSection[] = [];
  for (let i = 1; i <= half; i++) {
    const u = (2 * i - 1) / order;
    const zeta = cde([u, 0], k)[0];
    const zero = 1 / (k * zeta); // zeros at ±j·zero
    const pole = mul([0, 1], cde(sub([u, 0], mul([0, 1], v0)), k));
    const pole2 = pole[0] * pole[0] + pole[1] * pole[1];
    const gain = pole2 / (zero * zero); // unity gain at DC
    sections.push({ b: [gain * zero * zero, 0, gain], a: [pole2, -2 * pole[0], 1], f0: 1 });
  }
  if (odd) {
    const p0 = mul([0, 1], sne(mul([0, 1], v0), k))[0]; // real, negative
    sections.push({ b: [-p0, 0, 0], a: [-p0, 1, 0], f0: 1 });
  } else if (sections.length) {
    // even orders start at the bottom of the passband ripple
    const g = 1 / Math.sqrt(1 + ep * ep);
    const s0 = sections[0]!;
    sections[0] = { ...s0, b: [s0.b[0] * g, s0.b[1] * g, s0.b[2] * g] };
  }
  return { order, passbandDb, stopbandDb, stopbandEdge: 1 / k, sections };
}

/** Lowpass → highpass with the same edge (s → 1/s). */
export function toHighpass(section: AnalogSection): AnalogSection {
  const firstOrder = section.a[2] === 0 && section.b[2] === 0;
  return firstOrder
    ? { b: [section.b[1], section.b[0], 0], a: [section.a[1], section.a[0], 0], f0: section.f0 }
    : { b: [section.b[2], section.b[1], section.b[0]], a: [section.a[2], section.a[1], section.a[0]], f0: section.f0 };
}
