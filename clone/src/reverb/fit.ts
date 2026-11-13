import { decodeWav, type Profile } from "@vst-cloner/profile";
import { tableAt, type Errors, type ParamTable } from "../dynamics/fit.ts";
import {
  MAX_PREDELAY_SECONDS,
  MAX_RT,
  MIN_RT,
  packReverb,
  processReverb,
  REVERB_ENERGY,
  REVERB_LINES,
  REVERB_OFF_DB,
  REVERB_SPLITS,
  unpackReverb,
  type ReverbParams,
  type ReverbStructure,
} from "./model.ts";

export interface ReverbInput {
  sampleRate: number;
  /** the impulse segment: start and length (samples), amplitude of the impulse */
  start: number;
  length: number;
  amplitude: number;
}

export interface ReverbObservation {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  params: { index: number; value: number }[];
  kind?: string;
  sweepParameter?: number;
  /** what the impulse response shows (see describeResponse) */
  measured: ReverbDescription;
}

export function reverbInput(profile: Profile): ReverbInput {
  const segment = profile.testSignals.segments.find((s) => s.id === "impulse" && s.kind === "impulse");
  if (!segment) throw new Error("Das Profil enthält keine Hall-Messung (Impuls-Segment fehlt)");
  return { sampleRate: profile.manifest.capture.sampleRate, start: segment.start, length: segment.length, amplitude: segment.params?.amplitude ?? 1 };
}

export function reverbResponse(output: ArrayLike<number>, input: ReverbInput): Float32Array {
  const h = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) h[i] = (output[input.start + i] ?? 0) / input.amplitude;
  return h;
}

// ---- description of an impulse response ----------------------------------------------------------

/** the dry signal ends, and the tail can begin, after this time */
const DRY_SECONDS = 0.002;
/** decay curves are sampled at this interval */
const STEP_SECONDS = 0.01;
/** tails quieter than this (energy, dB re. the unit impulse) count as absent */
const NO_TAIL_DB = -90;
/** part of the decay curve the decay time is read from (dB below its start) */
const RT_FROM_DB = -5, RT_TO_DB = -25;

/**
 * What is heard of a reverb's impulse response: the dry level, when the tail sets in, and per band (lows, mids,
 * highs) the energy of the tail, its decay time and its decay curve.
 */
export interface ReverbDescription {
  dryDb: number;
  drySign: number;
  onsetSeconds: number;
  /** tail energy per band (dB re. the unit impulse) */
  levelDb: [number, number, number];
  /** decay time (RT60, s) per band; NaN where there is no tail */
  rt: [number, number, number];
  /** energy decay curve per band (dB re. the unit impulse), every STEP_SECONDS */
  decay: Float64Array[];
}

export function describeResponse(h: ArrayLike<number>, sampleRate: number): ReverbDescription {
  const guard = Math.round(DRY_SECONDS * sampleRate);
  let dry = 0;
  for (let i = 0; i < Math.min(guard, h.length); i++) if (Math.abs(h[i]!) > Math.abs(dry)) dry = h[i]!;
  let top = 0;
  for (let i = guard; i < h.length; i++) if (Math.abs(h[i]!) > top) top = Math.abs(h[i]!);
  let onset = guard;
  while (onset < h.length && Math.abs(h[onset]!) < Math.max(top * 0.05, 1e-6)) onset++;

  const a = REVERB_SPLITS.map((f) => Math.exp((-2 * Math.PI * f) / sampleRate));
  const step = Math.round(STEP_SECONDS * sampleRate), steps = Math.floor(h.length / step);
  const energy = [new Float64Array(steps), new Float64Array(steps), new Float64Array(steps)];
  let low = 0, mid = 0;
  for (let i = guard; i < steps * step; i++) {
    const x = h[i]!;
    low += (1 - a[0]!) * (x - low);
    mid += (1 - a[1]!) * (x - mid);
    const k = Math.floor(i / step);
    energy[0]![k]! += low * low;
    energy[1]![k]! += (mid - low) * (mid - low);
    energy[2]![k]! += (x - mid) * (x - mid);
  }
  const decay = energy.map((e) => {
    // Schroeder integration: the energy still to come
    const curve = new Float64Array(steps);
    let rest = 0;
    for (let k = steps - 1; k >= 0; k--) {
      rest += e[k]!;
      curve[k] = 10 * Math.log10(rest + 1e-30);
    }
    return curve;
  });
  const levelDb = decay.map((c) => Math.max(REVERB_OFF_DB, c[0] ?? REVERB_OFF_DB)) as [number, number, number];
  const rt = decay.map((c, b) => {
    if (levelDb[b]! < NO_TAIL_DB) return NaN;
    const at = (db: number) => {
      // time (in steps, interpolated) at which the curve has fallen by `db`
      for (let k = 1; k < c.length; k++) {
        if (c[k]! <= c[0]! + db) return k - 1 + (c[k - 1]! - (c[0]! + db)) / Math.max(c[k - 1]! - c[k]!, 1e-9);
      }
      return NaN;
    };
    const from = at(RT_FROM_DB);
    let to = at(RT_TO_DB), span = RT_TO_DB - RT_FROM_DB;
    if (Number.isNaN(to)) {
      // the tail outlasts the measurement: what it lost by four fifths of the measurement must do
      const last = Math.floor(c.length * 0.8);
      span = c[last]! - c[0]! - RT_FROM_DB;
      to = last;
    }
    if (Number.isNaN(from) || !(span < -1) || !(to > from)) return MAX_RT;
    return Math.min(MAX_RT, Math.max(MIN_RT, ((to - from) * STEP_SECONDS * -60) / span));
  }) as [number, number, number];
  return {
    dryDb: Math.abs(dry) > 1e-5 ? 20 * Math.log10(Math.abs(dry)) : REVERB_OFF_DB,
    drySign: dry < 0 ? -1 : 1,
    onsetSeconds: onset < h.length ? onset / sampleRate : 0,
    levelDb,
    rt,
    decay,
  };
}

