import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { capture, DEFAULT_PLAN, pluginInfo, type CapturePlanner, type CaptureProgress } from "@vst-cloner/capture";
import { readProfile } from "@vst-cloner/profile";
import { installPlugins, slugify, type BuildResult, type Logger } from "./build.ts";
import { classifyPlugin, type EffectClass } from "./batch.ts";
import { bestClone, compareClones, formatComparison, type CloneCandidate, type CloneComparison } from "./compare.ts";
import { delayPlanner, detectModulation, modulationPlanner } from "./delay/plan.ts";
import { cloneDelayProfile } from "./delay/workflow.ts";
import { distortionPlanner } from "./distortion/plan.ts";
import { cloneDistortionProfile } from "./distortion/workflow.ts";
import { dynamicsPlanner } from "./dynamics/plan.ts";
import { cloneDynamicsProfile } from "./dynamics/workflow.ts";
import { neuralPlanner } from "./neural/plan.ts";
import { cloneNeuralProfile } from "./neural/workflow.ts";
import { reverbPlanner } from "./reverb/plan.ts";
import { cloneReverbProfile } from "./reverb/workflow.ts";

type ClassClone = (options: { profilePath: string; outputDir: string; pluginName: string; log: Logger; signal?: AbortSignal }) => Promise<{ build: BuildResult }>;

/** Classes whose clones can be weighed against the network (EQ clones keep their own path: they are exact already). */
const CLASS_PATHS: Partial<Record<EffectClass, { planner: CapturePlanner; clone: ClassClone }>> = {
  dynamics: { planner: dynamicsPlanner, clone: cloneDynamicsProfile },
  distortion: { planner: distortionPlanner, clone: cloneDistortionProfile },
  delay: { planner: delayPlanner, clone: cloneDelayProfile },
  modulation: { planner: modulationPlanner, clone: cloneDelayProfile },
  reverb: { planner: reverbPlanner, clone: cloneReverbProfile },
};

export interface BestCloneOptions {
  plugin: string;
  outputDir: string;
  /** where the two measurements are saved (default: outputDir), and what their file names end with */
  profileDir?: string;
  profileSuffix?: string;
  /** training time of the network (default 20) */
  minutes?: number;
  install?: boolean;
  log: Logger;
  signal?: AbortSignal;
  /** the step that begins (for a progress display) */
  onStep?: (step: BestStep, title: string) => void;
  /** progress within the step: renders measured, training time, settings compared */
  onProgress?: (done: number, total: number, label: string) => void;
}

export type BestStep = "class-capture" | "class-clone" | "neural-capture" | "neural-clone" | "compare";

export interface BestCloneResult {
  name: string;
  effectClass?: EffectClass;
  results: CloneComparison[];
  best: CloneComparison;
  /** one or two sentences why the chosen clone won */
  explanation: string;
  vst3: string;
  lv2: string;
  installed: string[];
  /** the measurements made (network first) */
  profiles: string[];
}

/** class names as the user reads them */
export const ENGINE_NAMES: Partial<Record<EffectClass, string>> = {
  dynamics: "compressor engine", distortion: "distortion engine", delay: "delay engine", modulation: "modulation engine", reverb: "reverb engine",
};

/** Why the chosen clone won, in words: the sound measure decides, the waveform measure is put next to it. */
export function explainChoice(results: CloneComparison[], best: CloneComparison): string {
  const other = results.find((r) => r !== best);
  if (!other) return "Only one clone could be built, so it was taken.";
  const db = (r: CloneComparison) => `${r.spectralDb.median.toFixed(1)} dB`;
  const pct = (r: CloneComparison) => `${(r.esr.median * 100).toFixed(r.esr.median < 0.1 ? 1 : 0)} %`;
  const close = Math.abs(other.spectralDb.median - best.spectralDb.median) < 0.3;
  const sound = close
    ? `Both sound about equally close to the original (${db(best)} against ${db(other)} in the typical setting); the ${best.name} is slightly closer.`
    : `The ${best.name} sounds closer to the original: its spectrum deviates by ${db(best)} in the typical setting, the ${other.name}'s by ${db(other)}.`;
  const lacks = other.missing.length ? ` The ${other.name} also lacks ${other.missing.join(", ")}.` : "";
  const waveform = other.esr.median < best.esr.median
    ? ` The ${other.name} follows the waveform more closely (${pct(other)} against ${pct(best)} error) – ` +
      (best.name === "network" ? "yet misses part of the sound." : "a network matches the dry signal well but cannot hold long echoes, tails or a moving delay, which the ear notices first.")
    : ` It also follows the waveform more closely (${pct(best)} against ${pct(other)} error).`;
  return sound + waveform + lacks;
}

/**
 * Clones a plugin both ways – with the engine of its class (when it has one) and as a universal clone – renders both
 * with the same settings (the network's capture: all controls at random) and keeps the one closest in sound.
 * Delay and reverb engines win where a network cannot hold a long echo or tail; the network wins where a class
 * engine lacks a control or a behaviour. The class engine comes first: it is ready in minutes, the network trains.
 */
