import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Parameter } from "@vst-cloner/profile";
import type { Logger } from "../build.ts";
import { buildTable, detectEq, tableNorm, tableRange, type EqMapping } from "../eq/mapping.ts";
import { runGuiSnapshot, withVirtualDisplay, type GuiStep } from "./capture.ts";
import { countMask, diffMask, dilate, loadRaw } from "./image.ts";

export interface ProbeFrame {
  value: number;
  file: string;
}

export interface ProbedParameter {
  index: number;
  name: string;
  /** EQ band role of the template band (frequency, gain, …) */
  bandRole?: string;
  /** raw RGBA the frames are compared with (band switched on); default: the base image */
  reference?: string;
  discrete: boolean;
  /** display texts of discrete options */
  options?: string[];
  /** changed pixels in the first pass */
  pixels: number;
  frames: ProbeFrame[];
}

export interface GuiProbe {
  width: number;
  height: number;
  /** raw RGBA of the editor in its initial state */
  base: string;
  basePng: string;
  /** raw RGBA of a second capture of the initial state (animation noise) */
  base2: string;
  visible: ProbedParameter[];
  invisible: number[];
}

const MAX_CANDIDATES = 200;
const EXCLUDED = /bypass|analy[sz]er|display range|spectrum grab|receive midi|solo|freeze|^program$|preset/i;

/** Parameters worth probing: automatable, not meta; for multi-band EQs only the first band and global parameters. */
export function probeCandidates(parameters: Parameter[]): Parameter[] {
  let candidates = parameters.filter((p) => p.automatable && !p.meta && !EXCLUDED.test(p.name));
  try {
    const mapping = detectEq(parameters);
    const template = mapping.bands.find((b) => b.band === mapping.templateBand)!;
    const keep = new Set(Object.values(template.params));
    const bandNumber = /^(?:ex\s+)?band\s*(\d+)\b/i;
    candidates = candidates.filter((p) => {
      const match = bandNumber.exec(p.name);
      return !match || keep.has(p.index);
    });
  } catch {
    // not an EQ – probe everything
  }
  return candidates.slice(0, MAX_CANDIDATES);
}

const baseValue = (p: Parameter) => p.value ?? p.default;

interface EqProbeContext {
  mapping: EqMapping;
  /** role by parameter index of the template band */
  roles: Map<number, string>;
  /** template band switched on, gain +6 dB, 1 kHz */
  context: { index: number; value: number }[];
  /** physical targets for the axis calibration */
  frequencyValues?: number[];
  gainValues?: number[];
}

function eqContext(parameters: Parameter[]): EqProbeContext | undefined {
  let mapping: EqMapping;
  try {
    mapping = detectEq(parameters);
  } catch {
    return undefined;
  }
  const band = mapping.bands.find((b) => b.band === mapping.templateBand)!.params;
  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  const normOf = (index: number | undefined, value: number) => {
    if (index === undefined) return undefined;
    const table = mapping.tables[index] ?? buildTable(byIndex.get(index)!);
    if (!table) return undefined;
    const [lo, hi] = tableRange(table);
    return tableNorm(table, Math.min(hi, Math.max(lo, value)));
  };
  const context: { index: number; value: number }[] = [];
  if (band.enable !== undefined) context.push({ index: band.enable, value: mapping.enableValues?.on ?? 1 });
  const gain = normOf(band.gain, 6);
  if (gain !== undefined) context.push({ index: band.gain!, value: gain });
  const frequency = normOf(band.frequency, 1000);
  if (frequency !== undefined) context.push({ index: band.frequency!, value: frequency });
  const roles = new Map(Object.entries(band).map(([role, index]) => [index as number, role]));
  const frequencyValues = band.frequency !== undefined ? [50, 200, 1000, 5000, 15000].map((f) => normOf(band.frequency, f)!).filter((v) => v !== undefined) : undefined;
  const gainValues = band.gain !== undefined ? [-9, -4.5, 0, 4.5, 9].map((g) => normOf(band.gain, g)!).filter((v) => v !== undefined) : undefined;
  return { mapping, roles, context, ...(frequencyValues ? { frequencyValues } : {}), ...(gainValues ? { gainValues } : {}) };
}

function alternative(p: Parameter): number {
  const v = baseValue(p);
  if (p.discrete && p.numSteps >= 2 && p.numSteps < 1000) {
    const step = 1 / (p.numSteps - 1);
    return v + step <= 1 + 1e-6 ? Math.min(1, v + step) : Math.max(0, v - step);
  }
  return v < 0.5 ? 0.85 : 0.15;
}

function sweep(p: Parameter): number[] {
  if (p.discrete && p.numSteps >= 2 && p.numSteps < 1000) {
    const count = Math.min(p.numSteps, 8);
    return Array.from({ length: count }, (_, i) => Math.round((i / (count - 1)) * (p.numSteps - 1)) / (p.numSteps - 1));
  }
  return [0, 0.25, 0.5, 0.75, 1];
}

export interface ProbeOptions {
  plugin: string;
  identifier?: string;
  parameters: Parameter[];
  workDir: string;
  log: Logger;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
}