export function reverbObservations(profile: Profile, input: ReverbInput): ReverbObservation[] {
  return profile.captures.renders.map((r) => ({
    renderId: r.id,
    label: r.label ?? r.id,
    purpose: r.purpose === "validate" ? "validate" : "train",
    params: r.params.map((p) => ({ index: p.index, value: p.value })),
    kind: r.kind,
    ...(r.sweepParameter !== undefined ? { sweepParameter: r.sweepParameter } : {}),
    measured: describeResponse(reverbResponse(decodeWav(profile.files.get(r.file)!).channels[0]!, input), input.sampleRate),
  }));
}

// ---- comparison --------------------------------------------------------------------------------

/** only this much of a decay (dB below the loudest band's start) is compared: the rest is inaudible next to it */
const AUDIBLE_RANGE_DB = 50;
/** share of the comparison given to the dry level */
const SINGLE_WEIGHT = 0.05;

/**
 * Difference of two reverbs as heard: their decay curves per band (dB) – how much energy is still to come at
 * every moment, which also shows when the tail arrives – plus the dry level. The single reflections are not
 * compared: no model of this kind reproduces them.
 */
export function compareReverbs(model: ReverbDescription, measured: ReverbDescription): Errors {
  const top = Math.max(...measured.levelDb, ...model.levelDb);
  const floor = Math.max(REVERB_OFF_DB, top - AUDIBLE_RANGE_DB);
  let sum = 0, n = 0, max = 0;
  const add = (d: number, weight = 1) => {
    sum += weight * d * d;
    n += weight;
    if (Math.abs(d) > max) max = Math.abs(d);
  };
  for (let b = 0; b < 3; b++) {
    const x = model.decay[b]!, y = measured.decay[b]!;
    for (let k = 0; k < y.length; k++) {
      const u = Math.max(x[k] ?? REVERB_OFF_DB, floor), v = Math.max(y[k]!, floor);
      if (u <= floor && v <= floor) break;
      add(u - v);
    }
  }
  const single = Math.max(1, n) * SINGLE_WEIGHT;
  // the dry signal counts as far as it is audible next to the tail (and the other way round)
  const dryFloor = Math.max(REVERB_OFF_DB, Math.max(top, measured.dryDb, model.dryDb) - AUDIBLE_RANGE_DB);
  add(Math.max(model.dryDb, dryFloor) - Math.max(measured.dryDb, dryFloor), single);
  return { rmsDb: n ? Math.sqrt(sum / n) : 0, maxDb: max };
}

// ---- model for one description -------------------------------------------------------------------

/** Description of the model's response, as long as the measured ones. */
export const describeModel = (p: ReverbParams, s: ReverbStructure, input: ReverbInput): ReverbDescription =>
  describeResponse(processReverb([1], p, s, input.sampleRate, input.length), input.sampleRate);

/** onset of the bare network: its shortest line */
const networkOnset = (sampleRate: number) => Math.round((REVERB_LINES[0]! * sampleRate) / 48000) / sampleRate;

