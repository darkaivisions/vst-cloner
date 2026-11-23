import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeWav,
  encodeCapture,
  encodeWav,
  PROFILE_FORMAT,
  SCHEMA_VERSION,
  sha256Hex,
  writeProfile,
  type CaptureRender,
  type Parameter,
  type Profile,
} from "@vst-cloner/profile";
import { findHost, hostVersion, pluginInfo, runHost, type HostInfo, type HostMessage, type HostRenderMessage, type RenderJob } from "./host.ts";
import { planCaptures, PlanTooLargeError, resolveFixedValues, type CapturePlan, type FixedValue, type MeasuredSteps, type PlanOptions } from "./plan.ts";
import { generateTestSignal, type SignalPreset } from "./signals.ts";

export const GENERATOR = { name: "vst-cloner", version: "0.1.0" };

export interface CaptureOptions {
  plugin: string;
  output: string;
  identifier?: string;
  sampleRate: number;
  blockSize: number;
  channels: number;
  prerollSeconds: number;
  tailSeconds: number;
  plan: PlanOptions;
  /** Effect-class specific plan (replaces the generic sweep plan). */
  planner?: CapturePlanner;
  /** "<parameter>=<value>" specs applied to every render, see resolveFixedValues. */
  set?: string[];
  notes?: string;
  hostPath?: string;
  /** Keep the temporary working directory (job file, WAVs) for debugging. */
  keepWorkDir?: boolean;
  onProgress?: (event: CaptureProgress) => void;
  /** aborts the capture (kills vch-host) */
  signal?: AbortSignal;
}

export type CaptureProgress =
  | { stage: "info"; plugin: string }
  | { stage: "probe"; candidates: number; chosen: number; workingPoint: FixedValue[] }
  /** a preliminary step starts: its renders are not part of the plan and not counted by "render" */
  | { stage: "begin"; step: "repeat" | "probe" | "survey"; renders: number }
  | { stage: "step"; step: "repeat" | "probe" | "survey"; done: number; total: number }
  | { stage: "repeat"; repeatable: boolean }
  | { stage: "retry"; reason: string }
  /** the plugin was still settling after loading (switch-on thump): renders get a longer pre-roll */
  | { stage: "settle"; prerollSeconds: number }
  | { stage: "survey"; renders: number; stepped: { index: number; positions: number }[] }
  | { stage: "plan"; parameters: number; selected: number; renders: number }
  | { stage: "workdir"; path: string }
  | { stage: "render"; done: number; total: number; id: string; milliseconds: number }
  | { stage: "write"; path: string };

/** A capture planner for a specific effect class (e.g. EQ). */
export interface CapturePlanner {
  name: string;
  signalPreset: SignalPreset;
  /** the test signal for this plugin, where it depends on it (else signalPreset) */
  signalFor?(info: HostInfo): SignalPreset;
  plan(info: HostInfo, options: PlanOptions): CapturePlan;
  /**
   * Optional probe before planning: a few candidate settings are rendered with the test signal and the
   * planner chooses the one to measure around (returned as `workingPoint` of the plan options).
   * The first candidate is the initial state of the plugin (no values).
   */
  probe?(info: HostInfo, options: PlanOptions): CaptureProbe | undefined;
  /**
   * Optional survey after the probe: settings rendered with the test signal from which the planner learns
   * what it cannot read off the parameter list – controls that move in steps (returned as `steps` of the plan
   * options).
   */
  survey?(info: HostInfo, options: PlanOptions): CaptureSurvey | undefined;
}

export interface CaptureSurvey {
  renders: FixedValue[][];
  /** `outputs[i]` is the first channel of render i */
  evaluate(outputs: Float32Array[], input: Float32Array, sampleRate: number): MeasuredSteps[];
}

export interface CaptureProbe {
  candidates: FixedValue[][];
  /** index of the chosen candidate; `outputs[i]` is the first channel of candidate i */
  choose(outputs: Float32Array[], input: Float32Array, sampleRate: number): number;
}

/** longest pre-roll given to a plugin that settles slowly after loading */
const MAX_PREROLL_SECONDS = 8;

/**
 * A render as stored in the profile: mono when all channels are bit-identical (halves the size for stereo-linked
 * effects), 24-bit PCM scaled to its peak (see encodeCapture).
 */
export function packCapture(bytes: Uint8Array): { bytes: Uint8Array; mono: boolean; scale: number } {
  const audio = decodeWav(bytes);
  const [first, ...rest] = audio.channels;
  const mono = !!first && rest.length > 0 && rest.every((channel) => channel.every((v, i) => v === first[i]));
  const packed = encodeCapture(mono ? { sampleRate: audio.sampleRate, channels: [first!] } : audio);
  return { ...packed, mono };
}

