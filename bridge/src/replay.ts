/**
 * Replay of an editor recognition: the pictures the probe took (initial state, every control moved, the meter
 * films) with what the analysis recognised laid over them. The app asks for the outline first, then frame by frame.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { encodePng, loadProbe, loadRaw, readFilm, type FilmFrame, type GuiModel, type GuiProbe, type Image } from "@vst-cloner/clone";

export interface ReplaySegment {
  kind: "rest" | "control" | "film";
  label: string;
  frames: number;
  /** control segments: the parameter moved; film segments: time and input level per frame */
  param?: number;
  values?: number[];
  times?: { t: number; levelDb: number }[];
}

export interface ReplayOverlay {
  controls: { param: number; name: string; kind: string; x: number; y: number; w: number; h: number }[];
  displays: { kind: string; role?: string; x: number; y: number; w: number; h: number; source?: string; origin?: string; segments?: number }[];
}

export interface ReplayInfo {
  available: boolean;
  width: number;
  height: number;
  segments: ReplaySegment[];
  overlay?: ReplayOverlay;
}

/** The outline of a replay: segments and the recognised elements (from the stored editor model). */
export async function replayInfo(dir: string, model: GuiModel | undefined): Promise<ReplayInfo> {
  if (!existsSync(join(dir, "probe.json"))) return { available: false, width: 0, height: 0, segments: [] };
  const { probe } = await loadProbe(dir);
  const segments: ReplaySegment[] = [
    { kind: "rest", label: "Initial state", frames: 1 },
    ...probe.visible.map((p): ReplaySegment => ({ kind: "control", label: p.name, frames: p.frames.length, param: p.index, values: p.frames.map((f) => f.value) })),
    ...(probe.films ?? []).map((f): ReplaySegment => ({
      kind: "film",
      label: f.params ? "Level meters – threshold turned down" : "Level meters – silence, rising sine, silence",
      frames: f.frames.length,
      times: f.frames,
    })),
  ];
  return {
    available: true,
    width: probe.width,
    height: probe.height,
    segments,
    ...(model ? {
      overlay: {
        controls: model.controls.map((c) => ({ param: c.param, name: c.name, kind: c.kind, x: c.x, y: c.y, w: c.w, h: c.h })),
        displays: model.displays.map((d) => ({
          kind: d.kind, ...(d.role ? { role: d.role } : {}), x: d.x, y: d.y, w: d.w, h: d.h,
          ...(d.bar ? { source: d.bar.source, origin: d.bar.origin ?? "bottom", ...(d.bar.segments ? { segments: d.bar.segments } : {}) } : {}),
        })),
      },
    } : {}),
  };
}

/** decoded films, kept for a few requests: a replay asks for one frame after the other */
const filmCache = new Map<string, Promise<FilmFrame[]>>();

/** One frame of a replay as a PNG data URL. */
export async function replayFrame(dir: string, segment: number, index: number): Promise<string> {
  const { probe } = await loadProbe(dir);
  const image = await frameImage(probe, segment, index);
  return `data:image/png;base64,${Buffer.from(encodePng(image, { opaque: true, level: 1 })).toString("base64")}`;
}

async function frameImage(probe: GuiProbe, segment: number, index: number): Promise<Image> {
  const { width, height } = probe;
  if (segment === 0) return loadRaw(probe.base, width, height);
  const control = probe.visible[segment - 1];
  if (control) return loadRaw(control.frames[Math.min(index, control.frames.length - 1)]!.file, width, height);
  const film = probe.films?.[segment - 1 - probe.visible.length];
  if (!film) throw new Error(`replay: no segment ${segment}`);
  let frames = filmCache.get(film.file);
  if (!frames) {
    frames = readFilm(film.file, width, height);
    filmCache.set(film.file, frames);
    // two films at a time are enough (the two meter films of one editor)
    while (filmCache.size > 2) filmCache.delete(filmCache.keys().next().value!);
  }
  const all = await frames;
  return all[Math.min(index, all.length - 1)]!.image;
}
