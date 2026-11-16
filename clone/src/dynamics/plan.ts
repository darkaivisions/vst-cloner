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
  type MeasuredSteps,
  type PlannedRender,
  type PlanOptions,
} from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { parameterSteps } from "../eq/mapping.ts";

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
export const IGNORED = /bypass|meter|display|\bprogram\b|preset|oversampl|quality/i;

export interface DynamicsMapping {
  roles: Partial<Record<DynamicsRole, number>>;
  /** parameters without a recognised role (measured anyway, mapped by the fit) */
  other: number[];
}

export class NotDynamicsError extends Error {
  /**
   * The plugin is a known processor of another kind (gate, expander, dynamic EQ, multiband compressor …):
   * no other effect class should be tried for it either.
   */
  readonly otherProcessor: boolean;

  constructor(message: string, otherProcessor = false) {
    super(message);
    this.otherProcessor = otherProcessor;
    this.name = "NotDynamicsError";
  }
}

/** Plugin categories of other effect classes: their "drive", "threshold" … controls do not make them a compressor or distortion. */
export const OTHER_CLASS_CATEGORY = /delay|echo|reverb|chorus|flanger|phaser|modulat|pitch|shift|wah|tremolo|vibrato/i;

/** Dynamics processors the compressor model cannot represent: they have a threshold and timing controls too. */
const NOT_COMPRESSOR_CATEGORY = /envelope|\beq\b|equali[sz]er/i;
const NOT_COMPRESSOR_NAME = /dynamic\s*eq|envelope/i;
const GATE_PARAMETER = /gate/i;

/**
 * Reason why a plugin is a multiband or multi-stage compressor (one threshold/ratio per band), which the
 * single-band model cannot represent; undefined for an ordinary compressor.
 */
export function multibandReason(parameters: Parameter[]): string | undefined {
  const active = parameters.filter((p) => p.automatable && !p.meta && !IGNORED.test(p.name));
  const count = (pattern: RegExp) => active.filter((p) => pattern.test(p.name)).length;
  const stages = Math.max(count(/thresh|thr\b/i), count(/\bratio|ratio\s*\d*$/i));
  const crossover = count(/cross\s*-?over/i) > 0;
  if (stages >= 3 || (crossover && stages >= 2)) {
    return `Multiband- oder Mehrstufen-Kompressor (${stages} Stufen${crossover ? ", Crossover" : ""}) – mit dem Einband-Modell nicht abbildbar`;
  }
  return undefined;
}

/**
 * Recognises a compressor, limiter, gate or expander by its parameter names (and rules out other processors by
 * category and name). Which curve it has is decided by the fit, on the measurement.
 */
