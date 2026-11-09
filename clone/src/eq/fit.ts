import type { CaptureRender, Parameter, Profile } from "@vst-cloner/profile";
import { cascadeDb, type Design } from "../dsp/biquad.ts";
import { captureImpulseResponse, logGrid, magnitudeDb, maxDifference, rmsDifference } from "../dsp/response.ts";
import {
  buildTable,
  detectEq,
  optionIndex,
  parseValue,
  tableValue,
  type EqMapping,
  type ShapeKind,
} from "./mapping.ts";
import { bandSections, type BandSettings, type CutQMode, type EqModel, type FitStats, type ShapeFit, type ShapeReport } from "./model.ts";

export interface Observation {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  /** slope option that the model can only approximate */
  approximate: boolean;
  shapeLabel: string;
  settings: BandSettings;
  measuredDb: Float64Array;
}

export interface FitProgress {
  shape: string;
  index: number;
  total: number;
}

/** Value of a parameter in a render: from the render's applied params, otherwise the base state. */
function renderValue(render: CaptureRender, param: Parameter): { norm: number; text?: string } {
  const applied = render.params.find((p) => p.index === param.index);
  if (applied) return { norm: applied.value, ...(applied.text !== undefined ? { text: applied.text } : {}) };
  const norm = param.value ?? param.default;
  const text = param.texts?.reduce((best, t) => (Math.abs(t.value - norm) < Math.abs(best.value - norm) ? t : best)).text;
  return { norm, ...(text !== undefined ? { text } : {}) };
}

function physical(render: CaptureRender, param: Parameter | undefined, mapping: EqMapping, fallback: number): number {
  if (!param) return fallback;
  const { norm, text } = renderValue(render, param);
  const parsed = text !== undefined ? parseValue(text) : undefined;
  if (parsed && Number.isFinite(parsed.value)) return parsed.value;
  const table = mapping.tables[param.index];
  return table ? tableValue(table, norm) : fallback;
}

export function extractObservations(profile: Profile, mapping: EqMapping, grid: Float64Array, baseline: Float64Array): Observation[] {
  const byIndex = new Map(profile.parameters.parameters.map((p) => [p.index, p]));
  const template = mapping.bands.find((b) => b.band === mapping.templateBand)!.params;
  const sampleRate = profile.manifest.capture.sampleRate;
  const result: Observation[] = [];

  for (const render of profile.captures.renders) {
    if (render.purpose !== "train" && render.purpose !== "validate") continue;

    let shapeLabel = "bell";
    let kind: ShapeKind = "bell";
    if (template.shape !== undefined && mapping.shapes) {
      const option = optionIndex(renderValue(render, byIndex.get(template.shape)!).norm, mapping.shapes.length);
      shapeLabel = mapping.shapes[option]!.label;
      kind = mapping.shapes[option]!.kind;
    }

    let order = 2;
    let approximate = false;
    if (template.slope !== undefined && mapping.slopes) {
      const slope = mapping.slopes[optionIndex(renderValue(render, byIndex.get(template.slope)!).norm, mapping.slopes.length)]!;
      order = slope.order;
      approximate = slope.approximate && (kind === "lowCut" || kind === "highCut");
    }

    const measured = magnitudeDb(captureImpulseResponse(profile, render.id), sampleRate, grid);
    for (let i = 0; i < measured.length; i++) measured[i] = measured[i]! - baseline[i]!;

    result.push({
      renderId: render.id,
      label: render.label ?? render.id,
      purpose: render.purpose,
      approximate,
      shapeLabel,
      settings: {
        kind,
        frequency: physical(render, byIndex.get(template.frequency!), mapping, 1000),
        gainDb: physical(render, template.gain !== undefined ? byIndex.get(template.gain) : undefined, mapping, 0),
        q: physical(render, template.q !== undefined ? byIndex.get(template.q) : undefined, mapping, Math.SQRT1_2),
        order,
      },
      measuredDb: measured,
    });
  }
  return result;
}

function stats(observations: Observation[], fit: ShapeFit, sampleRate: number, grid: Float64Array): FitStats | undefined {
  if (observations.length === 0) return undefined;
  let rms = 0;
  let max = 0;
  for (const o of observations) {
    const model = cascadeDb(bandSections(o.settings, fit, sampleRate), sampleRate, grid);
    rms += rmsDifference(model, o.measuredDb);
    max = Math.max(max, maxDifference(model, o.measuredDb));
  }
  return { renders: observations.length, rmsDb: rms / observations.length, maxDb: max };
}

