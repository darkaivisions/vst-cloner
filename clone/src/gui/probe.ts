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
  /** editor while a 1 kHz sine of the given level runs through the plugin (level meters) */
  meter?: { levelDb: number; file: string }[];
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

/** a value text that is a plain number with an optional unit (continuous controls) */
const NUMERIC_TEXT = /^\s*[+-]?(\d+([.,]\d+)?|inf)\s*(db|%|ms|s|hz|khz|°|:\s*1|x)?\s*$/i;

/**
 * Steps of a parameter: declared steps, or – for plugins that report switches and menus as continuous –
 * the plateaus of its value texts (OFF/ON, Full/Masked/Unmasked …). Values are the middle of each plateau.
 */
export function parameterSteps(p: Parameter): { values: number[]; labels: string[] } | undefined {
  if (p.discrete && p.numSteps >= 2 && p.numSteps < 1000) {
    const values = Array.from({ length: p.numSteps }, (_, i) => i / (p.numSteps - 1));
    const labels = values.map((v) => p.texts?.reduce((best, t) => (Math.abs(t.value - v) < Math.abs(best.value - v) ? t : best)).text ?? String(v));
    return { values, labels };
  }
  const texts = [...(p.texts ?? [])].sort((a, b) => a.value - b.value);
  if (texts.length < 3) return undefined;
  const distinct = [...new Set(texts.map((t) => t.text))];
  const repeats = distinct.length < texts.length;
  if (!repeats || distinct.length > 12 || distinct.every((t) => NUMERIC_TEXT.test(t))) return undefined;
  const plateaus: { label: string; from: number; to: number }[] = [];
  for (const t of texts) {
    const last = plateaus[plateaus.length - 1];
    if (last && last.label === t.text) last.to = t.value;
    else plateaus.push({ label: t.text, from: t.value, to: t.value });
  }
  return { values: plateaus.map((q) => (q.from + q.to) / 2), labels: plateaus.map((q) => q.label) };
}

function alternative(p: Parameter): number {
  const v = baseValue(p);
  const steps = parameterSteps(p);
  if (steps) {
    // the next step that differs from the current one
    const current = steps.values.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(steps.values[best]! - v) ? i : best), 0);
    return steps.values[current + 1 < steps.values.length ? current + 1 : current - 1] ?? (v < 0.5 ? 0.85 : 0.15);
  }
  return v < 0.5 ? 0.85 : 0.15;
}

function sweep(p: Parameter): number[] {
  const steps = parameterSteps(p);
  if (steps) {
    const count = Math.min(steps.values.length, 8);
    return Array.from({ length: count }, (_, i) => steps.values[Math.round((i / Math.max(1, count - 1)) * (steps.values.length - 1))]!);
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
  /** also capture the editor with audio of these levels (dBFS, rising; first = silence reference) */
  meterLevels?: number[];
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
      discrete: parameterSteps(param) !== undefined,
      ...(parameterSteps(param) ? { options: parameterSteps(param)!.labels } : {}),
      pixels,
      frames: sweepOf(param).map((value, k) => ({ value, file: second!.shots.get(`p${param.index}_${k}`)!.file })),
    }));

    // level meters only move with audio: fresh instance, rising levels
    let meter: GuiProbe["meter"];
    if (options.meterLevels?.length) {
      const steps: GuiStep[] = options.meterLevels.map((levelDb, k) => ({ id: `meter${k}`, params: [], audio: { frequency: 1000, levelDb } }));
      const third = await runGuiSnapshot({
        plugin: options.plugin,
        ...(options.identifier ? { identifier: options.identifier } : {}),
        outputDir: passDir(3),
        steps,
        display,
        ...(options.signal ? { signal: options.signal } : {}),
        onShot: (_, done) => options.onProgress?.(done, steps.length, "Pegelanzeige aufzeichnen"),
      });
      if (third.width === width && third.height === height) {
        meter = options.meterLevels.map((levelDb, k) => ({ levelDb, file: third.shots.get(`meter${k}`)!.file }));
      }
    }

    const baseShot = (second ?? first).shots.get("base")!;
    return {
      width,
      height,
      base: baseShot.file,
      basePng: baseShot.png,
      base2: first.shots.get("base2")!.file,
      visible: probed,
      invisible,
      ...(meter ? { meter } : {}),
    };
  }, options.signal);
}
