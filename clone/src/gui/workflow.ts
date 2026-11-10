import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Profile } from "@vst-cloner/profile";
import type { Logger } from "../build.ts";
import { analyzeGui } from "./analyze.ts";
import { runGuiSnapshot, withVirtualDisplay } from "./capture.ts";
import { encodePng, loadRaw } from "./image.ts";
import type { GuiModel } from "./model.ts";
import { probeGui } from "./probe.ts";
import { renderSvg } from "./svg.ts";

export const GUI_MODEL_FILE = "model/gui.json";

function cacheRoot(): string {
  if (process.env.VCH_CACHE_DIR) return process.env.VCH_CACHE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "vst-cloner", "cache");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "vst-cloner");
}

/** Screenshots of the original editor stay in the local cache – they are never written into profiles. */
export const guiCacheDir = (profile: Profile) => join(cacheRoot(), "gui", profile.manifest.id);
/** Folder of all editor captures (one subfolder per profile id). */
export const guiCacheRoot = () => join(cacheRoot(), "gui");

function pluginDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    return [join(process.env.COMMONPROGRAMFILES ?? "C:\\Program Files\\Common Files", "VST3"), join(process.env.LOCALAPPDATA ?? "", "Programs", "Common", "VST3")];
  }
  return [join(home, ".vst3"), "/usr/lib/vst3", "/usr/local/lib/vst3", join(home, ".lv2"), "/usr/lib/lv2", "/usr/local/lib/lv2"];
}

