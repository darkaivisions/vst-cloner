import { DEFAULT_PLAN, selectParameters, type CapturePlan, type CapturePlanner, type CaptureProbe, type CaptureSurvey, type FixedValue, type HostInfo, type MeasuredSteps, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { IGNORED, parameterPositions, planSweeps } from "../dynamics/plan.ts";
import { analyseResponse } from "./fit.ts";
import { packDelay } from "./model.ts";

/** Roles of delay parameters, recognised by name. */
export type DelayRole = "time" | "feedback" | "mix" | "filter";

const ROLE_PATTERNS: [DelayRole, RegExp][] = [
  ["feedback", /feed\s*-?back|fdbk|\bfb\b|regen|repeat|decay|percent/i],
  ["time", /time|delay|length|\bms\b|beat|bpm|tempo|note|\bsync\b/i],
  ["filter", /\blpf?\b|\bhpf?\b|low\s*-?(pass|cut)|high\s*-?(pass|cut)|\bcut|tone|damp|filter|colou?r/i],
  ["mix", /mix|dry|wet|level|blend|amount|gain|volume/i],
];

export interface DelayMapping {
  roles: Partial<Record<DelayRole, number>>;
  other: number[];
}

export class NotDelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotDelayError";
  }
}

const DELAY_NAME = /delay|echo/i;
/** delay-based effects the model (one delay line with feedback) cannot represent */
const NOT_A_PLAIN_DELAY = /loop|grain|pitch|multi\s*-?band|\bmb|stuck|bent|reverse|no delay|chorus|flang|reverb/i;

/** Recognises a delay or echo by its category or name; a delay time control is required. */
export function detectDelay(parameters: Parameter[], category = "", name = ""): DelayMapping {
  if (!DELAY_NAME.test(category) && !DELAY_NAME.test(name)) throw new NotDelayError("Neither category nor name point to a delay");
  if (NOT_A_PLAIN_DELAY.test(name)) throw new NotDelayError(`"${name}" is not a plain delay (looper, granular, pitch, multiband …)`);
  const roles: DelayMapping["roles"] = {};
  const other: number[] = [];
  for (const p of parameters) {
    if (!p.automatable || p.meta || IGNORED.test(p.name)) continue;
    const role = ROLE_PATTERNS.find(([r, pattern]) => roles[r] === undefined && pattern.test(p.name))?.[0];
    if (role) roles[role] = p.index;
    else other.push(p.index);
  }
  if (roles.time === undefined) throw new NotDelayError("No delay time control detected");
  return { roles, other };
}

const MODULATION_NAME = /chorus|flang|vibrat|ensemble|dimension|doubler/i;
/** modulation effects the model (one delay line moved by one LFO) cannot represent */
const NOT_A_MODULATED_DELAY = /phas|trem|rotar|leslie|ring|pitch|reverb/i;

/**
 * Recognises a chorus, flanger or vibrato (one delay line whose time an LFO moves) by its category or name. The
 * roles are those of a delay; a time control is not required (many have only rate and depth).
 */
export function detectModulation(parameters: Parameter[], category = "", name = ""): DelayMapping {
  if (!MODULATION_NAME.test(category) && !MODULATION_NAME.test(name)) throw new NotDelayError("Neither category nor name point to a chorus, flanger or vibrato");
  if (NOT_A_MODULATED_DELAY.test(name)) throw new NotDelayError(`"${name}" is no modulated delay (phaser, tremolo, rotary …)`);
  const roles: DelayMapping["roles"] = {};
  const other: number[] = [];
  for (const p of parameters) {
    if (!p.automatable || p.meta || IGNORED.test(p.name)) continue;
    const role = ROLE_PATTERNS.find(([r, pattern]) => roles[r] === undefined && pattern.test(p.name))?.[0];
    if (role) roles[role] = p.index;
    else other.push(p.index);
  }
  if (roles.time === undefined && other.length === 0) throw new NotDelayError("No controls to measure");
  return { roles, other };
}

/** combinations measured for the fit: how several time controls work together (see fitDelay) */
export const DELAY_COMBINATIONS = 12;