export async function cloneBest(options: BestCloneOptions): Promise<BestCloneResult> {
  const { log, signal } = options;
  const step = options.onStep ?? (() => {});
  const progress = options.onProgress;
  const info = await pluginInfo(options.plugin, signal ? { signal } : {});
  const name = info.plugin.name || basename(options.plugin).replace(/\.[^.]+$/, "");
  const pluginName = `${name} Clone`;
  const classified = classifyPlugin(info);
  const { reason } = classified;
  // tremolos and phasers have engines, but not as their default: here they are compared with the network
  let effectClass = classified.effectClass;
  if (!effectClass) {
    try {
      detectModulation(info.parameters, info.plugin.category, info.plugin.name);
      effectClass = "modulation";
    } catch {
      // no modulation effect either
    }
  }
  const classPath = effectClass ? CLASS_PATHS[effectClass] : undefined;
  const engineName = effectClass ? ENGINE_NAMES[effectClass] ?? `${effectClass} engine` : "";
  log("info", effectClass ? `${name}: class ${effectClass}${classPath ? ` – cloning with the ${engineName} and as a network` : " – its clone is not compared, network only"}` : `${name}: no class (${reason.slice(0, 120)}) – network only`);
  await mkdir(options.outputDir, { recursive: true });
  const profileDir = options.profileDir ?? options.outputDir;
  await mkdir(profileDir, { recursive: true });
  const slug = slugify(name);
  const common = { sampleRate: 48000, blockSize: 512, channels: 2, prerollSeconds: 0.5, plan: { ...DEFAULT_PLAN }, ...(signal ? { signal } : {}) };
  const renderProgress = (event: CaptureProgress) => {
    if (event.stage === "render") progress?.(event.done, event.total, event.id);
  };

  const candidates: CloneCandidate[] = [];
  const profiles: string[] = [];
  if (classPath && effectClass) {
    const classProfile = join(profileDir, `${slug}-${effectClass}${options.profileSuffix ?? ""}.vcprofile`);
    profiles.push(classProfile);
    step("class-capture", `Measuring for the ${engineName}`);
    await capture({ ...common, plugin: options.plugin, output: classProfile, planner: classPath.planner, tailSeconds: 2, onProgress: renderProgress });
    step("class-clone", `Building the ${engineName} clone`);
    const result = await classPath.clone({ profilePath: classProfile, outputDir: join(options.outputDir, effectClass), pluginName, log, ...(signal ? { signal } : {}) });
    candidates.push({ name: engineName, clonePath: result.build.lv2, profile: await readProfile(classProfile) });
  }

  // the network: its capture (all controls at random) is the common ground both clones are measured on
  const neuralProfile = join(profileDir, `${slug}-neural${options.profileSuffix ?? ""}.vcprofile`);
  step("neural-capture", "Measuring for the network (all controls at random)");
  await capture({ ...common, plugin: options.plugin, output: neuralProfile, planner: neuralPlanner, tailSeconds: classPath && (effectClass === "delay" || effectClass === "reverb" || effectClass === "modulation") ? 2 : 0.5, onProgress: renderProgress });
  step("neural-clone", "Training and building the network clone");
  const neural = await cloneNeuralProfile({
    profilePath: neuralProfile, outputDir: join(options.outputDir, "neural"), pluginName, log,
    ...(options.minutes ? { minutes: options.minutes } : {}), ...(signal ? { signal } : {}), ...(progress ? { onProgress: progress } : {}),
  });
  candidates.unshift({ name: "network", clonePath: neural.build.lv2, profile: await readProfile(neuralProfile) });

  const reference = await readProfile(neuralProfile);
  step("compare", "Comparing the clones on the same settings");
  const results = candidates.length > 1 ? await compareClones(reference, candidates, { log, ...(signal ? { signal } : {}) }) : [];
  if (results.length) for (const line of formatComparison(results)) log("info", line);
  const spectral = neural.verify?.spectralDb;
  const best = bestClone(results) ?? {
    name: "network", clonePath: neural.build.lv2,
    esr: { mean: neural.verify?.esr ?? NaN, median: neural.verify?.median ?? NaN },
    spectralDb: { mean: spectral?.mean ?? NaN, median: spectral?.median ?? NaN }, missing: [],
  };
  const explanation = results.length ? explainChoice(results, best) : "The plugin belongs to no class with an engine of its own: the network is the only clone.";

  // the chosen clone next to the candidates' folders, under the plain name
  const winner = best.clonePath === neural.build.lv2 ? neural.build : { vst3: best.clonePath.replace(/\.lv2$/, ".vst3"), lv2: best.clonePath };
  const vst3 = join(options.outputDir, basename(winner.vst3));
  const lv2 = join(options.outputDir, basename(winner.lv2));
  for (const [from, to] of [[winner.vst3, vst3], [winner.lv2, lv2]] as const) {
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
  }
  log("info", `Chosen: ${best.name} – ${explanation}`);
  const installed = options.install ? await installPlugins(vst3, lv2, log) : [];
  return { name, ...(effectClass ? { effectClass } : {}), results, best, explanation, vst3, lv2, installed, profiles: [neuralProfile, ...profiles] };
}
