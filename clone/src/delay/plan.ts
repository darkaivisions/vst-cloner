import { DEFAULT_PLAN, type CapturePlan, type CapturePlanner, type CaptureProbe, type FixedValue, type HostInfo, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { IGNORED, planSweeps } from "../dynamics/plan.ts";

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
  if (!DELAY_NAME.test(category) && !DELAY_NAME.test(name)) throw new NotDelayError("Weder Kategorie noch Name weisen auf ein Delay hin");
  if (NOT_A_PLAIN_DELAY.test(name)) throw new NotDelayError(`„${name}“ ist kein einfaches Delay (Looper, Granular, Pitch, Multiband …)`);
  const roles: DelayMapping["roles"] = {};
  const other: number[] = [];
  for (const p of parameters) {
    if (!p.automatable || p.meta || IGNORED.test(p.name)) continue;
    const role = ROLE_PATTERNS.find(([r, pattern]) => roles[r] === undefined && pattern.test(p.name))?.[0];
    if (role) roles[role] = p.index;
    else other.push(p.index);
  }
  if (roles.time === undefined) throw new NotDelayError("Kein Regler für die Verzögerungszeit erkannt");
  return { roles, other };
}

/** combinations measured for the fit: how several time controls work together (see fitDelay) */
export const DELAY_COMBINATIONS = 12;

/** Single-parameter sweeps and a few combinations (training) plus random combinations (validation). */
export function planDelay(parameters: Parameter[], options: PlanOptions, category = "", name = ""): CapturePlan & { mapping: DelayMapping } {
  const mapping = detectDelay(parameters, category, name);
  return { ...planSweeps(parameters, options, IGNORED, { switches: true, combinations: DELAY_COMBINATIONS }), mapping };
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
export function delayProbe(parameters: Parameter[], category = "", name = ""): CaptureProbe | undefined {
  let mapping: DelayMapping;
  try {
    mapping = detectDelay(parameters, category, name);
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

export const delayPlanner: CapturePlanner = {
  name: "delay",
  signalPreset: "delay",
  plan: (info: HostInfo, options: PlanOptions) => planDelay(info.parameters, { ...DEFAULT_PLAN, ...options }, info.plugin.category, info.plugin.name),
  probe: (info: HostInfo) => delayProbe(info.parameters, info.plugin.category, info.plugin.name),
};