/** Time (s) at which the decay curve of the loudest band has lost `db` dB: where the bulk of the tail has arrived. */
function arrival(d: ReverbDescription, band: number, db = -3): number {
  const c = d.decay[band]!;
  for (let k = 1; k < c.length; k++) {
    if (c[k]! <= c[0]! + db) return (k - 1 + (c[k - 1]! - (c[0]! + db)) / Math.max(c[k - 1]! - c[k]!, 1e-9)) * STEP_SECONDS;
  }
  return 0;
}

/**
 * Model values for a measured description. Levels and decay times are set on the model's own response: starting
 * from the network's known energy, the band gains and decay times are corrected until the model shows what was
 * measured (the bands leak into each other, so one step is not enough). The pre-delay is set the same way, so
 * that the bulk of the tail arrives when it does in the original – many reverbs build up before they decay,
 * which the network does not. Bands without a tail keep the decay time of `fallback` (for sweep renders the
 * base model) and are switched off.
 */
export function fitReverbParams(measured: ReverbDescription, input: ReverbInput, fallback?: ReverbParams): { params: ReverbParams; structure: ReverbStructure } {
  const structure: ReverbStructure = { drySign: measured.drySign };
  const present = measured.levelDb.map((l, b) => l >= NO_TAIL_DB && !Number.isNaN(measured.rt[b]!));
  const rt = measured.rt.map((v, b) => (present[b] ? v : fallback?.rt[b] ?? 1)) as [number, number, number];
  const gainDb = measured.levelDb.map((l, b) =>
    present[b] ? l - 10 * Math.log10(REVERB_ENERGY.a[b]! * rt[b]! + REVERB_ENERGY.b[b]!) : REVERB_OFF_DB) as [number, number, number];
  const params: ReverbParams = {
    predelaySeconds: present.some(Boolean) ? Math.max(0, measured.onsetSeconds - networkOnset(input.sampleRate)) : fallback?.predelaySeconds ?? 0,
    dryDb: measured.dryDb,
    gainDb,
    rt,
  };
  if (!present.some(Boolean)) return { params, structure };
  const loudest = measured.levelDb.indexOf(Math.max(...measured.levelDb));
  for (let pass = 0; pass < 5; pass++) {
    const got = describeModel(params, structure, input);
    params.predelaySeconds = Math.min(MAX_PREDELAY_SECONDS, Math.max(0, params.predelaySeconds + arrival(measured, loudest) - arrival(got, loudest)));
    for (let b = 0; b < 3; b++) {
      if (!present[b]) continue;
      params.gainDb[b] = Math.max(REVERB_OFF_DB + 1, Math.min(40, params.gainDb[b]! + measured.levelDb[b]! - got.levelDb[b]!));
      if (!Number.isNaN(got.rt[b]!)) params.rt[b] = Math.min(MAX_RT, Math.max(MIN_RT, (params.rt[b]! * measured.rt[b]!) / got.rt[b]!));
    }
  }
  return { params, structure };
}

// ---- complete fit ------------------------------------------------------------------------------

export interface ReverbRenderReport {
  renderId: string;
  label: string;
  purpose: "train" | "validate";
  rmsDb: number;
  maxDb: number;
}

export interface ReverbModel {
  type: "reverb";
  version: 1;
  sampleRate: number;
  structure: ReverbStructure;
  base: ReverbParams;
  baseValues: { index: number; value: number }[];
  tables: ParamTable[];
  report: {
    /** false when the base render has no tail: nothing of the reverb could be measured */
    tail: boolean;
    renders: ReverbRenderReport[];
    train?: Errors;
    validate?: Errors;
  };
}

/** changes of the pre-delay below this (s) are not taken into the tables */
const MIN_PREDELAY_CHANGE = 0.015;

const summarize = (rows: ReverbRenderReport[]): Errors | undefined =>
  rows.length ? { rmsDb: rows.reduce((s, r) => s + r.rmsDb, 0) / rows.length, maxDb: Math.max(...rows.map((r) => r.maxDb)) } : undefined;

/** Model values for a combination of plugin values: base plus the change each parameter causes on its own. */
export function predictReverb(model: Pick<ReverbModel, "base" | "baseValues" | "tables">, values: Map<number, number>): ReverbParams {
  const packed = packReverb(model.base);
  const baseValues = new Map(model.baseValues.map((v) => [v.index, v.value]));
  for (const table of model.tables) {
    const reference = baseValues.get(table.index);
    const value = values.get(table.index) ?? reference;
    if (value === undefined || reference === undefined) continue;
    const at = tableAt(table, value), ref = tableAt(table, reference);
    for (let i = 0; i < packed.length; i++) packed[i]! += at[i]! - ref[i]!;
  }
  return unpackReverb(packed);
}

