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

/** Controls that only a distortion has; "gain" and "boost" are found on mixers, decoders and tuners as well. */
const STRONG_DRIVE = /drive|dist(ortion)?\b|fuzz|crunch|saturat|sustain/i;
const DISTORTION_CATEGORY = /distort|overdrive|amp|fuzz|simulator/i;
const DISTORTION_NAME = /distort|overdrive|fuzz|saturat|\bamp\b|amplifier|tube|\bdrive\b/i;
/** Tools that process audio without colouring it, whatever their controls are called. */
const NOT_DISTORTION_CATEGORY = /analy[sz]er|spatial|utility|tools|mixer/i;
/** Modulation and reverb built into an amp or tape machine: the static model has neither. */
const TIME_VARIANT_PARAMETER = /lfo|wow|flutter|vibe|vibrato|tremolo|reverb|chorus|\brate\b|speed/i;

/**
 * Recognises a distortion/overdrive/amp by its category, its name or a drive-like control. A "gain" control
 * alone is not enough, and neither are several drives (one per band) or built-in modulation and reverb.
 */
export function detectDistortion(parameters: Parameter[], category = "", name = ""): DistortionMapping {
  if (OTHER_CLASS_CATEGORY.test(category) || OTHER_CLASS_CATEGORY.test(name)) throw new NotDistortionError(`„${name || category}“ (${category}) ist kein Verzerrer`);
  if (NOT_DISTORTION_CATEGORY.test(category)) throw new NotDistortionError(`Plugin-Kategorie „${category}“ ist kein Verzerrer`);
  const roles: DistortionMapping["roles"] = {};
  const other: number[] = [];
  const active = parameters.filter((p) => p.automatable && !p.meta && !IGNORED.test(p.name));
  for (const p of active) {
    const role = ROLE_PATTERNS.find(([r, pattern]) => roles[r] === undefined && pattern.test(p.name))?.[0];
    if (role) roles[role] = p.index;
    else other.push(p.index);
  }
  const drives = active.filter((p) => STRONG_DRIVE.test(p.name));
  // the drive is the control named so, not the first "gain" in the list
  if (drives.length && !STRONG_DRIVE.test(parameters.find((p) => p.index === roles.drive)?.name ?? "")) roles.drive = drives[0]!.index;
  const timeVariant = active.find((p) => TIME_VARIANT_PARAMETER.test(p.name));
  if (timeVariant) throw new NotDistortionError(`Eingebaute Modulation oder Hall („${timeVariant.name}“) – mit dem Verzerrer-Modell nicht abbildbar`);
  if (drives.length >= 3) throw new NotDistortionError(`Mehrband-Verzerrer (${drives.length} Drive-Regler) – mit dem Verzerrer-Modell nicht abbildbar`);
  if (!drives.length && !DISTORTION_CATEGORY.test(category) && !DISTORTION_NAME.test(name)) {
    throw new NotDistortionError("Kein Drive/Distortion-Regler und weder Kategorie noch Name eines Verzerrers erkannt");
  }
  return { roles, other };
}

/** Single-parameter sweeps (training) plus random combinations (validation). */
export function planDistortion(parameters: Parameter[], options: PlanOptions, category = "", name = ""): CapturePlan & { mapping: DistortionMapping } {
  const mapping = detectDistortion(parameters, category, name);
  return { ...planSweeps(parameters, options, IGNORED), mapping };
}

export const distortionPlanner: CapturePlanner = {
  name: "distortion",
  signalPreset: "distortion",
  plan: (info: HostInfo, options: PlanOptions) => planDistortion(info.parameters, { ...DEFAULT_PLAN, ...options }, info.plugin.category, info.plugin.name),
};
