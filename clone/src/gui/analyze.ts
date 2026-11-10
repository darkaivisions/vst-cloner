import type { Parameter } from "@vst-cloner/profile";
import { buildTable, detectEq, tableValue } from "../eq/mapping.ts";
import {
  colorDistance,
  components,
  diffMask,
  dilate,
  dominantColor,
  hex,
  loadRaw,
  luminance,
  medianColor,
  overlaps,
  pixel,
  union,
  type Box,
  type Image,
  type Rgb,
} from "./image.ts";
import type { Control, Display, Fill, GuiModel, Line, Panel, Readout, RotaryStyle, TextItem } from "./model.ts";
import type { GuiProbe, ProbedParameter } from "./probe.ts";

const TAU = Math.PI * 2;

/** Angle clockwise from 12 o'clock (screen coordinates, y down). */
const angleOf = (dx: number, dy: number) => Math.atan2(dx, -dy);

const clampBox = (b: Box, img: { width: number; height: number }): Box => {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  return { x, y, w: Math.max(1, Math.min(img.width, Math.ceil(b.x + b.w)) - x), h: Math.max(1, Math.min(img.height, Math.ceil(b.y + b.h)) - y) };
};

const grow = (b: Box, dx: number, dy = dx): Box => ({ x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy });
const area = (b: Box) => b.w * b.h;
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
};

/** Per-pixel median of several images inside a box (static appearance of a control). */
function medianImage(frames: Image[], box: Box): Image {
  const out: Image = { width: frames[0]!.width, height: frames[0]!.height, data: new Uint8Array(frames[0]!.data) };
  const values = new Array<number>(frames.length);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * out.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        for (let f = 0; f < frames.length; f++) values[f] = frames[f]!.data[i + c]!;
        values.sort((a, b) => a - b);
        out.data[i + c] = values[values.length >> 1]!;
      }
    }
  }
  return out;
}

/** Pixel coordinates of a mask inside a box. */
function maskPoints(mask: Uint8Array, width: number, box: Box): [number, number][] {
  const points: [number, number][] = [];
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (mask[y * width + x]) points.push([x, y]);
  return points;
}

function dominantAt(img: Image, points: [number, number][]): Rgb {
  if (!points.length) return [128, 128, 128];
  const counts = new Map<number, { n: number; c: Rgb }>();
  for (const [x, y] of points) {
    const c = pixel(img, x, y);
    const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
    const e = counts.get(key) ?? { n: 0, c: [0, 0, 0] as Rgb };
    e.n++;
    e.c = [e.c[0] + c[0], e.c[1] + c[1], e.c[2] + c[2]];
    counts.set(key, e);
  }
  let best = { n: 0, c: [0, 0, 0] as Rgb };
  for (const e of counts.values()) if (e.n > best.n) best = e;
  return [best.c[0] / best.n, best.c[1] / best.n, best.c[2] / best.n].map(Math.round) as Rgb;
}

function sampleRing(img: Image, cx: number, cy: number, r: number, samples = 72): Rgb[] {
  const out: Rgb[] = [];
  for (let k = 0; k < samples; k++) {
    const a = (k / samples) * TAU;
    const x = Math.round(cx + Math.sin(a) * r);
    const y = Math.round(cy - Math.cos(a) * r);
    if (x >= 0 && y >= 0 && x < img.width && y < img.height) out.push(pixel(img, x, y));
  }
  return out;
}

function ringMedian(img: Image, cx: number, cy: number, r: number): Rgb {
  const ring = sampleRing(img, cx, cy, r);
  const median = (i: 0 | 1 | 2) => percentile(ring.map((c) => c[i]), 0.5);
  return [median(0), median(1), median(2)];
}

/** Least-squares circle through points (Kåsa fit). */
function fitCircle(points: [number, number][]): { cx: number; cy: number; r: number } | undefined {
  if (points.length < 3) return undefined;
  const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const my = points.reduce((s, p) => s + p[1], 0) / points.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [x, y] of points) {
    const u = x - mx, v = y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return undefined;
  const a = 0.5 * (suuu + suvv), b = 0.5 * (svvv + svuu);
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / points.length) };
}

/** Picks the variant of a parameter name whose estimated width fits the measured text block best. */
export function fitLabel(name: string, boxWidth: number, boxHeight: number, uppercase: boolean, wordCounts: Map<string, number> = new Map()): string | undefined {
  const words = name.split(/\s+/).filter(Boolean);
  const variants = new Set<string>([name]);
  // on equal width the specific word wins over group words shared by several parameters ("Tone Bass" → "Bass")
  const count = (w: string) => wordCounts.get(w.toLowerCase()) ?? 1;
  for (const w of [...words].sort((a, b) => count(a) - count(b))) variants.add(w);
  for (let i = 0; i + 1 < words.length; i++) variants.add(`${words[i]} ${words[i + 1]}`);
  // average glyph width ≈ 0.62 × cap height (capitals wider than lower case)
  const estimate = (text: string) => text.length * boxHeight * (uppercase ? 0.78 : 0.62);
  let best = name;
  for (const v of variants) if (Math.abs(Math.log(estimate(v) / boxWidth)) < Math.abs(Math.log(estimate(best) / boxWidth))) best = v;
  // a text block much wider or narrower than any variant of the name is a different text
  if (Math.abs(Math.log(estimate(best) / boxWidth)) > 0.75) return undefined;
  return uppercase ? best.toUpperCase() : best;
}

export function prettifyName(name: string): string {
  const withoutBand = name.replace(/^band\s*\d+\s*/i, "");
  const spaced = withoutBand.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\bd B\b/g, "dB").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---- controls ---------------------------------------------------------------------------------

interface Footprint {
  param: ProbedParameter;
  frames: Image[];
  region: Box;
  main: Box;
  readout?: Box;
  /** normalized value in the base image */
  value: number;
}

