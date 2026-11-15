import type { CaptureRender, Parameter } from "@vst-cloner/profile";

export type BandRole = "enable" | "frequency" | "gain" | "q" | "shape" | "slope";

/** flatTilt: constant slope (dB/octave) over the whole audio range, 0 dB at the band frequency */
export type ShapeKind = "bell" | "lowShelf" | "highShelf" | "lowCut" | "highCut" | "notch" | "bandPass" | "tiltShelf" | "flatTilt" | "unsupported";

export const GAIN_SHAPES: ShapeKind[] = ["bell", "lowShelf", "highShelf", "tiltShelf", "flatTilt"];
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
  /** index into EqMapping.groups (missing = 0): the bands of a group share shapes and fit */
  group?: number;
  /** name of a band without a number ("Lowshelf", "H", "32 Hz") */
  label?: string;
  /** centre frequency of a band without a frequency control: from its name, otherwise found by the fit */
  fixedFrequency?: number;
}

export interface ShapeOption {
  label: string;
  kind: ShapeKind;
  /** filter order named by the label ("HP (24dB/oct)") */
  order?: number;
  /** normalised value that selects the option, for shape controls the original reports as continuous */
  value?: number;
}

/** Bands with the same controls and shapes: one of them (the template) is measured, the fit holds for all. */
export interface BandGroup {
  template: number;
  shapes?: ShapeOption[];
  /** no shape control, but the name says what the band is ("Highpass", "Lowshelf") */
  hint?: ShapeKind;
}

export interface SlopeOption {
  label: string;
  /** filter order (dB/oct ÷ 6) */
  order: number;
  /** label could not be represented exactly (e.g. "Brickwall") */
  approximate: boolean;
  /** "Brickwall": extremely steep cut, modelled as an elliptic filter fitted to the measurements */
  brickwall?: boolean;
}

export interface EqMapping {
  bands: BandMapping[];
  /** template band of the first group */
  templateBand: number;
  /** missing in models fitted before revision 3: one group with `templateBand` and `shapes` */
  groups?: BandGroup[];
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
  // with exponent: some plugins show zero as "1.90735e-06"
  const match = /([+-]?\d+(?:[.,]\d+)?(?:e[+-]?\d+)?)\s*(k)?\s*(hz|db|%|ms|s\b|oct)?/i.exec(t);
  if (!match) return undefined;
  let value = Number(match[1]!.replace(",", "."));
  if (match[2]) value *= 1000;
  const unit = match[3] ? (/hz/i.test(match[3]) ? "Hz" : /db/i.test(match[3]) ? "dB" : match[3]) : "";
  return { value, unit };
}

export function classifyShape(label: string): ShapeKind {
  // "Low-shelf", "High_Pass": separators count as spaces
  const l = label.toLowerCase().replace(/[-_]+/g, " ");
  if (/flat\s*tilt/.test(l)) return "flatTilt";
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
  return { label, order: 16, approximate: true, ...(/brick\s*wall/i.test(label) ? { brickwall: true } : {}) };
}