/**
 * "Wiggle test": changes every parameter and records which part of the editor reacts.
 * Pass 1 finds visible controls, pass 2 records several values of each visible control.
 */
export async function probeGui(options: ProbeOptions): Promise<GuiProbe> {
  const { log } = options;
  const candidates = probeCandidates(options.parameters);
  const passDir = (n: number) => join(options.workDir, `pass${n}`);
  const eq = eqContext(options.parameters);
  const withContext = (p: Parameter, value: number) =>
    eq?.roles.has(p.index) ? [...eq.context.filter((c) => c.index !== p.index), { index: p.index, value }] : [{ index: p.index, value }];
  const sweepOf = (p: Parameter) => {
    const role = eq?.roles.get(p.index);
    if (role === "frequency" && eq?.frequencyValues?.length) return eq.frequencyValues;
    if (role === "gain" && eq?.gainValues?.length) return eq.gainValues;
    return sweep(p);
  };

  return withVirtualDisplay(async (display) => {
    log("info", `Plugin-Oberfläche wird unsichtbar geöffnet – ${candidates.length} Parameter werden einzeln verstellt`);
    const pass1Steps: GuiStep[] = [
      { id: "base", params: [], png: true },
      { id: "base2", params: [] },
      ...(eq ? [{ id: "bandbase", params: eq.context }] : []),
      ...candidates.map((p) => ({ id: `p${p.index}`, params: withContext(p, alternative(p)) })),
    ];
    const first = await runGuiSnapshot({
      plugin: options.plugin,
      ...(options.identifier ? { identifier: options.identifier } : {}),
      outputDir: passDir(1),
      steps: pass1Steps,
      display,
      ...(options.signal ? { signal: options.signal } : {}),
      onShot: (_, done) => options.onProgress?.(done, pass1Steps.length, "Bedienelemente suchen"),
    });

    const { width, height } = first;
    for (const title of first.dialogs) log("warn", `Das Plugin hat ein zusätzliches Fenster geöffnet („${title}“) – es wurde für die Aufnahmen zur Seite geschoben`);
    const base = await loadRaw(first.shots.get("base")!.file, width, height);
    const base2 = await loadRaw(first.shots.get("base2")!.file, width, height);
    const noise = dilate(diffMask(base, base2), width, height, 2);
    const animated = countMask(noise);
    if (animated > 0) log("detail", `${animated} Pixel bewegen sich von selbst (Animation) und werden ignoriert`);

    const visible: { param: Parameter; pixels: number }[] = [];
    const invisible: number[] = [];
    const bandBase = eq ? await loadRaw(first.shots.get("bandbase")!.file, width, height) : undefined;
    for (const p of candidates) {
      const shot = first.shots.get(`p${p.index}`)!;
      const reference = eq?.roles.has(p.index) && bandBase ? bandBase : base;
      const pixels = countMask(diffMask(reference, await loadRaw(shot.file, width, height), 24, noise));
      await rm(shot.file, { force: true });
      if (pixels >= 12) visible.push({ param: p, pixels });
      else invisible.push(p.index);
    }
    log("info", `${visible.length} sichtbare Bedienelemente gefunden${invisible.length ? `, ${invisible.length} Parameter ohne sichtbare Reaktion` : ""}`);

    const pass2Steps: GuiStep[] = [{ id: "base", params: [], png: true }, ...(eq ? [{ id: "bandbase", params: eq.context }] : [])];
    for (const { param } of visible) {
      sweepOf(param).forEach((value, k) => pass2Steps.push({ id: `p${param.index}_${k}`, params: withContext(param, value) }));
    }

    const second = visible.length
      ? await runGuiSnapshot({
          plugin: options.plugin,
          ...(options.identifier ? { identifier: options.identifier } : {}),
          outputDir: passDir(2),
          steps: pass2Steps,
          display,
          ...(options.signal ? { signal: options.signal } : {}),
          onShot: (_, done) => options.onProgress?.(done, pass2Steps.length, "Bewegungen aufzeichnen"),
        })
      : undefined;

    const bandReference = second?.shots.get("bandbase")?.file;
    const probed: ProbedParameter[] = visible.map(({ param, pixels }) => ({
      index: param.index,
      name: param.name,
      ...(eq?.roles.has(param.index) ? { bandRole: eq.roles.get(param.index)!, ...(bandReference ? { reference: bandReference } : {}) } : {}),
      discrete: param.discrete && param.numSteps >= 2 && param.numSteps < 1000,
      ...(param.texts && param.discrete ? { options: param.texts.map((t) => t.text) } : {}),
      pixels,
      frames: sweepOf(param).map((value, k) => ({ value, file: second!.shots.get(`p${param.index}_${k}`)!.file })),
    }));

    const baseShot = (second ?? first).shots.get("base")!;
    return {
      width,
      height,
      base: baseShot.file,
      basePng: baseShot.png,
      base2: first.shots.get("base2")!.file,
      visible: probed,
      invisible,
    };
  }, options.signal);
}
