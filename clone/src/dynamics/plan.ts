import {
  createRandom,
  DEFAULT_PLAN,
  PlanTooLargeError,
  selectParameters,
  type CapturePlan,
  type CapturePlanner,
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
  ["reduction", /peak\s*red|gain\s*red(?!.*meter)|compress(ion)?\s*(amount)?$|amount/i],
  ["threshold", /thresh|thr\b/i],
  ["ratio", /ratio/i],
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
const IGNORED = /bypass|meter|display|^program$|preset|oversampl|quality/i;

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
export function detectDynamics(parameters: Parameter[]): DynamicsMapping {
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

/** Single-parameter sweeps (training) plus random combinations (validation). */
export function planDynamics(parameters: Parameter[], options: PlanOptions): CapturePlan & { mapping: DynamicsMapping } {
  const mapping = detectDynamics(parameters);
  const exclude = options.exclude ? new RegExp(`${options.exclude.source}|${IGNORED.source}`, "i") : IGNORED;
  const selected = selectParameters(parameters, { ...(options.include ? { include: options.include } : {}), exclude });
  const stepped = (p: Parameter) => p.discrete && p.numSteps >= 2 && p.numSteps <= 64;
  const base = (p: Parameter) => p.value ?? p.default;
  const fixed = options.fixed ?? [];

  const renders: Omit<PlannedRender, "id">[] = [{ kind: "default", purpose: "train", label: "Grundeinstellung", params: [...fixed] }];
  for (const p of selected) {
    const values = stepped(p) ? Array.from({ length: p.numSteps }, (_, i) => i / (p.numSteps - 1)) : DYNAMICS_SWEEP;
    for (const value of values) {
      if (Math.abs(value - base(p)) < 1e-4) continue;
      renders.push({ kind: "sweep", sweepParameter: p.index, purpose: "train", label: `${p.name} = ${percent(p, value)}`, params: [...fixed, { index: p.index, value }] });
    }
  }
  const random = createRandom(options.seed);
  for (let i = 0; i < options.random; i++) {
    renders.push({
      kind: "random",
      purpose: "validate",
      label: `Zufallskombination ${i + 1}`,
      params: [...fixed, ...selected.map((p) => ({ index: p.index, value: stepped(p) ? Math.floor(random() * p.numSteps) / (p.numSteps - 1) : random() }))],
    });
  }
  if (renders.length > options.maxRenders) throw new PlanTooLargeError(renders.length, options.maxRenders);
  const width = Math.max(4, String(renders.length - 1).length);
  return { selected, mapping, renders: renders.map((r, i) => ({ id: `r${String(i).padStart(width, "0")}`, ...r })) };
}

export const dynamicsPlanner: CapturePlanner = {
  name: "dynamics",
  signalPreset: "dynamics",
  plan: (info: HostInfo, options: PlanOptions) => planDynamics(info.parameters, { ...DEFAULT_PLAN, ...options }),
};
