import type { CaptureRender, Parameter } from "@vst-cloner/profile";

export type BandRole = "enable" | "frequency" | "gain" | "q" | "shape" | "slope";

export type ShapeKind = "bell" | "lowShelf" | "highShelf" | "lowCut" | "highCut" | "notch" | "bandPass" | "tiltShelf" | "unsupported";

export const GAIN_SHAPES: ShapeKind[] = ["bell", "lowShelf", "highShelf", "tiltShelf"];
export const CUT_SHAPES: ShapeKind[] = ["lowCut", "highCut"];

/** Normalized → physical value table of a continuous parameter. */
export interface ValueTable {
  /** sorted by norm */
  points: [norm: number, value: number][];
  /** interpolate in log domain (frequencies, Q) */
  log: boolean;
  unit: string;
}

export interface BandMapping {
  band: number;
  params: Partial<Record<BandRole, number>>;
}

export interface ShapeOption {
  label: string;
  kind: ShapeKind;
}

export interface SlopeOption {
  label: string;
  /** filter order (dB/oct ÷ 6) */
  order: number;
  /** label could not be represented exactly (e.g. "Brickwall") */
  approximate: boolean;
}

export interface EqMapping {
  bands: BandMapping[];
  /** band used as template for measurements (usually band 1) */
  templateBand: number;
  tables: Record<number, ValueTable>;
  shapes?: ShapeOption[];
  slopes?: SlopeOption[];
  /** global output gain parameter */
  outputGain?: number;
  /** on/off values of the enable parameter */
  enableValues?: { on: number; off: number };
}

export class NotAnEqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAnEqError";
  }
}

// ---- value parsing ------------------------------------------------------------------------------

/** Parses display texts like "1219.8 Hz", "2.5 kHz", "+6.00 dB", "0.707", "-INF dB". */
export function parseValue(text: string): { value: number; unit: string } | undefined {
  const t = text.trim();
  if (/^-\s*inf/i.test(t)) return { value: -Infinity, unit: /db/i.test(t) ? "dB" : "" };
  const match = /([+-]?\d+(?:[.,]\d+)?)\s*(k)?\s*(hz|db|%|ms|s\b|oct)?/i.exec(t);
  if (!match) return undefined;
  let value = Number(match[1]!.replace(",", "."));
  if (match[2]) value *= 1000;
  const unit = match[3] ? (/hz/i.test(match[3]) ? "Hz" : /db/i.test(match[3]) ? "dB" : match[3]) : "";
  return { value, unit };
}

export function classifyShape(label: string): ShapeKind {
  const l = label.toLowerCase();
  if (/flat\s*tilt/.test(l)) return "unsupported";
  if (/tilt/.test(l)) return "tiltShelf";
  if (/low\s*shelf|bass\s*shelf|ls\b/.test(l)) return "lowShelf";
  if (/high\s*shelf|treble\s*shelf|hs\b/.test(l)) return "highShelf";
  if (/low\s*cut|high\s*pass|hpf|hp\b|lowcut/.test(l)) return "lowCut";
  if (/high\s*cut|low\s*pass|lpf|lp\b|highcut/.test(l)) return "highCut";
  if (/notch|band\s*(reject|stop)/.test(l)) return "notch";
  if (/band\s*pass|bandpass|bp\b/.test(l)) return "bandPass";
  if (/bell|peak|parametric|eq\b/.test(l)) return "bell";
  return "unsupported";
}

export function parseSlope(label: string): SlopeOption {
  const db = parseValue(label);
  if (db && db.value > 0 && /db/i.test(label)) {
    const order = Math.round(db.value / 6);
    return { label, order: Math.max(1, Math.min(16, order)), approximate: order * 6 !== db.value || order > 16 };
  }
  return { label, order: 16, approximate: true };
}

// ---- tables ------------------------------------------------------------------------------------

export function buildTable(param: Parameter, renders: CaptureRender[] = []): ValueTable | undefined {
  const points = new Map<number, number>();
  let unit = "";
  const add = (norm: number, text: string | undefined) => {
    if (text === undefined) return;
    const parsed = parseValue(text);
    if (!parsed || !Number.isFinite(parsed.value)) return;
    points.set(Math.round(norm * 1e6) / 1e6, parsed.value);
    unit ||= parsed.unit;
  };

  for (const t of param.texts ?? []) add(t.value, t.text);
  for (const r of renders) for (const p of r.params) if (p.index === param.index) add(p.value, p.text);

  const sorted = [...points.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length < 2) return undefined;

  const values = sorted.map(([, v]) => v);
  const positive = values.every((v) => v > 0);
  const log = positive && Math.max(...values) / Math.min(...values) > 20;
  return { points: sorted, log, unit };
}

export function tableValue(table: ValueTable, norm: number): number {
  const pts = table.points;
  if (norm <= pts[0]![0]) return pts[0]![1];
  if (norm >= pts[pts.length - 1]![0]) return pts[pts.length - 1]![1];
  let i = 1;
  while (pts[i]![0] < norm) i++;
  const [n0, v0] = pts[i - 1]!;
  const [n1, v1] = pts[i]!;
  const t = (norm - n0) / (n1 - n0);
  return table.log ? Math.exp(Math.log(v0) + t * (Math.log(v1) - Math.log(v0))) : v0 + t * (v1 - v0);
}

