import {
  createRandom,
  DEFAULT_PLAN,
  PlanTooLargeError,
  selectParameters,
  type CapturePlan,
  type CapturePlanner,
  type CaptureProbe,
  type FixedValue,
  type HostInfo,
  type PlannedRender,
  type PlanOptions,
} from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";

/** Roles of dynamics parameters, recognised by name. */
export type DynamicsRole =
  | "threshold" | "ratio" | "attack" | "release" | "knee" | "makeup" | "input" | "output"
  | "mix" | "reduction" | "limit" | "saturation" | "sidechain" | "lookahead";

const ROLE_PATTERNS: [DynamicsRole, RegExp][] = [
  ["reduction", /peak\s*red|gain\s*red(?!.*meter)|compress(ion)?\s*(amount)?$|^amount$/i],
  ["threshold", /thresh|thr\b/i],
  ["ratio", /\bratio\b/i],
  ["attack", /attack|\batt\b/i],
  ["release", /release|\brel\b|recovery/i],
  ["knee", /knee/i],
  ["limit", /limit|brickwall/i],
  ["saturation", /satur|drive|color|colour|warmth|tube|harmonic/i],
  ["makeup", /make\s*-?up|^gain$|output\s*gain|^level$/i],
  ["input", /input|in\s*gain|pre\s*gain/i],
  ["output", /output|out\s*gain|volume/i],
  ["mix", /mix|dry\s*\/?\s*wet|blend|parallel/i],
  ["sidechain", /side\s*-?chain|sc\s*(hp|filter)|hpf/i],
  ["lookahead", /look\s*-?ahead/i],
];

/** Parameters that are never measured (they do not change the sound or only switch the plugin off). */
export const IGNORED = /bypass|meter|display|^program$|preset|oversampl|quality/i;

export interface DynamicsMapping {
  roles: Partial<Record<DynamicsRole, number>>;
  /** parameters without a recognised role (measured anyway, mapped by the fit) */
  other: number[];
}

export class NotDynamicsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotDynamicsError";
  }
}

/** Recognises a compressor/limiter by its parameter names. */
/** Plugin categories of other effect classes: their "drive", "threshold" … controls do not make them a compressor or distortion. */
export const OTHER_CLASS_CATEGORY = /delay|echo|reverb|chorus|flanger|phaser|modulat|pitch|shift|wah|tremolo|vibrato/i;

export function detectDynamics(parameters: Parameter[], category = ""): DynamicsMapping {
  if (OTHER_CLASS_CATEGORY.test(category)) throw new NotDynamicsError(`Plugin-Kategorie „${category}“ ist kein Kompressor`);
  const roles: DynamicsMapping["roles"] = {};
  const other: number[] = [];
  for (const p of parameters) {
    if (!p.automatable || p.meta || IGNORED.test(p.name)) continue;
    const role = ROLE_PATTERNS.find(([r, pattern]) => roles[r] === undefined && pattern.test(p.name))?.[0];
    if (role) roles[role] = p.index;
    else other.push(p.index);
  }
  const level = roles.threshold !== undefined || roles.reduction !== undefined;
  const behaviour = roles.ratio !== undefined || roles.attack !== undefined || roles.release !== undefined || roles.limit !== undefined || roles.reduction !== undefined;
  if (!level || !behaviour) {
    throw new NotDynamicsError("Keine Kompressor-Parameter erkannt (Threshold/Peak Reduction und Ratio/Attack/Release)");
  }
  return { roles, other };
}

const percent = (p: Parameter, value: number) => {
  const text = p.texts?.reduce((best, t) => (Math.abs(t.value - value) < Math.abs(best.value - value) ? t : best)).text;
  return text ?? `${Math.round(value * 100)} %`;
};

/** Sweep points of continuous parameters: denser towards the ends, where control curves usually bend most. */
export const DYNAMICS_SWEEP = [0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95, 1];

/**
 * Single-parameter sweeps (training) plus random combinations (validation) of all selected parameters.
 * Shared by the dynamics and distortion planners.
 */
export function planSweeps(parameters: Parameter[], options: PlanOptions, ignored: RegExp): CapturePlan {
  const exclude = options.exclude ? new RegExp(`${options.exclude.source}|${ignored.source}`, "i") : ignored;
  const selected = selectParameters(parameters, { ...(options.include ? { include: options.include } : {}), exclude });
  const stepped = (p: Parameter) => p.discrete && p.numSteps >= 2 && p.numSteps <= 64;
  // the working point (if a probe found one) takes the place of the plugin's initial state
  const working = options.workingPoint ?? [];
  const workingValue = new Map(working.map((w) => [w.index, w.value]));
  const base = (p: Parameter) => workingValue.get(p.index) ?? p.value ?? p.default;
  const fixed = [...(options.fixed ?? []), ...working];

  const renders: Omit<PlannedRender, "id">[] = [{ kind: "default", purpose: "train", label: working.length ? "Arbeitspunkt" : "Grundeinstellung", params: [...fixed] }];
  for (const p of selected) {
    const values = stepped(p) ? Array.from({ length: p.numSteps }, (_, i) => i / (p.numSteps - 1)) : [...DYNAMICS_SWEEP];
    // a parameter moved to the working point: its initial value must be measured as well
    const initial = p.value ?? p.default;
    if (workingValue.has(p.index) && !values.some((v) => Math.abs(v - initial) < 1e-4)) values.push(initial);
    values.sort((x, y) => x - y);
    const others = fixed.filter((f) => f.index !== p.index);
    for (const value of values) {
      if (Math.abs(value - base(p)) < 1e-4) continue;
      renders.push({ kind: "sweep", sweepParameter: p.index, purpose: "train", label: `${p.name} = ${percent(p, value)}`, params: [...others, { index: p.index, value }] });
    }
  }
  const random = createRandom(options.seed);
  for (let i = 0; i < options.random; i++) {
    renders.push({
      kind: "random",
      purpose: "validate",
      label: `Zufallskombination ${i + 1}`,
      params: [...fixed.filter((f) => !selected.some((p) => p.index === f.index)), ...selected.map((p) => ({ index: p.index, value: stepped(p) ? Math.floor(random() * p.numSteps) / (p.numSteps - 1) : random() }))],
    });
  }
  if (renders.length > options.maxRenders) throw new PlanTooLargeError(renders.length, options.maxRenders);
  const width = Math.max(4, String(renders.length - 1).length);
  return { selected, renders: renders.map((r, i) => ({ id: `r${String(i).padStart(width, "0")}`, ...r })) };
}