function objective(observations: Observation[], fit: ShapeFit, sampleRate: number, grid: Float64Array): number {
  let total = 0;
  for (const o of observations) total += rmsDifference(cascadeDb(bandSections(o.settings, fit, sampleRate), sampleRate, grid), o.measuredDb);
  return total / observations.length;
}

interface Candidate {
  design: Design;
  qMode?: CutQMode;
  tiltOrder?: 1 | 2;
  gainScale?: number;
  usesQ: boolean;
}

function candidates(kind: ShapeKind): Candidate[] {
  const designs: Design[] = ["matched", "bilinear"];
  if (kind === "lowCut" || kind === "highCut") {
    return designs.flatMap((design) => (["scaleAll", "scaleLast", "ignore"] as CutQMode[]).map((qMode) => ({ design, qMode, usesQ: qMode !== "ignore" })));
  }
  if (kind === "tiltShelf") {
    return designs.flatMap((design) =>
      [1, 2].flatMap((gainScale) => [
        { design, tiltOrder: 1 as const, gainScale, usesQ: false },
        { design, tiltOrder: 2 as const, gainScale, usesQ: true },
      ]),
    );
  }
  return designs.map((design) => ({ design, usesQ: true }));
}

/**
 * Fits frequency scale, Q scale (both log2) and Q exponent for one candidate:
 * coarse grid, then coordinate descent with shrinking steps.
 */
function fitCandidate(observations: Observation[], candidate: Candidate, sampleRate: number, grid: Float64Array): { fit: ShapeFit; error: number } {
  const make = (x: number, y: number, z: number): ShapeFit => ({
    design: candidate.design,
    freqScale: 2 ** x,
    qScale: 2 ** y,
    ...(z !== 1 ? { qExponent: z } : {}),
    ...(candidate.gainScale && candidate.gainScale !== 1 ? { gainScale: candidate.gainScale } : {}),
    ...(candidate.qMode ? { qMode: candidate.qMode } : {}),
    ...(candidate.tiltOrder ? { tiltOrder: candidate.tiltOrder } : {}),
  });
  const cost = (x: number, y: number, z: number) => objective(observations, make(x, y, z), sampleRate, grid);

  let best = { x: 0, y: 0, z: 1, error: cost(0, 0, 1) };
  const ys = candidate.usesQ ? [-2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2] : [0];
  const zs = candidate.usesQ ? [0.5, 1] : [1];
  for (const x of [-1, -0.5, -0.25, 0, 0.25, 0.5, 1]) {
    for (const y of ys) {
      for (const z of zs) {
        const error = cost(x, y, z);
        if (error < best.error) best = { x, y, z, error };
      }
    }
  }

  for (let step = 0.125; step > 0.0005; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      const moves: [number, number, number][] = candidate.usesQ
        ? [[step, 0, 0], [-step, 0, 0], [0, step, 0], [0, -step, 0], [0, 0, step], [0, 0, -step]]
        : [[step, 0, 0], [-step, 0, 0]];
      for (const [dx, dy, dz] of moves) {
        const z = best.z + dz;
        if (z <= 0.05 || z > 2) continue;
        const error = cost(best.x + dx, best.y + dy, z);
        if (error < best.error - 1e-9) {
          best = { x: best.x + dx, y: best.y + dy, z, error };
          improved = true;
        }
      }
    }
  }

  // snap values that are practically "round" (keeps the model readable)
  const snap = (v: number, target: number) => (Math.abs(v - target) < 0.002 * target ? target : v);
  const fit = make(best.x, best.y, best.z);
  fit.freqScale = snap(fit.freqScale, 1);
  fit.qScale = snap(snap(snap(fit.qScale, 1), Math.SQRT1_2), Math.SQRT2);
  if (fit.qExponent !== undefined) {
    fit.qExponent = snap(fit.qExponent, 0.5);
    if (Math.abs(fit.qExponent - 1) < 0.002) delete fit.qExponent;
  }
  return { fit, error: objective(observations, fit, sampleRate, grid) };
}