export function detectDynamics(parameters: Parameter[], category = "", name = ""): DynamicsMapping {
  if (OTHER_CLASS_CATEGORY.test(category)) throw new NotDynamicsError(`Plugin-Kategorie „${category}“ ist kein Kompressor`);
  if (NOT_COMPRESSOR_CATEGORY.test(category)) throw new NotDynamicsError(`Plugin-Kategorie „${category}“ ist kein Kompressor`, true);
  if (NOT_COMPRESSOR_NAME.test(name)) throw new NotDynamicsError(`„${name}“ ist ein dynamischer EQ oder Hüllkurvenfolger, kein Kompressor`, true);
  const multiband = multibandReason(parameters);
  if (multiband) throw new NotDynamicsError(multiband, true);
  const roles: DynamicsMapping["roles"] = {};
  const other: number[] = [];
  for (const p of parameters) {
    if (!p.automatable || p.meta || IGNORED.test(p.name)) continue;
    // "gateThreshold", "gate release": the controls of a noise gate built into another effect are not a
    // compressor's (a gate plugin calls them just "Threshold", "Release")
    if (GATE_PARAMETER.test(p.name)) {
      other.push(p.index);
      continue;
    }
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
 * Discrete parameters with up to this many positions count as switches: they may change what the other controls
 * do (another tempo source, an inverted gate …), which tables per control cannot express. Their other positions
 * get sweeps of their own, from which the fit can build a model per position.
 */
export const SWITCH_STATES = 4;
/** random combinations measured in every other position of a switch (see planSweeps) */
const SWITCH_CHECKS = 6;

/**
 * The switch position a sweep render was measured in, if it is not the base position: the one parameter besides
 * the swept one that differs from the base values.
 */
export function renderCondition(
  params: { index: number; value: number }[],
  sweptIndex: number | undefined,
  baseValues: Map<number, number>,
): { index: number; value: number } | undefined {
  return params.find((p) => p.index !== sweptIndex && Math.abs(p.value - (baseValues.get(p.index) ?? p.value)) > 1e-4);
}

/**
 * A parameter whose every step is measured: its table holds one point per position. One with more steps
 * (0 … 127) is swept like a continuous control, and its table must be interpolated like one.
 */
export const steppedParameter = (p: Pick<Parameter, "discrete" | "numSteps">) => p.discrete && p.numSteps >= 2 && p.numSteps <= 64;

/**
 * Single-parameter sweeps (training) plus random combinations (validation) of all selected parameters.
 * Shared by the dynamics and distortion planners.
 */
/** Positions of a parameter that moves in steps: the value in the middle of each and the range it covers. */
export interface Positions {
  values: number[];
  bounds: [number, number][];
}

/**
 * Positions of a stepped parameter: declared steps, or – for controls the plugin reports as continuous – the
 * steps a survey measured, or the plateaus of its value texts (see parameterSteps).
 */
export function parameterPositions(p: Parameter, measured: MeasuredSteps[] = []): Positions | undefined {
  if (steppedParameter(p)) {
    const values = Array.from({ length: p.numSteps }, (_, i) => i / (p.numSteps - 1));
    const half = 0.5 / (p.numSteps - 1);
    return { values, bounds: values.map((v) => [Math.max(0, v - half), Math.min(1, v + half)]) };
  }
  if (p.discrete) return undefined;
  const found = measured.find((m) => m.index === p.index);
  if (found) return { values: found.values, bounds: found.bounds };
  const steps = parameterSteps(p);
  return steps ? { values: steps.values, bounds: steps.bounds } : undefined;
}

/** Position a normalised value falls into: the one whose range contains it, else the nearest. */
export function positionOf(positions: Positions, value: number): number {
  let best = 0, distance = Infinity;
  positions.bounds.forEach(([from, to], i) => {
    const d = value < from ? from - value : value > to ? value - to : 0;
    if (d < distance) { best = i; distance = d; }
  });
  return best;
}

export function planSweeps(parameters: Parameter[], options: PlanOptions, ignored: RegExp, extra: { switches?: boolean; combinations?: number; plateaus?: boolean } = {}): CapturePlan {
  const exclude = options.exclude ? new RegExp(`${options.exclude.source}|${ignored.source}`, "i") : ignored;
  const selected = selectParameters(parameters, { ...(options.include ? { include: options.include } : {}), exclude });
  // the working point (if a probe found one) takes the place of the plugin's initial state
  const working = options.workingPoint ?? [];
  const workingValue = new Map(working.map((w) => [w.index, w.value]));
  const base = (p: Parameter) => workingValue.get(p.index) ?? p.value ?? p.default;
  // with `plateaus`, controls that move in steps without saying so count as stepped too
  const positions = (p: Parameter): Positions | undefined => (extra.plateaus ? parameterPositions(p, options.steps) : steppedParameter(p) ? parameterPositions(p) : undefined);
  const stepped = (p: Parameter) => positions(p) !== undefined;
  const numPositions = (p: Parameter) => positions(p)?.values.length ?? 0;
  const randomPosition = (p: Parameter, random: () => number) => positions(p)!.values[Math.floor(random() * numPositions(p))]!;
  /** a value in the base position of a stepped parameter (the base value itself is not one of its position values) */
  const atBase = (p: Parameter, value: number) => {
    const all = positions(p);
    return all ? positionOf(all, value) === positionOf(all, base(p)) : Math.abs(value - base(p)) < 1e-4;
  };
  const fixed = [...(options.fixed ?? []), ...working];

  const renders: Omit<PlannedRender, "id">[] = [{ kind: "default", purpose: "train", label: working.length ? "Arbeitspunkt" : "Grundeinstellung", params: [...fixed] }];
  for (const p of selected) {
    const values = positions(p)?.values.slice() ?? [...DYNAMICS_SWEEP];
    // a parameter moved to the working point: its initial value must be measured as well
    const initial = p.value ?? p.default;
    if (workingValue.has(p.index) && !stepped(p) && !values.some((v) => Math.abs(v - initial) < 1e-4)) values.push(initial);
    values.sort((x, y) => x - y);
    const others = fixed.filter((f) => f.index !== p.index);
    for (const value of values) {
      if (atBase(p, value)) continue;
      renders.push({ kind: "sweep", sweepParameter: p.index, purpose: "train", label: `${p.name} = ${percent(p, value)}`, params: [...others, { index: p.index, value }] });
    }
  }
  // Switches (see SWITCH_STATES): the sweeps of all other parameters again in each of their other positions.
  // One switch after the other, as long as the plan stays within its limit.
  if (extra.switches) {
    // switches with few positions first: they cost the least and are the commonest (on/off)
    // A selector with more positions gets this treatment for its first one only, where it is not the base
    // position: there it is usually "off" and hands over to another control (free time instead of note values).
    const switchPositions = (s: Parameter) => (numPositions(s) <= SWITCH_STATES ? positions(s)!.values : extra.plateaus ? positions(s)!.values.slice(0, 1) : []);
    for (const s of selected.filter((p) => stepped(p) && switchPositions(p).length > 0).sort((a, b) => numPositions(a) - numPositions(b))) {
      const block: Omit<PlannedRender, "id">[] = [];
      for (const position of switchPositions(s)) {
        if (atBase(s, position)) continue;
        for (const p of selected) {
          if (p === s) continue;
          // the same points as in the base position: a model for this position must be as exact as the main one
          const values = positions(p)?.values ?? DYNAMICS_SWEEP;
          const others = fixed.filter((f) => f.index !== p.index && f.index !== s.index);
          for (const value of values) {
            if (atBase(p, value)) continue;
            block.push({
              kind: "sweep", sweepParameter: p.index, purpose: "train",
              label: `${s.name} = ${percent(s, position)}: ${p.name} = ${percent(p, value)}`,
              params: [...others, { index: s.index, value: position }, { index: p.index, value }],
            });
          }
        }
      }
      // random combinations within each position: the fit decides on them whether the position needs a model of
      // its own (they are not used for the tables, and not for the validation either)
      const checks = createRandom(options.seed + 1000 + s.index);
      for (const position of switchPositions(s)) {
        if (atBase(s, position)) continue;
        for (let i = 0; i < SWITCH_CHECKS; i++) {
          block.push({
            kind: "random", purpose: "train",
            label: `${s.name} = ${percent(s, position)}: Kombination ${i + 1}`,
            params: [
              ...fixed.filter((f) => !selected.some((p) => p.index === f.index)),
              ...selected.map((p) => ({ index: p.index, value: p === s ? position : stepped(p) ? randomPosition(p, checks) : checks() })),
            ],
          });
        }
      }
      if (renders.length + block.length + options.random <= options.maxRenders) renders.push(...block);
    }
  }
  // Combinations for the fit (not for validation): from them it learns how controls work together. Switches
  // stay in their base position – what they change is the business of the models per position.
  if (extra.combinations && renders.length + extra.combinations + options.random <= options.maxRenders) {
    const mixes = createRandom(options.seed + 500);
    const isSwitch = (p: Parameter) => stepped(p) && numPositions(p) <= SWITCH_STATES;
    for (let i = 0; i < extra.combinations; i++) {
      renders.push({
        kind: "random", purpose: "train", label: `Kombination ${i + 1}`,
        params: [
          ...fixed.filter((f) => !selected.some((p) => p.index === f.index)),
          ...selected.map((p) => ({ index: p.index, value: isSwitch(p) ? base(p) : stepped(p) ? randomPosition(p, mixes) : mixes() })),
        ],
      });
    }
  }
  const random = createRandom(options.seed);
  for (let i = 0; i < options.random; i++) {
    renders.push({
      kind: "random",
      purpose: "validate",
      label: `Zufallskombination ${i + 1}`,
      params: [...fixed.filter((f) => !selected.some((p) => p.index === f.index)), ...selected.map((p) => ({ index: p.index, value: stepped(p) ? randomPosition(p, random) : random() }))],
    });
  }
  if (renders.length > options.maxRenders) throw new PlanTooLargeError(renders.length, options.maxRenders);
  const width = Math.max(4, String(renders.length - 1).length);
  return { selected, renders: renders.map((r, i) => ({ id: `r${String(i).padStart(width, "0")}`, ...r })) };
}

/** Single-parameter sweeps (training) plus random combinations (validation). */
export function planDynamics(parameters: Parameter[], options: PlanOptions): CapturePlan & { mapping: DynamicsMapping } {
  const mapping = detectDynamics(parameters);
  return { ...planSweeps(parameters, options, IGNORED, { switches: true }), mapping };
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
    // a closed gate: silence counts as "closed", not as hundreds of dB
    gains.push(Math.max(-60, 10 * Math.log10(outSum / size + 1e-20) - inDb));
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