function analyzeRotary(fp: Footprint, median: Image, noise: Uint8Array): RotaryStyle | undefined {
  const { frames, main } = fp;
  const width = median.width;
  const searchBox = clampBox(grow(main, 4), median);
  const indicator = frames.map((f) => maskPoints(diffMask(f, median, 30, noise), width, searchBox));
  if (indicator.flat().length < 6) return undefined;

  // The centroid of a rotating pointer moves on a circle around the knob axis.
  let cx = main.x + main.w / 2;
  let cy = main.y + main.h / 2;
  for (let iteration = 0; iteration < 2; iteration++) {
    const reach = percentile(indicator.flat().map((p) => Math.hypot(p[0] - cx, p[1] - cy)), 0.95);
    const centroids = indicator
      .map((pts) => pts.filter((p) => Math.hypot(p[0] - cx, p[1] - cy) < reach * 0.9))
      .filter((pts) => pts.length >= 3)
      .map((pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] as [number, number]);
    const circle = fitCircle(centroids);
    if (!circle || circle.r < 2 || !overlaps({ x: circle.cx, y: circle.cy, w: 1, h: 1 }, main, 4)) break;
    cx = circle.cx;
    cy = circle.cy;
  }
  const dist = (p: [number, number]) => Math.hypot(p[0] - cx, p[1] - cy);
  const pointerReach = percentile(indicator.flat().map(dist), 0.95);

  // knob body: first radius where the ring colour departs from the centre colour
  const centre = ringMedian(median, cx, cy, Math.max(2, pointerReach * 0.25));
  let radius = pointerReach * 1.05;
  for (let r = pointerReach * 0.5; r < pointerReach * 2.2; r += 0.5) {
    if (colorDistance(ringMedian(median, cx, cy, r), centre) > 40) {
      radius = r;
      break;
    }
  }

  const first = indicator[0]!;
  const last = indicator[indicator.length - 1]!;

  // pointer: indicator pixels inside the body
  const pointerOf = (points: [number, number][]) => points.filter((p) => dist(p) < radius * 0.97);
  const pointerAngle = (points: [number, number][]) => {
    const pts = pointerOf(points);
    if (pts.length < 3) return undefined;
    const sx = pts.reduce((s, p) => s + p[0] - cx, 0) / pts.length;
    const sy = pts.reduce((s, p) => s + p[1] - cy, 0) / pts.length;
    return Math.hypot(sx, sy) > radius * 0.1 ? angleOf(sx, sy) : undefined;
  };

  let startAngle = pointerAngle(first) ?? (-135 * Math.PI) / 180;
  let endAngle = pointerAngle(last) ?? (135 * Math.PI) / 180;
  if (endAngle <= startAngle) endAngle += TAU;
  if (endAngle - startAngle > TAU * 0.95 || endAngle - startAngle < 0.5) {
    startAngle = (-135 * Math.PI) / 180;
    endAngle = (135 * Math.PI) / 180;
  }

  // value arc: compare the highest value with value 0 (the arc is empty there)
  let arc: RotaryStyle["arc"];
  const arcSearch = clampBox(grow(main, Math.round(radius * 0.6)), median);
  const arcPoints = maskPoints(diffMask(frames[frames.length - 1]!, frames[0]!, 30, noise), width, arcSearch)
    .filter((p) => dist(p) > radius * 0.85 && dist(p) < radius * 1.7);
  const arcAngles = arcPoints.map((p) => angleOf(p[0] - cx, p[1] - cy));
  const bins = new Set(arcAngles.map((a) => {
    let t = a;
    while (t < startAngle) t += TAU;
    return Math.floor(((t - startAngle) / Math.max(0.1, endAngle - startAngle)) * 24);
  }).filter((b) => b >= 0 && b < 24));
  if (arcPoints.length > 20 && bins.size >= 16) {
    const d = arcPoints.map(dist);
    const arcRadius = percentile(d, 0.5);
    const midAngle = (startAngle + endAngle) / 2;
    const trackPoint: [number, number] = [Math.round(cx + Math.sin(midAngle) * arcRadius), Math.round(cy - Math.cos(midAngle) * arcRadius)];
    const trackColor = pixel(frames[0]!, Math.min(width - 1, Math.max(0, trackPoint[0])), Math.min(median.height - 1, Math.max(0, trackPoint[1])));
    arc = {
      color: hex(dominantAt(frames[frames.length - 1]!, arcPoints)),
      radius: arcRadius,
      width: Math.max(1.5, percentile(d, 0.9) - percentile(d, 0.1) + 1),
      ...(colorDistance(trackColor, ringMedian(median, cx, cy, radius * 1.8)) > 25 ? { track: hex(trackColor) } : {}),
    };
  }

  const middle = pointerOf(indicator[indicator.length >> 1]!);
  const middleDistances = middle.map(dist);
  const inner = middleDistances.length ? percentile(middleDistances, 0.05) / radius : 0.3;
  const outer = middleDistances.length ? percentile(middleDistances, 0.95) / radius : 0.9;
  const pointerColor = middle.length ? dominantAt(frames[indicator.length >> 1]!, middle) : luminance(centre) > 128 ? [30, 30, 30] as Rgb : [235, 235, 235] as Rgb;
  const length = Math.max(1, (outer - inner) * radius);

  const top = pixel(median, Math.round(cx), Math.max(0, Math.round(cy - radius * 0.65)));
  const bottom = pixel(median, Math.round(cx), Math.min(median.height - 1, Math.round(cy + radius * 0.65)));
  const lt = luminance(top), lb = luminance(bottom), lc = luminance(centre);
  const brackets = Math.min(lt, lb) - 12 <= lc && lc <= Math.max(lt, lb) + 12;
  const body: Fill = colorDistance(top, bottom) > 18 && brackets && colorDistance(top, centre) < 80 && colorDistance(bottom, centre) < 80
    ? { color: hex(top), gradient: hex(bottom) }
    : { color: hex(centre) };

  const edge = ringMedian(median, cx, cy, radius);
  const outside = ringMedian(median, cx, cy, radius * 1.25 + 3);
  const outline = colorDistance(edge, centre) > 30 && colorDistance(edge, outside) > 30 ? hex(edge) : undefined;

  // tick marks around the knob: short marks at regular angles on a ring outside the body
  let ticks: RotaryStyle["ticks"];
  const background = outside;
  for (let r = radius * 1.12; r < radius * 1.7 && !ticks; r += 1) {
    const samples = 360;
    const hits: number[] = [];
    for (let k = 0; k < samples; k++) {
      const a = (k / samples) * TAU;
      const x = Math.round(cx + Math.sin(a) * r);
      const y = Math.round(cy - Math.cos(a) * r);
      if (x < 0 || y < 0 || x >= median.width || y >= median.height) continue;
      if (colorDistance(pixel(median, x, y), background) > 50) hits.push(k);
    }
    const runs: number[][] = [];
    for (const k of hits) {
      const run = runs[runs.length - 1];
      if (run && k - run[run.length - 1]! <= 1) run.push(k);
      else runs.push([k]);
    }
    const short = runs.filter((run) => run.length <= 6);
    const centres = short.map((run) => (run[0]! + run[run.length - 1]!) / 2).sort((a, b) => a - b);
    const gaps = centres.slice(1).map((c, i) => c - centres[i]!);
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const regular = gaps.length >= 4 && gaps.filter((g) => Math.abs(g - meanGap) < meanGap * 0.35 || Math.abs(g - 2 * meanGap) < meanGap * 0.35 || g > 60).length >= gaps.length - 1;
    if (short.length >= 5 && short.length <= 41 && short.length >= runs.length * 0.8 && regular) {
      const angles = short.map((run) => {
        const a = ((run[0]! + run[run.length - 1]!) / 2 / samples) * TAU;
        return a > Math.PI ? a - TAU : a;
      });
      const tickPoints: [number, number][] = short.map((run) => {
        const a = ((run[0]! + run[run.length - 1]!) / 2 / samples) * TAU;
        return [Math.round(cx + Math.sin(a) * r), Math.round(cy - Math.cos(a) * r)];
      });
      // radial extent of the first tick
      const a0 = angles[0]!;
      let outerR = r;
      while (outerR < radius * 2 && colorDistance(pixel(median, Math.round(cx + Math.sin(a0) * outerR), Math.round(cy - Math.cos(a0) * outerR)), background) > 50) outerR += 0.5;
      let innerR = r;
      while (innerR > radius && colorDistance(pixel(median, Math.round(cx + Math.sin(a0) * innerR), Math.round(cy - Math.cos(a0) * innerR)), background) > 50) innerR -= 0.5;
      ticks = {
        angles,
        inner: innerR / radius,
        outer: outerR / radius,
        color: hex(dominantAt(median, tickPoints)),
        width: Math.max(1, Math.round(short.reduce((s, run) => s + run.length, 0) / short.length * (TAU * r) / samples)),
      };
    }
  }

  return {
    cx, cy, radius, startAngle, endAngle, body,
    ...(outline ? { outline } : {}),
    pointer: hex(pointerColor),
    pointerInner: Math.max(0, Math.min(1, inner)),
    pointerOuter: Math.max(0.2, Math.min(1.05, outer)),
    pointerWidth: Math.max(1.5, Math.min(radius * 0.14, middle.length / length / 1.3)),
    pointerDot: inner > 0.45 && outer - inner < 0.35,
    ...(arc ? { arc } : {}),
    ...(ticks ? { ticks } : {}),
  };
}

