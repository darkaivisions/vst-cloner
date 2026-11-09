import type { Parameter, RenderKind } from "@vst-cloner/profile";
import { createRandom } from "./random.ts";

export interface PlanOptions {
  /** Sweep points per continuous parameter. */
  points: number;
  /** Number of random parameter combinations. */
  random: number;
  seed: number;
  /** Only parameters whose name matches. */
  include?: RegExp;
  /** Skip parameters whose name matches. */
  exclude?: RegExp;
  maxRenders: number;
  /** Fixed values applied to every render (e.g. enabling an EQ band); these parameters are not swept. */
  fixed?: FixedValue[];
}

export interface FixedValue {
  index: number;
  value: number;
}

export const DEFAULT_PLAN: PlanOptions = {
  points: 5,
  random: 16,
  seed: 1,
  exclude: /bypass/i,
  maxRenders: 500,
};

/** Discrete parameters up to this many steps are captured at every step. */
const MAX_DISCRETE_STEPS = 32;

export interface PlannedRender {
  id: string;
  kind: RenderKind;
  sweepParameter?: number;
  purpose?: "train" | "validate";
  label?: string;
  params: { index: number; value: number }[];
}

export interface CapturePlan {
  selected: Parameter[];
  renders: PlannedRender[];
}

export class PlanTooLargeError extends Error {
  constructor(count: number, max: number) {
    super(
      `capture plan has ${count} renders (limit ${max}). ` +
        "Narrow it with --include/--exclude, lower --points/--random or raise --max-renders.",
    );
    this.name = "PlanTooLargeError";
  }
}

export function baseValue(p: Parameter): number {
  return p.value ?? p.default;
}

/**
 * Resolves "<name or index>=<value>" specs. The value is a normalized number (0..1)
 * or a display text of a discrete parameter (e.g. "Band 1 Shape=Low Cut").
 */
export function resolveFixedValues(parameters: Parameter[], specs: string[]): FixedValue[] {
  return specs.map((spec) => {
    const eq = spec.lastIndexOf("=");
    if (eq <= 0) throw new Error(`invalid --set '${spec}', expected <parameter>=<value>`);
    const key = spec.slice(0, eq).trim();
    const raw = spec.slice(eq + 1).trim();

    const param = /^\d+$/.test(key)
      ? parameters.find((p) => p.index === Number(key))
      : parameters.find((p) => p.name.toLowerCase() === key.toLowerCase());
    if (!param) throw new Error(`--set: unknown parameter '${key}'`);

    const numeric = Number(raw);
    if (raw !== "" && Number.isFinite(numeric)) {
      if (numeric < 0 || numeric > 1) throw new Error(`--set ${param.name}: numeric values are normalized (0..1), got ${raw}`);
      return { index: param.index, value: numeric };
    }

    const text = param.texts?.find((t) => t.text.trim().toLowerCase() === raw.toLowerCase());
    if (!text) {
      const known = (param.texts ?? []).map((t) => t.text).join(", ");
      throw new Error(`--set ${param.name}: unknown value '${raw}'${known ? ` (known: ${known})` : ""}`);
    }
    return { index: param.index, value: text.value };
  });
}

function isStepped(p: Parameter): boolean {
  return p.discrete && p.numSteps >= 2 && p.numSteps <= MAX_DISCRETE_STEPS;
}

export function selectParameters(parameters: Parameter[], options: Pick<PlanOptions, "include" | "exclude">): Parameter[] {
  return parameters.filter(
    (p) =>
      p.automatable &&
      !p.meta &&
      (!options.include || options.include.test(p.name)) &&
      !(options.exclude && options.exclude.test(p.name)),
  );
}

export function sweepValues(p: Parameter, points: number): number[] {
  const count = isStepped(p) ? p.numSteps : Math.max(2, points);
  const base = baseValue(p);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = i / (count - 1);
    if (Math.abs(value - base) > 1e-4) values.push(value);
  }
  return values;
}

function randomValue(p: Parameter, random: () => number): number {
  if (isStepped(p)) return Math.floor(random() * p.numSteps) / (p.numSteps - 1);
  return random();
}

export function planCaptures(parameters: Parameter[], options: PlanOptions): CapturePlan {
  const fixed = options.fixed ?? [];
  const fixedIndices = new Set(fixed.map((f) => f.index));
  const selected = selectParameters(parameters, options).filter((p) => !fixedIndices.has(p.index));
  const renders: Omit<PlannedRender, "id">[] = [{ kind: "default", params: [...fixed] }];

  for (const p of selected) {
    for (const value of sweepValues(p, options.points)) {
      renders.push({ kind: "sweep", sweepParameter: p.index, params: [...fixed, { index: p.index, value }] });
    }
  }

  if (selected.length > 0) {
    const random = createRandom(options.seed);
    for (let i = 0; i < options.random; i++) {
      renders.push({ kind: "random", params: [...fixed, ...selected.map((p) => ({ index: p.index, value: randomValue(p, random) }))] });
    }
  }

  if (renders.length > options.maxRenders) throw new PlanTooLargeError(renders.length, options.maxRenders);

  const width = Math.max(4, String(renders.length - 1).length);
  return {
    selected,
    renders: renders.map((r, i) => ({ id: `r${String(i).padStart(width, "0")}`, ...r })),
  };
}
