import { DEFAULT_PLAN, type CapturePlan, type CaptureProbe, type CapturePlanner, type FixedValue, type HostInfo, type PlanOptions } from "@vst-cloner/capture";
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

/** output below this level against the input (dB, later part of the test signal): the setting lets nothing through */
const PROBE_AUDIBLE_DB = -40;
/** level a working point should reach */
const PROBE_WANTED_DB = -25;

/**
 * Candidate settings for the working point: gated fuzzes and starved amps are silent in their initial state,
 * and a silent base render says nothing about any control. Then the drive-like controls are turned up, one at a
 * time and together, and the plan measures around the first setting that sounds.
 */
export function distortionProbe(parameters: Parameter[], category = "", name = ""): CaptureProbe | undefined {
  let mapping: DistortionMapping;
  try {
    mapping = detectDistortion(parameters, category, name);
  } catch {
    return undefined;
  }
  const drives = parameters
    .filter((p) => p.automatable && !p.meta && !IGNORED.test(p.name) && !p.discrete && (STRONG_DRIVE.test(p.name) || p.index === mapping.roles.drive || /^(input|gain|pre.?gain)$/i.test(p.name)))
    .slice(0, 4);
  if (!drives.length) return undefined;
  const candidates: FixedValue[][] = [[]];
  for (const value of [0.75, 1]) {
    for (const p of drives) candidates.push([{ index: p.index, value }]);
    if (drives.length > 1) candidates.push(drives.map((p) => ({ index: p.index, value })));
  }
  return {
    candidates,
    choose(outputs, input) {
      // the first seconds may hold a switch-on thump: level over the later 60 % of the signal
      const level = (signal: Float32Array, length: number) => {
        let sum = 0;
        const from = Math.floor(length * 0.4);
        for (let i = from; i < length; i++) sum += signal[i]! * signal[i]!;
        return 10 * Math.log10(sum / Math.max(1, length - from) + 1e-30);
      };
      const gains = outputs.map((o) => {
        const length = Math.min(o.length, input.length);
        return level(o, length) - level(input, length);
      });
      if (gains[0]! >= PROBE_AUDIBLE_DB) return 0;
      // candidates are ordered from the smallest change to the largest
      const wanted = gains.findIndex((g, i) => i > 0 && g >= PROBE_WANTED_DB);
      if (wanted > 0) return wanted;
      const loudest = gains.reduce((best, g, i) => (g > gains[best]! ? i : best), 0);
      return gains[loudest]! >= Math.max(PROBE_AUDIBLE_DB, gains[0]! + 10) ? loudest : 0;
    },
  };
}

export const distortionPlanner: CapturePlanner = {
  name: "distortion",
  signalPreset: "distortion",
  plan: (info: HostInfo, options: PlanOptions) => planDistortion(info.parameters, { ...DEFAULT_PLAN, ...options }, info.plugin.category, info.plugin.name),
  probe: (info: HostInfo) => distortionProbe(info.parameters, info.plugin.category, info.plugin.name),
};