/** Single-parameter sweeps (training) plus random combinations (validation). */
export function planDynamics(parameters: Parameter[], options: PlanOptions): CapturePlan & { mapping: DynamicsMapping } {
  const mapping = detectDynamics(parameters);
  return { ...planSweeps(parameters, options, IGNORED), mapping };
}

/**
 * How strongly a render compresses: spread of the gain (output − input level per 100 ms window) between
 * the least and the most reduced windows, in dB. A plugin that only changes the level gives 0.
 */
export function compressionDepthDb(output: Float32Array, input: Float32Array, sampleRate: number): number {
  const size = Math.round(sampleRate * 0.1);
  const gains: number[] = [];
  for (let start = 0; start + size <= Math.min(input.length, output.length); start += size) {
    let inSum = 0, outSum = 0;
    for (let i = start; i < start + size; i++) {
      inSum += input[i]! * input[i]!;
      outSum += output[i]! * output[i]!;
    }
    const inDb = 10 * Math.log10(inSum / size + 1e-20);
    if (inDb < -60) continue;
    gains.push(10 * Math.log10(outSum / size + 1e-20) - inDb);
  }
  if (gains.length < 10) return 0;
  gains.sort((x, y) => x - y);
  const at = (q: number) => gains[Math.min(gains.length - 1, Math.floor(q * gains.length))]!;
  return at(0.9) - at(0.05);
}

/** With at least this much compression in its initial state a plugin is measured as it is. */
const ENOUGH_DEPTH_DB = 3;
/** A working point should compress at least this much … */
const WANTED_DEPTH_DB = 6;
/** … and ideally about this much. */
const IDEAL_DEPTH_DB = 10;

/**
 * Probe for compressors that do not compress in their initial state (ratio 1:1, threshold at the top …):
 * ratio and threshold/reduction are tried at a few values and the mildest change that compresses clearly
 * becomes the working point of the measurement.
 */
export function dynamicsProbe(parameters: Parameter[]): CaptureProbe | undefined {
  let mapping: DynamicsMapping;
  try {
    mapping = detectDynamics(parameters);
  } catch {
    return undefined;
  }
  const snap = (p: Parameter, value: number) => (p.discrete && p.numSteps >= 2 ? Math.round(value * (p.numSteps - 1)) / (p.numSteps - 1) : value);
  const options = (index: number | undefined, values: number[]): FixedValue[][] => {
    const p = parameters.find((x) => x.index === index);
    if (!p) return [[]];
    const initial = p.value ?? p.default;
    const distinct = [...new Set(values.map((v) => snap(p, v)))].filter((v) => Math.abs(v - initial) > 0.02);
    return [[], ...distinct.map((value) => [{ index: p.index, value }])];
  };
  const ratios = options(mapping.roles.ratio, [0.5, 1]);
  const levels = options(mapping.roles.threshold ?? mapping.roles.reduction, [0.25, 0.75, 0, 1]);
  const candidates = ratios.flatMap((r) => levels.map((l) => [...r, ...l]));
  if (candidates.length < 2) return undefined;
  return {
    candidates,
    choose(outputs, input, sampleRate) {
      const depths = outputs.map((o) => compressionDepthDb(o, input, sampleRate));
      if (depths[0]! >= ENOUGH_DEPTH_DB) return 0;
      // fewest changed parameters first, values at the end of a range last, then closest to the ideal depth
      const cost = (i: number) =>
        candidates[i]!.length * 100 + candidates[i]!.filter((v) => v.value === 0 || v.value === 1).length * 30 + Math.abs(depths[i]! - IDEAL_DEPTH_DB);
      const enough = depths.map((_, i) => i).filter((i) => i > 0 && depths[i]! >= WANTED_DEPTH_DB);
      if (enough.length) return enough.reduce((best, i) => (cost(i) < cost(best) ? i : best));
      const deepest = depths.reduce((best, d, i) => (d > depths[best]! ? i : best), 0);
      return depths[deepest]! >= Math.max(ENOUGH_DEPTH_DB, depths[0]! + 2) ? deepest : 0;
    },
  };
}

export const dynamicsPlanner: CapturePlanner = {
  name: "dynamics",
  signalPreset: "dynamics",
  plan: (info: HostInfo, options: PlanOptions) => planDynamics(info.parameters, { ...DEFAULT_PLAN, ...options }),
  probe: (info: HostInfo) => dynamicsProbe(info.parameters),
};