/** Finds the original plugin of a profile by its bundle name in the standard plugin folders. */
export async function locatePlugin(profile: Profile): Promise<string | undefined> {
  const name = profile.manifest.plugin.file?.name;
  if (!name) return undefined;
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) if (e.name === name) return join(dir, e.name);
    if (depth === 0) return undefined;
    for (const e of entries) {
      if (e.isDirectory() && !/\.(vst3|lv2)$/i.test(e.name)) {
        const found = await walk(join(dir, e.name), depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const dir of pluginDirs()) {
    if (!existsSync(dir)) continue;
    const found = await walk(dir, 3);
    if (found) return found;
  }
  return undefined;
}

export interface GuiCaptureResult {
  model: GuiModel;
  originalPng: string;
  originalRaw: string;
}

/** Wiggle test + layout analysis of the original plugin editor. */
export async function captureGuiLayout(
  profile: Profile,
  pluginPath: string,
  options: {
    log: Logger;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, label: string) => void;
    /** compressors: gain reduction (dB) of the clone for a sine of this peak level – finds and calibrates meters */
    meterReduction?: (levelDb: number) => number;
  },
): Promise<GuiCaptureResult> {
  const workDir = guiCacheDir(profile);
  const probe = await probeGui({
    ...(options.meterReduction ? { meterLevels: [-80, -30, -18, -6] } : {}),
    plugin: pluginPath,
    identifier: profile.manifest.plugin.identifier,
    parameters: profile.parameters.parameters,
    workDir,
    log: options.log,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  options.log("info", "Oberfläche wird analysiert (Regler, Farben, Flächen, Beschriftungen) …");
  const model = await analyzeGui(probe, profile.parameters.parameters, profile.manifest.plugin.name,
    options.meterReduction ? { meterReduction: options.meterReduction } : {});
  const kinds = new Map<string, number>();
  for (const c of model.controls) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  const names: Record<string, string> = { rotary: "Drehregler", "slider-h": "Schieberegler", "slider-v": "Schieberegler", toggle: "Schalter", choice: "Auswahlfelder", value: "Wertanzeigen" };
  options.log("info", `Erkannt: ${[...kinds].map(([k, n]) => `${n} ${names[k] ?? k}`).join(", ") || "keine Bedienelemente"}, ${model.displays.length} Anzeige(n)${model.displays.some((d) => d.kind === "meter") ? " (davon Pegelreduktions-Nadel)" : ""}, ${model.panels.length} Flächen, ${model.texts.length} Beschriftungen`);

  const originalPng = join(workDir, "original.png");
  await copyFile(probe.basePng, originalPng);
  await writeFile(join(workDir, "layout.svg"), renderSvg(model));
  return { model, originalPng, originalRaw: probe.base };
}

/** Mean structural similarity (SSIM) on luminance, 8×8 windows. 1 = identical. */
export function ssim(a: { width: number; height: number; data: Uint8Array }, b: { data: Uint8Array }): number {
  const lum = (d: Uint8Array, p: number) => 0.2126 * d[p * 4]! + 0.7152 * d[p * 4 + 1]! + 0.0722 * d[p * 4 + 2]!;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let total = 0, windows = 0;
  for (let y0 = 0; y0 + 8 <= a.height; y0 += 8) {
    for (let x0 = 0; x0 + 8 <= a.width; x0 += 8) {
      let ma = 0, mb = 0;
      for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) { const p = y * a.width + x; ma += lum(a.data, p); mb += lum(b.data, p); }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) {
        const p = y * a.width + x;
        const da = lum(a.data, p) - ma, db = lum(b.data, p) - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= 63; vb /= 63; cov /= 63;
      total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      windows++;
    }
  }
  return windows ? total / windows : 0;
}

export interface GuiComparison {
  /** structural similarity (SSIM), 0…1 */
  similarity: number;
  /** mean colour similarity, 0…1 */
  colorSimilarity: number;
  originalPng: string;
  clonePng: string;
  /** original and clone side by side */
  comparePng?: string;
}

/** Captures the clone's editor and compares it pixel by pixel with the original. */
export async function compareGui(
  profile: Profile,
  clonePath: string,
  originalRaw: string | undefined,
  model: GuiModel,
  options: { log: Logger; signal?: AbortSignal },
): Promise<GuiComparison | undefined> {
  const workDir = join(guiCacheDir(profile), "clone");
  await mkdir(workDir, { recursive: true });
  const shot = await withVirtualDisplay(
    (display) => runGuiSnapshot({ plugin: clonePath, outputDir: workDir, steps: [{ id: "clone", params: [], png: true }], display, settleMs: 1500, ...(options.signal ? { signal: options.signal } : {}) }),
    options.signal,
  );
  const cloneShot = shot.shots.get("clone")!;
  const clonePng = join(guiCacheDir(profile), "clone.png");
  await copyFile(cloneShot.png, clonePng);

  const originalPng = join(guiCacheDir(profile), "original.png");
  if (!originalRaw || !existsSync(originalRaw)) return undefined;
  if (cloneShot.width !== model.width || cloneShot.height !== model.height) {
    options.log("warn", `Klon-Oberfläche hat ${cloneShot.width}×${cloneShot.height} statt ${model.width}×${model.height} Pixel – kein Pixelvergleich`);
    return { similarity: 0, colorSimilarity: 0, originalPng, clonePng };
  }
  const a = await loadRaw(originalRaw, model.width, model.height);
  const b = await loadRaw(cloneShot.file, model.width, model.height);
  let total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    total += (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!)) / 3;
  }
  const colorSimilarity = 1 - total / (a.data.length / 4) / 255;
  const similarity = Math.max(0, ssim(a, b));

  const side = { width: model.width * 2 + 8, height: model.height, data: new Uint8Array((model.width * 2 + 8) * model.height * 4) };
  for (let y = 0; y < model.height; y++) {
    side.data.set(a.data.subarray(y * model.width * 4, (y + 1) * model.width * 4), y * side.width * 4);
    side.data.set(b.data.subarray(y * model.width * 4, (y + 1) * model.width * 4), (y * side.width + model.width + 8) * 4);
  }
  await writeFile(join(guiCacheDir(profile), "compare.png"), encodePng(side));
  options.log("info", `Oberfläche: Struktur-Ähnlichkeit ${Math.round(similarity * 100)} %, Farb-Ähnlichkeit ${Math.round(colorSimilarity * 100)} % (Vergleichsbild: ${join(guiCacheDir(profile), "compare.png")})`);
  return { similarity, colorSimilarity, originalPng, clonePng, comparePng: join(guiCacheDir(profile), "compare.png") };
}
