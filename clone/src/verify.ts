import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInfo, regenerateTestSignal, runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav, type Profile } from "@vst-cloner/profile";
import { cascadeDb } from "./dsp/biquad.ts";
import { findSegment, logGrid, magnitudeDb, maxDifference, rmsDifference } from "./dsp/response.ts";
import { extractObservations } from "./eq/fit.ts";
import { bandSections, type EqModel, type FitStats } from "./eq/model.ts";
import { cloneParameters } from "./eq/params.ts";
import type { Logger } from "./build.ts";

export interface VerifyShapeResult extends FitStats {
  label: string;
}

export interface VerifyReport {
  clone: string;
  renders: number;
  /** clone vs. original for all settings the model supports exactly */
  overall: FitStats;
  /** settings with unsupported shapes or approximated slopes */
  limited: (FitStats & { labels: string[] }) | undefined;
  shapes: VerifyShapeResult[];
  worst: { label: string; rmsDb: number; maxDb: number }[];
  /** clone vs. TypeScript model – detects differences between the C++ engine and the reference */
  engineMaxDb: number;
  engineWorst: string;
}

function summarize(rows: { rms: number; max: number }[]): FitStats {
  return {
    renders: rows.length,
    rmsDb: rows.reduce((s, r) => s + r.rms, 0) / Math.max(rows.length, 1),
    maxDb: rows.reduce((m, r) => Math.max(m, r.max), 0),
  };
}

/** Renders the clone with every captured setting and compares it with the original. */
export async function verifyClone(profile: Profile, model: EqModel, clonePath: string, options: { log: Logger; hostPath?: string }): Promise<VerifyReport> {
  const { log } = options;
  const sampleRate = profile.manifest.capture.sampleRate;
  const parameters = profile.parameters.parameters;
  const grid = logGrid(sampleRate);

  const info = await pluginInfo(clonePath, { sampleRate, ...(options.hostPath ? { hostPath: options.hostPath } : {}) });
  const cloneIndexByName = new Map(info.parameters.map((p) => [p.name, p.index]));
  const toClone = new Map<number, { index: number; toggle: boolean }>();
  for (const param of cloneParameters(model, parameters)) {
    const index = cloneIndexByName.get(param.name);
    if (index === undefined) throw new Error(`clone has no parameter '${param.name}'`);
    toClone.set(param.original, { index, toggle: param.kind === "toggle" });
  }

  const on = model.mapping.enableValues?.on ?? 1;
  const renders = profile.captures.renders.filter((r) => r.purpose === "train" || r.purpose === "validate");
  const job: RenderJob = {
    plugin: clonePath,
    sampleRate,
    blockSize: profile.manifest.capture.blockSize,
    channels: 1,
    prerollSeconds: 0.1,
    tailSeconds: profile.manifest.capture.tailSeconds,
    input: "input.wav",
    renders: renders.map((r) => ({
      id: r.id,
      output: `out/${r.id}.wav`,
      params: r.params.flatMap((p) => {
        const target = toClone.get(p.index);
        if (!target) return [];
        return [{ index: target.index, value: target.toggle ? (Math.abs(p.value - on) < 0.5 ? 1 : 0) : p.value }];
      }),
    })),
  };

  const workDir = await mkdtemp(join(tmpdir(), "vch-verify-"));
  try {
    const { audio } = regenerateTestSignal(profile.testSignals);
    await writeFile(join(workDir, "input.wav"), encodeWav({ sampleRate: audio.sampleRate, channels: [audio.channels[0]!] }));
    await writeFile(join(workDir, "job.json"), JSON.stringify(job));

    log("info", `Rendering the clone with ${renders.length} captured settings …`);
    let done = 0;
    await runHost(["render", join(workDir, "job.json")], {
      ...(options.hostPath ? { hostPath: options.hostPath } : {}),
      onMessage: (m) => {
        if (m.type === "render" && ++done % 25 === 0) log("detail", `rendered ${done}/${renders.length}`);
      },
    });

    const impulse = findSegment(profile, "impulse");
    const amplitude = impulse.params?.amplitude ?? 1;
    const observations = extractObservations(profile, model.mapping, grid, new Float64Array(grid.length).fill(model.baselineDb));
    const fits = new Map(model.shapes.map((s) => [s.label, s.fit]));

    const rows: { label: string; shape: string; rms: number; max: number; limited: boolean }[] = [];
    let engineMaxDb = 0;
    let engineWorst = "";

    for (const o of observations) {
      const wav = decodeWav(await readFile(join(workDir, "out", `${o.renderId}.wav`)));
      const ir = wav.channels[0]!.slice(impulse.start, impulse.start + impulse.length).map((v) => v / amplitude);
      const cloneDb = magnitudeDb(ir, sampleRate, grid);
      const fit = fits.get(o.shapeLabel);
      rows.push({
        label: o.label,
        shape: o.shapeLabel,
        rms: rmsDifference(cloneDb, o.measuredDb),
        max: maxDifference(cloneDb, o.measuredDb),
        limited: !fit || o.approximate,
      });

      const predicted = fit && !o.approximate ? cascadeDb(bandSections(o.settings, fit, sampleRate), sampleRate, grid) : undefined;
      const engineDifference = predicted ? maxDifference(predicted, cloneDb) : 0;
      if (engineDifference > engineMaxDb) {
        engineMaxDb = engineDifference;
        engineWorst = o.label;
      }
    }

    const exact = rows.filter((r) => !r.limited);
    const limitedRows = rows.filter((r) => r.limited);
    const shapes = [...new Set(exact.map((r) => r.shape))].map((label) => ({ label, ...summarize(exact.filter((r) => r.shape === label)) }));
    const worst = [...exact].sort((a, b) => b.rms - a.rms).slice(0, 5).map((r) => ({ label: r.label, rmsDb: r.rms, maxDb: r.max }));
    const limited = limitedRows.length > 0 ? { ...summarize(limitedRows), labels: [...new Set(limitedRows.map((r) => r.shape))] } : undefined;

    return { clone: clonePath, renders: rows.length, overall: summarize(exact), limited, shapes, worst, engineMaxDb, engineWorst };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
