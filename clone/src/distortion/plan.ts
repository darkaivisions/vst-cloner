import { DEFAULT_PLAN, type CapturePlan, type CapturePlanner, type HostInfo, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { IGNORED, OTHER_CLASS_CATEGORY, planSweeps } from "../dynamics/plan.ts";

/** Roles of distortion parameters, recognised by name. */
export type DistortionRole = "drive" | "tone" | "level" | "bass" | "mid" | "treble" | "presence" | "mix" | "model";

const ROLE_PATTERNS: [DistortionRole, RegExp][] = [
  ["drive", /drive|dist(ortion)?|fuzz|gain|sustain|overdrive|crunch|saturat|boost/i],
  ["tone", /^tone$|tone\b|filter|color|colour/i],
  ["bass", /bass|low/i],
  ["mid", /mid/i],
  ["treble", /treble|high/i],
  ["presence", /presence/i],
  ["level", /level|volume|output|master/i],
  ["mix", /mix|blend|dry\s*\/?\s*wet/i],
  ["model", /model|type|mode|stack|voice/i],
];

export interface DistortionMapping {
  roles: Partial<Record<DistortionRole, number>>;
  other: number[];
}

export class NotDistortionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotDistortionError";
  }
}

/** Recognises a distortion/overdrive/amp by its category or parameter names (a drive-like control is required). */
export function detectDistortion(parameters: Parameter[], category = ""): DistortionMapping {
  if (OTHER_CLASS_CATEGORY.test(category)) throw new NotDistortionError(`Plugin-Kategorie „${category}“ ist kein Verzerrer`);
  const roles: DistortionMapping["roles"] = {};
  const other: number[] = [];
  for (const p of parameters) {
    if (!p.automatable || p.meta || IGNORED.test(p.name)) continue;
    const role = ROLE_PATTERNS.find(([r, pattern]) => roles[r] === undefined && pattern.test(p.name))?.[0];
    if (role) roles[role] = p.index;
    else other.push(p.index);
  }
  const looksLikeDistortion = /distort|overdrive|amp|fuzz/i.test(category);
  if (roles.drive === undefined && !looksLikeDistortion) {
    throw new NotDistortionError("Kein Drive/Gain/Distortion-Regler und keine Verzerrer-Kategorie erkannt");
  }
  return { roles, other };
}

/** Single-parameter sweeps (training) plus random combinations (validation). */
export function planDistortion(parameters: Parameter[], options: PlanOptions, category = ""): CapturePlan & { mapping: DistortionMapping } {
  const mapping = detectDistortion(parameters, category);
  return { ...planSweeps(parameters, options, IGNORED), mapping };
}

export const distortionPlanner: CapturePlanner = {
  name: "distortion",
  signalPreset: "distortion",
  plan: (info: HostInfo, options: PlanOptions) => planDistortion(info.parameters, { ...DEFAULT_PLAN, ...options }, info.plugin.category),
};