function readoutStyle(fp: Footprint, median: Image): Readout | undefined {
  const box = fp.readout;
  if (!box) return undefined;
  const inside = dominantColor(median, clampBox(grow(box, 2), median));
  const frame = fp.frames[fp.frames.length >> 1]!;
  const glyphs = maskPoints(
    (() => {
      const m = new Uint8Array(median.width * median.height);
      const b = clampBox(box, median);
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (colorDistance(pixel(frame, x, y), inside) > 60) m[y * median.width + x] = 1;
      return m;
    })(),
    median.width,
    clampBox(box, median),
  );
  const color = glyphs.length ? dominantAt(frame, glyphs) : luminance(inside) > 128 ? ([20, 20, 20] as Rgb) : ([230, 230, 230] as Rgb);

  // find the first differing row/column on each side (box border or background change)
  const lineColor = (b: Box, side: "l" | "r" | "t" | "b", offset: number) => {
    const line: Box = side === "l" ? { x: b.x - offset, y: b.y, w: 1, h: b.h } : side === "r" ? { x: b.x + b.w - 1 + offset, y: b.y, w: 1, h: b.h }
      : side === "t" ? { x: b.x, y: b.y - offset, w: b.w, h: 1 } : { x: b.x, y: b.y + b.h - 1 + offset, w: b.w, h: 1 };
    return medianColor(median, clampBox(line, median));
  };
  const start = clampBox(grow(box, 1), median);
  const limit = Math.max(box.h * 1.5, 20);
  const found: Partial<Record<"l" | "r" | "t" | "b", { offset: number; color: Rgb }>> = {};
  for (const side of ["l", "r", "t", "b"] as const) {
    for (let offset = 1; offset < limit; offset++) {
      const c = lineColor(start, side, offset);
      if (colorDistance(c, inside) > 14) {
        found[side] = { offset, color: c };
        break;
      }
    }
  }
  const complete = found.l && found.r && found.t && found.b;
  if (!complete) {
    const outer = clampBox(grow(box, Math.round(box.h * 0.4), Math.round(box.h * 0.3)), median);
    return { ...outer, color: hex(color), size: Math.max(8, Math.round(box.h * 1.3)) };
  }
  const outer = { x: start.x - found.l!.offset, y: start.y - found.t!.offset, w: start.w + found.l!.offset + found.r!.offset, h: start.h + found.t!.offset + found.b!.offset };
  const border = found.t!.color;
  const beyond = medianColor(median, clampBox(grow(outer, 3), median));
  return {
    ...outer,
    color: hex(color),
    background: hex(inside),
    ...(colorDistance(border, beyond) > 10 ? { border: hex(border) } : {}),
    size: Math.max(8, Math.round(box.h * 1.3)),
  };
}

/** position of the smallest change of a value text – orders value texts that share one area */
const valueAnchors = new Map<number, number>();

function analyzeControl(fp: Footprint, noise: Uint8Array): Control | undefined {
  const { param, frames, main } = fp;
  const median = medianImage(frames, clampBox(grow(fp.region, 8), frames[0]!));
  const name = prettifyName(param.name);
  const readout = readoutStyle(fp, median);
  const base = { param: param.index, name, value: fp.value, x: main.x, y: main.y, w: main.w, h: main.h, ...(readout ? { readout } : {}) };

  if (param.discrete && frames.length === 2) {
    const off = dominantColor(frames[0]!, main);
    const on = dominantColor(frames[1]!, main);
    const round = Math.abs(main.w - main.h) < Math.max(3, main.w * 0.15);
    return { ...base, kind: "toggle", toggle: { off: hex(off), on: hex(on), radius: round ? main.w / 2 : Math.min(6, main.h / 3) } };
  }

  if (param.discrete) {
    const textPoints = frames.flatMap((f) => maskPoints(diffMask(f, median, 30, noise), f.width, main));
    return {
      ...base, kind: "choice",
      choice: { background: hex(dominantColor(median, main)), text: hex(dominantAt(frames[0]!, textPoints)), size: Math.max(9, Math.round(main.h * 0.55)) },
    };
  }

  // continuous: elongated footprint → slider, otherwise rotary
  const elongated = main.w > main.h * 2.2 || main.h > main.w * 2.2;

  if (elongated && Math.min(main.w, main.h) <= 18) {
    // a flat element whose changes stay in place is a value text ("0.0 dB"), not a slider with a moving thumb
    const horizontal = main.w >= main.h;
    // slider: in every frame only a small part changes (the thumb), and it moves in one direction with the value
    const length = horizontal ? main.w : main.h;
    const stats = frames.map((f) => {
      const coords = maskPoints(diffMask(f, median, 30, noise), median.width, main).map((p) => (horizontal ? p[0] : p[1]));
      return coords.length ? { centre: coords.reduce((a, b) => a + b, 0) / coords.length, extent: Math.max(...coords) - Math.min(...coords) } : undefined;
    }).filter((x): x is { centre: number; extent: number } => x !== undefined);
    const steps = stats.slice(1).map((x, i) => x.centre - stats[i]!.centre);
    const monotonic = steps.length >= 2 && (steps.every((d) => d >= -1) || steps.every((d) => d <= 1));
    const smallThumb = stats.length > 0 && percentile(stats.map((x) => x.extent), 0.5) < length * 0.5;
    if (!(monotonic && smallThumb)) {
      const background = dominantColor(median, main);
      const ink = frames.flatMap((f) => maskPoints(diffMask(f, median, 30, noise), f.width, main).filter(([x, y]) => colorDistance(pixel(f, x, y), background) > 50).map((p) => ({ f, p })));
      const color = ink.length ? dominantAt(ink[0]!.f, ink.filter((i) => i.f === ink[0]!.f).map((i) => i.p)) : luminance(background) > 128 ? ([30, 30, 30] as Rgb) : ([220, 220, 220] as Rgb);
      const anchor = stats.length ? [...stats].sort((a, b) => a.extent - b.extent)[0]!.centre : (horizontal ? main.x + main.w / 2 : main.y + main.h / 2);
      valueAnchors.set(param.index, anchor);
      return { ...base, kind: "value", choice: { background: hex(background), text: hex(color), size: Math.max(8, Math.round(main.h)) } };
    }
  }

  if (elongated) {
    const horizontal = main.w >= main.h;
    const thumbPoints = maskPoints(diffMask(frames[frames.length >> 1]!, median, 30, noise), median.width, main);
    const thumbExtent = thumbPoints.length ? (horizontal ? Math.max(...thumbPoints.map((p) => p[0])) - Math.min(...thumbPoints.map((p) => p[0])) : Math.max(...thumbPoints.map((p) => p[1])) - Math.min(...thumbPoints.map((p) => p[1]))) : 8;
    return {
      ...base,
      kind: horizontal ? "slider-h" : "slider-v",
      slider: { track: hex(dominantColor(median, main)), thumb: hex(dominantAt(frames[frames.length >> 1]!, thumbPoints)), thumbSize: Math.max(4, Math.min(thumbExtent, horizontal ? main.w / 3 : main.h / 3)) },
    };
  }

  const rotary = analyzeRotary(fp, median, noise);
  if (!rotary) return undefined;
  const extent = rotary.radius * Math.max(1, rotary.ticks?.outer ?? 1, rotary.arc ? (rotary.arc.radius + rotary.arc.width / 2) / rotary.radius : 1);
  return {
    ...base,
    kind: "rotary",
    x: Math.round(rotary.cx - extent - 1),
    y: Math.round(rotary.cy - extent - 1),
    w: Math.round(extent * 2 + 2),
    h: Math.round(extent * 2 + 2),
    rotary,
  };
}

