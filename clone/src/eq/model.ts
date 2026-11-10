import { butterworthQs, cascadeDb, digitize, IDENTITY, prototypes, type AnalogSection, type Design, type DigitalSection } from "../dsp/biquad.ts";
import type { EqMapping, ShapeKind } from "./mapping.ts";
import { toHighpass } from "../dsp/elliptic.ts";

/** How the Q parameter acts on cut filters with several sections. */
export type CutQMode = "ignore" | "scaleAll" | "scaleLast";

export interface ShapeFit {
  design: Design;
  /** multiplies the displayed frequency */
  freqScale: number;
  /** effective Q = qScale · Q^qExponent */
  qScale: number;
  qExponent?: number;
  /** multiplies the displayed gain (e.g. 2 for tilt shelves that apply the gain to both ends);
   *  flat tilt: slope in dB/octave per dB of displayed gain */
  gainScale?: number;
  /** cuts only */
  qMode?: CutQMode;
  /** tilt shelf only: 1 = first order, 2 = second order */
  tiltOrder?: 1 | 2;
  /** cuts with a "Brickwall" slope: elliptic lowpass prototype (passband edge = 1) */
  brickwall?: BrickwallFit;
}

export interface BrickwallFit {
  order: number;
  passbandDb: number;
  stopbandDb: number;
  /** passband edge = displayed frequency × freqScale × edgeScale */
  edgeScale: number;
  sections: { b: [number, number, number]; a: [number, number, number] }[];
}

export interface ShapeModel {
  label: string;
  kind: ShapeKind;
  fit?: ShapeFit;
}

export interface FitStats {
  renders: number;
  rmsDb: number;
  maxDb: number;
}

export interface ShapeReport {
  label: string;
  kind: ShapeKind;
  fit?: ShapeFit;
  train?: FitStats;
  validate?: FitStats;
  /** settings the model can only approximate (not used for fitting) */
  approximate?: FitStats;
  /** "Brickwall" slope, modelled by the elliptic fit */
  brickwall?: FitStats;
  note?: string;
}

export interface EqModel {
  type: "parametric-eq";
  version: 1;
  /** sample rate of the measurements */
  sampleRate: number;
  mapping: EqMapping;
  shapes: ShapeModel[];
  /** fit used when the plugin has no shape parameter */
  defaultFit?: ShapeFit;
  defaultKind?: ShapeKind;
  /** constant level offset of the plugin with all bands off (dB) */
  baselineDb: number;
  report: {
    shapes: ShapeReport[];
    baselineFlatnessDb: number;
    mappingErrors: { parameter: number; name: string; maxRelativeError: number }[];
  };
}

/** Settings of one band in physical units. */
export interface BandSettings {
  kind: ShapeKind;
  frequency: number;
  gainDb: number;
  q: number;
  /** cut filter order */
  order: number;
  /** cut with the "Brickwall" slope */
  brickwall?: boolean;
}

/** Q values of the sections of an order-N cut filter, see CutQMode. */
export function cutSectionQs(order: number, q: number, mode: CutQMode): { qs: number[]; firstOrder: boolean } {
  const { qs, firstOrder } = butterworthQs(order);
  if (mode === "ignore" || qs.length === 0) return { qs, firstOrder };
  const factor = q / Math.SQRT1_2;
  if (mode === "scaleAll") return { qs: qs.map((x) => x * factor), firstOrder };
  const last = qs.length - 1;
  return { qs: qs.map((x, i) => (i === last ? x * factor : x)), firstOrder };
}

export function effectiveQ(q: number, fit: ShapeFit): number {
  return Math.max(fit.qScale * Math.max(q, 1e-6) ** (fit.qExponent ?? 1), 1e-3);
}