export function fitEq(profile: Profile, onProgress?: (p: FitProgress) => void): EqModel {
  const parameters = profile.parameters.parameters;
  const renders = profile.captures.renders;
  const mapping = detectEq(parameters, renders);
  const sampleRate = profile.manifest.capture.sampleRate;
  const grid = logGrid(sampleRate);

  const reference = renders.find((r) => r.kind === "default");
  const baselineCurve = reference ? magnitudeDb(captureImpulseResponse(profile, reference.id), sampleRate, grid) : new Float64Array(grid.length);
  const baselineDb = baselineCurve.reduce((a, b) => a + b, 0) / baselineCurve.length;
  const baselineFlatnessDb = baselineCurve.reduce((m, v) => Math.max(m, Math.abs(v - baselineDb)), 0);
  // remove only the constant offset; a non-flat baseline is reported, not hidden
  const offset = new Float64Array(grid.length).fill(baselineDb);

  const observations = extractObservations(profile, mapping, grid, offset);
  if (observations.length === 0) throw new Error("profile contains no EQ measurements – capture it with '--class eq'");

  const shapeOptions = mapping.shapes ?? [{ label: "bell", kind: "bell" as ShapeKind }];
  const reports: ShapeReport[] = [];
  const shapes: EqModel["shapes"] = [];

  shapeOptions.forEach((shape, index) => {
    onProgress?.({ shape: shape.label, index, total: shapeOptions.length });
    const own = observations.filter((o) => o.shapeLabel === shape.label);
    // slopes that cannot be represented exactly (e.g. linear-phase "Brickwall") are reported, not fitted
    const exact = own.filter((o) => !o.approximate);
    const approximate = own.filter((o) => o.approximate);
    const train = exact.filter((o) => o.purpose === "train");
    const validate = exact.filter((o) => o.purpose === "validate");

    if (shape.kind === "unsupported") {
      shapes.push({ label: shape.label, kind: shape.kind });
      reports.push({ label: shape.label, kind: shape.kind, note: "shape not supported yet – the clone passes the signal unchanged" });
      return;
    }
    if (train.length === 0) {
      shapes.push({ label: shape.label, kind: shape.kind });
      reports.push({ label: shape.label, kind: shape.kind, note: "no measurements for this shape" });
      return;
    }

    let best: { fit: ShapeFit; error: number } | undefined;
    for (const candidate of candidates(shape.kind)) {
      const result = fitCandidate(train, candidate, sampleRate, grid);
      if (!best || result.error < best.error) best = result;
    }

    const trainStats = stats(train, best!.fit, sampleRate, grid);
    const validateStats = stats(validate, best!.fit, sampleRate, grid);
    const approximateStats = stats(approximate, best!.fit, sampleRate, grid);
    shapes.push({ label: shape.label, kind: shape.kind, fit: best!.fit });
    const approximateSlopes = shape.kind === "lowCut" || shape.kind === "highCut" ? mapping.slopes?.filter((s) => s.approximate).map((s) => s.label) : undefined;
    reports.push({
      label: shape.label,
      kind: shape.kind,
      fit: best!.fit,
      ...(trainStats ? { train: trainStats } : {}),
      ...(validateStats ? { validate: validateStats } : {}),
      ...(approximateStats ? { approximate: approximateStats } : {}),
      ...(approximateSlopes?.length ? { note: `approximated by the steepest exact slope: ${approximateSlopes.join(", ")}` } : {}),
    });
  });

  // how well does the 11-point display table predict the values actually set during capture?
  const mappingErrors: EqModel["report"]["mappingErrors"] = [];
  for (const [indexText, table] of Object.entries(mapping.tables)) {
    const index = Number(indexText);
    const param = parameters.find((p) => p.index === index)!;
    const textsOnly = buildTable(param);
    if (!textsOnly) continue;
    let maxRelativeError = 0;
    for (const render of renders) {
      const applied = render.params.find((p) => p.index === index);
      const parsed = applied?.text !== undefined ? parseValue(applied.text) : undefined;
      if (!applied || !parsed || !Number.isFinite(parsed.value)) continue;
      const predicted = tableValue(textsOnly, applied.value);
      const scale = Math.max(Math.abs(parsed.value), table.unit === "dB" ? 1 : 1e-6);
      maxRelativeError = Math.max(maxRelativeError, Math.abs(predicted - parsed.value) / scale);
    }
    mappingErrors.push({ parameter: index, name: param.name, maxRelativeError });
  }

  return {
    type: "parametric-eq",
    version: 1,
    sampleRate,
    mapping,
    shapes,
    baselineDb,
    report: { shapes: reports, baselineFlatnessDb, mappingErrors },
  };
}