/** Value texts next to each other often change one common area – divide it among them from left to right. */
function splitSharedValues(controls: Control[]): void {
  const values = controls.filter((c) => c.kind === "value");
  const done = new Set<Control>();
  for (const c of values) {
    if (done.has(c)) continue;
    const group = values.filter((o) => !done.has(o) && overlaps(o, c) && Math.abs(o.y - c.y) < c.h * 0.5);
    if (group.length < 2) continue;
    const box = union(group);
    group.sort((a, b) => (valueAnchors.get(a.param) ?? a.x) - (valueAnchors.get(b.param) ?? b.x));
    const part = box.w / group.length;
    group.forEach((o, i) => {
      o.x = Math.round(box.x + i * part);
      o.w = Math.round(part);
      o.y = box.y;
      o.h = box.h;
      done.add(o);
    });
  }
}

// ---- EQ display -------------------------------------------------------------------------------

/** Region of similar colour around a seed pixel (flood fill with local tolerance); returns its bounding box. */
function growRegion(img: Image, seedX: number, seedY: number, tolerance = 7): Box {
  const { width, height } = img;
  const seen = new Uint8Array(width * height);
  const stack = [seedY * width + seedX];
  seen[stack[0]!] = 1;
  let minX = seedX, maxX = seedX, minY = seedY, maxY = seedY;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width, y = (p - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const q of [p - 1, p + 1, p - width, p + width]) {
      if (q < 0 || q >= seen.length || seen[q]) continue;
      if ((q === p - 1 && x === 0) || (q === p + 1 && x === width - 1)) continue;
      const i = p * 4, j = q * 4;
      if (Math.max(Math.abs(img.data[i]! - img.data[j]!), Math.abs(img.data[i + 1]! - img.data[j + 1]!), Math.abs(img.data[i + 2]! - img.data[j + 2]!)) <= tolerance) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Columns inside `box` that form a vertical line over most of its height (lighter or darker than both neighbours). */
function lineColumns(img: Image, box: Box): number[] {
  const lum = (x: number, y: number) => luminance(pixel(img, x, y));
  const rows: number[] = [];
  for (let y = box.y + Math.round(box.h * 0.2); y < box.y + box.h * 0.8; y += 3) rows.push(y);
  const found: number[] = [];
  for (let x = Math.max(1, box.x); x < Math.min(img.width - 1, box.x + box.w); x++) {
    let hits = 0;
    for (const y of rows) {
      const c = lum(x, y), l = lum(x - 1, y), r = lum(x + 1, y);
      if ((c - Math.max(l, r) >= 3) || (Math.min(l, r) - c >= 3)) hits++;
    }
    if (hits >= rows.length * 0.6 && !(found.length && found[found.length - 1] === x - 1)) found.push(x);
  }
  return found;
}

/**
 * Snaps a rough log-frequency axis (x = a + b·ln f) to the grid lines: searches offset and scale so that as many
 * 1-2-5 frequencies as possible fall exactly on a grid column, then refines with least squares.
 */
function snapFrequencyAxis(img: Image, box: Box, fit: { a: number; b: number }): { a: number; b: number } {
  const columns = lineColumns(img, box);
  if (columns.length < 4) return fit;
  const isColumn = new Uint8Array(img.width + 2);
  for (const x of columns) isColumn[x] = 1;
  const logs: number[] = [];
  for (let decade = 10; decade <= 10000; decade *= 10) for (const m of [1, 2, 5]) logs.push(Math.log(decade * m));
  const near = (x: number) => {
    const r = Math.round(x);
    for (const d of [0, -1, 1]) if (r + d >= 0 && r + d < isColumn.length && isColumn[r + d]) return r + d;
    return undefined;
  };
  let best = { score: 0, a: fit.a, b: fit.b };
  for (let scale = 0.8; scale <= 1.2; scale += 0.004) {
    const b = fit.b * scale;
    const pivot = fit.a + fit.b * Math.log(1000);
    for (let shift = -30; shift <= 30; shift += 0.5) {
      const a = pivot + shift - b * Math.log(1000);
      let score = 0;
      for (const lf of logs) {
        const x = a + b * lf;
        if (x >= box.x && x < box.x + box.w && near(x) !== undefined) score++;
      }
      if (score > best.score) best = { score, a, b };
    }
  }
  if (best.score < 5) return fit;
  const points: [number, number][] = [];
  for (const lf of logs) {
    const x = best.a + best.b * lf;
    const column = x >= box.x && x < box.x + box.w ? near(x) : undefined;
    if (column !== undefined) points.push([lf, column + 0.5]);
  }
  const refined = linearFit(points);
  return refined && refined.b > 0 ? refined : fit;
}

/** Vertical extent of the frequency grid lines (columns that differ from both horizontal neighbours). */
function gridExtent(img: Image, columns: number[], from: number): { top: number; bottom: number } | undefined {
  const lum = (x: number, y: number) => luminance(pixel(img, x, y));
  const tops: number[] = [], bottoms: number[] = [];
  for (const x0 of columns) {
    // the exact column: strongest line within ±2 px at the start row
    let x = -1, best = 0;
    for (let c = Math.max(1, Math.round(x0) - 2); c <= Math.min(img.width - 2, Math.round(x0) + 2); c++) {
      let score = 0;
      for (let y = from - 10; y <= from + 10; y++) if (y > 0 && y < img.height) score += Math.min(Math.abs(lum(c, y) - lum(c - 1, y)), Math.abs(lum(c, y) - lum(c + 1, y)));
      if (score > best) { best = score; x = c; }
    }
    if (x < 0 || best < 21 * 2) continue;
    // same polarity as the grid line (lighter or darker than its surroundings), roughly the same strength
    const contrast = (y: number) => lum(x, y) - (lum(x - 1, y) + lum(x + 1, y)) / 2;
    const polarity = Math.sign(contrast(from)) || 1;
    const isLine = (y: number) => {
      const c = contrast(y) * polarity;
      return c >= 2 && Math.abs(lum(x - 1, y) - lum(x + 1, y)) < Math.max(4, c);
    };
    const surrounding = (y: number) => (lum(x - 3, y) + lum(x + 3, y)) / 2;
    const scan = (dir: -1 | 1) => {
      let y = from, gap = 0, last = from, around = surrounding(from);
      while (y + dir >= 0 && y + dir < img.height && gap <= 4) {
        y += dir;
        // the plot background changes only gradually – a jump means another area (header, footer)
        // (single rows such as horizontal grid lines are skipped like gaps)
        if (Math.abs(surrounding(y) - around) > 8) { gap++; continue; }
        if (isLine(y)) { last = y; gap = 0; around = surrounding(y); } else gap++;
      }
      return last;
    };
    tops.push(scan(-1));
    bottoms.push(scan(1));
  }
  if (tops.length < 2) return undefined;
  // conservative: where the header has nearly the plot colour, single columns overshoot
  return { top: Math.max(...tops), bottom: Math.min(...bottoms) };
}

function linearFit(points: [number, number][]): { a: number; b: number } | undefined {
  if (points.length < 2) return undefined;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  if (sxx < 1e-12) return undefined;
  const b = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
  return { a: my - b * mx, b };
}

/**
 * EQ curve area: union of everything the template band changes, extended to the plot background.
 * Axis calibration: node position for known frequencies and gains.
 */
function analyzeEqDisplay(base: Image, bands: { param: ProbedParameter; frames: Image[] }[], parameters: Parameter[], noise: Uint8Array): Display | undefined {
  const { width, height } = base;
  const changed = new Uint8Array(width * height);
  for (const { frames } of bands) {
    for (const f of frames) {
      const m = diffMask(f, base, 24, noise);
      for (let p = 0; p < m.length; p++) if (m[p]) changed[p] = 1;
    }
  }
  const parts = components(dilate(changed, width, height, 3), width, height, 20);
  if (!parts.length) return undefined;
  const touched = union(parts);
  // plot background: grow from a background pixel next to the changes
  let seed = { x: Math.round(touched.x + touched.w / 2), y: Math.round(touched.y + touched.h / 2) };
  for (let dy = 0; dy < touched.h / 2 && changed[seed.y * width + seed.x]; dy += 2) seed = { x: seed.x, y: Math.min(height - 1, seed.y + 2) };
  const plot = growRegion(base, seed.x, seed.y);
  const box = clampBox(area(plot) > area(touched) ? union([plot, touched]) : touched, base);

  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  const physical = (index: number, norm: number) => {
    const table = buildTable(byIndex.get(index)!);
    return table ? tableValue(table, norm) : undefined;
  };

  // x = a + b · ln f
  let fMin: number | undefined, fMax: number | undefined;
  const freq = bands.find((b) => b.param.bandRole === "frequency");
  if (freq) {
    const points: [number, number][] = [];
    freq.frames.forEach((f, k) => {
      const hz = physical(freq.param.index, freq.param.frames[k]!.value);
      const pts = maskPoints(diffMask(f, base, 24, noise), width, box);
      if (!hz || pts.length < 5) return;
      points.push([Math.log(hz), pts.reduce((s, p) => s + p[0], 0) / pts.length]);
    });
    const rough = linearFit(points);
    const fit = rough && rough.b > 0 ? snapFrequencyAxis(base, box, rough) : rough;
    if (fit && fit.b > 0) {
      fMin = Math.exp((box.x - fit.a) / fit.b);
      fMax = Math.exp((box.x + box.w - fit.a) / fit.b);
    }
  }

  // y = c + d · dB (node: extreme point of the bell)
  let dbTop: number | undefined, dbBottom: number | undefined;
  const gain = bands.find((b) => b.param.bandRole === "gain");
  if (gain) {
    const points: [number, number][] = [];
    gain.frames.forEach((f, k) => {
      const db = physical(gain.param.index, gain.param.frames[k]!.value);
      const pts = maskPoints(diffMask(f, base, 24, noise), width, box);
      if (db === undefined || pts.length < 5) return;
      const ys = pts.map((p) => p[1]);
      const y = db > 0.5 ? Math.min(...ys) : db < -0.5 ? Math.max(...ys) : ys.reduce((a, b) => a + b, 0) / ys.length;
      if (y <= box.y + 2 || y >= box.y + box.h - 3) return; // clipped at the edge
      points.push([db, y]);
    });
    const fit = linearFit(points);
    if (fit && fit.b < 0) {
      dbTop = (box.y - fit.a) / fit.b;
      dbBottom = (box.y + box.h - fit.a) / fit.b;
    }
  }

  // the grid lines mark the plot exactly; frequency labels often sit in a strip right below it
  let labelBand = 0;
  if (fMin && fMax) {
    const xOf = (f: number) => box.x + (Math.log(f / fMin!) / Math.log(fMax! / fMin!)) * box.w;
    const columns = [100, 200, 1000, 2000, 10000].filter((f) => f > fMin! * 1.05 && f < fMax! / 1.05).map(xOf);
    const extent = gridExtent(base, columns, Math.round(box.y + box.h / 2));
    if (extent && extent.bottom - extent.top > box.h * 0.5) {
      const oldTop = box.y, oldHeight = box.h;
      box.y = extent.top;
      box.h = extent.bottom - extent.top + 1;
      // keep the dB calibration: it refers to the old box
      if (dbTop !== undefined && dbBottom !== undefined) {
        const perPixel = (dbTop - dbBottom) / oldHeight;
        dbTop = dbTop + (oldTop - box.y) * perPixel;
        dbBottom = dbTop - box.h * perPixel;
      }
      // text below the grid at the label positions → reserve a label strip
      const strip = { x: box.x, y: box.y + box.h + 2, w: box.w, h: 16 };
      if (strip.y + strip.h <= height) {
        const stripBg = medianColor(base, strip);
        let hits = 0;
        for (const x of [20, 50, 100, 200, 500, 1000, 2000, 5000].filter((f) => f > fMin! && f < fMax!).map(xOf)) {
          let ink = 0;
          for (let y = strip.y; y < strip.y + strip.h; y++) for (let dx = -6; dx <= 6; dx++) {
            const px = Math.round(x + dx);
            if (px >= 0 && px < width && colorDistance(pixel(base, px, y), stripBg) > 60) ink++;
          }
          if (ink >= 4) hits++;
        }
        if (hits >= 4) {
          labelBand = strip.h + 4;
          box.h += labelBand;
        }
      }
    }
  }

  const bg = dominantColor(base, box);
  // where the curve moves, pixels turn dark (old position) or take the curve colour (new position) – use the latter
  const curveFrame = gain?.frames[gain.frames.length - 1];
  const curvePoints = curveFrame
    ? maskPoints(diffMask(curveFrame, base, 40, noise), width, box).filter(([x, y]) => colorDistance(pixel(curveFrame, x, y), bg) > 60).slice(0, 20000)
    : [];
  const curve = curveFrame && curvePoints.length ? dominantAt(curveFrame, curvePoints) : ([230, 180, 60] as Rgb);
  const subtle = new Uint8Array(width * height);
  const bright = new Uint8Array(width * height);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const c = pixel(base, x, y);
    const d = colorDistance(c, bg);
    if (d > 6 && d < 60) subtle[y * width + x] = 1;
    if (d > 80 && colorDistance(c, curve) > 60) bright[y * width + x] = 1;
  }
  let text = bright.some((v) => v === 1) ? dominantColor(base, box, bright) : (luminance(bg) > 128 ? [60, 60, 60] as Rgb : [160, 160, 160] as Rgb);

  // dB labels: ink on the rows of the grid lines in the right part of the plot → their right edge and colour
  let dbLabelRight: number | undefined;
  if (dbTop !== undefined && dbBottom !== undefined) {
    const plotH = box.h - labelBand;
    const step = gridStep(plotH / Math.abs(dbTop - dbBottom));
    const rights: number[] = [];
    const ink: [number, number][] = [];
    for (let db = Math.ceil(Math.min(dbTop, dbBottom) / step) * step; db <= Math.max(dbTop, dbBottom); db += step) {
      if (Math.abs(db) < 1e-6) continue; // the curve lies on the 0 dB line
      const y = Math.round(box.y + ((dbTop - db) / (dbTop - dbBottom)) * plotH);
      let right = -1;
      for (let yy = y - 4; yy <= y + 4; yy++) {
        if (yy < box.y || yy >= box.y + plotH) continue;
        for (let x = box.x + Math.round(box.w * 0.6); x < box.x + box.w; x++) {
          const c = pixel(base, x, yy);
          if (colorDistance(c, bg) > 70) {
            ink.push([x, yy]);
            if (x > right) right = x;
          }
        }
      }
      if (right >= 0) rights.push(right);
    }
    const expected = Math.floor((Math.max(dbTop, dbBottom) - Math.min(dbTop, dbBottom)) / step);
    if (rights.length >= Math.max(3, expected * 0.6)) {
      dbLabelRight = percentile(rights, 0.5) + 1;
      text = dominantAt(base, ink);
    }
  }
  const band = Math.max(2, Math.round(box.h * 0.08));
  const topColor = medianColor(base, { x: box.x, y: box.y, w: box.w, h: band });
  const bottomColor = medianColor(base, { x: box.x, y: box.y + box.h - band, w: box.w, h: band });
  return {
    kind: "eq", ...box,
    background: hex(bg),
    ...(colorDistance(topColor, bottomColor) > 8 ? { backgroundTop: hex(topColor), backgroundBottom: hex(bottomColor) } : {}),
    grid: hex(dominantColor(base, box, subtle)),
    curve: hex(curve),
    text: hex(text),
    ...(fMin && fMax ? { fMin, fMax } : {}),
    ...(dbTop !== undefined && dbBottom !== undefined ? { dbTop, dbBottom, dbStep: gridStep((box.h - labelBand) / Math.abs(dbTop - dbBottom)) } : {}),
    ...(labelBand ? { labelBand } : {}),
    ...(dbLabelRight !== undefined ? { dbLabelRight } : {}),
  };
}

/** Smallest usual dB step whose grid lines are at least ~28 px apart. */
export function gridStep(pixelsPerDb: number): number {
  return [1, 2, 3, 5, 6, 10, 12, 20, 24].find((step) => step * pixelsPerDb >= 28) ?? 30;
}

// ---- static layout ------------------------------------------------------------------------------

interface Region extends Box {
  pixels: number;
  mask: Uint8Array;
  color: Rgb;
}

/** Region growing with a local colour tolerance (keeps gradients together, stops at edges). */
function segment(img: Image, exclude: Uint8Array, tolerance = 7): Region[] {
  const { width, height } = img;
  const labels = new Int32Array(width * height);
  const regions: Region[] = [];
  const stack: number[] = [];
  let label = 0;
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] || exclude[start]) continue;
    label++;
    let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
    const members: number[] = [];
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const p = stack.pop()!;
      members.push(p);
      const x = p % width;
      const y = (p - x) / width;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const i = p * 4;
      for (const q of [p - 1, p + 1, p - width, p + width]) {
        if (q < 0 || q >= labels.length || labels[q] || exclude[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === width - 1)) continue;
        const j = q * 4;
        const d = Math.max(Math.abs(img.data[i]! - img.data[j]!), Math.abs(img.data[i + 1]! - img.data[j + 1]!), Math.abs(img.data[i + 2]! - img.data[j + 2]!));
        if (d <= tolerance) {
          labels[q] = label;
          stack.push(q);
        }
      }
    }
    if (count < 40) continue;
    const regionMask = new Uint8Array(width * height);
    for (const p of members) regionMask[p] = 1;
    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    regions.push({ ...box, pixels: count, mask: regionMask, color: medianColor(img, box, regionMask) });
  }
  return regions.sort((a, b) => b.pixels - a.pixels);
}

