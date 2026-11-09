import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  encodeWav,
  PROFILE_FORMAT,
  SCHEMA_VERSION,
  sha256Hex,
  writeProfile,
  type CaptureRender,
  type Profile,
} from "@vst-cloner/profile";
import { findHost, hostVersion, pluginInfo, runHost, type HostRenderMessage, type RenderJob } from "./host.ts";
import { planCaptures, resolveFixedValues, type PlanOptions } from "./plan.ts";
import { generateTestSignal } from "./signals.ts";

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
  /** "<parameter>=<value>" specs applied to every render, see resolveFixedValues. */
  set?: string[];
  notes?: string;
  hostPath?: string;
  /** Keep the temporary working directory (job file, WAVs) for debugging. */
  keepWorkDir?: boolean;
  onProgress?: (event: CaptureProgress) => void;
}

export type CaptureProgress =
  | { stage: "info"; plugin: string }
  | { stage: "plan"; parameters: number; selected: number; renders: number }
  | { stage: "workdir"; path: string }
  | { stage: "render"; done: number; total: number; id: string; milliseconds: number }
  | { stage: "write"; path: string };

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
  });

  if (info.mainOutputChannels === 0) throw new Error(`${info.plugin.name} has no audio output bus`);

  const planOptions = { ...options.plan, fixed: resolveFixedValues(info.parameters, options.set ?? []) };
  const plan = planCaptures(info.parameters, planOptions);
  progress({ stage: "plan", parameters: info.parameters.length, selected: plan.selected.length, renders: plan.renders.length });

  const signal = generateTestSignal({ sampleRate: options.sampleRate, channels: options.channels, seed: options.plan.seed });
  const workDir = await mkdtemp(join(tmpdir(), "vch-capture-"));
  progress({ stage: "workdir", path: workDir });

  try {
    await writeFile(join(workDir, "input.wav"), encodeWav(signal.audio));

    const job: RenderJob = {
      plugin: pluginPath,
      identifier: info.plugin.identifier,
      sampleRate: options.sampleRate,
      blockSize: options.blockSize,
      channels: options.channels,
      prerollSeconds: options.prerollSeconds,
      tailSeconds: options.tailSeconds,
      input: "input.wav",
      renders: plan.renders.map((r) => ({ id: r.id, params: r.params, output: `captures/${r.id}.wav` })),
    };
    await writeFile(join(workDir, "job.json"), JSON.stringify(job, null, 2));

    const results = new Map<string, HostRenderMessage>();
    await runHost(["render", join(workDir, "job.json")], {
      hostPath,
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
      files.set(file, await readFile(join(workDir, file)));
      renders.push({
        id: planned.id,
        file,
        kind: planned.kind,
        ...(planned.sweepParameter !== undefined ? { sweepParameter: planned.sweepParameter } : {}),
        params: result.params.map((p) => ({ index: p.index, value: Math.min(1, Math.max(0, p.value)), text: p.text })),
        latencySamples: result.latencySamples,
        peak: result.peak,
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
          prerollSeconds: options.prerollSeconds,
          tailSeconds: options.tailSeconds,
          plan: {
            points: options.plan.points,
            random: options.plan.random,
            seed: options.plan.seed,
            ...(options.plan.include ? { include: options.plan.include.source } : {}),
            ...(options.plan.exclude ? { exclude: options.plan.exclude.source } : {}),
            fixed: planOptions.fixed,
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
