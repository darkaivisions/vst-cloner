import type { CaptureRender, Parameter, Profile } from "@vst-cloner/profile";
import { cascadeDb, type Design } from "../dsp/biquad.ts";
import { captureImpulseResponse, logGrid, magnitudeDb, maxDifference, rmsDifference } from "../dsp/response.ts";
import {
  bandGroups,
  bandLabel,
  buildTable,
  detectEq,
  optionIndex,
  parseValue,
  tableValue,
  type BandMapping,
  type EqMapping,
  type ShapeKind,
  type ShapeOption,
} from "./mapping.ts";
import {
  bandSections, FIT_REVISION, groupShapes, NOMINAL_FREQUENCY,
  type BandSettings, type BrickwallFit, type CutQMode, type EqModel, type FitStats, type ShapeFit, type ShapeModel, type ShapeReport,
} from "./model.ts";
import { ellipticLowpass } from "../dsp/elliptic.ts";

export interface Observation {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  /** slope option that the model can only approximate */
  approximate: boolean;
  shapeLabel: string;
  /** band group and band the render measures */
  group: number;
  band: number;
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

/** Name of the single shape of a group without shape control. */
export function groupLabel(mapping: EqMapping, group: number): string {
  const groups = bandGroups(mapping);
  const template = mapping.bands.find((b) => b.band === groups[group]!.template)!;
  return template.label ?? (groups.length === 1 ? "bell" : bandLabel(template));
}

interface BandState {
  active: boolean;
  /** option of the shape control, 0 without one */
  option: number;
  shapeLabel: string;
  approximate: boolean;
  settings: BandSettings;
}

/** What a render sets one band to. Without a shape control the kind is a placeholder until the fit has found it. */
function bandState(render: CaptureRender, band: BandMapping, mapping: EqMapping, byIndex: Map<number, Parameter>): BandState {
  const p = band.params;
  const group = bandGroups(mapping)[band.group ?? 0]!;
  const shapes: ShapeOption[] | undefined = p.shape !== undefined ? group.shapes : undefined;

  let option = 0;
  if (shapes) {
    const norm = renderValue(render, byIndex.get(p.shape!)!).norm;
    option = shapes[0]!.value !== undefined
      ? shapes.reduce((best, s, i) => (Math.abs(s.value! - norm) < Math.abs(shapes[best]!.value! - norm) ? i : best), 0)
      : optionIndex(norm, shapes.length);
  }
  const shape = shapes?.[option];
  const kind: ShapeKind = shape?.kind ?? group.hint ?? "bell";
  const cut = kind === "lowCut" || kind === "highCut";

  let order = shape?.order ?? 2;
  let approximate = false;
  let brickwall = false;
  if (p.slope !== undefined && mapping.slopes && shape?.order === undefined) {
    const slope = mapping.slopes[optionIndex(renderValue(render, byIndex.get(p.slope)!).norm, mapping.slopes.length)]!;
    order = slope.order;
    approximate = slope.approximate && cut;
    brickwall = Boolean(slope.brickwall) && cut;
  }

  let active = true;
  if (p.enable !== undefined) {
    const { on, off } = mapping.enableValues ?? { on: 1, off: 0 };
    const norm = renderValue(render, byIndex.get(p.enable)!).norm;
    active = Math.abs(norm - on) < Math.abs(norm - off);
  }

  return {
    active,
    option,
    shapeLabel: shape?.label ?? groupLabel(mapping, band.group ?? 0),
    approximate,
    settings: {
      kind,
      frequency: p.frequency !== undefined ? physical(render, byIndex.get(p.frequency), mapping, NOMINAL_FREQUENCY) : band.fixedFrequency ?? NOMINAL_FREQUENCY,
      gainDb: physical(render, p.gain !== undefined ? byIndex.get(p.gain) : undefined, mapping, 0),
      q: physical(render, p.q !== undefined ? byIndex.get(p.q) : undefined, mapping, Math.SQRT1_2),
      order,
      ...(brickwall ? { brickwall: true } : {}),
    },
  };
}

/**
 * Bands a render works on: those whose frequency, Q, shape or slope it sets, or whose gain it moves away from
 * 0 dB. The plan sets these for one band per measurement and for all bands in a combination.
 */
function exercisedBands(render: CaptureRender, mapping: EqMapping, byIndex: Map<number, Parameter>): BandMapping[] {
  const set = new Set(render.params.map((p) => p.index));
  return mapping.bands.filter((band) => {
    const p = band.params;
    if ([p.frequency, p.q, p.shape, p.slope].some((index) => index !== undefined && set.has(index))) return true;
    // in dB, not as normalised value: the original may round what it is set to
    return p.gain !== undefined && set.has(p.gain) && Math.abs(physical(render, byIndex.get(p.gain), mapping, 0)) > 0.05;
  });
}

function measuredCurve(profile: Profile, renderId: string, grid: Float64Array, baseline: Float64Array): Float64Array {
  const measured = magnitudeDb(captureImpulseResponse(profile, renderId), profile.manifest.capture.sampleRate, grid);
  for (let i = 0; i < measured.length; i++) measured[i] = measured[i]! - baseline[i]!;
  return measured;
}

/** One observation per render that measures a single band. */
export function extractObservations(profile: Profile, mapping: EqMapping, grid: Float64Array, baseline: Float64Array): Observation[] {
  const byIndex = new Map(profile.parameters.parameters.map((p) => [p.index, p]));
  const groups = bandGroups(mapping);
  const result: Observation[] = [];

  for (const render of profile.captures.renders) {
    if (render.purpose !== "train" && render.purpose !== "validate") continue;
    const exercised = exercisedBands(render, mapping, byIndex);
    // profiles from before the band groups measure the template band, whatever else they set
    const band = exercised.length === 1 ? exercised[0]! : groups.length === 1 && exercised.length === 0 ? mapping.bands.find((b) => b.band === mapping.templateBand)! : undefined;
    if (!band) continue;
    const state = bandState(render, band, mapping, byIndex);
    result.push({
      renderId: render.id,
      label: render.label ?? render.id,
      purpose: render.purpose,
      approximate: state.approximate,
      shapeLabel: state.shapeLabel,
      group: band.group ?? 0,
      band: band.band,
      settings: state.settings,
      measuredDb: measuredCurve(profile, render.id, grid, baseline),
    });
  }
  return result;
}

/** Fit and settings of an observation as the finished model sees them (the fitted kind of bands without shape control). */
export function resolveObservation(model: EqModel, o: Observation): { fit: ShapeFit | undefined; settings: BandSettings } {
  const shape = groupShapes(model, o.group).find((s) => s.label === o.shapeLabel);
  return { fit: shape?.fit, settings: shape ? { ...o.settings, kind: shape.kind } : o.settings };
}

export interface Combination {
  renderId: string;
  label: string;
  measuredDb: Float64Array;
  /** response of the model: the bands in series */
  modelDb: Float64Array;
}

/** Renders that set several bands at once, with the response the model gives for them. */
export function extractCombinations(profile: Profile, model: EqModel, grid: Float64Array): Combination[] {
  const mapping = model.mapping;
  const byIndex = new Map(profile.parameters.parameters.map((p) => [p.index, p]));
  const sampleRate = profile.manifest.capture.sampleRate;
  const baseline = new Float64Array(grid.length).fill(model.baselineDb);
  const result: Combination[] = [];
  for (const render of profile.captures.renders) {
    if (render.purpose !== "validate" || exercisedBands(render, mapping, byIndex).length < 2) continue;
    const modelDb = new Float64Array(grid.length);
    for (const band of mapping.bands) {
      const state = bandState(render, band, mapping, byIndex);
      if (!state.active) continue;
      const shape = groupShapes(model, band.group ?? 0)[band.params.shape !== undefined ? state.option : 0];
      if (!shape?.fit) continue;
      const db = cascadeDb(bandSections({ ...state.settings, kind: shape.kind }, shape.fit, sampleRate), sampleRate, grid);
      for (let i = 0; i < grid.length; i++) modelDb[i] = modelDb[i]! + db[i]!;
    }
    result.push({ renderId: render.id, label: render.label ?? render.id, measuredDb: measuredCurve(profile, render.id, grid, baseline), modelDb });
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

/** Slope in dB/octave per dB of displayed gain: least squares over the measured curves (regression on log2 f). */
function flatTiltSlope(observations: Observation[], grid: Float64Array): number {
  const x = Array.from(grid, (f) => Math.log2(f));
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  let num = 0, den = 0;
  for (const o of observations) {
    const my = o.measuredDb.reduce((a, b) => a + b, 0) / o.measuredDb.length;
    let sxy = 0;
    for (let i = 0; i < x.length; i++) sxy += (x[i]! - mx) * (o.measuredDb[i]! - my);
    const slope = sxy / sxx;
    num += slope * o.settings.gainDb;
    den += o.settings.gainDb ** 2;
  }
  const value = den > 0 ? num / den : 0.2;
  // round values are usually exact (e.g. 0.2 dB/octave per dB)
  return Math.abs(value - Math.round(value * 100) / 100) < 0.002 ? Math.round(value * 100) / 100 : value;
}

/** dB curves compared down to this floor – below it the measurement is only noise */
const BRICKWALL_FLOOR_DB = -80;

/**
 * Brickwall cut: searches order, passband ripple and stopband attenuation of an elliptic filter, then the
 * position of the passband edge relative to the displayed frequency.
 */
function fitBrickwall(observations: Observation[], fit: ShapeFit, sampleRate: number, grid: Float64Array): BrickwallFit {
  const clip = (v: number) => Math.max(v, BRICKWALL_FLOOR_DB);
  const error = (brickwall: BrickwallFit) => {
    let total = 0;
    for (const o of observations) {
      const model = cascadeDb(bandSections(o.settings, { ...fit, brickwall }, sampleRate), sampleRate, grid);
      let sum = 0;
      for (let i = 0; i < grid.length; i++) sum += (clip(model[i]!) - clip(o.measuredDb[i]!)) ** 2;
      total += Math.sqrt(sum / grid.length);
    }
    return total / observations.length;
  };
  const make = (order: number, passbandDb: number, stopbandDb: number, edgeScale: number): BrickwallFit => {
    const p = ellipticLowpass(order, passbandDb, stopbandDb);
    return { order, passbandDb, stopbandDb, edgeScale, sections: p.sections.map((s) => ({ b: s.b, a: s.a })) };
  };

  let best = { fit: make(16, 0.01, 90, 1), error: Infinity };
  for (let order = 4; order <= 16; order++) {
    for (const passbandDb of [0.001, 0.003, 0.01, 0.03, 0.1, 0.3]) {
      for (const stopbandDb of [60, 70, 80, 90, 100]) {
        const candidate = make(order, passbandDb, stopbandDb, 1);
        const e = error(candidate);
        if (e < best.error) best = { fit: candidate, error: e };
      }
    }
  }
  for (let step = 0.02; step > 0.0002; step /= 2) {
    for (const direction of [1, -1]) {
      for (;;) {
        const candidate = { ...best.fit, edgeScale: best.fit.edgeScale * (1 + direction * step) };
        const e = error(candidate);
        if (e >= best.error - 1e-9) break;
        best = { fit: candidate, error: e };
      }
    }
  }
  if (Math.abs(best.fit.edgeScale - 1) < 0.002) best.fit.edgeScale = 1;
  return best.fit;
}

interface Candidate {
  design: Design;
  qMode?: CutQMode;
  tiltOrder?: 1 | 2;
  gainScale?: number;
  /** cuts of a band without slope control */
  order?: number;
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

interface FitOptions {
  /** band without frequency control: its centre may be far from the nominal frequency */
  wideFrequency?: boolean;
  /** band without shape control: the displayed gain need not be the gain of the filter */
  fitGain?: boolean;
  /** the control is a bandwidth: a larger value means a wider filter */
  bandwidth?: boolean;
}

/**
 * Fits frequency scale, Q scale (both log2), Q exponent and – on request – the gain scale (log2) for one
 * candidate: coarse grid, then coordinate descent with shrinking steps.
 */
function fitCandidate(observations: Observation[], candidate: Candidate, sampleRate: number, grid: Float64Array, options: FitOptions = {}): { fit: ShapeFit; error: number } {
  const baseGain = candidate.gainScale ?? 1;
  const make = (x: number, y: number, z: number, g: number): ShapeFit => {
    const gainScale = baseGain * 2 ** g;
    return {
      design: candidate.design,
      freqScale: 2 ** x,
      qScale: 2 ** y,
      ...(z !== 1 ? { qExponent: z } : {}),
      ...(gainScale !== 1 ? { gainScale } : {}),
      ...(candidate.qMode ? { qMode: candidate.qMode } : {}),
      ...(candidate.tiltOrder ? { tiltOrder: candidate.tiltOrder } : {}),
      ...(candidate.order ? { order: candidate.order } : {}),
    };
  };
  const cost = (x: number, y: number, z: number, g: number) => objective(observations, make(x, y, z, g), sampleRate, grid);

  let best = { x: 0, y: 0, z: 1, g: 0, error: cost(0, 0, 1, 0) };
  const xs = options.wideFrequency ? [-3, -2.5, -2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2, 2.5, 3] : [-1, -0.5, -0.25, 0, 0.25, 0.5, 1];
  const ys = candidate.usesQ ? [-2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2] : [0];
  const zs = !candidate.usesQ ? [1] : options.bandwidth ? [0.5, 1, -0.5, -1] : [0.5, 1];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const error = cost(x, y, z, 0);
        if (error < best.error) best = { x, y, z, g: 0, error };
      }
    }
  }

  for (let step = 0.125; step > 0.0005; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      const moves: [number, number, number, number][] = [[step, 0, 0, 0], [-step, 0, 0, 0]];
      if (candidate.usesQ) moves.push([0, step, 0, 0], [0, -step, 0, 0], [0, 0, step, 0], [0, 0, -step, 0]);
      if (options.fitGain) moves.push([0, 0, 0, step], [0, 0, 0, -step]);
      for (const [dx, dy, dz, dg] of moves) {
        const z = best.z + dz;
        if (Math.abs(z) <= 0.05 || Math.abs(z) > 2 || (z < 0 && !options.bandwidth)) continue;
        const error = cost(best.x + dx, best.y + dy, z, best.g + dg);
        if (error < best.error - 1e-9) {
          best = { x: best.x + dx, y: best.y + dy, z, g: best.g + dg, error };
          improved = true;
        }
      }
    }
  }

