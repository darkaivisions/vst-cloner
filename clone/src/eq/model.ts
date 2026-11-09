import { butterworthQs, digitize, IDENTITY, prototypes, type AnalogSection, type Design, type DigitalSection } from "../dsp/biquad.ts";
import type { EqMapping, ShapeKind } from "./mapping.ts";

/** How the Q parameter acts on cut filters with several sections. */
export type CutQMode = "ignore" | "scaleAll" | "scaleLast";

export interface ShapeFit {
  design: Design;
  /** multiplies the displayed frequency */
  freqScale: number;
  /** effective Q = qScale · Q^qExponent */
  qScale: number;
  qExponent?: number;
  /** multiplies the displayed gain (e.g. 2 for tilt shelves that apply the gain to both ends) */
  gainScale?: number;
  /** cuts only */
  qMode?: CutQMode;
  /** tilt shelf only: 1 = first order, 2 = second order */
  tiltOrder?: 1 | 2;
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
    case "unsupported": return [];
  }
}

/** Highest centre frequency for the bilinear design (tan() diverges at Nyquist). Same limit in the Faust code. */
export const BILINEAR_MAX_FRACTION = 0.49;

export function bandSections(settings: BandSettings, fit: ShapeFit, sampleRate: number): DigitalSection[] {
  const limit = BILINEAR_MAX_FRACTION * sampleRate;
  return analogSections(settings, fit).map((s) =>
    digitize(fit.design === "bilinear" && s.f0 > limit ? { ...s, f0: limit } : s, fit.design, sampleRate),
  );
}

export { IDENTITY };
