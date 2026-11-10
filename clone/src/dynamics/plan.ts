import { DEFAULT_PLAN, planCaptures, type CapturePlan, type CapturePlanner, type HostInfo, type PlanOptions } from "@vst-cloner/capture";
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

/** Generic sweeps of every parameter (training) plus random combinations (validation). */
export function planDynamics(parameters: Parameter[], options: PlanOptions): CapturePlan & { mapping: DynamicsMapping } {
  const mapping = detectDynamics(parameters);
  const plan = planCaptures(parameters, {
    ...options,
    points: Math.max(options.points, 5),
    exclude: options.exclude ? new RegExp(`${options.exclude.source}|${IGNORED.source}`, "i") : IGNORED,
  });
  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  return {
    ...plan,
    mapping,
    renders: plan.renders.map((r) => ({
      ...r,
      purpose: r.kind === "random" ? "validate" : "train",
      label: r.kind === "default"
        ? "Grundeinstellung"
        : r.kind === "sweep"
          ? r.params.map((v) => `${byIndex.get(v.index)!.name} = ${percent(byIndex.get(v.index)!, v.value)}`).join(", ")
          : `Zufallskombination ${r.id}`,
    })),
  };
}

export const dynamicsPlanner: CapturePlanner = {
  name: "dynamics",
  signalPreset: "dynamics",
  plan: (info: HostInfo, options: PlanOptions) => planDynamics(info.parameters, { ...DEFAULT_PLAN, ...options }),
};
