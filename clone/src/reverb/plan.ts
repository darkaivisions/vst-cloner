import { DEFAULT_PLAN, type CapturePlan, type CapturePlanner, type CaptureProbe, type FixedValue, type HostInfo, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { echoDb } from "../delay/plan.ts";
import { IGNORED, planSweeps } from "../dynamics/plan.ts";

export class NotReverbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotReverbError";
  }
}

const REVERB_NAME = /reverb|verb\b/i;
/** reverb-like effects the model (a feedback delay network with a decay time per band) cannot represent */
const NOT_A_PLAIN_REVERB = /convol|\bir\b|multi\s*-?band|\bmb|shimm|encoder|early|gate/i;
const MIX = /mix|dry|wet|level|blend|amount/i;

/** Recognises a reverb by its category or name. Returns the index of its mix control, if it has one. */
export function detectReverb(parameters: Parameter[], category = "", name = ""): { mix?: number } {
  if (!REVERB_NAME.test(category) && !REVERB_NAME.test(name)) throw new NotReverbError("Neither category nor name point to a reverb");
  if (NOT_A_PLAIN_REVERB.test(name)) throw new NotReverbError(`"${name}" is not a plain reverb (convolution, multiband, shimmer, early reflections …)`);
  const usable = parameters.filter((p) => p.automatable && !p.meta && !IGNORED.test(p.name));
  if (!usable.length) throw new NotReverbError("No controls found");
  const mix = usable.find((p) => MIX.test(p.name));
  return mix ? { mix: mix.index } : {};
}

/** Single-parameter sweeps (training) plus random combinations (validation). */
export function planReverb(parameters: Parameter[], options: PlanOptions, category = "", name = ""): CapturePlan {
  detectReverb(parameters, category, name);
  return planSweeps(parameters, options, IGNORED);
}

/** A reverb whose tail is quieter than this in its initial state is measured with the mix opened. */
const ENOUGH_TAIL_DB = -40;

/** Working point: a reverb that starts fully dry shows nothing of its controls; the probe opens its mix control. */
export function reverbProbe(parameters: Parameter[], category = "", name = ""): CaptureProbe | undefined {
  let found: { mix?: number };
  try {
    found = detectReverb(parameters, category, name);
  } catch {
    return undefined;
  }
  const mix = parameters.find((p) => p.index === found.mix);
  if (!mix) return undefined;
  const initial = mix.value ?? mix.default;
  const candidates: FixedValue[][] = [[], ...[0.5, 1, 0.75, 0.25].filter((v) => Math.abs(v - initial) > 0.02).map((value) => [{ index: mix.index, value }])];
  return {
    candidates,
    choose(outputs, input, sampleRate) {
      const levels = outputs.map((o) => echoDb(o, input, sampleRate));
      if (levels[0]! >= ENOUGH_TAIL_DB) return 0;
      const enough = levels.findIndex((l, i) => i > 0 && l >= ENOUGH_TAIL_DB);
      if (enough > 0) return enough;
      const loudest = levels.reduce((best, l, i) => (l > levels[best]! ? i : best), 0);
      return levels[loudest]! > levels[0]! + 6 ? loudest : 0;
    },
  };
}

export const reverbPlanner: CapturePlanner = {
  name: "reverb",
  signalPreset: "reverb",
  plan: (info: HostInfo, options: PlanOptions) => planReverb(info.parameters, { ...DEFAULT_PLAN, ...options }, info.plugin.category, info.plugin.name),
  probe: (info: HostInfo) => reverbProbe(info.parameters, info.plugin.category, info.plugin.name),
};