  // snap values that are practically "round" (keeps the model readable)
  const snap = (v: number, target: number) => (Math.abs(v - target) < 0.002 * target ? target : v);
  const fit = make(best.x, best.y, best.z, best.g);
  fit.freqScale = snap(fit.freqScale, 1);
  fit.qScale = snap(snap(snap(fit.qScale, 1), Math.SQRT1_2), Math.SQRT2);
  if (fit.qExponent !== undefined) {
    fit.qExponent = snap(fit.qExponent, 0.5);
    if (Math.abs(fit.qExponent - 1) < 0.002) delete fit.qExponent;
  }
  if (fit.gainScale !== undefined && Math.abs(fit.gainScale - 1) < 0.002) delete fit.gainScale;
  return { fit, error: objective(observations, fit, sampleRate, grid) };
}

/** Where a band without frequency control works: the frequency of its strongest measured change. */
function strongestFrequency(observations: Observation[], grid: Float64Array): number {
  let best = { value: 0, frequency: NOMINAL_FREQUENCY };
  for (const o of observations) {
    for (let i = 0; i < grid.length; i++) {
      if (Math.abs(o.measuredDb[i]!) > best.value) best = { value: Math.abs(o.measuredDb[i]!), frequency: grid[i]! };
    }
  }
  return best.frequency;
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
  // a plugin that puts out NaN or nothing at all cannot be measured; a model fitted to it would be NaN as well
  if (!Number.isFinite(baselineDb)) {
    throw new Error("Das Original gibt in der Grundeinstellung kein gültiges Signal aus (NaN oder Stille) – die Messung ist unbrauchbar");
  }
  const baselineFlatnessDb = baselineCurve.reduce((m, v) => Math.max(m, Math.abs(v - baselineDb)), 0);
  // remove only the constant offset; a non-flat baseline is reported, not hidden
  const offset = new Float64Array(grid.length).fill(baselineDb);

  const observations = extractObservations(profile, mapping, grid, offset);
  if (observations.length === 0) throw new Error("Das Profil enthält keine EQ-Messungen – bitte mit der EQ-Messung (--class eq) aufnehmen");

  const groups = bandGroups(mapping);
  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  const reports: ShapeReport[] = [];
  const groupModels: { shapes: ShapeModel[] }[] = [];
  const total = groups.reduce((n, g) => n + (g.shapes?.length ?? 1), 0);
  let done = 0;

  groups.forEach((group, groupIndex) => {
    const template = mapping.bands.find((b) => b.band === group.template)!;
    const fixedShape = !group.shapes;
    const shapeOptions = group.shapes ?? [{ label: groupLabel(mapping, groupIndex), kind: (group.hint ?? "bell") as ShapeKind }];
    const prefix = groups.length > 1 && !fixedShape ? `${bandLabel(template)}: ` : "";
    const shapes: ShapeModel[] = [];
    groupModels.push({ shapes });
    const inGroup = observations.filter((o) => o.group === groupIndex);

    // a slider without a frequency in its name: start the fit where the band works
    const noFrequency = template.params.frequency === undefined;
    if (noFrequency && template.fixedFrequency === undefined) {
      template.fixedFrequency = Math.round(strongestFrequency(inGroup.filter((o) => o.purpose === "train"), grid));
      for (const o of inGroup) o.settings.frequency = template.fixedFrequency;
    }
    const qParam = template.params.q !== undefined ? byIndex.get(template.params.q) : undefined;
    const fitOptions: FitOptions = {
      ...(noFrequency ? { wideFrequency: true } : {}),
      ...(fixedShape && template.params.gain !== undefined ? { fitGain: true } : {}),
      ...(qParam && /bandwidth|\bbw\b|width/i.test(qParam.name) ? { bandwidth: true } : {}),
    };

    shapeOptions.forEach((shape) => {
      const label = prefix + shape.label;
      onProgress?.({ shape: label, index: done++, total });
      const own = inGroup.filter((o) => o.shapeLabel === shape.label);
      // slopes that cannot be represented exactly (e.g. linear-phase "Brickwall") are reported, not fitted
      const exact = own.filter((o) => !o.approximate);
      const approximate = own.filter((o) => o.approximate);
      const train = exact.filter((o) => o.purpose === "train");
      const validate = exact.filter((o) => o.purpose === "validate");
      const tag = groupIndex > 0 ? { group: groupIndex } : {};

      if (shape.kind === "unsupported") {
        shapes.push({ label: shape.label, kind: shape.kind });
        reports.push({ label, kind: shape.kind, ...tag, note: "Form noch nicht unterstützt – der Klon leitet das Signal unverändert durch" });
        return;
      }
      if (train.length === 0) {
        shapes.push({ label: shape.label, kind: shape.kind });
        reports.push({ label, kind: shape.kind, ...tag, note: "keine Messungen für diese Form" });
        return;
      }

      // without a shape control the measurements decide what the band is
      const kinds: ShapeKind[] = !fixedShape || group.hint ? [shape.kind]
        : template.params.gain !== undefined ? ["bell", "lowShelf", "highShelf"] : ["lowCut", "highCut"];
      let best: { fit: ShapeFit; error: number; kind: ShapeKind } | undefined;
      for (const kind of kinds) {
        const cut = kind === "lowCut" || kind === "highCut";
        // the order is part of the fit where no slope control sets it: named by the shape ("HP (24dB/oct)") or searched
        const orders = !cut ? [undefined] : shape.order !== undefined ? [shape.order] : template.params.slope === undefined ? [1, 2, 3, 4] : [undefined];
        const observed = train.map((o) => ({ ...o, settings: { ...o.settings, kind } }));
        const kindCandidates = kind === "flatTilt"
          ? [{ design: "matched" as Design, gainScale: flatTiltSlope(train, grid), usesQ: false }]
          : candidates(kind);
        for (const candidate of kindCandidates) {
          for (const order of orders) {
            const result = fitCandidate(observed, { ...candidate, ...(order ? { order } : {}) }, sampleRate, grid, kind === "flatTilt" ? {} : fitOptions);
            if (!best || result.error < best.error) best = { ...result, kind };
          }
        }
      }
      const kind = best!.kind;
      for (const o of own) o.settings.kind = kind;

      // "Brickwall" cuts: elliptic filter fitted to their own measurements
      const brickwallObservations = approximate.filter((o) => o.settings.brickwall);
      if (brickwallObservations.length) {
        onProgress?.({ shape: `${label} (Brickwall)`, index: done - 1, total });
        best!.fit.brickwall = fitBrickwall(brickwallObservations, best!.fit, sampleRate, grid);
      }
      const remaining = best!.fit.brickwall ? approximate.filter((o) => !o.settings.brickwall) : approximate;

      const trainStats = stats(train, best!.fit, sampleRate, grid);
      const validateStats = stats(validate, best!.fit, sampleRate, grid);
      const approximateStats = stats(remaining, best!.fit, sampleRate, grid);
      const brickwallStats = best!.fit.brickwall ? stats(brickwallObservations, best!.fit, sampleRate, grid) : undefined;
      shapes.push({ label: shape.label, kind, fit: best!.fit });
      const approximateSlopes = (kind === "lowCut" || kind === "highCut") && template.params.slope !== undefined
        ? mapping.slopes?.filter((s) => s.approximate && !(s.brickwall && best!.fit.brickwall)).map((s) => s.label)
        : undefined;
      reports.push({
        label,
        kind,
        ...tag,
        fit: best!.fit,
        ...(trainStats ? { train: trainStats } : {}),
        ...(validateStats ? { validate: validateStats } : {}),
        ...(approximateStats ? { approximate: approximateStats } : {}),
        ...(brickwallStats ? { brickwall: brickwallStats } : {}),
        ...(approximateSlopes?.length ? { note: `angenähert durch die steilste exakte Flanke: ${approximateSlopes.join(", ")}` } : {}),
      });
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

  const model: EqModel = {
    type: "parametric-eq",
    version: 1,
    fitRevision: FIT_REVISION,
    sampleRate,
    mapping,
    shapes: groupModels[0]!.shapes,
    groups: groupModels,
    baselineDb,
    report: { shapes: reports, baselineFlatnessDb, mappingErrors },
  };

  // several bands at once: do they add up like filters in series?
  const combinations = extractCombinations(profile, model, grid);
  if (combinations.length) {
    const rows = combinations.map((c) => ({ rms: rmsDifference(c.modelDb, c.measuredDb), max: maxDifference(c.modelDb, c.measuredDb) }));
    model.report.combined = {
      renders: rows.length,
      rmsDb: rows.reduce((sum, r) => sum + r.rms, 0) / rows.length,
      maxDb: rows.reduce((max, r) => Math.max(max, r.max), 0),
    };
  }
  return model;
}
