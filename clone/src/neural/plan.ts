import { DEFAULT_PLAN, type CapturePlan, type CapturePlanner, type HostInfo, type PlannedRender, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { IGNORED } from "../dynamics/plan.ts";

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
 * under a second, so the cap is set by the profile size (about 1 MB per render). The cross-check has 32 settings, so
 * one odd setting does not decide the rating.
 */
export function neuralRenderCounts(controls: number): NeuralPlanOptions {
  return { train: Math.min(400, Math.max(128, 50 * controls)), validate: 32 };
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

function randomValue(p: Parameter, random: () => number): number {
  if (p.discrete && p.numSteps >= 2 && p.numSteps <= MAX_STEPS) return Math.floor(random() * p.numSteps) / (p.numSteps - 1);
  return random();
}

export function planNeural(parameters: Parameter[], options: PlanOptions, counts?: NeuralPlanOptions): CapturePlan {
  const selected = neuralControls(parameters, options);
  const fixed = options.fixed ?? [];
  const { train, validate } = counts ?? neuralRenderCounts(selected.length);
  const renders: Omit<PlannedRender, "id">[] = [{ kind: "default", purpose: "train", label: "base setting", params: [...fixed] }];
  if (selected.length > 0) {
    const trainRandom = generator(options.seed);
    for (let i = 0; i < train; i++) {
      renders.push({ kind: "random", purpose: "train", label: `setting ${i + 1}`, params: [...fixed, ...selected.map((p) => ({ index: p.index, value: randomValue(p, trainRandom) }))] });
    }
    // the cross-check uses its own seed: none of its settings is seen in training
    const validateRandom = generator(options.seed + 7919);
    for (let i = 0; i < validate; i++) {
      renders.push({ kind: "random", purpose: "validate", label: `random combination ${i + 1}`, params: [...fixed, ...selected.map((p) => ({ index: p.index, value: randomValue(p, validateRandom) }))] });
    }
  }
  const width = Math.max(4, String(renders.length - 1).length);
  return { selected, renders: renders.map((r, i) => ({ id: `r${String(i).padStart(width, "0")}`, ...r })) };
}

export const neuralPlanner: CapturePlanner = {
  name: "neural",
  signalPreset: "neural",
  plan: (info: HostInfo, options: PlanOptions) => planNeural(info.parameters, { ...DEFAULT_PLAN, ...options }),
};