/** Decimal places the original shows in its value texts (most common count), undefined if not numeric. */
export function textDecimals(param: Parameter): number | undefined {
  const counts = new Map<number, number>();
  for (const t of param.texts ?? []) {
    const match = /[+-]?\d+(?:[.,](\d+))?/.exec(t.text);
    if (!match) continue;
    const d = match[1]?.length ?? 0;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return counts.size ? [...counts].sort((a, b) => b[1] - a[1])[0]![0] : undefined;
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
/** panners and beam formers have filters per band too, but their bands are directions */
const SPATIAL = /azimuth|elevation/i;
const ROLE_WORDS = /freq|gain|\bq\b|shape|type|slope|enable|used|active|boost|bandwidth|\bbw\b|resonance|section/i;
const NAMED_BAND = /^(low\s*shelf|high\s*shelf|high\s*pass|low\s*pass|low\s*cut|high\s*cut|hpf|lpf)\b\s*(.*)$/i;
const LETTER_BAND = /^(frequency|freq|gain|boost\s*\/\s*cut|bandwidth|q)\s+(l|h|lf|hf|lo|hi|low|high)$/i;
/** sliders of a graphic EQ: "32Hz", "Gain 2.5 kHz", "G7" */
const FREQUENCY_BAND = /^(?:gain\s+)?(\d+(?:[.,]\d+)?)\s*(k)?hz$/i;
const SLIDER_BAND = /^g(\d+)$/i;

interface BandName {
  /** bands with the same key belong together */
  key: string;
  number?: number;
  rest: string;
  label?: string;
  frequency?: number;
  hint?: ShapeKind;
  /** slider of a graphic EQ: a gain and nothing else */
  slider?: boolean;
}

function bandOf(name: string): BandName | undefined {
  const text = name.trim();
  const prefix = /^band\s*(\d+)\s*[:\-]?\s*(.+)$/i.exec(text);
  if (prefix) return { key: `n${prefix[1]}`, number: Number(prefix[1]), rest: prefix[2]!.trim() };
  const suffix = /^(.+?)\s*(?:band\s*)?(\d+)$/i.exec(text);
  if (suffix && ROLE_WORDS.test(suffix[1]!) && !SLIDER_BAND.test(text)) return { key: `n${suffix[2]}`, number: Number(suffix[2]), rest: suffix[1]!.trim() };
  const named = NAMED_BAND.exec(text);
  if (named) {
    const label = named[1]!;
    const hint = classifyShape(label);
    return { key: `p${label.toLowerCase().replace(/\s+/g, "")}`, rest: named[2]!.trim(), label, ...(hint !== "unsupported" ? { hint } : {}) };
  }
  const letter = LETTER_BAND.exec(text);
  if (letter) return { key: `l${letter[2]!.toLowerCase()}`, rest: letter[1]!, label: letter[2]! };
  const frequency = FREQUENCY_BAND.exec(text);
  if (frequency) {
    const hz = Number(frequency[1]!.replace(",", ".")) * (frequency[2] ? 1000 : 1);
    return { key: `f${hz}`, rest: "gain", label: `${frequency[1]} ${frequency[2] ? "kHz" : "Hz"}`, frequency: hz, slider: true };
  }
  const slider = SLIDER_BAND.exec(text);
  if (slider) return { key: `g${slider[1]}`, rest: "gain", label: text, slider: true };
  return undefined;
}

/** a switch with two positions, also one the original reports as a continuous control with two value texts */
function isSwitch(param: Parameter): boolean {
  return param.boolean || param.numSteps === 2 || parameterSteps(param)?.labels.length === 2;
}

function roleOf(text: string, param: Parameter): BandRole | undefined {
  // "Filter Frequency", "Filter Q": the word says nothing about the role
  const rest = text.replace(/^filter\s+(?=\S)/i, "");
  if (EXCLUDED.test(rest)) return undefined;
  if (rest === "") return isSwitch(param) ? "enable" : undefined;
  if (/\bslope\b/i.test(rest) && param.discrete) return "slope";
  if (/\b(shape|type|filter|curve|mode)\b/i.test(rest)) {
    const steps = param.discrete ? param.numSteps : parameterSteps(param)?.labels.length ?? 0;
    if (steps > 2) return "shape";
  }
  if (/\bfreq(uency)?\b|\bhz\b/i.test(rest)) return "frequency";
  if (/^(q|bandwidth|bw|width|resonance|quality)$/i.test(rest)) return "q";
  if ((/\bgain\b/i.test(rest) && !/scale/i.test(rest)) || /^boost\s*\/\s*cut$/i.test(rest)) return "gain";
  if (/\b(used|enabled?|enablement|active|on|power|section)\b/i.test(rest) && isSwitch(param)) return "enable";
  return undefined;
}

function onOffValues(param: Parameter): { on: number; off: number } {
  const texts = param.texts ?? [];
  const isOn = (t: { text: string }) => /^(used|enabled?|on|active|true)$/i.test(t.text.trim());
  const isOff = (t: { text: string }) => /^(unused|disabled?|off|inactive|bypass(ed)?|false)$/i.test(t.text.trim());
  // the outermost value of each plateau: safe for originals that report the switch as continuous
  const on = texts.filter(isOn).sort((a, b) => b.value - a.value)[0];
  const off = texts.filter(isOff).sort((a, b) => a.value - b.value)[0];
  return { on: on?.value ?? 1, off: off?.value ?? 0 };
}

/** Options of a shape control: declared steps, or the plateaus of its value texts. */
function shapeOptions(param: Parameter): ShapeOption[] | undefined {
  const option = (label: string): ShapeOption => {
    const kind = classifyShape(label);
    const slope = /(\d+)\s*db\s*\/\s*oct/i.exec(label);
    return { label, kind, ...(slope && (kind === "lowCut" || kind === "highCut") ? { order: Math.max(1, Math.round(Number(slope[1]) / 6)) } : {}) };
  };
  if (param.discrete) return param.texts?.map((t) => option(t.text));
  const steps = parameterSteps(param);
  return steps?.labels.map((label, i) => ({ ...option(label), value: steps.values[i]! }));
}

export function bandGroups(mapping: EqMapping): BandGroup[] {
  return mapping.groups ?? [{ template: mapping.templateBand, ...(mapping.shapes ? { shapes: mapping.shapes } : {}) }];
}

export function bandLabel(band: BandMapping): string {
  return band.label ?? `Band ${band.band}`;
}

/**
 * Detects an EQ from parameter names: numbered bands ("Band 1 Frequency", "Gain 3"), named bands with a fixed
 * shape ("Lowshelf Gain", "Highpass Frequency", "Frequency L") and the sliders of a graphic EQ ("32Hz", "G7").
 * Throws NotAnEqError if no band with a frequency control or at least three sliders are found.
 */
export function detectEq(parameters: Parameter[], renders: CaptureRender[] = []): EqMapping {
  if (parameters.some((p) => SPATIAL.test(p.name))) {
    throw new NotAnEqError("Räumlicher Effekt (Azimut/Elevation): die Bänder sind Richtungen, kein EQ");
  }
  const found = new Map<string, { name: BandName; mapping: BandMapping }>();
  const byIndex = new Map(parameters.map((p) => [p.index, p]));

  for (const param of parameters) {
    const name = bandOf(param.name);
    if (!name) continue;
    const role = name.slider ? (param.discrete ? undefined : "gain") : roleOf(name.rest, param);
    if (!role) continue;
    const entry = found.get(name.key) ?? { name, mapping: { band: name.number ?? 0, params: {} } };
    if (entry.mapping.params[role] === undefined) entry.mapping.params[role] = param.index;
    found.set(name.key, entry);
  }

  const tables: Record<number, ValueTable> = {};
  for (const { mapping } of found.values()) {
    for (const role of ["frequency", "gain", "q"] as const) {
      const index = mapping.params[role];
      if (index === undefined) continue;
      const table = buildTable(byIndex.get(index)!, renders);
      if (table) tables[index] = table;
      else delete mapping.params[role];
    }
  }

  /** a gain in dB can cut and boost; a level from 0 to 1 is something else */
  const cutsAndBoosts = (index: number | undefined) => {
    if (index === undefined) return false;
    const [lo, hi] = tableRange(tables[index]!);
    return lo < 0 && hi > 0;
  };
  const parametric = [...found.values()].filter(({ name, mapping: b }) =>
    !name.slider && b.params.frequency !== undefined && (b.params.gain !== undefined || b.params.shape !== undefined || name.hint !== undefined));
  const sliders = [...found.values()].filter(({ name, mapping: b }) => name.slider && cutsAndBoosts(b.params.gain));
  const graphic = sliders.length >= 3;
  // a low and a high shelf alone are the tone filters of some other effect; an EQ has numbered bands or sliders as well
  const numbered = parametric.some(({ name }) => name.number !== undefined);
  const entries = numbered || graphic ? [...parametric, ...(graphic ? sliders : [])] : [];

  if (entries.length === 0) {
    throw new NotAnEqError("Keine EQ-Bänder gefunden (erwartet werden Parameter wie „Band 1 Frequency“, „Band 1 Gain“ oder die Regler eines grafischen EQs)");
  }

  // bands without a number get one after the numbered ones, in the order of their parameters
  let next = Math.max(100, ...entries.map((e) => e.name.number ?? 0)) + 1;
  for (const { name, mapping: b } of entries) {
    if (name.number === undefined) {
      b.band = next++;
      if (name.label) b.label = name.label;
      if (name.frequency !== undefined) b.fixedFrequency = name.frequency;
    }
  }
  entries.sort((a, b) => a.mapping.band - b.mapping.band);

  // numbered bands with the same controls and shapes form a group; every other band stands alone
  const groups: BandGroup[] = [];
  const groupBySignature = new Map<string, number>();
  for (const { name, mapping: b } of entries) {
    const shapeParam = b.params.shape !== undefined ? byIndex.get(b.params.shape) : undefined;
    const shapes = shapeParam ? shapeOptions(shapeParam) : undefined;
    if (!shapes) delete b.params.shape;
    const signature = name.number === undefined
      ? name.key
      : `${Object.keys(b.params).sort().join(",")}|${shapes?.map((s) => s.label).join("/") ?? ""}`;
    let group = groupBySignature.get(signature);
    if (group === undefined) {
      group = groups.length;
      groups.push({ template: b.band, ...(shapes ? { shapes } : {}), ...(name.hint ? { hint: name.hint } : {}) });
      groupBySignature.set(signature, group);
    }
    if (group > 0) b.group = group;
  }

  const usable = entries.map((e) => e.mapping);
  const first = groups[0]!;
  const template = usable.find((b) => b.band === first.template)!;
  const mapping: EqMapping = { bands: usable, templateBand: template.band, groups, tables: {} };
  for (const band of usable) {
    for (const role of ["frequency", "gain", "q"] as const) {
      const index = band.params[role];
      if (index !== undefined) mapping.tables[index] = tables[index]!;
    }
  }
  if (first.shapes) mapping.shapes = first.shapes;

  const slopeParam = template.params.slope !== undefined ? byIndex.get(template.params.slope) : undefined;
  if (slopeParam?.texts) mapping.slopes = slopeParam.texts.map((t) => parseSlope(t.text));

  const enableBand = usable.find((b) => b.params.enable !== undefined);
  if (enableBand) mapping.enableValues = onOffValues(byIndex.get(enableBand.params.enable!)!);

  const output = parameters.find((p) => /^(output|out|master)\s*(level|gain|volume)?$/i.test(p.name.trim()) && !p.discrete);
  if (output) {
    const table = buildTable(output, renders);
    // without a unit: a level that cuts and boosts is one in dB
    if (table && (/db/i.test(table.unit) || (table.unit === "" && tableRange(table)[0] < 0 && tableRange(table)[1] > 0))) {
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

/** a value text that is a plain number with an optional unit (continuous controls) */
const NUMERIC_TEXT = /^\s*[+-]?(\d+([.,]\d+)?|inf)\s*(db|%|ms|s|hz|khz|°|:\s*1|x)?\s*$/i;

export interface ParameterSteps {
  /** normalised value per step (middle of its plateau) */
  values: number[];
  labels: string[];
  /** normalised range [from, to] of each step */
  bounds: [number, number][];
}

/**
 * Steps of a parameter: declared steps, or – for plugins that report switches and menus as continuous –
 * the plateaus of its value texts (OFF/ON, Full/Masked/Unmasked …). Values are the middle of each plateau.
 */
export function parameterSteps(p: Parameter): ParameterSteps | undefined {
  if (p.discrete && p.numSteps >= 2 && p.numSteps < 1000) {
    const values = Array.from({ length: p.numSteps }, (_, i) => i / (p.numSteps - 1));
    const labels = values.map((v) => p.texts?.reduce((best, t) => (Math.abs(t.value - v) < Math.abs(best.value - v) ? t : best)).text ?? String(v));
    const half = 0.5 / (p.numSteps - 1);
    return { values, labels, bounds: values.map((v) => [Math.max(0, v - half), Math.min(1, v + half)]) };
  }
  const texts = [...(p.texts ?? [])].sort((a, b) => a.value - b.value);
  if (texts.length < 3) return undefined;
  const distinct = [...new Set(texts.map((t) => t.text))];
  const repeats = distinct.length < texts.length;
  if (!repeats || distinct.length > 12 || distinct.every((t) => NUMERIC_TEXT.test(t))) return undefined;
  const plateaus: { label: string; from: number; to: number }[] = [];
  for (const t of texts) {
    const last = plateaus[plateaus.length - 1];
    if (last && last.label === t.text) last.to = t.value;
    else plateaus.push({ label: t.text, from: t.value, to: t.value });
  }
  return { values: plateaus.map((q) => (q.from + q.to) / 2), labels: plateaus.map((q) => q.label), bounds: plateaus.map((q) => [q.from, q.to]) };
}

/** Step that a normalised value of the original selects: the plateau containing it, else the nearest one. */
export function stepIndex(steps: ParameterSteps, value: number): number {
  let best = 0, bestDistance = Infinity;
  steps.bounds.forEach(([from, to], i) => {
    const distance = value < from ? from - value : value > to ? value - to : 0;
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  });
  return best;
}
