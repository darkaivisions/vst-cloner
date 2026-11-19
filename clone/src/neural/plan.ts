import { DEFAULT_PLAN, type CapturePlan, type CapturePlanner, type CaptureSurvey, type FixedValue, type HostInfo, type MeasuredSteps, type PlannedRender, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { IGNORED, parameterPositions, type Positions } from "../dynamics/plan.ts";

/**
 * Measurement plan for the universal (neural) clone. The network has to learn how all controls act together, so
 * nearly every render sets every control at random – unlike the class plans, which move one control at a time.
 * A separate set of random settings (another seed) is only used as a cross-check.
 */

/** controls the network is conditioned on at most; more make random settings too sparse to learn from */
export const MAX_NEURAL_CONTROLS = 24;
/** steps of a discrete control up to which a random setting picks a step instead of a continuous value */
const MAX_STEPS = 64;

export interface NeuralPlanOptions {
  /** training renders with random settings (the default setting comes on top) */
  train: number;
  /** cross-check renders with random settings */
  validate: number;
}

/**
 * More controls need more settings to cover their combinations. With 12 per control the network learned the training
 * settings by heart and got worse on unseen ones (Tal-Filter-2: 112 settings for 6 controls); a render takes well
 * under a second, so the cap is set by the profile size (about 1 MB per render). 50 per control up to 800: with 22
 * controls (SwankyAmp) 800 instead of 400 settings cut the error on unseen combinations from 58 % to 46 % at the same
 * training time; a larger network (128 units) was worse in both cases. The cross-check has 32 settings, so one odd
 * setting does not decide the rating.
 */
export function neuralRenderCounts(controls: number): NeuralPlanOptions {
  return { train: Math.min(800, Math.max(128, 50 * controls)), validate: 32 };
}

/** Controls the clone follows: automatable, not a meter or bypass, at most MAX_NEURAL_CONTROLS. */
export function neuralControls(parameters: Parameter[], options: Pick<PlanOptions, "include" | "exclude" | "fixed"> = {}): Parameter[] {
  const fixed = new Set((options.fixed ?? []).map((f) => f.index));
  return parameters
    .filter((p) => p.automatable && !p.meta && !IGNORED.test(p.name) && !fixed.has(p.index))
    .filter((p) => (!options.include || options.include.test(p.name)) && !(options.exclude && options.exclude.test(p.name)))
    .slice(0, MAX_NEURAL_CONTROLS);
}

/** xorshift32: same plan for the same seed on every machine */
function generator(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function randomValue(p: Parameter, random: () => number, positions?: Positions): number {
  if (p.discrete && p.numSteps >= 2 && p.numSteps <= MAX_STEPS) return Math.floor(random() * p.numSteps) / (p.numSteps - 1);
  // a control that moves in steps: every position equally often, however narrow its range (Tal-Filter-2's filter type
  // has positions 0.02 wide next to ones 0.3 wide)
  if (positions) return positions.values[Math.floor(random() * positions.values.length)]!;
  return random();
}

/**
 * Positions of the controls the network is conditioned on that move in steps although they may be reported as
 * continuous (measured by the survey, or told by their value texts). The network sees the middle of the position,
 * in training and in the clone, so it never has to learn a jump between two neighbouring values.
 */
export function neuralPositions(selected: Parameter[], steps: MeasuredSteps[] = []): Map<number, Positions> {
  return new Map(selected.flatMap((p) => {
    if (p.discrete) return [];
    const found = parameterPositions(p, steps);
    return found ? [[p.index, found] as const] : [];
  }));
}

/** points at which the survey sets every continuous control */
export const NEURAL_SURVEY_POINTS = 33;
/** more positions than this is no selector any more */
const MAX_POSITIONS = 24;
/** outputs closer than this (error energy against signal energy) are the same position */
const SAME_OUTPUT = 1e-5;

/** Error energy of b against a, relative to a (at least −60 dBFS, as in the verification). */
function difference(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let e = 0, s = 0;
  for (let i = 0; i < n; i++) {
    e += (a[i]! - b[i]!) ** 2;
    s += a[i]! ** 2;
  }
  return e / Math.max(s, n * 1e-6);
}

/**
 * Positions of a control from its outputs at evenly spaced values: runs of values with (nearly) the same output.
 * A selector gives a few runs with jumps between them; a continuous control changes from point to point, perhaps
 * with a flat stretch where it is off or at its limit. Returns undefined for the latter.
 */
export function outputPositions(xs: number[], outputs: Float32Array[]): MeasuredSteps | undefined {
  const runs: [number, number][] = [];
  for (let i = 0; i < xs.length; i++) {
    const last = runs[runs.length - 1];
    // the same as the first output of the run, not merely as the one before: a control that drifts is no step
    if (last && difference(outputs[last[0]]!, outputs[i]!) < SAME_OUTPUT) last[1] = i;
    else runs.push([i, i]);
  }
  if (runs.length < 2 || runs.length > MAX_POSITIONS) return undefined;
  const single = runs.filter(([from, to]) => from === to).length;
  if (single > runs.length / 2 || xs.length - runs.length < 0.4 * (xs.length - 1)) return undefined;
  // a step is a jump far larger than anything that moves within a position
  let within = 0, jump = Infinity;
  runs.forEach(([from, to], k) => {
    for (let i = from + 1; i <= to; i++) within = Math.max(within, difference(outputs[from]!, outputs[i]!));
    if (k > 0) jump = Math.min(jump, difference(outputs[runs[k - 1]![1]]!, outputs[from]!));
  });
  if (jump < Math.max(100 * within, SAME_OUTPUT)) return undefined;
  const bounds = runs.map(([from, to]): [number, number] => [xs[from]!, xs[to]!]);
  return { index: -1, values: bounds.map(([from, to]) => (from + to) / 2), bounds };
}

/**
 * Survey: every control the network follows that the plugin reports as continuous, without telling value texts, is
 * set to evenly spaced values from the initial state. Selectors among them show as runs of identical outputs.
 */
export function neuralSurvey(parameters: Parameter[], options: PlanOptions): CaptureSurvey | undefined {
  const candidates = neuralControls(parameters, options).filter((p) => !p.discrete && parameterPositions(p) === undefined);
  if (candidates.length === 0) return undefined;
  const fixed: FixedValue[] = options.fixed ?? [];
  const xs = Array.from({ length: NEURAL_SURVEY_POINTS }, (_, i) => i / (NEURAL_SURVEY_POINTS - 1));
  const renders: FixedValue[][] = candidates.flatMap((p) => xs.map((value) => [...fixed, { index: p.index, value }]));
  return {
    renders,
    evaluate(outputs) {
      return candidates.flatMap((p, k) => {
        const found = outputPositions(xs, outputs.slice(k * xs.length, (k + 1) * xs.length));
        return found ? [{ ...found, index: p.index }] : [];
      });
    },
  };
}

export function planNeural(parameters: Parameter[], options: PlanOptions, counts?: NeuralPlanOptions): CapturePlan {
  const selected = neuralControls(parameters, options);
  const fixed = options.fixed ?? [];
  const { train, validate } = counts ?? neuralRenderCounts(selected.length);
  const positions = neuralPositions(selected, options.steps);
  const renders: Omit<PlannedRender, "id">[] = [{ kind: "default", purpose: "train", label: "base setting", params: [...fixed] }];
  if (selected.length > 0) {
    const trainRandom = generator(options.seed);
    for (let i = 0; i < train; i++) {
      renders.push({ kind: "random", purpose: "train", label: `setting ${i + 1}`, params: [...fixed, ...selected.map((p) => ({ index: p.index, value: randomValue(p, trainRandom, positions.get(p.index)) }))] });
    }
    // the cross-check uses its own seed: none of its settings is seen in training
    const validateRandom = generator(options.seed + 7919);
    for (let i = 0; i < validate; i++) {
      renders.push({ kind: "random", purpose: "validate", label: `random combination ${i + 1}`, params: [...fixed, ...selected.map((p) => ({ index: p.index, value: randomValue(p, validateRandom, positions.get(p.index)) }))] });
    }
  }
  const width = Math.max(4, String(renders.length - 1).length);
  return { selected, renders: renders.map((r, i) => ({ id: `r${String(i).padStart(width, "0")}`, ...r })) };
}

export const neuralPlanner: CapturePlanner = {
  name: "neural",
  signalPreset: "neural",
  plan: (info: HostInfo, options: PlanOptions) => planNeural(info.parameters, { ...DEFAULT_PLAN, ...options }),
  survey: (info: HostInfo, options: PlanOptions) => neuralSurvey(info.parameters, { ...DEFAULT_PLAN, ...options }),
};