/** SHA-256 of a plugin file, or of a bundle directory (sorted relative paths + file hashes). */
export async function hashPluginPath(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) return sha256Hex(await readFile(path));

  const files = (await readdir(path, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  const lines: string[] = [];
  for (const file of files) {
    lines.push(`${sha256Hex(await readFile(file))}  ${relative(path, file).split(sep).join("/")}`);
  }
  return sha256Hex(lines.join("\n"));
}

export async function capture(options: CaptureOptions): Promise<Profile> {
  const hostPath = options.hostPath ?? findHost();
  const progress = options.onProgress ?? (() => {});
  const pluginPath = resolve(options.plugin);

  progress({ stage: "info", plugin: pluginPath });
  const info = await pluginInfo(pluginPath, {
    hostPath,
    sampleRate: options.sampleRate,
    channels: options.channels,
    ...(options.identifier ? { identifier: options.identifier } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (info.mainOutputChannels === 0) throw new Error(`${info.plugin.name} has no audio output bus`);

  const planOptions: PlanOptions = { ...options.plan, fixed: resolveFixedValues(info.parameters, options.set ?? []) };
  // fails early when the plugin is not of the planner's class
  const firstPlan = options.planner ? options.planner.plan(info, planOptions) : planCaptures(info.parameters, planOptions);
  if (firstPlan.renders.length > planOptions.maxRenders) throw new PlanTooLargeError(firstPlan.renders.length, planOptions.maxRenders);

  const signal = generateTestSignal({
    sampleRate: options.sampleRate,
    channels: options.channels,
    seed: options.plan.seed,
    preset: options.planner?.signalFor?.(info) ?? options.planner?.signalPreset ?? "full",
  });
  const workDir = await mkdtemp(join(tmpdir(), "vch-capture-"));
  progress({ stage: "workdir", path: workDir });

  try {
    await writeFile(join(workDir, "input.wav"), encodeWav(signal.audio));
    const jobBase: Omit<RenderJob, "renders"> = {
      plugin: pluginPath,
      identifier: info.plugin.identifier,
      sampleRate: options.sampleRate,
      blockSize: options.blockSize,
      channels: options.channels,
      prerollSeconds: options.prerollSeconds,
      tailSeconds: options.tailSeconds,
      input: "input.wav",
    };

    // With a fresh instance per render a job loads and unloads the plugin hundreds of times, and some plugins
    // crash at that once in a while: such a job gets a second attempt.
    const render: typeof runHost = async (args, hostOptions) => {
      try {
        return await runHost(args, hostOptions);
      } catch (error) {
        if (!jobBase.isolate || options.signal?.aborted) throw error;
        progress({ stage: "retry", reason: (error as Error).message.slice(0, 200) });
        return await runHost(args, hostOptions);
      }
    };

    // renders of a preliminary step, counted as they arrive
    const counted = (step: "repeat" | "probe" | "survey", total: number) => {
      let done = 0;
      return (message: HostMessage) => {
        if (message.type === "render") progress({ stage: "step", step, done: ++done, total });
      };
    };

    // Repeatability: the initial state again and again, with one measured control after the other moved to
    // other values in between. If the renders of the initial state differ, the plugin keeps state that is no parameter value
    // (a button that toggles on every press): its renders depend on their order, and every one gets a fresh
    // instance instead.
    if (firstPlan.selected.length > 0) {
      const fixed = planOptions.fixed ?? [];
      const initial = (p: Parameter) => p.value ?? p.default;
      // every control on its own (a toggle shows when it alone is pressed), at a few values each
      const values = (p: Parameter) => (initial(p) < 0.5 ? [1, 0.02, 0.6] : [0, 0.98, 0.4]);
      const settings = [[...fixed], ...firstPlan.selected.slice(0, 64).flatMap((p) => values(p).flatMap((value) => [[...fixed, { index: p.index, value }], [...fixed]]))];
      const repeatJob: RenderJob = { ...jobBase, renders: settings.map((params, i) => ({ id: `q${i}`, params, output: `repeat/q${i}.wav` })) };
      progress({ stage: "begin", step: "repeat", renders: settings.length });
      await mkdir(join(workDir, "repeat"), { recursive: true });
      await writeFile(join(workDir, "repeat.json"), JSON.stringify(repeatJob, null, 2));
      await runHost(["render", join(workDir, "repeat.json")], { hostPath, ...(options.signal ? { signal: options.signal } : {}), onMessage: counted("repeat", settings.length) });
      const before = decodeWav(await readFile(join(workDir, "repeat", "q0.wav"))).channels[0]!;
      let peak = 0, difference = 0;
      for (const v of before) peak = Math.max(peak, Math.abs(v));
      for (let k = 2; k < settings.length; k += 2) {
        const again = decodeWav(await readFile(join(workDir, "repeat", `q${k}.wav`))).channels[0]!;
        for (let i = 0; i < before.length; i++) difference = Math.max(difference, Math.abs(before[i]! - (again[i] ?? 0)));
      }
      const repeatable = !(difference > 1e-3 * Math.max(peak, 1e-6));
      progress({ stage: "repeat", repeatable });
      if (!repeatable) jobBase.isolate = true;

      // Settling: output that decays while the input is still silent is no answer to the test signal (bias and
      // coupling capacitors of a circuit model charging after the reset). The pre-roll is made long enough for
      // it to fall below -100 dBFS; steady noise does not decay and stays as it is.
      const lead = signal.set.segments[0];
      if (lead?.kind === "silence" && lead.start === 0 && lead.length >= 512) {
        const half = Math.floor(lead.length / 2);
        const peakDb = (from: number) => {
          let m = 0;
          for (let i = from; i < from + half; i++) m = Math.max(m, Math.abs(before[i] ?? 0));
          return 20 * Math.log10(m + 1e-12);
        };
        const early = peakDb(0), late = peakDb(half);
        const rate = (early - late) / (half / options.sampleRate); // dB per second
        if (late > -100 && rate > 5) {
          const prerollSeconds = Math.min(MAX_PREROLL_SECONDS, Math.ceil((options.prerollSeconds + ((late + 100) / rate) * 1.25) * 10) / 10);
          if (prerollSeconds > jobBase.prerollSeconds) {
            jobBase.prerollSeconds = prerollSeconds;
            progress({ stage: "settle", prerollSeconds });
          }
        }
      }
    }

    // probe: the planner looks at a few candidate settings and picks the one to measure around
    let plan = firstPlan;
    const probe = options.planner?.probe?.(info, planOptions);
    if (probe && probe.candidates.length > 1) {
      const fixed = planOptions.fixed ?? [];
      const probeJob: RenderJob = {
        ...jobBase,
        renders: probe.candidates.map((values, i) => ({ id: `p${i}`, params: [...fixed, ...values], output: `probe/p${i}.wav` })),
      };
      progress({ stage: "begin", step: "probe", renders: probe.candidates.length });
      await mkdir(join(workDir, "probe"), { recursive: true });
      await writeFile(join(workDir, "probe.json"), JSON.stringify(probeJob, null, 2));
      await render(["render", join(workDir, "probe.json")], { hostPath, ...(options.signal ? { signal: options.signal } : {}), onMessage: counted("probe", probe.candidates.length) });
      const outputs: Float32Array[] = [];
      for (let i = 0; i < probe.candidates.length; i++) outputs.push(decodeWav(await readFile(join(workDir, "probe", `p${i}.wav`))).channels[0]!);
      const chosen = probe.choose(outputs, signal.audio.channels[0]!, options.sampleRate);
      const workingPoint = probe.candidates[chosen] ?? [];
      progress({ stage: "probe", candidates: probe.candidates.length, chosen, workingPoint });
      if (workingPoint.length) {
        planOptions.workingPoint = workingPoint;
        plan = options.planner!.plan(info, planOptions);
        if (plan.renders.length > planOptions.maxRenders) throw new PlanTooLargeError(plan.renders.length, planOptions.maxRenders);
      }
    }
    // survey: controls that move in steps although the plugin reports them as continuous
    const survey = options.planner?.survey?.(info, planOptions);
    if (survey && survey.renders.length > 0) {
      const fixed = planOptions.fixed ?? [];
      const surveyJob: RenderJob = {
        ...jobBase,
        renders: survey.renders.map((values, i) => ({ id: `s${i}`, params: [...fixed, ...values], output: `survey/s${i}.wav` })),
      };
      progress({ stage: "begin", step: "survey", renders: survey.renders.length });
      await mkdir(join(workDir, "survey"), { recursive: true });
      await writeFile(join(workDir, "survey.json"), JSON.stringify(surveyJob, null, 2));
      await render(["render", join(workDir, "survey.json")], { hostPath, ...(options.signal ? { signal: options.signal } : {}), onMessage: counted("survey", survey.renders.length) });
      const outputs: Float32Array[] = [];
      for (let i = 0; i < survey.renders.length; i++) outputs.push(decodeWav(await readFile(join(workDir, "survey", `s${i}.wav`))).channels[0]!);
      const steps = survey.evaluate(outputs, signal.audio.channels[0]!, options.sampleRate);
      progress({ stage: "survey", renders: survey.renders.length, stepped: steps.map((s) => ({ index: s.index, positions: s.values.length })) });
      if (steps.length) {
        planOptions.steps = steps;
        plan = options.planner!.plan(info, planOptions);
        if (plan.renders.length > planOptions.maxRenders) throw new PlanTooLargeError(plan.renders.length, planOptions.maxRenders);
      }
    }
    progress({ stage: "plan", parameters: info.parameters.length, selected: plan.selected.length, renders: plan.renders.length });

    const job: RenderJob = {
      ...jobBase,
      renders: plan.renders.map((r) => ({ id: r.id, params: r.params, output: `captures/${r.id}.wav` })),
    };
    await writeFile(join(workDir, "job.json"), JSON.stringify(job, null, 2));

    const results = new Map<string, HostRenderMessage>();
    await render(["render", join(workDir, "job.json")], {
      hostPath,
      ...(options.signal ? { signal: options.signal } : {}),
      onMessage: (message) => {
        if (message.type !== "render") return;
        results.set(message.id, message);
        progress({ stage: "render", done: results.size, total: plan.renders.length, id: message.id, milliseconds: message.milliseconds });
      },
    });

    const files = new Map<string, Uint8Array>();
    const renders: CaptureRender[] = [];

    for (const planned of plan.renders) {
      const result = results.get(planned.id);
      if (!result) throw new Error(`vch-host did not render ${planned.id}`);
      const file = `captures/${planned.id}.wav`;
      const { bytes, mono, scale } = packCapture(await readFile(join(workDir, file)));
      files.set(file, bytes);
      renders.push({
        id: planned.id,
        file,
        kind: planned.kind,
        ...(planned.sweepParameter !== undefined ? { sweepParameter: planned.sweepParameter } : {}),
        ...(planned.purpose ? { purpose: planned.purpose } : {}),
        ...(planned.label ? { label: planned.label } : {}),
        params: result.params.map((p) => ({ index: p.index, value: Math.min(1, Math.max(0, p.value)), text: p.text })),
        latencySamples: result.latencySamples,
        peak: result.peak,
        ...(mono ? { mono: true } : {}),
        scale,
      });
    }

    const { plugin } = info;
    const profile: Profile = {
      manifest: {
        format: PROFILE_FORMAT,
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        generator: GENERATOR,
        plugin: {
          name: plugin.name,
          descriptiveName: plugin.descriptiveName,
          manufacturer: plugin.manufacturer,
          version: plugin.version,
          format: plugin.format,
          category: plugin.category,
          identifier: plugin.identifier,
          uniqueId: plugin.uniqueId,
          isInstrument: plugin.isInstrument,
          mainInputChannels: info.mainInputChannels,
          mainOutputChannels: info.mainOutputChannels,
          latencySamples: info.latencySamples,
          tailSeconds: info.tailSeconds,
          file: { name: basename(pluginPath), sha256: await hashPluginPath(pluginPath) },
        },
        capture: {
          host: { name: "vch-host", version: await hostVersion(hostPath) },
          os: `${platform()}-${arch()} ${release()}`,
          sampleRate: options.sampleRate,
          blockSize: options.blockSize,
          channels: options.channels,
          prerollSeconds: jobBase.prerollSeconds,
          tailSeconds: options.tailSeconds,
          plan: {
            planner: options.planner?.name ?? "generic",
            points: options.plan.points,
            random: options.plan.random,
            seed: options.plan.seed,
            ...(options.plan.include ? { include: options.plan.include.source } : {}),
            ...(options.plan.exclude ? { exclude: options.plan.exclude.source } : {}),
            fixed: planOptions.fixed,
            ...(planOptions.workingPoint?.length ? { workingPoint: planOptions.workingPoint } : {}),
            ...(planOptions.steps?.length ? { steps: planOptions.steps } : {}),
            ...(jobBase.isolate ? { isolated: true } : {}),
            selectedParameters: plan.selected.map((p) => p.index),
          },
        },
        ...(options.notes ? { notes: options.notes } : {}),
      },
      parameters: { parameters: info.parameters },
      testSignals: signal.set,
      captures: { renders },
      files,
    };

    progress({ stage: "write", path: options.output });
    await writeProfile(options.output, profile);
    return profile;
  } finally {
    if (!options.keepWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}