/** Single-parameter sweeps and a few combinations (training) plus random combinations (validation). */
export function planDelay(parameters: Parameter[], options: PlanOptions, category = "", name = ""): CapturePlan & { mapping: DelayMapping } {
  const mapping = detectDelay(parameters, category, name);
  return { ...planSweeps(parameters, options, IGNORED, { switches: true, combinations: DELAY_COMBINATIONS, plateaus: true }), mapping };
}

/** Energy of everything after the first 2 ms of the impulse's answer, relative to the impulse (dB). */
export function echoDb(output: Float32Array, input: Float32Array, sampleRate: number): number {
  let start = 0;
  while (start < input.length && input[start] === 0) start++;
  if (start >= input.length) return -200;
  let end = start + 1;
  while (end < input.length && input[end] === 0) end++;
  let sum = 0;
  for (let i = start + Math.round(0.002 * sampleRate); i < Math.min(end, output.length); i++) sum += output[i]! * output[i]!;
  return 10 * Math.log10(sum / (input[start]! * input[start]!) + 1e-20);
}

/** A delay whose echoes are quieter than this in its initial state is measured with the mix opened. */
const ENOUGH_ECHO_DB = -30;

/**
 * Working point: a delay that starts fully dry (or with its level at zero) shows nothing of its time, feedback
 * and filter controls. The probe opens the mix control until echoes are heard.
 */
export function delayProbe(parameters: Parameter[], category = "", name = "", detect = detectDelay): CaptureProbe | undefined {
  let mapping: DelayMapping;
  try {
    mapping = detect(parameters, category, name);
  } catch {
    return undefined;
  }
  const mix = parameters.find((p) => p.index === mapping.roles.mix);
  if (!mix) return undefined;
  const initial = mix.value ?? mix.default;
  const candidates: FixedValue[][] = [[], ...[0.5, 1, 0.75, 0.25].filter((v) => Math.abs(v - initial) > 0.02).map((value) => [{ index: mix.index, value }])];
  return {
    candidates,
    choose(outputs, input, sampleRate) {
      const levels = outputs.map((o) => echoDb(o, input, sampleRate));
      if (levels[0]! >= ENOUGH_ECHO_DB) return 0;
      const enough = levels.findIndex((l, i) => i > 0 && l >= ENOUGH_ECHO_DB);
      if (enough > 0) return enough;
      const loudest = levels.reduce((best, l, i) => (l > levels[best]! ? i : best), 0);
      return levels[loudest]! > levels[0]! + 6 ? loudest : 0;
    },
  };
}

/** points at which the survey sets every continuous control */
export const SURVEY_POINTS = 61;
/** more positions than this is no selector any more */
const MAX_POSITIONS = 24;
/**
 * Model values (packed, see packDelay) that differ by less are the same position: 0.1 % in time, 0.05 dB, 0.5 % in
 * frequency. Tight, because a position repeats its effect exactly while a slow control only nearly does.
 */
const SAME = [0.001, 0.05, 0.05, 0.05, 0.005, 0.005, 0.005, 0.005, 0.01, 0.005, 0.05];

/**
 * Positions of a control from what it does at evenly spaced values: runs of values with the same effect. A
 * selector or switch gives a few runs with jumps between them; a continuous control changes from point to
 * point (possibly with a flat stretch where it is off or at its limit). Returns undefined for the latter.
 */
export function measuredPositions(xs: number[], effects: number[][]): { values: number[]; bounds: [number, number][] } | undefined {
  const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < (SAME[i] ?? 0.2));
  const runs: [number, number][] = [];
  for (let i = 0; i < xs.length; i++) {
    const last = runs[runs.length - 1];
    // the same as the first value of the run, not merely as the one before: a control that drifts slowly is no step
    if (last && same(effects[last[0]]!, effects[i]!)) last[1] = i;
    else runs.push([i, i]);
  }
  if (runs.length < 2 || runs.length > MAX_POSITIONS) return undefined;
  const single = runs.filter(([from, to]) => from === to).length;
  const equalPairs = xs.length - runs.length;
  if (single > runs.length / 2 || equalPairs < 0.4 * (xs.length - 1)) return undefined;
  // A step is a jump: far larger than anything that moves within a position. A control that creeps (a filter on
  // the other channel that slowly changes the feedback) only falls into runs because the comparison has a tolerance.
  const distance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!) / (SAME[i] ?? 0.2)));
  let within = 0, jump = Infinity;
  runs.forEach(([from, to], k) => {
    for (let i = from + 1; i <= to; i++) within = Math.max(within, distance(effects[from]!, effects[i]!));
    if (k > 0) jump = Math.min(jump, distance(effects[runs[k - 1]![1]]!, effects[from]!));
  });
  if (jump < 5 * within) return undefined;
  const bounds = runs.map(([from, to]): [number, number] => [xs[from]!, xs[to]!]);
  return { values: bounds.map(([from, to]) => (from + to) / 2), bounds };
}

