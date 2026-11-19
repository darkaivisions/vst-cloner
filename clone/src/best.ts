import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { capture, DEFAULT_PLAN, pluginInfo, type CapturePlanner } from "@vst-cloner/capture";
import { readProfile } from "@vst-cloner/profile";
import { installPlugins, slugify, type BuildResult, type Logger } from "./build.ts";
import { classifyPlugin, type EffectClass } from "./batch.ts";
import { bestClone, compareClones, formatComparison, type CloneCandidate, type CloneComparison } from "./compare.ts";
import { delayPlanner } from "./delay/plan.ts";
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
  reverb: { planner: reverbPlanner, clone: cloneReverbProfile },
};

export interface BestCloneOptions {
  plugin: string;
  outputDir: string;
  /** training time of the network (default 20) */
  minutes?: number;
  install?: boolean;
  log: Logger;
  signal?: AbortSignal;
}

export interface BestCloneResult {
  effectClass?: EffectClass;
  results: CloneComparison[];
  best: CloneComparison;
  vst3: string;
  lv2: string;
  installed: string[];
}

/**
 * Clones a plugin both ways – with the engine of its class (when it has one) and as a universal clone – renders both
 * with the same settings (the network's capture: all controls at random) and keeps the one closest in sound.
 * Delay and reverb engines win where a network cannot hold a long echo or tail; the network wins where a class
 * engine lacks a control or a behaviour.
 */
export async function cloneBest(options: BestCloneOptions): Promise<BestCloneResult> {
  const { log, signal } = options;
  const info = await pluginInfo(options.plugin, signal ? { signal } : {});
  const name = info.plugin.name || basename(options.plugin).replace(/\.[^.]+$/, "");
  const pluginName = `${name} Clone`;
  const { effectClass, reason } = classifyPlugin(info);
  const classPath = effectClass ? CLASS_PATHS[effectClass] : undefined;
  log("info", effectClass ? `${name}: class ${effectClass}${classPath ? " – cloning with its engine and as a network" : " – its clone is not compared, network only"}` : `${name}: no class (${reason.slice(0, 120)}) – network only`);
  await mkdir(options.outputDir, { recursive: true });
  const slug = slugify(name);
  const common = { sampleRate: 48000, blockSize: 512, channels: 2, prerollSeconds: 0.5, plan: { ...DEFAULT_PLAN }, ...(signal ? { signal } : {}) };

  const candidates: CloneCandidate[] = [];
  // the network: its capture (all controls at random) is the common ground both clones are measured on
  const neuralProfile = join(options.outputDir, `${slug}-neural.vcprofile`);
  log("info", "Capturing for the universal clone …");
  await capture({ ...common, plugin: options.plugin, output: neuralProfile, planner: neuralPlanner, tailSeconds: classPath && (effectClass === "delay" || effectClass === "reverb") ? 2 : 0.5 });
  const neural = await cloneNeuralProfile({
    profilePath: neuralProfile, outputDir: join(options.outputDir, "neural"), pluginName, log,
    ...(options.minutes ? { minutes: options.minutes } : {}), ...(signal ? { signal } : {}),
  });
  candidates.push({ name: "network", clonePath: neural.build.lv2, profile: await readProfile(neuralProfile) });

  if (classPath && effectClass) {
    const classProfile = join(options.outputDir, `${slug}-${effectClass}.vcprofile`);
    log("info", `Capturing for the ${effectClass} engine …`);
    await capture({ ...common, plugin: options.plugin, output: classProfile, planner: classPath.planner, tailSeconds: 2 });
    const result = await classPath.clone({ profilePath: classProfile, outputDir: join(options.outputDir, effectClass), pluginName, log, ...(signal ? { signal } : {}) });
    candidates.push({ name: `${effectClass} engine`, clonePath: result.build.lv2, profile: await readProfile(classProfile) });
  }

  const reference = await readProfile(neuralProfile);
  const results = candidates.length > 1 ? await compareClones(reference, candidates, { log, ...(signal ? { signal } : {}) }) : [];
  if (results.length) for (const line of formatComparison(results)) log("info", line);
  const best = bestClone(results) ?? { name: "network", clonePath: neural.build.lv2, esr: { mean: neural.verify?.esr ?? NaN, median: neural.verify?.median ?? NaN }, spectralDb: { mean: NaN, median: NaN }, missing: [] };

  // the chosen clone next to the candidates' folders, under the plain name
  const winner = best.clonePath === neural.build.lv2 ? neural.build : { vst3: best.clonePath.replace(/\.lv2$/, ".vst3"), lv2: best.clonePath };
  const vst3 = join(options.outputDir, basename(winner.vst3));
  const lv2 = join(options.outputDir, basename(winner.lv2));
  for (const [from, to] of [[winner.vst3, vst3], [winner.lv2, lv2]] as const) {
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
  }
  log("info", `Chosen: ${best.name} – ${vst3}`);
  const installed = options.install ? await installPlugins(vst3, lv2, log) : [];
  return { ...(effectClass ? { effectClass } : {}), results, best, vst3, lv2, installed };
}