function regionFill(img: Image, r: Region): Fill {
  const band = Math.max(1, Math.round(r.h * 0.15));
  const top = medianColor(img, { x: r.x, y: r.y, w: r.w, h: band }, r.mask);
  const bottom = medianColor(img, { x: r.x, y: r.y + r.h - band, w: r.w, h: band }, r.mask);
  return colorDistance(top, bottom) > 10 ? { color: hex(top), gradient: hex(bottom) } : { color: hex(r.color) };
}

function cornerRadius(r: Region, width: number): number {
  let steps = 0;
  while (steps < Math.min(r.w, r.h) / 2 && !r.mask[(r.y + steps) * width + r.x + steps]) steps++;
  return Math.min(40, Math.round(steps * 2.4));
}

/** Text blocks: high local contrast, merged horizontally. */
function textBlocks(img: Image, exclude: Uint8Array): { box: Box; color: Rgb; bold: boolean; uppercase: boolean }[] {
  const { width, height } = img;
  const lum = new Float64Array(width * height);
  for (let p = 0; p < lum.length; p++) lum[p] = luminance([img.data[p * 4]!, img.data[p * 4 + 1]!, img.data[p * 4 + 2]!]);
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += lum[y * width + x]!;
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1]! + row;
    }
  }
  const r = 7;
  const contrast = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (exclude[y * width + x]) continue;
      const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
      const sum = integral[y1 * (width + 1) + x1]! - integral[y0 * (width + 1) + x1]! - integral[y1 * (width + 1) + x0]! + integral[y0 * (width + 1) + x0]!;
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (Math.abs(lum[y * width + x]! - mean) > 45) contrast[y * width + x] = 1;
    }
  }
  const merged = dilate(contrast, width, height, 4, 1);
  return components(merged, width, height, 15)
    .filter((c) => c.h >= 6 && c.h <= 60 && c.w >= c.h * 0.6 && c.w <= width * 0.8)
    .map((c) => {
      const box = { x: c.x, y: c.y, w: c.w, h: c.h };
      const points = maskPoints(contrast, width, box);
      // capitals all reach the cap height; in mixed case only ascender letters do.
      // Compare how many ink columns reach the top band with how many have ink in the middle band.
      const ys = points.map((p) => p[1]);
      const top = Math.min(...ys), bottom = Math.max(...ys), inkHeight = bottom - top + 1;
      const columnsWith = (from: number, to: number) => new Set(points.filter((p) => p[1] >= top + inkHeight * from && p[1] < top + inkHeight * to).map((p) => p[0])).size;
      const topColumns = columnsWith(0, 0.22);
      const middleColumns = columnsWith(0.4, 0.65);
      const ratio = middleColumns > 0 ? topColumns / middleColumns : 0;
      const uppercase = inkHeight >= 7 && ratio > 0.8;
      return { box, color: dominantAt(img, points), bold: points.length / area(box) > 0.3, uppercase };
    });
}