/**
 * Fits the reverb model: base render, then every single-parameter sweep (a table of model values per plugin
 * parameter), and finally predicts every render from the tables (validation renders – random combinations –
 * were never used for fitting).
 */
export function fitReverb(profile: Profile, onProgress?: (done: number, total: number, label: string) => void): ReverbModel {
  const input = reverbInput(profile);
  const observations = reverbObservations(profile, input);
  const parameters = profile.parameters.parameters;
  const working = new Map(((profile.manifest.capture.plan?.workingPoint as { index: number; value: number }[] | undefined) ?? []).map((w) => [w.index, w.value]));
  const baseValues = new Map(parameters.map((p) => [p.index, working.get(p.index) ?? p.value ?? p.default]));
  const base = observations.find((o) => o.kind === "default") ?? observations.find((o) => o.params.length === 0) ?? observations[0]!;
  const swept = (o: ReverbObservation) =>
    o.sweepParameter !== undefined ? o.params.find((p) => p.index === o.sweepParameter) : o.params.length === 1 ? o.params[0] : undefined;
  const train = observations.filter((o) => o.purpose === "train" && o !== base && o.kind !== "random" && swept(o) !== undefined);

  const baseFit = fitReverbParams(base.measured, input);
  const tables = new Map<number, ParamTable>();
  train.forEach((o, i) => {
    onProgress?.(i, train.length + observations.length, o.label);
    const p = swept(o)!;
    const info = parameters.find((x) => x.index === p.index)!;
    const fit = fitReverbParams(o.measured, input, baseFit.params);
    // the arrival of the tail is read to about a hundredth of a second: smaller changes of the pre-delay are
    // measurement noise, which would add up over the tables
    if (Math.abs(fit.params.predelaySeconds - baseFit.params.predelaySeconds) < MIN_PREDELAY_CHANGE) fit.params.predelaySeconds = baseFit.params.predelaySeconds;
    const table = tables.get(p.index)
      ?? { index: p.index, name: info.name, discrete: info.discrete, points: [{ value: baseValues.get(p.index)!, packed: packReverb(baseFit.params) }] };
    table.points.push({ value: p.value, packed: packReverb(fit.params) });
    tables.set(p.index, table);
  });
  for (const [index, table] of tables) {
    // points at the same plugin value carry no information and break the interpolation (see fitDynamics)
    table.points = table.points.filter((pt, i, all) => all.findIndex((other) => Math.abs(other.value - pt.value) < 1e-9) === i);
    // a control that changes (almost) nothing needs no table: tails differ a little from render to render
    const first = unpackReverb(table.points[0]!.packed);
    const moves = table.points.some((pt) => {
      const p = unpackReverb(pt.packed);
      return Math.abs(p.predelaySeconds - first.predelaySeconds) > 1e-6 || Math.abs(p.dryDb - first.dryDb) > 1
        || p.gainDb.some((g, b) => Math.abs(g - first.gainDb[b]!) > 1) || p.rt.some((t, b) => Math.abs(Math.log(t / first.rt[b]!)) > 0.1);
    });
    if (table.points.length < 2 || !moves) tables.delete(index);
    else table.points.sort((a, b) => a.value - b.value);
  }

  const model: ReverbModel = {
    type: "reverb",
    version: 1,
    sampleRate: input.sampleRate,
    structure: baseFit.structure,
    base: baseFit.params,
    baseValues: [...tables.keys()].map((index) => ({ index, value: baseValues.get(index)! })),
    tables: [...tables.values()],
    report: { tail: base.measured.levelDb.some((l) => l >= NO_TAIL_DB), renders: [] },
  };
  model.report.renders = observations.map((o, i) => {
    onProgress?.(train.length + i, train.length + observations.length, o.label);
    const predicted = predictReverb(model, new Map(o.params.map((p) => [p.index, p.value])));
    const e = compareReverbs(describeModel(predicted, model.structure, input), o.measured);
    return { renderId: o.renderId, label: o.label, purpose: o.purpose, rmsDb: e.rmsDb, maxDb: e.maxDb };
  });
  const trainStats = summarize(model.report.renders.filter((r) => r.purpose === "train"));
  const validateStats = summarize(model.report.renders.filter((r) => r.purpose === "validate"));
  if (trainStats) model.report.train = trainStats;
  if (validateStats) model.report.validate = validateStats;
  return model;
}
