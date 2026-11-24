/**
 * Editor recognition bench: probes of real plugin editors (saved once, see probeGui) analysed again and scored
 * against hand-made labels – which displays and controls an editor has and where. Every change to the recognition
 * shows in the numbers, for all editors at once, instead of in the one plugin that was looked at.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginInfo } from "@vst-cloner/capture";
import type { Logger } from "../build.ts";
import { analyzeGui } from "./analyze.ts";
import type { Display, GuiModel } from "./model.ts";
import { loadRaw } from "./image.ts";
import { loadProbe, probeGui, type GuiProbe } from "./probe.ts";
import { renderSvg } from "./svg.ts";
import { ssim } from "./workflow.ts";

/** Display types in the labels; the analysis's kinds are mapped onto them (benchKind). */
export type BenchDisplayKind = "curve" | "meter" | "eq" | "analyzer" | "other";

export interface BenchLabels {
  /** plugin bundle and, for bundles with several plugins, its identifier */
  plugin: string;
  identifier?: string;
  /** editor size the boxes refer to */
  width: number;
  height: number;
  displays: { kind: BenchDisplayKind; box: [number, number, number, number]; note?: string }[];
  /** controls by parameter name; kind as in ControlKind (rotary, slider-h, slider-v, toggle, choice, value) */
  controls: { param: string; kind: string }[];
}

export const benchProbeRoot = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "vst-cloner", "gui-bench");
export const benchLabelDir = () => fileURLToPath(new URL("../../test/gui-bench/", import.meta.url));

/** sine levels of the meter pass (dBFS; first = silence) */
const METER_LEVELS = [-80, -30, -18, -6];

/** Opens the editor of a plugin and saves a probe for the bench (with the meter pass). */
export async function captureBenchProbe(name: string, plugin: string, identifier: string | undefined, log: Logger): Promise<string> {
  const info = await pluginInfo(plugin, identifier ? { identifier } : {});
  const workDir = join(benchProbeRoot(), name);
  await probeGui({ plugin, ...(identifier ? { identifier } : {}), parameters: info.parameters, workDir, log, meterLevels: METER_LEVELS });
  return workDir;
}

/** The analysis's display kinds in the terms of the labels. */
export function benchKind(display: Display): BenchDisplayKind {
  if (display.kind === "meter" || display.kind === "bar") return "meter";
  if (display.kind === "eq") return "eq";
  return display.role ?? "other";
}

/**
 * How much two boxes are the same thing: the share of the smaller one inside the larger. A meter's needle sweeps
 * only part of the instrument it sits in, a curve may be detected without its axis labels – containment counts.
 */