// ---- main ---------------------------------------------------------------------------------------

export async function analyzeGui(probe: GuiProbe, parameters: Parameter[], pluginName: string): Promise<GuiModel> {
  const { width, height } = probe;
  const base = await loadRaw(probe.base, width, height);
  const base2 = await loadRaw(probe.base2, width, height);
  const noise = dilate(diffMask(base, base2), width, height, 2);

  // Pixels that react to many different parameters are global indicators (e.g. "preset modified") – ignore them.
  const plain = probe.visible.filter((p) => !p.bandRole);
  if (plain.length >= 4) {
    const counts = new Uint16Array(width * height);
    for (const param of plain) {
      const last = await loadRaw(param.frames[param.frames.length - 1]!.file, width, height);
      const m = dilate(diffMask(last, base, 24, noise), width, height, 2);
      for (let p = 0; p < m.length; p++) counts[p] = counts[p]! + m[p]!;
    }
    const limit = Math.max(3, Math.ceil(plain.length * 0.4));
    for (let p = 0; p < counts.length; p++) if (counts[p]! >= limit) noise[p] = 1;
  }

  let eqParams = new Set<number>();
  try {
    const mapping = detectEq(parameters);
    eqParams = new Set(mapping.bands.flatMap((b) => Object.values(b.params)));
  } catch {
    // not an EQ
  }

  const footprints: Footprint[] = [];
  const displayRegions: { box: Box; eq: boolean; params: ProbedParameter[]; frames: Image[] }[] = [];

  const bandFootprints: { param: ProbedParameter; frames: Image[] }[] = [];
  const pending: { param: ProbedParameter; frames: Image[]; parts: ReturnType<typeof components> }[] = [];
  const hiddenSwitches: number[] = [];
  const contains = (outer: Box, inner: Box) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  for (const param of probe.visible) {
    const frames = await Promise.all(param.frames.map((f) => loadRaw(f.file, width, height)));
    if (param.bandRole) {
      bandFootprints.push({ param, frames });
      continue;
    }
    const changed = new Uint8Array(width * height);
    for (const f of frames) {
      const m = diffMask(f, base, 24, noise);
      for (let p = 0; p < m.length; p++) if (m[p]) changed[p] = 1;
    }
    const allParts = components(dilate(changed, width, height, 4), width, height, 10);
    if (!allParts.length) continue;
    const changedPixels = changed.reduce((n, v) => n + v, 0);

    // A parameter may change a display (curve, meter) and its own control at the same time:
    // large parts belong to the display, compact parts outside of it to the control.
    const large = allParts.filter((p) => area(p) > width * height * 0.08);
    const displayBox = large.length ? union(large) : undefined;
    if (displayBox && changedPixels > width * height * 0.01) {
      displayRegions.push({ box: displayBox, eq: eqParams.has(param.index), params: [param], frames });
    }
    const parts = allParts.filter((p) => !large.includes(p) && !(displayBox && contains(displayBox, p)));
    if (!parts.length) continue;
    if (displayBox && !(parts[0]!.w <= width * 0.3 && parts[0]!.h <= height * 0.3)) continue;
    const pendingParam = { param, frames, parts };
    pending.push(pendingParam);
  }

  // Switches often also dim the control they enable – their own footprint is the part that is not another control.
  const continuousBoxes = pending.filter((p) => !p.param.discrete).map((p) => p.parts[0]!);
  for (const { param, frames, parts: candidates } of pending) {
    let parts = candidates;
    if (param.discrete) {
      const own = parts.filter((p) => !continuousBoxes.some((b) => overlaps(b, p, 2)));
      if (!own.length) {
        hiddenSwitches.push(param.index);
        continue;
      }
      parts = own;
    }
    // only nearby parts belong to the control (a toggle may also change something far away)
    const main0 = parts[0]!;
    const nearby = parts.filter((p) => Math.hypot(p.cx - main0.cx, p.cy - main0.cy) < Math.max(main0.w, main0.h) * 2.5 + 40);
    const region = union(nearby);
    const main = main0;
    const textLike = nearby.slice(1).filter((p) => p.h >= 6 && p.h <= 32 && p.w >= p.h * 1.2 &&
      (p.y >= main0.y + main0.h - 2 || p.y + p.h <= main0.y + 2) && p.x < main0.x + main0.w && p.x + p.w > main0.x && frames.filter((f, i) => i > 0 && diffMask(f, frames[i - 1]!, 30, noise).some((v, q) => v === 1 && (q % width) >= p.x && (q % width) < p.x + p.w && Math.floor(q / width) >= p.y && Math.floor(q / width) < p.y + p.h)).length >= Math.min(3, frames.length - 1));
    const near = textLike.sort((a, b) => Math.hypot(a.cx - main.cx, a.cy - main.cy) - Math.hypot(b.cx - main.cx, b.cy - main.cy))[0];
    const parameter = parameters.find((p) => p.index === param.index);
    footprints.push({
      param, frames, region, value: parameter ? parameter.value ?? parameter.default : 0.5,
      main: clampBox(grow({ x: main.x, y: main.y, w: main.w, h: main.h }, -3), base),
      ...(near ? { readout: clampBox(grow({ x: near.x, y: near.y, w: near.w, h: near.h }, -3), base) } : {}),
    });
  }

  valueAnchors.clear();
  const controls = footprints.map((fp) => analyzeControl(fp, noise)).filter((c): c is Control => Boolean(c));
  splitSharedValues(controls);
  const eqDisplay = bandFootprints.length ? analyzeEqDisplay(base, bandFootprints, parameters, noise) : undefined;

  // merge overlapping display regions
  const displays: Display[] = eqDisplay ? [eqDisplay] : [];
  const merged: typeof displayRegions = [];
  for (const d of displayRegions) {
    if (eqDisplay && overlaps(eqDisplay, d.box)) continue;
    const target = merged.find((m) => overlaps(m.box, d.box));
    if (target) {
      target.box = union([target.box, d.box]);
      target.eq ||= d.eq;
      target.params.push(...d.params);
      target.frames.push(...d.frames);
    } else merged.push({ ...d, params: [...d.params], frames: [...d.frames] });
  }
  for (const d of merged) {
    const box = clampBox(d.box, base);
    const bg = dominantColor(base, box);
    const subtle = new Uint8Array(width * height);
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
      const dist = colorDistance(pixel(base, x, y), bg);
      if (dist > 10 && dist < 70) subtle[y * width + x] = 1;
    }
    const curvePoints = d.frames.flatMap((f) => maskPoints(diffMask(f, base, 40, noise), width, box)).slice(0, 20000);
    const curve = dominantAt(d.frames[0]!, curvePoints);
    const grid = dominantColor(base, box, subtle);
    displays.push({ kind: d.eq ? "eq" : "generic", ...box, background: hex(bg), grid: hex(grid), curve: hex(curve), text: hex(luminance(bg) > 128 ? [40, 40, 40] : [170, 170, 170]) });
  }

  // exclusion mask for static analysis
  const occupied = new Uint8Array(width * height);
  const mark = (b: Box, pad: number) => {
    const c = clampBox(grow(b, pad), base);
    for (let y = c.y; y < c.y + c.h; y++) occupied.fill(1, y * width + c.x, y * width + c.x + c.w);
  };
  for (const c of controls) {
    mark(c, 3);
    if (c.readout) mark(c.readout, 2);
  }
  for (const d of displays) mark(d, 1);

  // texts and labels
  const blocks = textBlocks(base, occupied);
  const wordCounts = new Map<string, number>();
  for (const c of controls) for (const w of new Set(c.name.toLowerCase().split(/\s+/))) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
  const texts: TextItem[] = [];
  const used = new Set<number>();
  for (const c of controls) {
    const bottom = c.readout && c.readout.y > c.y + c.h * 0.5 ? c.readout.y + c.readout.h : c.y + c.h;
    const candidates = blocks
      .map((b, i) => ({ ...b, i }))
      .filter(({ i, box }) => !used.has(i) && box.h <= 28 && !(c.readout && overlaps(box, c.readout)))
      .map((b) => {
        const centred = Math.abs(b.box.x + b.box.w / 2 - (c.x + c.w / 2)) < Math.max(c.w, b.box.w) * 0.6;
        const below = b.box.y >= bottom - 4 ? b.box.y - bottom : Infinity;
        const above = b.box.y + b.box.h <= c.y + 4 ? c.y - (b.box.y + b.box.h) : Infinity;
        const sameRow = Math.abs(b.box.y + b.box.h / 2 - (c.y + c.h / 2)) < c.h * 0.6;
        const side = sameRow && b.box.x >= c.x + c.w - 2 ? b.box.x - (c.x + c.w) : Infinity;
        // labels sit close to their control – about one or two text lines away
        const limit = Math.max(14, Math.min(36, c.h * 0.3));
        const score = Math.min(centred && below < limit ? below : Infinity, centred && above < limit ? above * 1.6 + 4 : Infinity, c.kind === "toggle" && side < c.w * 3 ? side : Infinity);
        return { ...b, score, align: (side === score ? "left" : "center") as "left" | "center" };
      })
      .filter((b) => Number.isFinite(b.score))
      .map((b) => ({ ...b, text: fitLabel(c.name, b.box.w, b.box.h, b.uppercase, wordCounts) }))
      .filter((b): b is typeof b & { text: string } => b.text !== undefined);
    const best = candidates.sort((a, b) => a.score - b.score)[0];
    if (!best) continue;
    used.add(best.i);
    const text = best.text;
    texts.push({ ...best.box, text, color: hex(best.color), size: Math.round(best.box.h * 1.25), bold: best.bold, align: best.align, role: "label" });
  }
  const titleCandidate = blocks
    .map((b, i) => ({ ...b, i }))
    .filter(({ box, i }) => !used.has(i) && box.y < height * 0.35 && box.h >= 14 && box.h <= 60)
    .sort((a, b) => b.box.h - a.box.h)[0];
  if (titleCandidate) {
    // multi-coloured titles ("Tone" + "Recast") consist of several blocks on one line
    let box = titleCandidate.box;
    const row = blocks.map((b, i) => ({ ...b, i })).filter(({ box: b, i }) => !used.has(i) && Math.abs(b.y + b.h / 2 - (box.y + box.h / 2)) < box.h * 0.35 && Math.abs(b.h - box.h) < box.h * 0.4);
    for (let grew = true; grew;) {
      grew = false;
      for (const b of row) {
        const gap = b.box.x > box.x + box.w ? b.box.x - (box.x + box.w) : box.x > b.box.x + b.box.w ? box.x - (b.box.x + b.box.w) : 0;
        if (gap < box.h * 2 && !(b.box.x >= box.x && b.box.x + b.box.w <= box.x + box.w)) {
          box = union([box, b.box]);
          used.add(b.i);
          grew = true;
        }
      }
    }
    used.add(titleCandidate.i);
    const title = pluginName.replace(/\s+clone$/i, "");
    const estimate = title.length * box.h * (titleCandidate.uppercase ? 0.78 : 0.62);
    if (Math.abs(Math.log(estimate / box.w)) < 0.6) {
      texts.push({ ...box, text: titleCandidate.uppercase ? title.toUpperCase() : title, color: hex(titleCandidate.color), size: Math.round(box.h * 1.2), bold: titleCandidate.bold, align: "left", role: "title" });
    }
  }

  // background, panels and lines
  for (const b of blocks) mark(b.box, 2);
  const regions = segment(base, occupied);
  const background = regions[0];
  const panels: Panel[] = [];
  const lines: Line[] = [];
  const freeIn = (b: Box) => {
    let n = 0;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (!occupied[y * width + x]) n++;
    return Math.max(1, n);
  };
  for (const r of regions.slice(1)) {
    const thin = Math.min(r.w, r.h);
    const long = Math.max(r.w, r.h);
    const fill = r.pixels / freeIn(r);
    if (thin <= 4 && long >= 30 && fill > 0.6) {
      const horizontal = r.w >= r.h;
      lines.push(horizontal
        ? { x1: r.x, y1: r.y + r.h / 2, x2: r.x + r.w, y2: r.y + r.h / 2, color: hex(r.color), thickness: thin }
        : { x1: r.x + r.w / 2, y1: r.y, x2: r.x + r.w / 2, y2: r.y + r.h, color: hex(r.color), thickness: thin });
    } else if (r.pixels >= width * height * 0.006 && fill > 0.55 && background && colorDistance(r.color, background.color) > 8) {
      panels.push({ x: r.x, y: r.y, w: r.w, h: r.h, fill: regionFill(base, r), radius: cornerRadius(r, width) });
    }
  }

  const insideDisplay = (b: Box) => displays.some((d) => {
    const ix = Math.max(0, Math.min(b.x + b.w, d.x + d.w) - Math.max(b.x, d.x));
    const iy = Math.max(0, Math.min(b.y + b.h, d.y + d.h) - Math.max(b.y, d.y));
    return ix * iy > area(b) * 0.5;
  });
  const lineBox = (l: Line): Box => ({ x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1) + 1, h: Math.abs(l.y2 - l.y1) + 1 });
  const keptPanels = panels.filter((p) => !insideDisplay(p));
  const keptLines = lines.filter((l) => !insideDisplay(lineBox(l)));
  const keptTexts = texts.filter((t) => !insideDisplay(t));
  texts.length = 0;
  texts.push(...keptTexts);
  panels.length = 0;
  panels.push(...keptPanels);
  lines.length = 0;
  lines.push(...keptLines);

  return {
    type: "gui-layout",
    version: 1,
    width,
    height,
    background: background ? regionFill(base, background) : { color: hex(dominantColor(base, { x: 0, y: 0, w: width, h: height })) },
    panels: panels.slice(0, 60),
    lines: lines.slice(0, 80),
    texts,
    controls,
    displays,
    hidden: [...probe.invisible, ...hiddenSwitches],
  };
}