export function analogSections(settings: BandSettings, fit: ShapeFit): AnalogSection[] {
  const f = settings.frequency * fit.freqScale;
  const q = effectiveQ(settings.q, fit);
  const g = settings.gainDb * (fit.gainScale ?? 1);

  switch (settings.kind) {
    case "bell": return [prototypes.bell(f, g, q)];
    case "lowShelf": return [prototypes.lowShelf(f, g, q)];
    case "highShelf": return [prototypes.highShelf(f, g, q)];
    case "tiltShelf": return [fit.tiltOrder === 1 ? prototypes.tilt1(f, g) : prototypes.tilt2(f, g, q)];
    case "notch": return [prototypes.notch(f, q)];
    case "bandPass": return [prototypes.bandPass(f, q)];
    case "lowCut":
    case "highCut": {
      const { qs, firstOrder } = cutSectionQs(settings.order, q, fit.qMode ?? "scaleAll");
      const second = settings.kind === "lowCut" ? prototypes.highPass2 : prototypes.lowPass2;
      const sections = qs.map((sq) => second(f, Math.max(sq, 1e-3)));
      if (firstOrder) sections.push(settings.kind === "lowCut" ? prototypes.highPass1(f) : prototypes.lowPass1(f));
      return sections;
    }
    case "flatTilt":
    case "unsupported": return [];
  }
}

/** Highest centre frequency for the bilinear design (tan() diverges at Nyquist). Same limit in the Faust code. */
export const BILINEAR_MAX_FRACTION = 0.49;

/**
 * Flat tilt: a chain of first-order shelves, evenly spaced in log frequency between FLAT_TILT.low and
 * FLAT_TILT.high, gives a constant slope; pairs are merged into biquads and the chain is normalised to
 * 0 dB at f0. Same construction in plugin-template/eq/src/EqEngine.h.
 */
export const FLAT_TILT = { stages: 16, low: 5, high: 40000 } as const;

export function flatTiltSections(f0: number, slopeDbPerOctave: number, sampleRate: number): DigitalSection[] {
  const { stages, low, high } = FLAT_TILT;
  const spacing = (high / low) ** (1 / stages);
  // each stage rises by `slope` over one spacing: r = spacing^(slope / 6.02)
  const r = spacing ** (slopeDbPerOctave / (20 * Math.log10(2)));
  const firstOrder: DigitalSection[] = [];
  for (let k = 0; k < stages; k++) {
    const centre = low * spacing ** (k + 0.5);
    // (1 + r·s') / (1 + s') with s' = s / pole: pole at centre·√r, zero at centre/√r
    firstOrder.push(digitize({ b: [1, r, 0], a: [1, 1, 0], f0: centre * Math.sqrt(r) }, "matched", sampleRate));
  }
  const sections: DigitalSection[] = [];
  for (let k = 0; k < stages; k += 2) {
    const x = firstOrder[k]!, y = firstOrder[k + 1]!;
    sections.push({ b0: x.b0 * y.b0, b1: x.b0 * y.b1 + x.b1 * y.b0, b2: x.b1 * y.b1, a1: x.a1 + y.a1, a2: x.a1 * y.a1 });
  }
  const atPivot = cascadeDb(sections, sampleRate, new Float64Array([Math.min(f0, sampleRate * 0.49)]))[0]!;
  const scale = 10 ** (-atPivot / 20);
  sections[0] = { ...sections[0]!, b0: sections[0]!.b0 * scale, b1: sections[0]!.b1 * scale, b2: sections[0]!.b2 * scale };
  return sections;
}

/** Elliptic brickwall cut: prototype shifted to the cutoff, bilinear (exact zeros, prewarped at the edge). */
export function brickwallSections(kind: "lowCut" | "highCut", frequency: number, brickwall: BrickwallFit, sampleRate: number): DigitalSection[] {
  const edge = Math.min(frequency * brickwall.edgeScale, BILINEAR_MAX_FRACTION * sampleRate);
  return brickwall.sections.map((s) => {
    const lowpass = { b: s.b, a: s.a, f0: edge };
    return digitize(kind === "lowCut" ? toHighpass(lowpass) : lowpass, "bilinear", sampleRate);
  });
}

export function bandSections(settings: BandSettings, fit: ShapeFit, sampleRate: number): DigitalSection[] {
  if (settings.brickwall && fit.brickwall && (settings.kind === "lowCut" || settings.kind === "highCut")) {
    return brickwallSections(settings.kind, settings.frequency * fit.freqScale, fit.brickwall, sampleRate);
  }
  if (settings.kind === "flatTilt") {
    return flatTiltSections(settings.frequency * fit.freqScale, settings.gainDb * (fit.gainScale ?? 0.2), sampleRate);
  }
  const limit = BILINEAR_MAX_FRACTION * sampleRate;
  return analogSections(settings, fit).map((s) =>
    digitize(fit.design === "bilinear" && s.f0 > limit ? { ...s, f0: limit } : s, fit.design, sampleRate),
  );
}

export { IDENTITY };