const overlap = (a: [number, number, number, number], b: { x: number; y: number; w: number; h: number }) => {
  const x0 = Math.max(a[0], b.x), y0 = Math.max(a[1], b.y), x1 = Math.min(a[0] + a[2], b.x + b.w), y1 = Math.min(a[1] + a[3], b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / Math.max(1, Math.min(a[2] * a[3], b.w * b.h));
};

export interface BenchScore {
  name: string;
  displays: { expected: number; found: number; rightKind: number; extra: number; misses: string[]; wrong: string[] };
  controls: { expected: number; found: number; rightKind: number; extra: number; misses: string[]; wrong: string[] };
  /** how much the rebuilt editor looks like the original (rendered from its SVG), 0…1 */
  look?: { structure: number; color: number };
}

let renderTools: boolean | undefined;
const hasTool = (tool: string) => {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * The rebuilt editor drawn from its SVG (same drawing rules as the clone's editor) against the original's
 * picture: structural similarity (SSIM) and mean colour similarity. Needs rsvg-convert and ImageMagick; without
 * them there is no score.
 */
export async function lookScore(probe: GuiProbe, model: GuiModel): Promise<BenchScore["look"]> {
  renderTools ??= hasTool("rsvg-convert") && hasTool("magick");
  if (!renderTools) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "vch-look-"));
  try {
    await writeFile(join(dir, "clone.svg"), renderSvg(model));
    execFileSync("rsvg-convert", ["-w", String(probe.width), "-h", String(probe.height), "-b", "black", join(dir, "clone.svg"), "-o", join(dir, "clone.png")]);
    execFileSync("magick", [join(dir, "clone.png"), "-depth", "8", `rgba:${join(dir, "clone.rgba")}`]);
    const a = await loadRaw(probe.base, probe.width, probe.height);
    const b = await loadRaw(join(dir, "clone.rgba"), probe.width, probe.height);
    let total = 0;
    for (let i = 0; i < a.data.length; i += 4) total += (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!)) / 3;
    return { structure: Math.max(0, ssim(a, b)), color: 1 - total / (a.data.length / 4) / 255 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Labels against an analysed editor: a display is found where a detected one lies at least half inside it (or it inside that). */
export function scoreGui(name: string, labels: BenchLabels, model: GuiModel, parameterNames: Map<number, string> = new Map()): BenchScore {
  const used = new Set<Display>();
  const displays: BenchScore["displays"] = { expected: labels.displays.length, found: 0, rightKind: 0, extra: 0, misses: [], wrong: [] };
  for (const expected of labels.displays) {
    const match = model.displays
      .filter((d) => !used.has(d))
      .map((d) => ({ d, overlap: overlap(expected.box, d) }))
      .sort((a, b) => b.overlap - a.overlap)[0];
    const label = `${expected.kind}${expected.note ? ` (${expected.note})` : ""}`;
    if (!match || match.overlap < 0.5) {
      displays.misses.push(label);
      continue;
    }
    used.add(match.d);
    displays.found++;
    if (benchKind(match.d) === expected.kind) displays.rightKind++;
    else displays.wrong.push(`${label} seen as ${benchKind(match.d)}`);
  }
  displays.extra = model.displays.filter((d) => !used.has(d)).length;

  const controls: BenchScore["controls"] = { expected: labels.controls.length, found: 0, rightKind: 0, extra: 0, misses: [], wrong: [] };
  const named = new Set(labels.controls.map((c) => c.param));
  // labels name the plugin's parameter; the control carries a name made readable ("MakeUp Gain" → "Make Up Gain")
  const paramName = (c: GuiModel["controls"][number]) => parameterNames.get(c.param) ?? c.name;
  for (const expected of labels.controls) {
    const control = model.controls.find((c) => paramName(c) === expected.param);
    if (!control) {
      controls.misses.push(expected.param);
      continue;
    }
    controls.found++;
    if (control.kind === expected.kind) controls.rightKind++;
    else controls.wrong.push(`${expected.param}: ${control.kind} instead of ${expected.kind}`);
  }
  controls.extra = model.controls.filter((c) => !named.has(paramName(c))).length;
  return { name, displays, controls };
}

/** Analyses every labelled editor whose probe exists and scores it. */
export async function runGuiBench(only?: string): Promise<{ scores: BenchScore[]; missing: string[] }> {
  const scores: BenchScore[] = [], missing: string[] = [];
  for (const file of (await readdir(benchLabelDir())).filter((f) => f.endsWith(".json")).sort()) {
    const name = file.replace(/\.json$/, "");
    if (only && name !== only) continue;
    const workDir = join(benchProbeRoot(), name);
    if (!existsSync(join(workDir, "probe.json"))) {
      missing.push(name);
      continue;
    }
    const labels = JSON.parse(await readFile(join(benchLabelDir(), file), "utf8")) as BenchLabels;
    const { probe, parameters } = await loadProbe(workDir);
    // without a fitted compressor the meters are found with a typical curve (threshold −20 dB, ratio 4)
    const model = await analyzeGui(probe, parameters, name, { meterReduction: (levelDb) => Math.max(0, (levelDb + 20) * 0.75) });
    if (process.env.VCH_BENCH_VERBOSE) {
      for (const c of model.controls) console.error(`  ${name}: control ${c.name} ${c.kind} ${c.x},${c.y} ${c.w}x${c.h}`);
      for (const d of model.displays) console.error(`  ${name}: ${d.kind}${d.role ? `/${d.role}` : ""} ${d.x},${d.y} ${d.w}x${d.h}${d.bar ? ` ${d.bar.source} from ${d.bar.origin ?? "bottom"} ${d.bar.fromDb.toFixed(1)}…${d.bar.toDb.toFixed(1)} dB${d.bar.segments ? ` ${d.bar.segments} LEDs` : ""}` : ""}`);
    }
    const score = scoreGui(name, labels, model, new Map(parameters.map((p) => [p.index, p.name.trim()])));
    const look = await lookScore(probe, model);
    scores.push(look ? { ...score, look } : score);
  }
  return { scores, missing };
}

export function formatBench(scores: BenchScore[]): string[] {
  const sum = (f: (s: BenchScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)} %` : "–");
  const lines = scores.map((s) =>
    `${s.name.padEnd(26)} displays ${s.displays.rightKind}/${s.displays.expected} right (${s.displays.found} found, ${s.displays.extra} extra)` +
    `   controls ${s.controls.rightKind}/${s.controls.expected} right (${s.controls.found} found, ${s.controls.extra} extra)` +
    (s.look ? `   look ${pct(s.look.structure * 100, 100)} structure, ${pct(s.look.color * 100, 100)} colour` : "") +
    [...s.displays.misses.map((m) => `\n    missing display: ${m}`), ...s.displays.wrong.map((m) => `\n    wrong display: ${m}`),
      ...s.controls.misses.map((m) => `\n    missing control: ${m}`), ...s.controls.wrong.map((m) => `\n    wrong control: ${m}`)].join(""));
  const looks = scores.filter((s) => s.look);
  const mean = (f: (s: BenchScore) => number) => looks.reduce((a, s) => a + f(s), 0) / Math.max(1, looks.length);
  lines.push(
    (looks.length ? `MEAN LOOK: ${pct(mean((s) => s.look!.structure) * 100, 100)} structure, ${pct(mean((s) => s.look!.color) * 100, 100)} colour (${looks.length} editors)\n` : "") +
    `TOTAL displays: ${pct(sum((s) => s.displays.rightKind), sum((s) => s.displays.expected))} right, ${pct(sum((s) => s.displays.found), sum((s) => s.displays.expected))} found, ${sum((s) => s.displays.extra)} extra` +
    ` · controls: ${pct(sum((s) => s.controls.rightKind), sum((s) => s.controls.expected))} right, ${pct(sum((s) => s.controls.found), sum((s) => s.controls.expected))} found, ${sum((s) => s.controls.extra)} extra`,
  );
  return lines;
}