/** Inverse of tableValue for monotonic tables. */
export function tableNorm(table: ValueTable, value: number): number {
  const pts = table.points;
  const increasing = pts[pts.length - 1]![1] >= pts[0]![1];
  const f = (v: number) => (table.log ? Math.log(v) : v);
  const target = f(value);
  for (let i = 1; i < pts.length; i++) {
    const a = f(pts[i - 1]![1]);
    const b = f(pts[i]![1]);
    const inside = increasing ? target >= a && target <= b : target <= a && target >= b;
    if (inside) return pts[i - 1]![0] + ((target - a) / (b - a || 1)) * (pts[i]![0] - pts[i - 1]![0]);
  }
  const lowEnd = increasing ? target < f(pts[0]![1]) : target > f(pts[0]![1]);
  return lowEnd ? pts[0]![0] : pts[pts.length - 1]![0];
}

export function tableRange(table: ValueTable): [number, number] {
  const values = table.points.map(([, v]) => v);
  return [Math.min(...values), Math.max(...values)];
}

// ---- detection ---------------------------------------------------------------------------------

const EXCLUDED = /dynamic|solo|side\s*chain|speaker|stereo|placement|threshold|range|ratio|attack|release|analy[sz]er|display|midi/i;

function bandOf(name: string): { band: number; rest: string } | undefined {
  const prefix = /^band\s*(\d+)\s*[:\-]?\s*(.+)$/i.exec(name);
  if (prefix) return { band: Number(prefix[1]), rest: prefix[2]!.trim() };
  const suffix = /^(.+?)\s*(?:band\s*)?(\d+)$/i.exec(name);
  if (suffix && /freq|gain|\bq\b|shape|type|slope|enable|used|active/i.test(suffix[1]!)) return { band: Number(suffix[2]), rest: suffix[1]!.trim() };
  return undefined;
}

function roleOf(rest: string, param: Parameter): BandRole | undefined {
  if (EXCLUDED.test(rest)) return undefined;
  if (/\bslope\b/i.test(rest) && param.discrete) return "slope";
  if (/\b(shape|type|filter|curve|mode)\b/i.test(rest) && param.discrete && param.numSteps > 2) return "shape";
  if (/\bfreq(uency)?\b|\bhz\b/i.test(rest)) return "frequency";
  if (/^(q|bandwidth|bw|width|resonance|quality)$/i.test(rest)) return "q";
  if (/\bgain\b/i.test(rest) && !/scale/i.test(rest)) return "gain";
  if (/\b(used|enabled?|active|on|power)\b/i.test(rest) && (param.boolean || param.numSteps === 2)) return "enable";
  return undefined;
}

function onOffValues(param: Parameter): { on: number; off: number } {
  const texts = param.texts ?? [];
  const on = texts.find((t) => /^(used|enabled?|on|active|true)$/i.test(t.text.trim()));
  const off = texts.find((t) => /^(unused|disabled?|off|inactive|bypass(ed)?|false)$/i.test(t.text.trim()));
  return { on: on?.value ?? 1, off: off?.value ?? 0 };
}

/**
 * Detects a multi-band parametric EQ from parameter names. Throws NotAnEqError if no band structure
 * with at least frequency and gain/shape parameters is found.
 */
export function detectEq(parameters: Parameter[], renders: CaptureRender[] = []): EqMapping {
  const bands = new Map<number, BandMapping>();
  const byIndex = new Map(parameters.map((p) => [p.index, p]));

  for (const param of parameters) {
    const band = bandOf(param.name);
    if (!band) continue;
    const role = roleOf(band.rest, param);
    if (!role) continue;
    const mapping = bands.get(band.band) ?? { band: band.band, params: {} };
    if (mapping.params[role] === undefined) mapping.params[role] = param.index;
    bands.set(band.band, mapping);
  }

  const usable = [...bands.values()]
    .filter((b) => b.params.frequency !== undefined && (b.params.gain !== undefined || b.params.shape !== undefined))
    .sort((a, b) => a.band - b.band);

  if (usable.length === 0) {
    throw new NotAnEqError("no EQ bands found (expected parameters like 'Band 1 Frequency', 'Band 1 Gain')");
  }

  const template = usable.reduce((best, b) => (Object.keys(b.params).length > Object.keys(best.params).length ? b : best));
  const tables: Record<number, ValueTable> = {};
  for (const band of usable) {
    for (const role of ["frequency", "gain", "q"] as const) {
      const index = band.params[role];
      if (index === undefined) continue;
      const table = buildTable(byIndex.get(index)!, renders);
      if (table) tables[index] = table;
      else delete band.params[role];
    }
  }

  const mapping: EqMapping = { bands: usable, templateBand: template.band, tables };

  const shapeParam = template.params.shape !== undefined ? byIndex.get(template.params.shape) : undefined;
  if (shapeParam?.texts) mapping.shapes = shapeParam.texts.map((t) => ({ label: t.text, kind: classifyShape(t.text) }));

  const slopeParam = template.params.slope !== undefined ? byIndex.get(template.params.slope) : undefined;
  if (slopeParam?.texts) mapping.slopes = slopeParam.texts.map((t) => parseSlope(t.text));

  const enableParam = template.params.enable !== undefined ? byIndex.get(template.params.enable) : undefined;
  if (enableParam) mapping.enableValues = onOffValues(enableParam);

  const output = parameters.find((p) => /^(output|out)\s*(level|gain|volume)?$/i.test(p.name.trim()) && !p.discrete);
  if (output) {
    const table = buildTable(output, renders);
    if (table && /db/i.test(table.unit)) {
      mapping.outputGain = output.index;
      mapping.tables[output.index] = table;
    }
  }

  return mapping;
}

/** Index of a discrete option (0-based) from a normalized value with n options. */
export function optionIndex(norm: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(norm * (count - 1))));
}