/**
 * Survey: every control the plugin reports as continuous and without telling value texts is set to evenly spaced
 * values. Selectors and switches among them (note values, "x2", sync on/off) show as steps in what they do.
 */
export function delaySurvey(parameters: Parameter[], options: PlanOptions, category = "", name = ""): CaptureSurvey | undefined {
  try {
    detectDelay(parameters, category, name);
  } catch {
    return undefined;
  }
  const exclude = options.exclude ? new RegExp(`${options.exclude.source}|${IGNORED.source}`, "i") : IGNORED;
  const fixed = new Set((options.fixed ?? []).map((f) => f.index));
  const candidates = selectParameters(parameters, { ...(options.include ? { include: options.include } : {}), exclude })
    .filter((p) => !p.discrete && !fixed.has(p.index) && parameterPositions(p) === undefined);
  if (candidates.length === 0) return undefined;
  const working = options.workingPoint ?? [];
  const xs = Array.from({ length: SURVEY_POINTS }, (_, i) => i / (SURVEY_POINTS - 1));
  const renders: FixedValue[][] = [[...working]];
  for (const p of candidates) for (const value of xs) renders.push([...working.filter((w) => w.index !== p.index), { index: p.index, value }]);
  return {
    renders,
    evaluate(outputs, input, sampleRate) {
      // the impulse and the silence after it (see echoDb)
      let start = 0;
      while (start < input.length && input[start] === 0) start++;
      let end = start + 1;
      while (end < input.length && input[end] === 0) end++;
      const response = (output: Float32Array) => Float32Array.from({ length: end - start }, (_, i) => (output[start + i] ?? 0) / input[start]!);
      const base = analyseResponse(response(outputs[0]!), sampleRate);
      const steps: MeasuredSteps[] = [];
      candidates.forEach((p, k) => {
        const effects = xs.map((_, i) => packDelay(analyseResponse(response(outputs[1 + k * SURVEY_POINTS + i]!), sampleRate, base.params).params));
        const found = measuredPositions(xs, effects);
        if (found) steps.push({ index: p.index, ...found });
      });
      return steps;
    },
  };
}

/** Chorus, flanger, vibrato: the delay's measurement plus a train of clicks for the LFO (see modulationSegmentSpecs). */
export const modulationPlanner: CapturePlanner = {
  name: "modulation",
  signalPreset: "modulation",
  plan: (info: HostInfo, options: PlanOptions) => {
    const mapping = detectModulation(info.parameters, info.plugin.category, info.plugin.name);
    return { ...planSweeps(info.parameters, { ...DEFAULT_PLAN, ...options }, IGNORED, { switches: true, combinations: DELAY_COMBINATIONS, plateaus: true }), mapping };
  },
  probe: (info: HostInfo) => delayProbe(info.parameters, info.plugin.category, info.plugin.name, detectModulation),
};

export const delayPlanner: CapturePlanner = {
  name: "delay",
  signalPreset: "delay",
  plan: (info: HostInfo, options: PlanOptions) => planDelay(info.parameters, { ...DEFAULT_PLAN, ...options }, info.plugin.category, info.plugin.name),
  probe: (info: HostInfo) => delayProbe(info.parameters, info.plugin.category, info.plugin.name),
  survey: (info: HostInfo, options: PlanOptions) => delaySurvey(info.parameters, { ...DEFAULT_PLAN, ...options }, info.plugin.category, info.plugin.name),
};
