import type { Parameter } from "@vst-cloner/profile";
import { buildTable, detectEq, tableValue } from "../eq/mapping.ts";
import {
  colorDistance,
  components,
  countMask,
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
import type { Circle, Control, Display, Fill, GuiModel, LevelBar, Line, Needle, Panel, Readout, RotaryStyle, TextItem } from "./model.ts";
import type { GuiProbe, ProbedParameter } from "./probe.ts";
import { METER_FILM, readFilm, segmentTimes, type FilmFrame } from "./film.ts";
import { findTesseract, plausibleText, recognizeBlocks, splitWords } from "./ocr.ts";

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

function bilinear(img: Image, x: number, y: number): Rgb {
  const x0 = Math.max(0, Math.min(img.width - 2, Math.floor(x))), y0 = Math.max(0, Math.min(img.height - 2, Math.floor(y)));
  const tx = Math.min(1, Math.max(0, x - x0)), ty = Math.min(1, Math.max(0, y - y0));
  const a = pixel(img, x0, y0), b = pixel(img, x0 + 1, y0), c = pixel(img, x0, y0 + 1), d = pixel(img, x0 + 1, y0 + 1);
  const mix = (i: 0 | 1 | 2) => Math.round((a[i] * (1 - tx) + b[i] * tx) * (1 - ty) + (c[i] * (1 - tx) + d[i] * tx) * ty);
  return [mix(0), mix(1), mix(2)];
}

function ringMedian(img: Image, cx: number, cy: number, r: number): Rgb {
  const ring = sampleRing(img, cx, cy, r);
  const median = (i: 0 | 1 | 2) => percentile(ring.map((c) => c[i]), 0.5);
  return [median(0), median(1), median(2)];
}

/**
 * Robust circle fit for a value arc: refits after dropping points far from the ring.
 * Returns the ring if most points lie on it and it spans a good part of the circle.
 */
function fitRing(points: [number, number][]): { cx: number; cy: number; r: number; width: number } | undefined {
  if (points.length < 30) return undefined;
  let inliers = points;
  let circle = fitCircle(inliers);
  for (let i = 0; i < 4 && circle; i++) {
    const c = circle;
    const d = points.map((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r));
    // a fixed band relative to the radius: a rotating pointer spreads its pixels radially and fails this test
    const tolerance = Math.max(2, c.r * 0.08);
    inliers = points.filter((_, k) => d[k]! <= tolerance);
    if (inliers.length < 20) return undefined;
    circle = fitCircle(inliers);
  }
  if (!circle || circle.r < 6 || inliers.length < points.length * 0.6) return undefined;
  const c = circle;
  const sectors = new Set(inliers.map((p) => Math.floor(((Math.atan2(p[0] - c.cx, -(p[1] - c.cy)) + TAU) % TAU) / TAU * 24)));
  if (sectors.size < 8) return undefined;
  const radial = inliers.map((p) => Math.hypot(p[0] - c.cx, p[1] - c.cy));
  return { ...c, width: Math.max(1.5, percentile(radial, 0.95) - percentile(radial, 0.05) + 1) };
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

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

/** Words common on plugin editors; uncertain readings one letter away are corrected ("RISHT" → "RIGHT"). */
const COMMON_WORDS = ["LEFT", "RIGHT", "FRONT", "BACK", "TOP", "BOTTOM", "MID", "SIDE", "INPUT", "OUTPUT", "GAIN", "LEVEL", "MIX", "DRY", "WET", "LOW", "HIGH", "BASS", "TREBLE", "ON", "OFF", "BYPASS", "STEREO", "MONO"];

function commonWord(word: string, confidence: number): string {
  if (confidence >= 85 || word.length < 3) return word;
  const upper = word.toUpperCase();
  const match = COMMON_WORDS.find((w) => w.length === upper.length && editDistance(w, upper) === 1);
  if (!match) return word;
  // keep the case of the reading
  return word === upper ? match : word === word.toLowerCase() ? match.toLowerCase() : match[0] + match.slice(1).toLowerCase();
}

/**
 * An uncertain OCR reading that is nearly a part of the parameter name ("Makelp" for "MakeUp Gain 1"):
 * that part of the name, spelled as in the name.
 */
export function nameLike(read: string | undefined, name: string): string | undefined {
  const text = read?.trim();
  if (!text || text.length < 3) return undefined;
  const words = name.split(/\s+/).filter(Boolean);
  let best: { part: string; distance: number } | undefined;
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= words.length; j++) {
    // with and without spaces ("Make Up" is shown as "MakeUp")
    for (const part of new Set([words.slice(i, j).join(" "), words.slice(i, j).join("")])) {
      const distance = editDistance(text.toLowerCase(), part.toLowerCase()) / Math.max(part.length, text.length);
      if (!best || distance < best.distance) best = { part, distance };
    }
  }
  if (!best || best.distance > 0.25) return undefined;
  // capitals as read ("OUTPUT" stays upper case)
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() ? best.part.toUpperCase() : best.part;
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
  /** value text of the original at `value` */
  valueText?: string;
}

function analyzeRotary(fp: Footprint, median: Image, noise: Uint8Array): RotaryStyle | undefined {
  const { frames, main } = fp;
  const width = median.width;
  const searchBox = clampBox(grow(main, 4), median);
  const moving = frames.map((f) => maskPoints(diffMask(f, median, 30, noise), width, searchBox));
  if (moving.flat().length < 6) return undefined;
  // A pointer passes a pixel once; what changes in the same place again and again is a value text drawn on the
  // knob (or its arc). With enough frames those pixels are told apart and kept out of the pointer.
  const seen = new Map<number, number>();
  for (const pts of moving) for (const [x, y] of pts) seen.set(y * width + x, (seen.get(y * width + x) ?? 0) + 1);
  const repeats = frames.length >= 7 ? 3 : Infinity;
  const passing = moving.map((pts) => pts.filter(([x, y]) => seen.get(y * width + x)! < repeats));
  const indicator = passing.flat().length >= 6 ? passing : moving;

  // Value arcs: if most changing pixels lie on a ring, that ring is centred on the knob axis.
  // a ring larger than the control itself belongs to something else (value text, neighbouring display)
  // (a value arc lights the same pixels in many frames; pointer marks near the rim lie on a ring too, but each once)
  const lasting = moving.flat().filter(([x, y]) => seen.get(y * width + x)! >= repeats);
  const fittedRing = frames.length >= 7 ? (lasting.length >= moving.flat().length * 0.3 ? fitRing(lasting) : undefined) : fitRing(moving.flat());
  const ring = fittedRing && fittedRing.r <= Math.max(main.w, main.h) * 0.6 ? fittedRing : undefined;
  // The centroid of a rotating pointer moves on a circle around the knob axis.
  let cx = ring ? ring.cx : main.x + main.w / 2;
  let cy = ring ? ring.cy : main.y + main.h / 2;
  for (let iteration = 0; iteration < (ring ? 0 : 2); iteration++) {
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
  // pointer: changing pixels inside the arc (if there is one)
  const inside = (p: [number, number]) => !ring || dist(p) < ring.r - ring.width;
  const pointerReach = percentile(indicator.flat().filter(inside).map(dist), 0.95) || (ring ? ring.r * 0.7 : 0);

  // knob body: first radius where the ring colour departs from the centre colour
  let centre = ringMedian(median, cx, cy, Math.max(2, pointerReach * 0.25));
  let radius = pointerReach * 1.05;
  const maxRadius = ring ? ring.r - ring.width / 2 - 1 : pointerReach * 2.2;
  for (let r = pointerReach * 0.5; r < maxRadius; r += 0.5) {
    if (colorDistance(ringMedian(median, cx, cy, r), centre) > (ring ? 14 : 40)) {
      radius = r;
      break;
    }
    radius = Math.min(maxRadius, Math.max(radius, r));
  }
  // Better: the rim of the disc in the still image – the first full circle at or beyond the pointer tip, widened
  // over bevel rings right outside of it. The centre moves to where the circles are complete.
  const half = Math.max(main.w, main.h) / 2;
  const edges = circleEdges(median, cx, cy, Math.max(4, pointerReach * 0.92), ring ? ring.r - ring.width / 2 - 1 : Math.max(pointerReach * 1.8, half * 1.35), ring ? 1 : 3);
  if (process.env.VCH_GUI_DEBUG) console.error(`rotary ${fp.param.name}: main ${main.x},${main.y} ${main.w}x${main.h} frames ${frames.length} points ${moving.map((m) => m.length).join("/")} passing ${passing.map((m) => m.length).join("/")} ring ${ring ? ring.r.toFixed(1) : "-"} centre ${cx.toFixed(1)},${cy.toFixed(1)} reach ${pointerReach.toFixed(1)} oldRadius ${radius.toFixed(1)} edges ${edges ? `${edges.cx.toFixed(1)},${edges.cy.toFixed(1)} [${edges.radii.join(" ")}]` : "-"}`);
  // without a rim the body cannot be larger than what moved
  if (!edges && !ring) radius = Math.min(radius, Math.max(pointerReach * 1.12, half * 0.95));
  if (edges) {
    const rim = edges.radii[0]!;
    radius = edges.radii.filter((r) => r <= rim * 1.3).pop()!;
    cx = edges.cx;
    cy = edges.cy;
    centre = ringMedian(median, cx, cy, Math.max(2, radius * 0.3));
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

  // Travel: the pointer followed through all positions, so that knobs turning anticlockwise or all the way round
  // (start and end in the same place) are told apart from a pointer that did not move.
  let startAngle = (-135 * Math.PI) / 180;
  let endAngle = (135 * Math.PI) / 180;
  const angles = indicator.map(pointerAngle);
  const steps: number[] = [];
  for (let i = 1, prev = angles[0]; i < angles.length; i++) {
    const a = angles[i];
    if (a === undefined || prev === undefined) {
      prev = a ?? prev;
      continue;
    }
    steps.push(Math.atan2(Math.sin(a - prev), Math.cos(a - prev)));
    prev = a;
  }
  const travel = steps.reduce((x, y) => x + y, 0);
  const oneWay = steps.filter((d) => Math.abs(d) > 0.05).every((d) => Math.sign(d) === Math.sign(travel));
  const firstAngle = angles.find((a) => a !== undefined);
  if (firstAngle !== undefined && angles[0] !== undefined && angles[angles.length - 1] !== undefined && oneWay && Math.abs(travel) >= 0.5) {
    startAngle = firstAngle;
    endAngle = startAngle + Math.sign(travel) * Math.min(TAU, Math.abs(travel));
  } else {
    // the end positions alone (old behaviour: clockwise, less than a full turn)
    const s0 = pointerAngle(first), e0 = pointerAngle(last);
    if (s0 !== undefined && e0 !== undefined) {
      const e = e0 <= s0 ? e0 + TAU : e0;
      if (e - s0 <= TAU * 0.95 && e - s0 >= 0.5) {
        startAngle = s0;
        endAngle = e;
      }
    }
  }
  const span = endAngle - startAngle;
  /** position of an angle along the travel, 0 at the start, 1 at the end */
  const along = (a: number) => {
    let t = (a - startAngle) * Math.sign(span);
    t = ((t % TAU) + TAU) % TAU;
    return t / Math.abs(span);
  };
  const atAlong = (u: number) => startAngle + u * span;

  // value arc: compare the highest value with value 0 (between them every part of the arc changes, whether it
  // grows from the start or from a centre position)
  let arc: RotaryStyle["arc"];
  const arcSearch = clampBox(grow(main, Math.round(radius * 0.6)), median);
  const arcPoints = maskPoints(diffMask(frames[frames.length - 1]!, frames[0]!, 30, noise), width, arcSearch)
    .filter((p) => dist(p) > radius * 0.85 && dist(p) < radius * 1.7);
  const bins = new Set(arcPoints.map((p) => Math.floor(along(angleOf(p[0] - cx, p[1] - cy)) * 24)).filter((b) => b >= 0 && b < 24));
  if (arcPoints.length > 20 && bins.size >= 16) {
    const d = arcPoints.map(dist);
    const arcRadius = percentile(d, 0.5);
    // in each changed pixel one of the two frames shows the arc, the other the track: the arc is the one that
    // stands out more from the surroundings
    const far = ringMedian(median, cx, cy, radius * 1.8);
    const lit: Rgb[] = [], unlit: Rgb[] = [];
    for (const [x, y] of arcPoints) {
      const c0 = pixel(frames[0]!, x, y), c1 = pixel(frames[frames.length - 1]!, x, y);
      const [on, off] = colorDistance(c0, far) > colorDistance(c1, far) ? [c0, c1] : [c1, c0];
      lit.push(on);
      unlit.push(off);
    }
    const mid = (cs: Rgb[]): Rgb => [0, 1, 2].map((i) => percentile(cs.map((c) => c[i]!), 0.5)) as Rgb;
    const arcColor = mid(lit), trackColor = mid(unlit);

    // Where the arc starts: in every position it reaches from there to the pointer. Its length and middle in
    // each frame give that point; a value 0 that lights nothing means the start of the travel.
    const samples = 96;
    const full = Math.abs(span) > TAU * 0.9;
    const origins: number[] = [];
    frames.forEach((f, i) => {
      const t = fp.param.frames[i]?.value;
      if (t === undefined) return;
      const covered: number[] = [];
      for (let k = 0; k < samples; k++) {
        const u = (k + 0.5) / samples;
        // (all the way round, the start and the end are the same place: leave out the seam)
        if (full && (u < 0.03 || u > 0.97)) continue;
        const a = atAlong(u);
        const x = Math.round(cx + Math.sin(a) * arcRadius), y = Math.round(cy - Math.cos(a) * arcRadius);
        if (x < 0 || y < 0 || x >= width || y >= median.height) continue;
        const c = pixel(f, x, y);
        if (colorDistance(c, arcColor) < colorDistance(c, trackColor) && colorDistance(c, arcColor) < 60) covered.push(u);
      }
      const len = covered.length / samples;
      if (len < 0.05) return;
      const m = covered.reduce((x, y) => x + y, 0) / covered.length;
      const candidates = [t - len, t + len].filter((o) => o > -0.08 && o < 1.08);
      if (!candidates.length) return;
      origins.push(candidates.sort((p, q) => Math.abs((p + t) / 2 - m) - Math.abs((q + t) / 2 - m))[0]!);
    });
    let origin = origins.length >= 2 ? Math.max(0, Math.min(1, percentile(origins, 0.5))) : 0;
    // the zero of a ± range is mostly the middle or the plugin's default
    for (const snap of [0.5, fp.value]) if (Math.abs(origin - snap) < 0.025) origin = snap;
    if (process.env.VCH_GUI_DEBUG) console.error(`arc ${fp.param.name}: start ${startAngle.toFixed(2)} end ${endAngle.toFixed(2)} origins ${origins.map((o) => o.toFixed(2)).join(" ")} → ${origin.toFixed(2)}`);

    arc = {
      color: hex(arcColor),
      radius: arcRadius,
      width: Math.max(1.5, percentile(d, 0.9) - percentile(d, 0.1) + 1),
      ...(colorDistance(trackColor, far) > 25 ? { track: hex(trackColor) } : {}),
      ...(origin > 0.04 ? { origin: Math.round(origin * 1000) / 1000 } : {}),
    };
  }

  const middle = pointerOf(indicator[indicator.length >> 1]!);
  const middleDistances = middle.map(dist);
  const inner = middleDistances.length ? percentile(middleDistances, 0.05) / radius : 0.3;
  const outer = middleDistances.length ? percentile(middleDistances, 0.95) / radius : 0.9;
  // pointer colour: of the pointer pixels in all positions, those that stand out most from the body (a thin line
  // between two pixel rows leaves only blends in the most common colour)
  const pointerPixels = indicator.flatMap((pts, i) => pointerOf(pts).map(([x, y]) => pixel(frames[i]!, x, y)))
    .sort((a, b) => colorDistance(b, centre) - colorDistance(a, centre));
  const strongest = pointerPixels.slice(0, Math.max(1, Math.round(pointerPixels.length * 0.25)));
  const pointerColor: Rgb = strongest.length && pointerPixels.length >= 3
    ? [0, 1, 2].map((i) => percentile(strongest.map((c) => c[i]!), 0.5)) as Rgb
    : luminance(centre) > 128 ? [30, 30, 30] : [235, 235, 235];
  const length = Math.max(1, (outer - inner) * radius);
  // a short line pointing outwards is longer along the radius than across it; a dot is as wide as long
  const middleAngles = middle.map((p) => angleOf(p[0] - cx, p[1] - cy));
  const meanAngle = middleAngles.length ? Math.atan2(middleAngles.reduce((s, a) => s + Math.sin(a), 0), middleAngles.reduce((s, a) => s + Math.cos(a), 0)) : 0;
  const across = middle.map((p, i) => Math.sin(middleAngles[i]! - meanAngle) * dist(p));
  const acrossExtent = across.length ? percentile(across, 0.95) - percentile(across, 0.05) + 1 : length;
  const radialMark = length >= acrossExtent * 1.5;

  const top = pixel(median, Math.round(cx), Math.max(0, Math.round(cy - radius * 0.65)));
  const bottom = pixel(median, Math.round(cx), Math.min(median.height - 1, Math.round(cy + radius * 0.65)));
  const lt = luminance(top), lb = luminance(bottom), lc = luminance(centre);
  const brackets = Math.min(lt, lb) - 12 <= lc && lc <= Math.max(lt, lb) + 12;
  const body: Fill = colorDistance(top, bottom) > 18 && brackets && colorDistance(top, centre) < 80 && colorDistance(bottom, centre) < 80
    ? { color: hex(top), gradient: hex(bottom) }
    : { color: hex(centre) };

  const edge = ringMedian(median, cx, cy, radius);
  const outside = ringMedian(median, cx, cy, radius * 1.25 + 3);
  let outline = colorDistance(edge, centre) > 30 && colorDistance(edge, outside) > 30 ? hex(edge) : undefined;
  // A thin ring of its own colour right around the disc (a coloured or bevelled rim): it differs from the body
  // and from what lies a little further out. The body then reaches to the middle of that ring.
  if (!outline) {
    let best: { r: number; c: Rgb; d: number } | undefined;
    for (let r = radius + 0.5; r <= radius + 3; r += 0.5) {
      const c = ringMedian(median, cx, cy, r);
      const d = Math.min(colorDistance(c, centre), colorDistance(c, ringMedian(median, cx, cy, r + 3)));
      if (d > 40 && (!best || d > best.d)) best = { r, c, d };
    }
    if (best) {
      const like = (r: number) => colorDistance(ringMedian(median, cx, cy, r), best!.c) < 40;
      let r0 = best.r, r1 = best.r;
      while (r0 - 0.5 > radius - 1 && like(r0 - 0.5)) r0 -= 0.5;
      while (r1 + 0.5 < best.r + 4 && like(r1 + 0.5)) r1 += 0.5;
      if (r1 - r0 <= 3) {
        outline = hex(best.c);
        radius = (r0 + r1) / 2;
      }
    }
  }

  // A coloured ring a little inside the rim (ZamComp's red, green, yellow … rings between black edges): per angle
  // the most saturated pixel near the rim; where most angles have one of the same hue, that is the knob's colour.
  // (Per angle rather than on one circle: a centre a pixel or two off misses a ring two pixels wide.)
  {
    const saturation = (c: Rgb) => Math.max(...c) - Math.min(...c);
    const hits: Rgb[] = [];
    // (a body coloured all over – x42's yellow, red and blue knobs – has no ring of its own to find)
    const angles = 48;
    for (let k = 0; k < angles; k++) {
      const a = (k / angles) * Math.PI * 2;
      let best: Rgb | undefined;
      for (let r = radius * 0.7; r <= radius * 1.08; r += 0.5) {
        const c = pixel(median, Math.round(cx + Math.sin(a) * r), Math.round(cy - Math.cos(a) * r));
        if (saturation(c) > 60 && (!best || saturation(c) > saturation(best))) best = c;
      }
      if (best) hits.push(best);
    }
    if (hits.length >= angles * 0.6 && saturation(centre) <= 50) {
      const ring = dominantColorOf(hits);
      const alike = hits.filter((c) => colorDistance(c, ring) < 80).length;
      if (alike >= angles * 0.5 && colorDistance(ring, centre) > 40) outline = hex(ring);
    }
  }

  // tick marks around the knob: short marks at regular angles on a ring outside the body
  let ticks: RotaryStyle["ticks"];
  const background = outside;
  for (let r = radius * 1.12; r < radius * 1.45 && !ticks; r += 1) {
    const samples = 360;
    const ringColors: (Rgb | undefined)[] = [];
    for (let k = 0; k < samples; k++) {
      const a = (k / samples) * TAU;
      const x = Math.round(cx + Math.sin(a) * r);
      const y = Math.round(cy - Math.cos(a) * r);
      ringColors.push(x < 0 || y < 0 || x >= median.width || y >= median.height ? undefined : pixel(median, x, y));
    }
    // A mark stands out from the background next to it on the same ring: the background may change around the
    // knob (a panel on one side, a display on the other).
    const localBackground = (k: number): Rgb => {
      const near: Rgb[] = [];
      for (let j = -12; j <= 12; j++) {
        const c = ringColors[(k + j + samples) % samples];
        if (c) near.push(c);
      }
      const ch = (i: 0 | 1 | 2) => percentile(near.map((c) => c[i]), 0.5);
      return near.length ? [ch(0), ch(1), ch(2)] : background;
    };
    const hits: number[] = [];
    for (let k = 0; k < samples; k++) {
      const c = ringColors[k];
      if (c && colorDistance(c, localBackground(k)) > 50) hits.push(k);
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
    // marks go around the knob (at least half the way): a label below it gives short runs too, but all in one place
    const span = centres.length ? centres[centres.length - 1]! - centres[0]! : 0;
    if (short.length >= 5 && short.length <= 41 && short.length >= runs.length * 0.8 && regular && span >= samples * 0.5) {
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
      const tickBackground = localBackground(Math.round((short[0]![0]! + short[0]![short[0]!.length - 1]!) / 2));
      const marked = (d: number) => {
        const x = Math.round(cx + Math.sin(a0) * d), y = Math.round(cy - Math.cos(a0) * d);
        return x >= 0 && y >= 0 && x < median.width && y < median.height && colorDistance(pixel(median, x, y), tickBackground) > 50;
      };
      let outerR = r;
      while (outerR < radius * 2 && marked(outerR)) outerR += 0.5;
      let innerR = r;
      while (innerR > radius && marked(innerR)) innerR -= 0.5;
      ticks = {
        angles,
        inner: innerR / radius,
        outer: outerR / radius,
        color: hex(dominantAt(median, tickPoints)),
        width: Math.max(1, Math.round(short.reduce((s, run) => s + run.length, 0) / short.length * (TAU * r) / samples)),
      };
    }
  }

  // A cap on the axis: a small disc that stands out from the body and does not turn (it is there in the still
  // image). A pointer that starts at the axis would look the same, so the pointer has to begin outside of it.
  let cap: RotaryStyle["cap"];
  const capColor = ringMedian(median, cx, cy, 0.5);
  if (colorDistance(capColor, centre) > 60) {
    let capRadius = 0;
    for (let r = 1; r <= radius * 0.35; r += 0.5) {
      if (colorDistance(ringMedian(median, cx, cy, r), capColor) > 40) break;
      capRadius = r;
    }
    capRadius += 0.5;
    if (capRadius >= 1.5 && capRadius <= radius * 0.3 && inner * radius > capRadius + 1) cap = { radius: capRadius, color: hex(capColor) };
  }

  return {
    cx, cy, radius, startAngle, endAngle, body,
    ...(outline ? { outline } : {}),
    ...(cap ? { cap } : {}),
    pointer: hex(pointerColor),
    pointerInner: Math.max(0, Math.min(1, inner)),
    pointerOuter: Math.max(0.2, Math.min(1.05, outer)),
    pointerWidth: Math.max(1.5, Math.min(radius * 0.14, middle.length / length / 1.3)),
    pointerDot: inner > 0.45 && outer - inner < 0.35 && !radialMark,
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
  const base = {
    param: param.index, name, value: fp.value,
    ...(fp.valueText ? { valueText: fp.valueText } : {}),
    ...(param.options?.length ? { options: param.options } : {}),
    x: main.x, y: main.y, w: main.w, h: main.h, ...(readout ? { readout } : {}),
  };

  if (param.discrete && frames.length === 2) {
    const off = dominantColor(frames[0]!, main);
    const on = dominantColor(frames[1]!, main);
    const round = Math.abs(main.w - main.h) < Math.max(3, main.w * 0.15);
    return { ...base, kind: "toggle", toggle: { off: hex(off), on: hex(on), radius: round ? main.w / 2 : Math.min(6, main.h / 3) } };
  }

  if (param.discrete) {
    // the option text is always there: pixels clearly apart from the box colour in the first frame
    const background = dominantColor(median, main);
    const frame = frames[0]!;
    const ink: [number, number][] = [];
    for (let y = main.y; y < main.y + main.h; y++) for (let x = main.x; x < main.x + main.w; x++) if (colorDistance(pixel(frame, x, y), background) > 80) ink.push([x, y]);
    const text = ink.length >= 4 ? dominantAt(frame, ink) : luminance(background) > 128 ? ([20, 20, 20] as Rgb) : ([235, 235, 235] as Rgb);
    return {
      ...base, kind: "choice",
      choice: { background: hex(background), text: hex(text), size: Math.max(9, Math.round(main.h * 0.55)) },
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
    const thumbAcross = thumbPoints.length ? (horizontal ? Math.max(...thumbPoints.map((p) => p[1])) - Math.min(...thumbPoints.map((p) => p[1])) : Math.max(...thumbPoints.map((p) => p[0])) - Math.min(...thumbPoints.map((p) => p[0]))) + 1 : thumbExtent;
    // A thin track: lines along the slider (without the thumb – the median of all positions) that stand out
    // from what lies around it (ZamEQ2's black line under a blue ball). Otherwise the box is the track.
    const across = horizontal ? main.h : main.w;
    const lineColor = (k: number) => medianColor(median, horizontal ? { x: main.x, y: main.y + k, w: main.w, h: 1 } : { x: main.x + k, y: main.y, w: 1, h: main.h });
    const around = medianColor(median, clampBox(horizontal ? { x: main.x, y: main.y - 3, w: main.w, h: 2 } : { x: main.x - 3, y: main.y, w: 2, h: main.h }, median));
    const lineDistances = Array.from({ length: across }, (_, k) => colorDistance(lineColor(k), around));
    const peak = lineDistances.indexOf(Math.max(...lineDistances));
    let from = peak, to = peak;
    while (from > 0 && lineDistances[from - 1]! > 40) from--;
    while (to < across - 1 && lineDistances[to + 1]! > 40) to++;
    const thinTrack = lineDistances[peak]! > 40 && to - from + 1 <= across * 0.5;
    const trackColor = thinTrack ? lineColor(Math.round((from + to) / 2)) : dominantColor(median, main);
    // a disc fills about π/4 of its square
    const fillRatio = thumbPoints.length / Math.max(1, (thumbExtent + 1) * thumbAcross);
    const roundThumb = thumbPoints.length >= 12 && Math.abs(thumbExtent + 1 - thumbAcross) <= Math.max(2, thumbAcross * 0.2) && fillRatio > 0.6 && fillRatio < 0.9;
    return {
      ...base,
      kind: horizontal ? "slider-h" : "slider-v",
      slider: {
        track: hex(trackColor), thumb: hex(dominantAt(frames[frames.length >> 1]!, thumbPoints)), thumbSize: Math.max(4, Math.min(thumbExtent, horizontal ? main.w / 3 : main.h / 3)),
        ...(thinTrack ? { trackWidth: to - from + 1 } : {}),
        ...(roundThumb ? { roundThumb: true } : {}),
      },
    };
  }

  const rotary = analyzeRotary(fp, median, noise);
  if (!rotary) return undefined;
  const onKnob = readout ? undefined : valueOnKnob(fp, rotary, median, noise);
  const extent = rotary.radius * Math.max(1, rotary.ticks?.outer ?? 1, rotary.arc ? (rotary.arc.radius + rotary.arc.width / 2) / rotary.radius : 1);
  return {
    ...base,
    kind: "rotary",
    x: Math.round(rotary.cx - extent - 1),
    y: Math.round(rotary.cy - extent - 1),
    w: Math.round(extent * 2 + 2),
    h: Math.round(extent * 2 + 2),
    rotary,
    ...(onKnob ? { readout: onKnob } : {}),
  };
}

const rgbOf = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/**
 * A value written on the knob itself (ZamComp's "10.0" in the middle of the knob): rows around the centre that
 * change from almost every position to the next – a pointer passes any row only now and then. The rows form a
 * flat band, the text is what stands out from the knob body there.
 */
function valueOnKnob(fp: Footprint, rotary: RotaryStyle, median: Image, noise: Uint8Array): Readout | undefined {
  const { frames } = fp;
  if (frames.length < 4) return undefined;
  const r = rotary.radius;
  const inner = clampBox({ x: Math.round(rotary.cx - r * 0.8), y: Math.round(rotary.cy - r * 0.55), w: Math.round(r * 1.6), h: Math.round(r * 1.1) }, median);
  const body = rgbOf(rotary.body.color);
  // text stands out from the body in every frame; a pointer is a thin line that crosses a row only now and then
  const ink = (f: Image, x: number, y: number) => colorDistance(pixel(f, x, y), body) > 110;
  const rows = new Float64Array(inner.h);
  for (const f of frames) for (let y = 0; y < inner.h; y++) {
    let n = 0;
    for (let x = inner.x; x < inner.x + inner.w; x++) if (ink(f, x, inner.y + y)) n++;
    if (n >= 2) rows[y]! += 1;
  }
  const always = frames.length * 0.6;
  const centre = Math.round(rotary.cy - inner.y);
  let top = -1, bottom = -1;
  for (let d = 0; d < inner.h / 2 && top < 0; d++) for (const y of [centre - d, centre + d]) if (top < 0 && y >= 0 && y < inner.h && rows[y]! >= always) top = bottom = y;
  if (process.env.VCH_GUI_DEBUG) console.error(`value on knob ${fp.param.name}: r ${r.toFixed(1)} rows ${[...rows].join(",")} (of ${frames.length})`);
  if (top < 0) return undefined;
  // (a thin row inside the text – the bar of an "e", a gap between lines of a glyph – does not end the band)
  const strong = (y: number) => y >= 0 && y < inner.h && rows[y]! >= always;
  while (strong(top - 1) || (strong(top - 2) && rows[top - 1]! > 0)) top -= strong(top - 1) ? 1 : 2;
  while (strong(bottom + 1) || (strong(bottom + 2) && rows[bottom + 1]! > 0)) bottom += strong(bottom + 1) ? 1 : 2;
  const h = bottom - top + 1;
  if (h < Math.max(5, r * 0.15) || h > r * 0.7 || Math.abs(inner.y + (top + bottom) / 2 - rotary.cy) > r * 0.4) return undefined;
  // columns: ink in any frame
  let left = inner.w, right = -1;
  for (const f of frames) for (let y = top; y <= bottom; y++) for (let x = 0; x < inner.w; x++) if (ink(f, inner.x + x, inner.y + y)) { left = Math.min(left, x); right = Math.max(right, x); }
  const w = right - left + 1;
  if (w < h * 1.2) return undefined;
  const box: Box = { x: inner.x + left, y: inner.y + top, w, h };
  // a value changes with the control (a logo printed on the knob does not)
  const changing = frames.slice(1).filter((f, k) => maskPoints(diffMask(f, frames[k]!, 40, noise), median.width, box).length >= h).length;
  if (changing < (frames.length - 1) * 0.6) return undefined;
  const frame = frames[frames.length >> 1]!;
  const points: [number, number][] = [];
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (ink(frame, x, y)) points.push([x, y]);
  if (points.length < h * 2) return undefined;
  const decimals = shownDecimals(frames, box, ink);
  return { ...box, color: hex(dominantAt(frame, points)), size: Math.max(7, Math.round(h * 1.3)), onKnob: true, ...(decimals !== undefined ? { decimals } : {}) };
}

/**
 * Digits after the point in a value text, counted on the glyphs: columns with ink separate them, a decimal point
 * is a small blot at the bottom. The most frequent count over all frames (a frame may show an integer like "200").
 */
function shownDecimals(frames: Image[], box: Box, ink: (f: Image, x: number, y: number) => boolean): number | undefined {
  const counts = new Map<number, number>();
  for (const f of frames) {
    const glyphs: { x0: number; x1: number; top: number; bottom: number }[] = [];
    let open: (typeof glyphs)[number] | undefined;
    for (let x = box.x; x <= box.x + box.w; x++) {
      let top = Infinity, bottom = -Infinity;
      if (x < box.x + box.w) for (let y = box.y; y < box.y + box.h; y++) if (ink(f, x, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      if (bottom >= top) open = open ? { ...open, x1: x, top: Math.min(open.top, top), bottom: Math.max(open.bottom, bottom) } : { x0: x, x1: x, top, bottom };
      else if (open) { glyphs.push(open); open = undefined; }
    }
    if (glyphs.length < 2) continue;
    const dot = glyphs.findIndex((g) => g.x1 - g.x0 + 1 <= box.h * 0.35 && g.bottom - g.top + 1 <= box.h * 0.4 && g.bottom >= box.y + box.h * 0.6);
    const n = dot >= 0 ? glyphs.length - dot - 1 : 0;
    if (n <= 4) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= frames.length * 0.4 ? best[0] : undefined;
}

/**
 * Blobs that belong together: grown from the largest one, each joining when it is closer to the group than
 * the group is wide. Gives up (undefined) when the result is no compact, roughly square area.
 */
function nearbyBlobs(parts: (Box & { cx: number; cy: number })[], width: number, height: number): { box: Box; count: number } | undefined {
  if (parts.length < 2) return undefined;
  const group = [parts[0]!];
  const rest = parts.slice(1);
  for (let grew = true; grew;) {
    grew = false;
    const box = union(group);
    const reach = Math.max(box.w, box.h, 24) * 0.9 + 12;
    for (let i = rest.length - 1; i >= 0; i--) {
      const p = rest[i]!;
      const dx = Math.max(box.x - (p.x + p.w), p.x - (box.x + box.w), 0), dy = Math.max(box.y - (p.y + p.h), p.y - (box.y + box.h), 0);
      if (Math.hypot(dx, dy) < reach && Math.max(union([box, p]).w, union([box, p]).h) < Math.min(width, height) * 0.45) {
        group.push(p);
        rest.splice(i, 1);
        grew = true;
      }
    }
  }
  const box = union(group);
  if (group.length < 2 || box.w > box.h * 1.6 || box.h > box.w * 1.6) return undefined;
  // marks of one pointer are alike in size (two neighbouring ones may merge into one twice as large); a knob of
  // its own next to small marks of a display it moves is not
  const sizes = group.map(area).sort((a, b) => a - b);
  if (sizes[sizes.length - 1]! > sizes[sizes.length >> 1]! * 4.5) return undefined;
  // one blob that already is most of the control: what lies well outside of it is something else it changes
  const largest = parts[0]!;
  if (area(largest) > area(box) * 0.3 && (box.w > largest.w * 1.3 || box.h > largest.h * 1.3)) return undefined;
  return { box, count: group.length };
}

/**
 * Circular edges around a centre in a still image: radii at which most directions show a colour step. Knobs are
 * drawn as discs – their rims are there whatever the pointer looks like. The centre is nudged (up to `nudge`
 * pixels) to where the circles are most complete. Radii are returned in rising order.
 */
function circleEdges(img: Image, cx0: number, cy0: number, rMin: number, rMax: number, nudge: number): { cx: number; cy: number; radii: number[] } | undefined {
  const directions = 48;
  const coverageAt = (cx: number, cy: number, r: number) => {
    let hits = 0, valid = 0;
    for (let k = 0; k < directions; k++) {
      const a = (k / directions) * TAU, sx = Math.sin(a), sy = -Math.cos(a);
      const x0 = cx + sx * (r - 1.2), y0 = cy + sy * (r - 1.2), x1 = cx + sx * (r + 1.2), y1 = cy + sy * (r + 1.2);
      if (Math.min(x0, x1, y0, y1) < 1 || Math.max(x0, x1) >= img.width - 2 || Math.max(y0, y1) >= img.height - 2) continue;
      valid++;
      if (colorDistance(bilinear(img, x0, y0), bilinear(img, x1, y1)) > 16) hits++;
    }
    return valid >= directions * 0.75 ? hits / valid : 0;
  };
  let best: { cx: number; cy: number; radii: number[]; score: number } | undefined;
  for (let dx = -nudge; dx <= nudge; dx++) for (let dy = -nudge; dy <= nudge; dy++) {
    const cx = cx0 + dx, cy = cy0 + dy;
    const radii: number[] = [];
    let peak = 0, open: { r: number; c: number } | undefined;
    for (let r = rMin; r <= rMax + 0.5; r += 0.5) {
      const c = r <= rMax ? coverageAt(cx, cy, r) : 0;
      peak = Math.max(peak, c);
      if (c >= 0.7) {
        if (!open || c > open.c) open = { r, c };
      } else if (open) {
        radii.push(open.r);
        open = undefined;
      }
    }
    if (!radii.length) continue;
    const score = peak - Math.hypot(dx, dy) * 0.03;
    if (!best || score > best.score) best = { cx, cy, radii, score };
  }
  return best;
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

/** Value text of a parameter at a normalised value: interpolated between numeric texts, otherwise the nearest. */
export function textAtValue(p: Parameter, value: number): string | undefined {
  const texts = [...(p.texts ?? [])].sort((a, b) => a.value - b.value);
  if (!texts.length) return undefined;
  const number = (t: string) => /^\s*[+-]?\d+(?:[.,]\d+)?/.exec(t)?.[0];
  const upper = texts.findIndex((t) => t.value >= value);
  const a = texts[Math.max(0, upper - 1)]!, b = texts[upper < 0 ? texts.length - 1 : upper]!;
  const na = number(a.text), nb = number(b.text);
  if (na === undefined || nb === undefined || b.value === a.value || a.text.slice(na.length) !== b.text.slice(nb.length)) {
    return (Math.abs(a.value - value) <= Math.abs(b.value - value) ? a : b).text;
  }
  const decimals = (na.split(/[.,]/)[1] ?? "").length;
  const v = Number(na.replace(",", ".")) + ((value - a.value) / (b.value - a.value)) * (Number(nb.replace(",", ".")) - Number(na.replace(",", ".")));
  return `${v.toFixed(decimals)}${a.text.slice(na.length)}`;
}

/**
 * Splits a changed area into a control and a value text stacked above or below it: the rows of the
 * (undilated) change mask fall into blocks separated by empty rows; a flat, wide block is the value text.
 */
function splitStack(changed: Uint8Array, width: number, box: Box): { control: Box; readout: Box } | undefined {
  const rows: number[] = [];
  for (let y = box.y; y < box.y + box.h; y++) {
    let n = 0;
    for (let x = box.x; x < box.x + box.w; x++) n += changed[y * width + x]!;
    rows.push(n);
  }
  const blocks: { from: number; to: number }[] = [];
  let gap = 2;
  rows.forEach((n, i) => {
    if (n > 0) {
      if (gap >= 2 || !blocks.length) blocks.push({ from: i, to: i });
      else blocks[blocks.length - 1]!.to = i;
      gap = 0;
    } else gap++;
  });
  if (blocks.length < 2) return undefined;
  const boxOf = (b: { from: number; to: number }): Box => {
    let minX = Infinity, maxX = -Infinity;
    for (let y = box.y + b.from; y <= box.y + b.to; y++) {
      for (let x = box.x; x < box.x + box.w; x++) if (changed[y * width + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
    return { x: minX, y: box.y + b.from, w: maxX - minX + 1, h: b.to - b.from + 1 };
  };
  const boxes = blocks.map(boxOf);
  const isText = (b: Box) => b.h <= 24 && b.w >= b.h * 1.3;
  const control = boxes.reduce((best, b) => (area(b) > area(best) && !isText(b) ? b : best), boxes.find((b) => !isText(b)) ?? boxes[0]!);
  const readout = boxes.filter((b) => b !== control && isText(b)).sort((a, b) => Math.abs(a.y - control.y) - Math.abs(b.y - control.y))[0];
  return readout && !isText(control) ? { control: grow(control, 3), readout: grow(readout, 3) } : undefined;
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
  // Every band control moves the curve, but each turns only its own knob: the display is what several of them
  // change. (With a single band control there is nothing to tell apart – everything it changes counts.)
  const counts = new Uint8Array(width * height);
  for (const { frames } of bands) {
    const own = new Uint8Array(width * height);
    for (const f of frames) {
      const m = diffMask(f, base, 24, noise);
      for (let p = 0; p < m.length; p++) if (m[p]) own[p] = 1;
    }
    for (let p = 0; p < own.length; p++) counts[p] = counts[p]! + own[p]!;
  }
  const changed = new Uint8Array(width * height);
  const needed = bands.length >= 2 ? 2 : 1;
  for (let p = 0; p < counts.length; p++) if (counts[p]! >= needed) changed[p] = 1;
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

/**
 * Discs in the static layout: round areas that stand out from the background (spheres, round displays).
 * The colour profile from the centre to the edge keeps concentric rings and radial gradients.
 */
function findCircles(img: Image, exclude: Uint8Array, background: Rgb): Circle[] {
  const { width, height } = img;
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    if (exclude[p]) continue;
    const i = p * 4;
    const c: Rgb = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    if (colorDistance(c, background) > 25) mask[p] = 1;
  }
  const circles: Circle[] = [];
  for (const comp of components(mask, width, height, 400)) {
    const size = (comp.w + comp.h) / 2;
    if (size < 30 || Math.abs(comp.w - comp.h) > size * 0.08) continue;
    // circle through the edge pixels (robust: knobs or dots on the edge are dropped in a second fit)
    const edge: [number, number][] = [];
    for (let y = comp.y; y < comp.y + comp.h; y++) for (let x = comp.x; x < comp.x + comp.w; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      const open = (q: number, ok: boolean) => ok && !mask[q] && !exclude[q];
      if (open(p - 1, x > 0) || open(p + 1, x < width - 1) || open(p - width, y > 0) || open(p + width, y < height - 1)) edge.push([x, y]);
    }
    // outer edge only (holes inside – grid lines, dark marks – are not the outline): outermost point per angle
    const bx = comp.x + comp.w / 2, by = comp.y + comp.h / 2;
    const outer = new Map<number, [number, number]>();
    for (const pt of edge) {
      const bin = Math.round(((Math.atan2(pt[1] - by, pt[0] - bx) + Math.PI) / TAU) * 180);
      const best = outer.get(bin);
      if (!best || Math.hypot(pt[0] - bx, pt[1] - by) > Math.hypot(best[0] - bx, best[1] - by)) outer.set(bin, pt);
    }
    edge.length = 0;
    edge.push(...outer.values());
    let fit = fitCircle(edge);
    for (let pass = 0; pass < 2 && fit; pass++) {
      const f = fit;
      const near = edge.filter(([x, y]) => Math.abs(Math.hypot(x - f.cx, y - f.cy) - f.r) < 2);
      if (near.length < edge.length * 0.6) { fit = undefined; break; }
      fit = fitCircle(near);
    }
    if (!fit) continue;
    const { cx, cy } = fit;
    // edge pixel centres lie half a pixel inside the edge
    const r = fit.r + 0.5;
    // inside the circle nearly everything belongs to it (or is covered by texts and controls), outside nothing
    let inside = 0, insideHit = 0, outside = 0, outsideHit = 0;
    for (let y = comp.y; y < comp.y + comp.h; y++) for (let x = comp.x; x < comp.x + comp.w; x++) {
      const p = y * width + x;
      const d = Math.hypot(x - cx, y - cy);
      if (d < r - 1.5) { if (!exclude[p]) { inside++; if (mask[p]) insideHit++; } }
      else if (d > r + 1.5 && !exclude[p]) { outside++; if (mask[p]) outsideHit++; }
    }
    if (inside < 300 || insideHit / inside < 0.9 || (outside > 0 && outsideHit / outside > 0.15)) continue;
    // radial profile in half pixels (bilinear): median colour of every ring, stops where the colour changes
    const ringAt = (radius: number): Rgb => {
      const ring: Rgb[] = [];
      const samples = Math.max(16, Math.round(TAU * radius * 1.5));
      for (let k = 0; k < samples; k++) {
        const a = (k / samples) * TAU;
        ring.push(bilinear(img, cx + Math.sin(a) * radius, cy - Math.cos(a) * radius));
      }
      const median = (i: 0 | 1 | 2) => percentile(ring.map((c) => c[i]), 0.5);
      return [median(0), median(1), median(2)];
    };
    const radii: number[] = [];
    for (let k = 0; k <= r + 0.25; k += 0.5) radii.push(k);
    const profile = radii.map(ringAt);
    const stops: Circle["stops"] = [];
    profile.forEach((c, k) => {
      const prev = profile[k - 1], next = profile[k + 1];
      const keep = k === 0 || k === profile.length - 1 || (prev && colorDistance(c, prev) > 3) || (next && colorDistance(c, next) > 3);
      if (keep) stops.push({ at: Math.min(1, radii[k]! / r), color: hex(c) });
    });
    // spokes: straight lines through the centre (cross hairs), darker or lighter than their ring
    const spokes: number[] = [];
    const steps = 360;
    const deviation = new Float64Array(steps);
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * TAU;
      let sum = 0, n = 0;
      for (let k = Math.round(profile.length * 0.25); k < Math.round(profile.length * 0.85); k++) {
        const c = bilinear(img, cx + Math.sin(a) * radii[k]!, cy - Math.cos(a) * radii[k]!);
        sum += luminance(c) - luminance(profile[k]!);
        n++;
      }
      deviation[s] = n ? sum / n : 0;
    }
    let spokeLum = 0;
    for (let s = 0; s < steps; s++) {
      const d = deviation[s]!;
      const isPeak = Math.abs(d) > 6 && Math.abs(d) >= Math.abs(deviation[(s + steps - 1) % steps]!) && Math.abs(d) > Math.abs(deviation[(s + 1) % steps]!);
      if (isPeak) { spokes.push((s / steps) * TAU); spokeLum += d; }
    }
    const spokeColor = (() => {
      if (!spokes.length) return undefined;
      // core of each line: the most extreme pixel across it (the line is ~1 px, sampling blurs it)
      const darker = spokeLum < 0;
      const cores: Rgb[] = [];
      for (const a of spokes) for (let f = 0.3; f <= 0.8; f += 0.05) {
        const x = cx + Math.sin(a) * r * f, y = cy - Math.cos(a) * r * f;
        let best: Rgb | undefined;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const c = pixel(img, Math.round(x) + dx, Math.round(y) + dy);
          if (!best || (darker ? luminance(c) < luminance(best) : luminance(c) > luminance(best))) best = c;
        }
        cores.push(best!);
      }
      const median = (i: 0 | 1 | 2) => percentile(cores.map((c) => c[i]), 0.5);
      return hex([median(0), median(1), median(2)]);
    })();
    circles.push({
      // continuous coordinates: pixel x covers [x, x + 1]
      cx: cx + 0.5, cy: cy + 0.5, r, stops: stops.slice(0, 160),
      ...(spokes.length >= 2 && spokes.length <= 16 && spokeColor ? { spokes: { angles: spokes, color: spokeColor, width: 1 } } : {}),
    });
  }
  return circles.slice(0, 8);
}

/** Text blocks: high local contrast, merged horizontally. */
/** Median colour of the 1-px ring just outside a box (the background around a text). */
function ringColor(img: Image, box: Box): Rgb {
  const ring: Rgb[] = [];
  const x0 = box.x - 2, y0 = box.y - 2, x1 = box.x + box.w + 1, y1 = box.y + box.h + 1;
  const add = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < img.width && y < img.height) ring.push(pixel(img, x, y)); };
  for (let x = x0; x <= x1; x++) { add(x, y0); add(x, y1); }
  for (let y = y0 + 1; y < y1; y++) { add(x0, y); add(x1, y); }
  const median = (i: 0 | 1 | 2) => percentile(ring.map((c) => c[i]), 0.5);
  return ring.length ? [median(0), median(1), median(2)] : [128, 128, 128];
}

function textBlocks(img: Image, exclude: Uint8Array): { box: Box; color: Rgb; background: Rgb; bold: boolean; uppercase: boolean }[] {
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
  // (also where controls lie: a text partly under a control's box keeps its colour – ZamEQ2's scale under the fader)
  const contrastAll = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
      const sum = integral[y1 * (width + 1) + x1]! - integral[y0 * (width + 1) + x1]! - integral[y1 * (width + 1) + x0]! + integral[y0 * (width + 1) + x0]!;
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (Math.abs(lum[y * width + x]! - mean) > 45) {
        contrastAll[y * width + x] = 1;
        if (!exclude[y * width + x]) contrast[y * width + x] = 1;
      }
    }
  }
  // Long straight runs are edges, frames and tracks, not glyph strokes: left in, a bevel under a row of scale
  // numbers joins them into one block whose "ink" is the bevel's colour (ZamEQ2's −12 … +12 read as "12").
  const longRun = Math.max(30, Math.round(Math.min(width, height) * 0.15));
  const straight = new Uint8Array(width * height);
  // a run goes on through pixels of its colour and across short stretches of other ink lying over it (digits
  // standing on a bevel), but not across background – the bottoms of a word's letters are no line
  const scan = (count: number, length: number, at: (i: number, k: number) => number) => {
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < length;) {
        const p0 = at(i, k);
        if (!contrast[p0]) { k++; continue; }
        const colour = pixel(img, p0 % width, Math.floor(p0 / width));
        const members: number[] = [];
        let end = k, over = 0;
        while (end < length) {
          const p = at(i, end);
          if (!contrast[p]) break;
          if (colorDistance(pixel(img, p % width, Math.floor(p / width)), colour) < 40) { members.push(p); over = 0; }
          else if (++over > 10) break;
          end++;
        }
        if (members.length >= longRun) for (const p of members) straight[p] = 1;
        k = Math.max(end, k + 1);
      }
    }
  };
  scan(height, width, (y, x) => y * width + x);
  scan(width, height, (x, y) => y * width + x);
  for (let p = 0; p < contrast.length; p++) if (straight[p]) contrast[p] = 0;
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
      const background = ringColor(img, box);
      const all = maskPoints(contrastAll, width, box).filter(([x, y]) => !straight[y * width + x]);
      const inkPoints = (all.length ? all : points).filter(([x, y]) => colorDistance(pixel(img, x, y), background) > 40);
      return { box, color: dominantAt(img, inkPoints.length ? inkPoints : points), background, bold: points.length / area(box) > 0.3, uppercase };
    });
}

/** a scale value: a plain number, with a sign or unit around it ("-24", "−12 dB", "+6") */
export function scaleNumber(text: string): number | undefined {
  const clean = text.replace(/[−–—]/g, "-").replace(/\s+/g, "").replace(/dB(FS)?$/i, "");
  const m = clean.match(/[+-]?\d{1,3}(?:\.\d+)?/);
  // a little junk around the number (a grid line read as "|", an axis name) is allowed, words are not
  if (!m || clean.length - m[0].length > 2) return undefined;
  return Number(m[0]);
}

/**
 * Straight line through (position, value) of the numbers of one row or column: at least three, in order (the values
 * rise or fall with the position) and fitting within a tenth of their spacing – else they are no scale (value
 * readouts, misreadings). Up to a third of the numbers may be misread ("-48" as "-45", a lost minus).
 */
export function fitAxis<P extends { at: number; value: number }>(points: P[]): { a: number; b: number; inliers: P[] } | undefined {
  const sorted = [...points].sort((x, y) => x.at - y.at);
  const fits = (subset: typeof sorted) => {
    if (subset.length < 3) return undefined;
    const diffs = subset.slice(1).map((p, i) => p.value - subset[i]!.value);
    if (!(diffs.every((d) => d > 0) || diffs.every((d) => d < 0))) return undefined;
    const fit = linearFit(subset.map((p) => [p.at, p.value]));
    if (!fit) return undefined;
    const spacing = Math.min(...diffs.map(Math.abs));
    // a scale goes in even steps: every gap is a whole number of the smallest
    if (diffs.some((d) => Math.abs(Math.abs(d) / spacing - Math.round(Math.abs(d) / spacing)) > 0.05)) return undefined;
    return subset.every((p) => Math.abs(fit.a + fit.b * p.at - p.value) <= spacing * 0.1) ? { ...fit, inliers: subset } : undefined;
  };
  const maxDrop = Math.floor(sorted.length / 3);
  // fewest dropped first
  const search = (from: number, kept: typeof sorted, dropped: number): ReturnType<typeof fits> => {
    if (from === sorted.length) return dropped === target ? fits(kept) : undefined;
    return search(from + 1, [...kept, sorted[from]!], dropped) ?? (dropped < target ? search(from + 1, kept, dropped + 1) : undefined);
  };
  let target = 0;
  for (; target <= maxDrop; target++) {
    const fit = search(0, [], 0);
    if (fit) return fit;
  }
  return undefined;
}

/**
 * The scale of a curve or graph: numbers inside its box (read with tesseract), grouped into rows (x axis) and
 * columns (y axis), and the straight line value = a + b·position of each axis (editor pixels).
 */
async function readScale(img: Image, d: Box): Promise<Display["scale"]> {
  const { width, height } = img;
  const outside = new Uint8Array(width * height).fill(1);
  const box = clampBox(d, img);
  for (let y = box.y; y < box.y + box.h; y++) outside.fill(0, y * width + box.x, y * width + box.x + box.w);
  // grid lines run longer than any stroke of a digit: left out, they no longer join the numbers next to them
  const bg = dominantColor(img, box);
  const ink = (x: number, y: number) => colorDistance(pixel(img, x, y), bg) > 25;
  const LINE = 25;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w;) {
      let end = x;
      while (end < box.x + box.w && ink(end, y)) end++;
      if (end - x >= LINE) outside.fill(1, y * width + x, y * width + end);
      x = end + 1;
    }
  }
  for (let x = box.x; x < box.x + box.w; x++) {
    for (let y = box.y; y < box.y + box.h;) {
      let end = y;
      while (end < box.y + box.h && ink(x, end)) end++;
      if (end - y >= LINE) for (let k = y; k < end; k++) outside[k * width + x] = 1;
      y = end + 1;
    }
  }
  const blocks = textBlocks(img, outside).filter((b) => b.box.h <= 20 && b.box.w <= 60);
  if (blocks.length < 3) return undefined;
  // read without the grid lines: they are painted over in the background colour
  const clean: Image = { width, height, data: img.data.slice() };
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    if (outside[y * width + x]) clean.data.set([bg[0], bg[1], bg[2], 255], (y * width + x) * 4);
  }
  const reads = await recognizeBlocks(clean, blocks.map((b) => ({ box: clampBox(grow(b.box, 1), img), color: b.color, background: b.background })));
  const numbers = blocks.flatMap((b, i) => {
    const r = reads[i];
    const value = r && r.confidence >= 70 ? scaleNumber(r.text) : undefined;
    const at = r?.box ?? b.box;
    return value === undefined ? [] : [{ text: String(value), value, x: at.x, y: at.y, w: at.w, h: at.h, color: b.color }];
  });
  if (numbers.length < 3) return undefined;
  // rows: numbers whose centres lie on one line; the largest group with a fitting line is the axis
  const group = (key: (n: (typeof numbers)[number]) => number) => {
    const groups: (typeof numbers)[] = [];
    for (const n of [...numbers].sort((a, b) => key(a) - key(b))) {
      const g = groups.find((g) => Math.abs(key(g[0]!) - key(n)) <= 3);
      if (g) g.push(n);
      else groups.push([n]);
    }
    return groups.sort((a, b) => b.length - a.length);
  };
  const axisOf = (groups: (typeof numbers)[], at: (n: (typeof numbers)[number]) => number) => {
    for (const g of groups) {
      const fit = fitAxis(g.map((n) => ({ at: at(n), value: n.value, n })));
      if (fit) return { fit: { a: fit.a, b: fit.b }, labels: fit.inliers.map((p) => p.n) };
    }
    return undefined;
  };
  const xAxis = axisOf(group((n) => n.y + n.h / 2), (n) => n.x + n.w / 2);
  // a column of right-aligned numbers lines up at their right edge
  const yAxis = axisOf([...group((n) => n.x + n.w), ...group((n) => n.x + n.w / 2)], (n) => n.y + n.h / 2);
  if (!xAxis && !yAxis) return undefined;
  const labels = [...new Set([...(xAxis?.labels ?? []), ...(yAxis?.labels ?? [])])];
  return {
    labels: labels.map((n) => ({ text: n.text, x: n.x, y: n.y, w: n.w, h: n.h, color: hex(n.color) })),
    ...(xAxis ? { x: xAxis.fit } : {}),
    ...(yAxis ? { y: yAxis.fit } : {}),
  };
}

/**
 * Font size (px) for a text whose ink is `inkHeight` px tall: capitals/digits reach ~0.72 of the font size,
 * lower case without ascenders ~0.53, descenders add ~0.22.
 */
export function fontSize(text: string, inkHeight: number): number {
  const tall = /[A-Z0-9bdfhklt|ÄÖÜß%/()]/.test(text);
  const descender = /[gjpqy,;]/.test(text);
  const fraction = (tall ? 0.72 : 0.53) + (descender ? 0.22 : 0);
  return Math.max(7, Math.round(inkHeight / fraction));
}

// ---- main ---------------------------------------------------------------------------------------

/** Principal axis of a point set: centroid and unit direction. */
function principalAxis(points: [number, number][]): { cx: number; cy: number; dx: number; dy: number; elongation: number } {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p[0], 0) / n, cy = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of points) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const l1 = (sxx + syy) / 2 + Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
  const l2 = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
  return { cx, cy, dx: Math.cos(angle), dy: Math.sin(angle), elongation: Math.sqrt(l1 / Math.max(l2, 1e-9)) };
}

/**
 * Gain reduction needle from editor shots with audio of rising levels: the pixels that leave in every shot are
 * the needle at rest, the pixels that appear are the deflected needle. Lines through all positions meet at the
 * pivot; the angles are calibrated with the gain reduction the compressor model predicts for each level.
 */
async function analyzeMeter(probe: GuiProbe, series: MeterShot[], noise: Uint8Array, reduction: (levelDb: number) => number): Promise<Display | undefined> {
  const { width, height } = probe;
  if (series.length < 3) return undefined;
  // only the levels at which the needle has left its rest (below the threshold it does not move)
  const moved = series.slice(1).filter((m) => countMask(diffMask(m.image, series[0]!.image, 40, noise)) >= 20);
  if (moved.length < 2) return undefined;
  series = [series[0]!, ...moved];
  const shots = series.map((m) => m.image);
  const rest = shots[0]!;
  const changes = shots.slice(1).map((s) => diffMask(s, rest, 40, noise));
  const restMask = new Uint8Array(width * height);
  for (let p = 0; p < restMask.length; p++) restMask[p] = changes.every((c) => c[p]) ? 1 : 0;
  const all = (m: Uint8Array) => maskPoints(m, width, { x: 0, y: 0, w: width, h: height });

  const positions: { levelDb: number; points: [number, number][] }[] = [{ levelDb: series[0]!.levelDb, points: all(restMask) }];
  changes.forEach((c, k) => {
    const m = new Uint8Array(c.length);
    for (let p = 0; p < m.length; p++) m[p] = c[p] && !restMask[p] ? 1 : 0;
    positions.push({ levelDb: series[k + 1]!.levelDb, points: all(m) });
  });
  const lines = positions.filter((p) => p.points.length >= 20).map((p) => ({ ...p, axis: principalAxis(p.points) })).filter((p) => p.axis.elongation > 4);
  if (lines.length < 2) return undefined;

  // pivot: least-squares intersection of the needle lines
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const { axis } of lines) {
    const m11 = 1 - axis.dx * axis.dx, m12 = -axis.dx * axis.dy, m22 = 1 - axis.dy * axis.dy;
    a11 += m11; a12 += m12; a22 += m22;
    b1 += m11 * axis.cx + m12 * axis.cy;
    b2 += m12 * axis.cx + m22 * axis.cy;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-6) return undefined;
  const pivotX = (a22 * b1 - a12 * b2) / det, pivotY = (a11 * b2 - a12 * b1) / det;
  if (pivotX < -width || pivotX > 2 * width || pivotY < -height || pivotY > 2 * height) return undefined;

  const angles = lines.map((l) => ({ levelDb: l.levelDb, angle: angleOf(l.axis.cx - pivotX, l.axis.cy - pivotY), points: l.points }));
  // a needle turns: parallel strokes (rows of LEDs lighting up) meet nowhere near and barely change their angle
  if (Math.max(...angles.map((a) => a.angle)) - Math.min(...angles.map((a) => a.angle)) < 0.15) return undefined;
  const distances = angles.flatMap((a) => a.points.map((p) => Math.hypot(p[0] - pivotX, p[1] - pivotY)));
  const length = percentile(distances, 0.97);
  const inner = percentile(distances, 0.03);
  const deflected = angles[angles.length - 1]!;
  const widthPx = Math.max(1, Math.min(6, deflected.points.length / Math.max(1, length - inner)));

  // calibration: angle = angleZero + radiansPerDb · reduction
  const points = angles.map((a) => [reduction(a.levelDb), a.angle] as [number, number]);
  const fit = linearFit(points);
  if (!fit || Math.abs(fit.b) < 1e-4) return undefined;

  const box = clampBox(grow(union(angles.map((a) => {
    const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
  })), 4), probe);
  // a needle sweeps part of an instrument: changes all over the editor are several meters and graphs, not one needle
  if (area(box) > width * height * 0.25) return undefined;
  const color = hex(dominantAt(shots[shots.length - 1]!, deflected.points));
  const background = ringMedian(rest, pivotX, pivotY, length * 0.6);

  // hub: the colour at the pivot (needle removed: shot with the needle elsewhere) up to where it ends
  let cap: Needle["cap"];
  const hubShot = shots[shots.length - 1]!;
  const hub = pixel(hubShot, Math.round(pivotX), Math.round(pivotY));
  if (colorDistance(hub, background) > 60) {
    let r = 1;
    const closerToHub = (c: Rgb) => colorDistance(c, hub) < colorDistance(c, background);
    while (r < length * 0.3 && closerToHub(ringMedian(hubShot, pivotX, pivotY, r))) r += 0.5;
    if (r > 2) cap = { radius: r, color: hex(hub) };
  }

  // scale marks: short strokes on a circle around the pivot, in the swept range (+ margin)
  const a0 = fit.a, a1 = fit.a + fit.b * 30;
  const lo = Math.min(a0, a1) - 0.15, hi = Math.max(a0, a1) + 0.15;
  let ticks: Needle["ticks"];
  let bestCount = 0;
  for (let r = length * 0.9; r < length * 1.2; r += 1) {
    const samples = Math.round((hi - lo) * r);
    const hits: number[] = [];
    for (let k = 0; k <= samples; k++) {
      const a = lo + (k / samples) * (hi - lo);
      const x = Math.round(pivotX + Math.sin(a) * r), y = Math.round(pivotY - Math.cos(a) * r);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (colorDistance(pixel(rest, x, y), background) > 80 && !restMask[y * width + x]) hits.push(k);
    }
    const runs: number[][] = [];
    for (const k of hits) {
      const run = runs[runs.length - 1];
      if (run && k - run[run.length - 1]! <= 1) run.push(k);
      else runs.push([k]);
    }
    const strokes = runs.filter((run) => run.length <= 8);
    // scale marks are evenly spaced (letters are not)
    const centres = strokes.map((run) => (run[0]! + run[run.length - 1]!) / 2);
    const gaps = centres.slice(1).map((c, i) => c - centres[i]!);
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const even = gaps.length >= 3 && gaps.every((g) => Math.abs(g - meanGap) < meanGap * 0.3);
    if (even && strokes.length >= 5 && strokes.length > bestCount && strokes.length >= runs.length * 0.8) {
      bestCount = strokes.length;
      const angles = strokes.map((run) => lo + (((run[0]! + run[run.length - 1]!) / 2) / samples) * (hi - lo));
      const extent = (a: number, dir: 1 | -1) => {
        let rr = r;
        while (Math.abs(rr - r) < length * 0.3 && colorDistance(pixel(rest, Math.round(pivotX + Math.sin(a) * rr), Math.round(pivotY - Math.cos(a) * rr)), background) > 80) rr += dir;
        return rr;
      };
      const inner = percentile(angles.map((a) => extent(a, -1)), 0.5), outer = percentile(angles.map((a) => extent(a, 1)), 0.5);
      const points = angles.map((a) => [Math.round(pivotX + Math.sin(a) * r), Math.round(pivotY - Math.cos(a) * r)] as [number, number]);
      ticks = {
        angles, inner, outer,
        width: Math.max(1, strokes.reduce((s, run) => s + run.length, 0) / strokes.length),
        color: hex(dominantAt(rest, points)),
      };
    }
  }

  return {
    kind: "meter", ...box,
    background: hex(dominantColor(rest, box)), grid: color, curve: color, text: color,
    needle: { pivotX, pivotY, length, width: widthPx, color, angleZero: fit.a, radiansPerDb: fit.b, ...(cap ? { cap } : {}), ...(ticks ? { ticks } : {}) },
  };
}

/**
 * Level meters from editor shots with audio of rising levels (first shot: silence): areas that light up, go dark
 * or move with the level and are long and narrow are meters – bars or LED chains, vertical or horizontal, growing
 * from the end that stays put. One that is lit already at the quietest level shows the input; one that only
 * moves once the compressor works (or goes dark as a gate opens) shows gain reduction. Large areas that move with
 * the signal without that shape are analyzers or time graphs.
 */
async function analyzeLevelMeters(probe: GuiProbe, all: MeterSeries[], noise: Uint8Array, exclude: Box[], reduction?: (levelDb: number) => number): Promise<Display[]> {
  const found: Display[] = [];
  // the plain series first; the one with the threshold turned down adds gain reduction meters that stayed dark
  for (const { shots: series, turned, moving, film } of [...all].sort((a, b) => Number(a.turned) - Number(b.turned))) {
    const calibrated = !turned;
    if (series.length < 3) continue;
    const shared = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    for (const d of await levelMetersOf(probe, series, turned, moving, film, noise, [...exclude, ...found], calibrated ? reduction : undefined)) {
      if (!found.some((f) => shared(f, d) > Math.min(area(f), area(d)) * 0.3)) found.push(d);
    }
  }
  const displays = found;
  // a bar that changes colour along its length (green, yellow, red) may fall into pieces: pieces in line join up
  for (let i = 0; i < displays.length; i++) {
    for (let j = displays.length - 1; j > i; j--) {
      const a = displays[i]!, b = displays[j]!;
      if (!a.bar || !b.bar || a.bar.source !== b.bar.source) continue;
      const horizontal = a.w > a.h && b.w > b.h, vertical = a.h > a.w && b.h > b.w;
      const inRow = horizontal && Math.abs(a.y - b.y) <= 3 && Math.abs(a.h - b.h) <= 4 && (b.x <= a.x + a.w + 6 && a.x <= b.x + b.w + 6);
      const inColumn = vertical && Math.abs(a.x - b.x) <= 3 && Math.abs(a.w - b.w) <= 4 && (b.y <= a.y + a.h + 6 && a.y <= b.y + b.h + 6);
      if (!inRow && !inColumn) continue;
      Object.assign(a, union([a, b]));
      displays.splice(j, 1);
    }
  }
  // flat pieces of a graph's curves along its time axis are no meters
  const graphs = displays.filter((d) => d.role === "analyzer");
  return displays.filter((d) => !(d.bar && d.w > d.h && graphs.some((g) => overlaps(g, d, 8))));
}

/** analyzeLevelMeters for one series of shots (first: silence). */
async function levelMetersOf(probe: GuiProbe, series: MeterShot[], turned: boolean, moving: Uint8Array | undefined, film: FilmFrame[] | undefined, noise: Uint8Array, exclude: Box[], reduction?: (levelDb: number) => number): Promise<Display[]> {
  const { width, height } = probe;
  const shots = series.map((m) => m.image);
  const rest = shots[0]!;
  const levels = series.slice(1).map((m) => m.levelDb);
  const changes = shots.slice(1).map((s) => diffMask(s, rest, 30, noise));
  const any = new Uint8Array(width * height);
  for (const c of changes) for (let p = 0; p < any.length; p++) if (c[p]) any[p] = 1;
  for (const b of exclude) {
    const c = clampBox(grow(b, 2), rest);
    for (let y = c.y; y < c.y + c.h; y++) any.fill(0, y * width + c.x, y * width + c.x + c.w);
  }
  const displays: Display[] = [];
  /** thin, sparse changes (curves of a time graph or analyzer): gathered into zones afterwards */
  const sparse: Box[] = [];
  // LED segments and the two channels of a stereo meter close up; separate meters stay apart
  for (const comp of components(dilate(any, width, height, 3, 3), width, height, 20)) {
    const box = { x: comp.x, y: comp.y, w: comp.w, h: comp.h };
    let lit = 0;
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) lit += any[y * width + x]!;
    if (lit < 30) continue;
    if (process.env.VCH_GUI_DEBUG) console.error(`level component ${box.x},${box.y} ${box.w}x${box.h} lit ${lit}`);
    const vertical = box.h >= box.w;
    const long = Math.max(box.w, box.h), short = Math.min(box.w, box.h);
    // extent of the changed pixels along the component, per level
    const extents = changes.map((c) => {
      let lo = Infinity, hi = -Infinity, count = 0;
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
        if (!c[y * width + x]) continue;
        const t = vertical ? y : x;
        lo = Math.min(lo, t); hi = Math.max(hi, t); count++;
      }
      return count >= short ? { lo, hi, length: hi - lo + 1, count } : undefined;
    });
    const seen = extents.map((e, k) => ({ e, k })).filter((x): x is { e: NonNullable<typeof x.e>; k: number } => x.e !== undefined);
    // a bar or LED chain fills its lit stretch; the lines of a graph do not
    const densest = Math.max(0, ...seen.map((s) => s.e.count / (s.e.length * short)));
    // a meter stands still while the input does; a time graph or analyzer keeps moving
    let keepsMoving = 0;
    if (moving) for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (any[y * width + x] && moving[y * width + x]) keepsMoving++;
    // (a pronounced bar may flicker with its peak display: that is no graph)
    if (long < short * 2.5 || densest < 0.25 || seen.length === 0 || (keepsMoving > lit * 0.3 && long < short * 4)) {
      sparse.push(box);
      continue;
    }
    const lengths = seen.map((s) => s.e.length);
    const slack = Math.max(2, long * 0.06);
    const rising = lengths.every((l, i) => i === 0 || l >= lengths[i - 1]! - slack) && lengths[lengths.length - 1]! >= lengths[0]!;
    const falling = lengths.every((l, i) => i === 0 || l <= lengths[i - 1]! + slack) && lengths[lengths.length - 1]! <= lengths[0]!;
    if (!rising && !falling) {
      sparse.push(box);
      continue;
    }
    // the end that stays put is where the bar starts
    const first = seen[0]!.e, last = seen[seen.length - 1]!.e;
    const anchoredLow = Math.abs(first.lo - last.lo) <= Math.abs(first.hi - last.hi);
    const origin: NonNullable<LevelBar["origin"]> = vertical ? (anchoredLow ? "top" : "bottom") : (anchoredLow ? "left" : "right");
    // lit at the quietest level: it follows the input; otherwise it shows what the compressor or gate does
    // (an input meter lights up at quiet levels and grows with the input; gain reduction starts at the threshold)
    const source: LevelBar["source"] = levels[seen[0]!.k]! <= -30 && rising && !turned ? "input" : "reduction";
    // LED chain: the lit stretch falls into evenly spaced runs
    const runs: number[] = [];
    {
      const c = changes[seen[seen.length - 1]!.k]!;
      let open = false;
      for (let t = vertical ? box.y : box.x; t < (vertical ? box.y + box.h : box.x + box.w); t++) {
        let on = false;
        for (let u = vertical ? box.x : box.y; u < (vertical ? box.x + box.w : box.y + box.h) && !on; u++) on = c[(vertical ? t * width + u : u * width + t)]! === 1;
        if (on && !open) runs.push(t);
        open = on;
      }
    }
    const pitches = runs.slice(1).map((r, i) => r - runs[i]!);
    const pitch = pitches.length >= 3 ? percentile(pitches, 0.5) : 0;
    let segments = pitch >= 4 && pitches.every((p) => Math.abs(p - pitch) <= Math.max(2, pitch * 0.25)) ? Math.round(long / pitch) : undefined;
    // An LED chain is longer than the part that lit up: unlit LEDs repeat at the same pitch in the silent picture.
    let round: boolean | undefined;
    if (segments && runs.length >= 2) {
      const across = vertical ? box.x + box.w / 2 : box.y + box.h / 2;
      const r = Math.max(1, Math.floor(Math.min(short, pitch) / 4));
      const patch = (t: number): Rgb | undefined => {
        const cx = Math.round(vertical ? across : t), cy = Math.round(vertical ? t : across);
        if (cx - r < 0 || cy - r < 0 || cx + r >= width || cy + r >= height) return undefined;
        return medianColor(rest, { x: cx - r, y: cy - r, w: 2 * r + 1, h: 2 * r + 1 });
      };
      const lastLit = changes[seen[seen.length - 1]!.k]!;
      const runWidth = (start: number) => {
        let t = start;
        while (t < start + pitch) {
          let on = false;
          for (let u = vertical ? box.x : box.y; u < (vertical ? box.x + box.w : box.y + box.h) && !on; u++) on = lastLit[(vertical ? t * width + u : u * width + t)]! === 1;
          if (!on) break;
          t++;
        }
        return Math.max(1, t - start);
      };
      const centres = runs.map((start) => start + runWidth(start) / 2);
      const step = (centres[centres.length - 1]! - centres[0]!) / (centres.length - 1);
      const unlit = patch(centres[0]!);
      if (unlit) {
        // the same unlit LED, with the background beside it across the chain (not just a large area of that colour)
        const side = (t: number, offset: number): Rgb | undefined => {
          const cx = Math.round(vertical ? across + offset : t), cy = Math.round(vertical ? t : across + offset);
          return cx >= 0 && cy >= 0 && cx < width && cy < height ? pixel(rest, cx, cy) : undefined;
        };
        const reach = short / 2 + 3;
        const sameLed = (t: number) => {
          const at = patch(t), a = side(t, -reach), b = side(t, reach);
          return at !== undefined && colorDistance(at, unlit) < 30 && [a, b].some((c) => c === undefined || colorDistance(c, unlit) > 30);
        };
        let lo = centres[0]!, hi = centres[centres.length - 1]!;
        while (sameLed(lo - step)) lo -= step;
        while (sameLed(hi + step)) hi += step;
        const half = runWidth(runs[0]!) / 2;
        const from = Math.floor(lo - half), to = Math.ceil(hi + half);
        if (vertical) { box.y = from; box.h = to - from; } else { box.x = from; box.w = to - from; }
        segments = Math.round((hi - lo) / step) + 1;
        // round LEDs fill less of their square than rectangles do
        const size = Math.min(runWidth(runs[0]!), short);
        let filled = 0;
        const c0 = Math.round(centres[0]!), a0 = Math.round(across - size / 2);
        for (let a = 0; a < size; a++) for (let b = 0; b < size; b++) {
          const x = vertical ? a0 + a : Math.round(c0 - size / 2) + b, y = vertical ? Math.round(c0 - size / 2) + b : a0 + a;
          if (x >= 0 && y >= 0 && x < width && y < height && lastLit[y * width + x]) filled++;
        }
        round = filled < size * size * 0.85;
      }
    }
    // calibration: where the lit stretch ends against the level (input) or the expected gain reduction
    const ends = seen.map((s) => {
      const end = origin === "bottom" || origin === "right" ? s.e.lo : s.e.hi;
      const x = source === "input" ? levels[s.k]! : reduction ? reduction(levels[s.k]!) : NaN;
      return [x, end] as [number, number];
    }).filter(([x]) => Number.isFinite(x));
    const fit = ends.length >= 2 ? linearFit(ends) : undefined;
    const startPos = origin === "bottom" ? box.y + box.h : origin === "top" ? box.y : origin === "left" ? box.x : box.x + box.w;
    const endPos = origin === "bottom" ? box.y : origin === "top" ? box.y + box.h : origin === "left" ? box.x + box.w : box.x;
    const valueAt = (pos: number) => (fit && Math.abs(fit.b) > 1e-6 ? (pos - fit.a) / fit.b : NaN);
    const fromDb = valueAt(startPos), toDb = valueAt(endPos);
    const plausible = Number.isFinite(fromDb) && Number.isFinite(toDb) && Math.abs(toDb - fromDb) >= 6 && Math.abs(toDb - fromDb) <= 200;
    // From the film: the input level at which each LED first lights up, and how fast the meter falls once the
    // signal stops. (Input meters on the plain film; their scales are often not linear – 40, 30, 20, 15, 10 …)
    let ledDb: number[] | undefined, fallDbPerSecond: number | undefined;
    if (film && source === "input" && segments && segments >= 3) {
      const n = segments, along = vertical ? box.h : box.w;
      const centreOf = (k: number) => {
        const t = (k + 0.5) * (along / n);
        const pos = origin === "bottom" ? box.y + box.h - t : origin === "top" ? box.y + t : origin === "left" ? box.x + t : box.x + box.w - t;
        return vertical ? { x: Math.round(box.x + box.w / 2), y: Math.round(pos) } : { x: Math.round(pos), y: Math.round(box.y + box.h / 2) };
      };
      const litAt = (frame: FilmFrame, k: number) => {
        const c = centreOf(k);
        return c.x >= 0 && c.y >= 0 && c.x < width && c.y < height && colorDistance(pixel(frame.image, c.x, c.y), pixel(rest, c.x, c.y)) > 40;
      };
      const times = segmentTimes(METER_FILM);
      const rampFrames = film.filter((f) => f.t >= times[1]!.from && f.t <= times[2]!.to);
      const first = Array.from({ length: n }, (_, k) => rampFrames.find((f) => litAt(f, k))?.levelDb);
      const known = first.map((db, k) => ({ db, k })).filter((x): x is { db: number; k: number } => x.db !== undefined && x.db > -150);
      if (known.length >= 2 && known.every((x, i) => i === 0 || x.db >= known[i - 1]!.db - 0.5)) {
        // LEDs that never lit (above the loudest level) continue at the spacing of the last two
        const lastTwo = known.slice(-2);
        const spacing = Math.max(0.5, (lastTwo[1]!.db - lastTwo[0]!.db) / Math.max(1, lastTwo[1]!.k - lastTwo[0]!.k));
        const firstTwo = known.slice(0, 2);
        const below = Math.max(0.5, (firstTwo[1]!.db - firstTwo[0]!.db) / Math.max(1, firstTwo[1]!.k - firstTwo[0]!.k));
        ledDb = first.map((db, k) => (db !== undefined && db > -150 ? db : k < known[0]!.k ? known[0]!.db - (known[0]!.k - k) * below : lastTwo[1]!.db + (k - lastTwo[1]!.k) * spacing));
        // fall: lit LEDs at the end of the held level, then the time until they are dark
        const held = [...film].reverse().find((f) => f.t <= times[2]!.to);
        const litCount = (f: FilmFrame) => Array.from({ length: n }, (_, k) => litAt(f, k)).filter(Boolean).length;
        const top = held ? litCount(held) : 0;
        const dark = film.find((f) => f.t > times[2]!.to && litCount(f) === 0);
        if (held && top > 0 && dark) fallDbPerSecond = Math.max(5, (ledDb[top - 1]! - ledDb[0]! + 1) / Math.max(0.03, (dark.t - times[2]!.to) / 1000));
      }
    }
    const litPoints = maskPoints(changes[seen[seen.length - 1]!.k]!, width, box);
    const color = hex(dominantAt(shots[seen[seen.length - 1]!.k + 1]!, litPoints));
    // what the lit pixels look like when the meter is off
    const offColor = hex(dominantAt(rest, litPoints));
    displays.push({
      kind: "bar", ...box,
      background: hex(dominantColor(rest, box)), grid: color, curve: color, text: color,
      bar: {
        source,
        fromDb: plausible ? fromDb : source === "input" ? -60 : 0,
        toDb: plausible ? toDb : source === "input" ? 0 : 20,
        color, origin, offColor, ...(segments ? { segments } : {}), ...(round !== undefined ? { round } : {}),
        ...(ledDb ? { ledDb } : {}), ...(fallDbPerSecond ? { fallDbPerSecond } : {}),
      },
    });
  }
  // analyzer and time graph zones: sparse changes that lie close together and cover a large area
  const zones: Box[] = [];
  for (const b of sparse) {
    const near = zones.find((z) => overlaps(z, b, 6));
    if (near) Object.assign(near, union([near, b]));
    else zones.push({ ...b });
  }
  for (const zone of zones) {
    if (process.env.VCH_GUI_DEBUG) console.error(`analyzer zone? ${zone.x},${zone.y} ${zone.w}x${zone.h}`);
    if (area(zone) < width * height * 0.02 || Math.min(zone.w, zone.h) < 40 || displays.some((d) => overlaps(d, zone) && area(d) > area(zone) * 0.5)) continue;
    const bg = dominantColor(rest, zone);
    const moving = maskPoints(changes[changes.length - 1]!, width, zone);
    const curve = hex(moving.length ? dominantAt(shots[shots.length - 1]!, moving) : bg);
    displays.push({ kind: "generic", role: "analyzer", ...zone, background: hex(bg), grid: hex(bg), curve, text: curve });
  }
  return displays;
}

/**
 * An LED chain in changed pixels: at least five blobs of about the same size in one row or column at an even
 * pitch. Returns their extent and number.
 */
function ledChain(masks: Uint8Array[], width: number, box: Box): { box: Box; count: number; vertical: boolean } | undefined {
  const all = new Uint8Array(masks[0]?.length ?? 0);
  for (const m of masks) for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (m[y * width + x]) all[y * width + x] = 1;
  const blobs = components(all, width, all.length / width, 6).filter((b) => b.w >= 3 && b.h >= 3 && b.w <= 40 && b.h <= 40);
  if (blobs.length < 5) return undefined;
  const size = percentile(blobs.map((b) => b.w * b.h), 0.5);
  const alike = blobs.filter((b) => b.w * b.h > size * 0.5 && b.w * b.h < size * 2);
  for (const vertical of [false, true]) {
    const lines = new Map<number, typeof alike>();
    for (const b of alike) {
      const key = Math.round((vertical ? b.cx : b.cy) / 4);
      lines.set(key, [...(lines.get(key) ?? []), b]);
    }
    for (const row of lines.values()) {
      if (row.length < 5) continue;
      const along = row.map((b) => (vertical ? b.cy : b.cx)).sort((a, b) => a - b);
      const pitches = along.slice(1).map((v, i) => v - along[i]!);
      const pitch = percentile(pitches, 0.5);
      if (pitch < 4 || !pitches.every((p) => Math.abs(p - pitch) <= Math.max(2, pitch * 0.2))) continue;
      return { box: union(row), count: row.length, vertical };
    }
  }
  return undefined;
}

/** most frequent colour of a list (coarsely binned), averaged within its bin */
function dominantColorOf(colors: Rgb[]): Rgb {
  const bins = new Map<number, { n: number; sum: [number, number, number] }>();
  for (const c of colors) {
    const key = (c[0] >> 4) << 8 | (c[1] >> 4) << 4 | (c[2] >> 4);
    const bin = bins.get(key) ?? { n: 0, sum: [0, 0, 0] };
    bin.n++; bin.sum[0] += c[0]; bin.sum[1] += c[1]; bin.sum[2] += c[2];
    bins.set(key, bin);
  }
  const best = [...bins.values()].sort((a, b) => b.n - a.n)[0]!;
  return [Math.round(best.sum[0] / best.n), Math.round(best.sum[1] / best.n), Math.round(best.sum[2] / best.n)];
}

interface MeterShot {
  levelDb: number;
  image: Image;
}

interface MeterSeries {
  /** taken with the thresholds turned down */
  turned: boolean;
  /** silence first, then rising levels */
  shots: MeterShot[];
  /** pixels that keep changing while the input level is held (graphs scroll, meters stand) – films only */
  moving?: Uint8Array;
  /** all frames of the film, for timing (when each LED lights up, how fast meters fall) */
  film?: FilmFrame[];
}

/** levels picked from the rising sine of a meter film (dBFS) */
const FILM_LEVELS = [-48, -40, -32, -26, -20, -14, -9, -5, -3];

/** The audio-driven series of a probe: from its films (newer probes) or its still shots. */
async function meterSeries(probe: GuiProbe): Promise<MeterSeries[]> {
  const { width, height } = probe;
  if (probe.films?.length) {
    const times = segmentTimes(METER_FILM);
    const ramp = times[1]!, hold = times[2]!;
    return Promise.all(probe.films.map(async (film) => {
      const frames = await readFilm(film.file, width, height);
      // rest: the last frame of the first silence; levels: the frames nearest to FILM_LEVELS on the ramp
      const rest = [...frames].reverse().find((f) => f.t < times[0]!.to - 10) ?? frames[0]!;
      const onRamp = frames.filter((f) => f.t >= ramp.from && f.t <= hold.to);
      const shots = FILM_LEVELS.flatMap((level) => {
        const best = onRamp.reduce<FilmFrame | undefined>((a, f) => (!a || Math.abs(f.levelDb - level) < Math.abs(a.levelDb - level) ? f : a), undefined);
        return best && Math.abs(best.levelDb - level) < 2 ? [{ levelDb: level, image: best.image }] : [];
      });
      const held = frames.filter((f) => f.t > hold.from + 150 && f.t <= hold.to);
      const moving = new Uint8Array(width * height);
      for (let i = 1; i < held.length; i++) {
        const m = diffMask(held[i]!.image, held[i - 1]!.image, 30);
        for (let p = 0; p < m.length; p++) if (m[p]) moving[p] = 1;
      }
      return { turned: Boolean(film.params), shots: [{ levelDb: -200, image: rest.image }, ...shots], moving, film: frames };
    }));
  }
  if (!probe.meter) return [];
  const load = (list: NonNullable<GuiProbe["meter"]>) => Promise.all(list.map(async (m) => ({ levelDb: m.levelDb, image: await loadRaw(m.file, width, height) })));
  return [
    { turned: false, shots: await load(probe.meter.filter((m) => !m.params)) },
    { turned: true, shots: await load(probe.meter.filter((m) => m.params)) },
  ];
}

export interface AnalyzeOptions {
  /** gain reduction (dB) the clone will show for a sine of this peak level – calibrates meters */
  meterReduction?: (levelDb: number) => number;
}

export async function analyzeGui(probe: GuiProbe, parameters: Parameter[], pluginName: string, options: AnalyzeOptions = {}): Promise<GuiModel> {
  const { width, height } = probe;
  const base = await loadRaw(probe.base, width, height);
  const base2 = await loadRaw(probe.base2, width, height);
  const noise = dilate(diffMask(base, base2), width, height, 2);
  // (meters are found against the animation alone: pixels many controls change may be meters that react to them)
  const animation = noise.slice();

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
  const pending: { param: ProbedParameter; frames: Image[]; parts: ReturnType<typeof components>; changed: Uint8Array }[] = [];
  const hiddenSwitches: number[] = [];
  /** pixels each parameter changes, with its frames (texts hidden by moving parts are read there) */
  const changeSets: { changed: Uint8Array; frames: Image[] }[] = [];
  const contains = (outer: Box, inner: Box) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  // EQ: the controls of one band were recorded with the other bands turned (so that the curve shows) – against
  // that picture ("bandbase") the curve is the display, and what is left of each change is its knob
  const bandParams = probe.visible.filter((p) => p.bandRole);
  for (const param of bandParams) bandFootprints.push({ param, frames: await Promise.all(param.frames.map((f) => loadRaw(f.file, width, height))) });
  // The recorded "bandbase" may show a knob before it was redrawn (ZamEQ2: the band's frequency knob), and then
  // every frame differs from it there. With several band controls the median of all their frames is that picture:
  // each knob stands still in the frames of the others.
  const bandReference = bandFootprints.length >= 2
    ? medianImage(bandFootprints.flatMap((b) => b.frames), { x: 0, y: 0, w: width, h: height })
    : bandParams[0]?.reference ? await loadRaw(bandParams[0].reference, width, height) : base;
  const eqDisplay = bandFootprints.length ? analyzeEqDisplay(bandReference, bandFootprints, parameters, noise) : undefined;
  const bandIgnore = noise.slice();
  if (eqDisplay) {
    const d = clampBox(grow({ x: eqDisplay.x, y: eqDisplay.y, w: eqDisplay.w, h: eqDisplay.h }, 2), base);
    for (let y = d.y; y < d.y + d.h; y++) for (let x = d.x; x < d.x + d.w; x++) bandIgnore[y * width + x] = 1;
  }

  for (const param of probe.visible) {
    const band = bandFootprints.find((b) => b.param === param);
    const frames = band?.frames ?? await Promise.all(param.frames.map((f) => loadRaw(f.file, width, height)));
    const reference = band ? bandReference : base;
    const changed = new Uint8Array(width * height);
    for (const f of frames) {
      const m = diffMask(f, reference, 24, band ? bandIgnore : noise);
      for (let p = 0; p < m.length; p++) if (m[p]) changed[p] = 1;
    }
    changeSets.push({ changed, frames });
    const allParts = components(dilate(changed, width, height, 4), width, height, 10);
    if (!allParts.length) continue;
    const changedPixels = changed.reduce((n, v) => n + v, 0);

    // A parameter may change a display (curve, meter) and its own control at the same time:
    // large parts belong to the display, compact parts outside of it to the control.
    const large = allParts.filter((p) => area(p) > width * height * 0.08);
    const displayBox = large.length ? union(large) : undefined;
    // (a switch outside an EQ shows or hides something rather than drawing a display)
    if (!band && displayBox && changedPixels > width * height * 0.01 && (!param.discrete || eqParams.has(param.index))) {
      // one control may move two displays (a gate's curve and its threshold line in a time graph): each on its own
      for (const part of large) {
        // displays a few pixels apart (a graph, a meter, a curve side by side) only merge at the coarse dilation
        const inside = new Uint8Array(width * height);
        for (let y = part.y; y < part.y + part.h; y++) for (let x = part.x; x < part.x + part.w; x++) inside[y * width + x] = changed[y * width + x]!;
        const pieces = components(dilate(inside, width, height, 1), width, height, 10).filter((q) => area(q) > width * height * 0.02);
        for (const piece of pieces.length > 1 ? pieces : [part]) {
          displayRegions.push({ box: { x: piece.x, y: piece.y, w: piece.w, h: piece.h }, eq: eqParams.has(param.index), params: [param], frames });
          if (process.env.VCH_GUI_DEBUG) console.error(`display region of ${param.name}: ${piece.x},${piece.y} ${piece.w}x${piece.h} (${pieces.length} pieces)`);
        }
      }
    }
    const rest = allParts.filter((p) => !large.includes(p) && !(displayBox && contains(displayBox, p)));
    // Parts that look like a display are not the control while others are left: a tall and wide area (a curve
    // below the size of a "large" part), a wide band, or lines of the same width one below the other (a time
    // graph's traces). A long narrow fader is none of these.
    const strips = (p: Box) => rest.filter((q) =>
      p.w > p.h * 4 ? Math.abs(q.x - p.x) <= 2 && Math.abs(q.w - p.w) <= 2 && q.w > q.h * 4 : Math.abs(q.y - p.y) <= 2 && Math.abs(q.h - p.h) <= 2 && q.h > q.w * 4).length;
    const displayLike = (p: Box) =>
      (p.h > height * 0.3 && p.w > width * 0.1) || (p.w > width * 0.3 && p.h > height * 0.1) || ((p.w > p.h * 4 || p.h > p.w * 4) && strips(p) >= 3);
    const controlLike = rest.filter((p) => !displayLike(p));
    const parts = controlLike.length ? controlLike : rest;
    if (!parts.length) continue;
    if (displayBox && !(parts[0]!.w <= width * 0.3 && parts[0]!.h <= height * 0.3)) continue;
    const pendingParam = { param, frames, parts, changed };
    pending.push(pendingParam);
  }

  // Switches often also dim the control they enable – their own footprint is the part that is not another control.
  const continuousBoxes = pending.filter((p) => !p.param.discrete).map((p) => p.parts[0]!);
  for (const { param, frames, parts: candidates, changed } of pending) {
    let parts = candidates;
    if (param.discrete) {
      // a part covered substantially by a continuous control is that control dimmed by the switch (touching is not enough)
      const covered = (b: Box, p: Box) =>
        Math.max(0, Math.min(b.x + b.w, p.x + p.w) - Math.max(b.x, p.x)) * Math.max(0, Math.min(b.y + b.h, p.y + p.h) - Math.max(b.y, p.y)) > area(p) * 0.3;
      const own = parts.filter((p) => !continuousBoxes.some((b) => covered(b, p)));
      if (!own.length) {
        hiddenSwitches.push(param.index);
        continue;
      }
      parts = own;
    }
    // only nearby parts belong to the control (a toggle may also change something far away)
    // A value text that changes with the control may be larger than the knob itself: the knob is the control.
    const textShaped = (p: Box) => p.h <= 24 && p.w >= p.h * 2.2 && p.w >= 28;
    const knobShaped = !param.discrete && textShaped(parts[0]!) ? parts.find((p) => !textShaped(p) && area(p) >= area(parts[0]!) * 0.4) : undefined;
    if (knobShaped) parts = [knobShaped, ...parts.filter((p) => p !== knobShaped)];
    const main0 = parts[0]!;
    const nearby = parts.filter((p) => Math.hypot(p.cx - main0.cx, p.cy - main0.cy) < Math.max(main0.w, main0.h) * 2.5 + 40);
    const region = union(nearby);
    // knob and value box directly below/above it often merge into one changed area: split them at an empty row
    // (a changed area that is not taller than wide holds no knob with a text below it: the text is on the knob)
    const stacked0 = main0.h > main0.w * 1.15 || param.discrete ? splitStack(changed, width, main0) : undefined;
    // A small pointer near the rim of a knob leaves one blob per position: together they are the control.
    // (Blobs that look like a value text below or above stay out, as do far-away ones.)
    const blobLike = (p: Box) => !(p.h <= 24 && p.w >= p.h * 2.2 && p.w >= 28);
    const cluster = !param.discrete ? nearbyBlobs(candidates.filter(blobLike), width, height) : undefined;
    // (one blob of such a group split into "control and text" would be nonsense)
    const stacked = cluster && area(cluster.box) > area(main0) * 2 ? undefined : stacked0;
    const main = stacked?.control ?? (cluster ? cluster.box : main0);
    const textLike = nearby.slice(1).filter((p) => p.h >= 6 && p.h <= 32 && p.w >= p.h * 1.2 &&
      (p.y >= main0.y + main0.h - 2 || p.y + p.h <= main0.y + 2) && p.x < main0.x + main0.w && p.x + p.w > main0.x && frames.filter((f, i) => i > 0 && diffMask(f, frames[i - 1]!, 30, noise).some((v, q) => v === 1 && (q % width) >= p.x && (q % width) < p.x + p.w && Math.floor(q / width) >= p.y && Math.floor(q / width) < p.y + p.h)).length >= Math.min(3, frames.length - 1));
    if (process.env.VCH_GUI_DEBUG) console.error(`footprint ${param.name}: discrete ${param.discrete} parts ${candidates.slice(0, 12).map((p) => `${p.x},${p.y} ${p.w}x${p.h}`).join(" | ")} cluster ${cluster ? `${cluster.box.x},${cluster.box.y} ${cluster.box.w}x${cluster.box.h} n${cluster.count}` : "-"} stacked ${stacked ? "yes" : "no"} main ${main.x},${main.y} ${main.w}x${main.h}`);
    const mcx = main.x + main.w / 2, mcy = main.y + main.h / 2;
    const near = stacked?.readout ?? textLike.sort((a, b) => Math.hypot(a.cx - mcx, a.cy - mcy) - Math.hypot(b.cx - mcx, b.cy - mcy))[0];
    const parameter = parameters.find((p) => p.index === param.index);
    const value = parameter ? parameter.value ?? parameter.default : 0.5;
    const valueText = parameter ? textAtValue(parameter, value) : undefined;
    footprints.push({
      param, frames, region: union([region, main]), value, ...(valueText ? { valueText } : {}),
      main: clampBox(grow({ x: main.x, y: main.y, w: main.w, h: main.h }, -3), base),
      ...(near ? { readout: clampBox(grow({ x: near.x, y: near.y, w: near.w, h: near.h }, -3), base) } : {}),
    });
  }

  valueAnchors.clear();
  // a control is small and inside the editor: a "knob" fitted to a whole display or reaching out of the editor is a misreading
  const controls = footprints.map((fp) => analyzeControl(fp, noise)).filter((c): c is Control => Boolean(c))
    .filter((c) => c.x >= -2 && c.y >= -2 && c.x + c.w <= width + 2 && c.y + c.h <= height + 2 && c.w * c.h <= width * height * 0.08);
  splitSharedValues(controls);
  // values on knobs of one editor share their format (majority): a point stuck to the next digit is no integer
  const onKnob = controls.filter((c) => c.readout?.onKnob && c.readout.decimals !== undefined);
  if (onKnob.length >= 3) {
    const votes = new Map<number, number>();
    for (const c of onKnob) votes.set(c.readout!.decimals!, (votes.get(c.readout!.decimals!) ?? 0) + 1);
    const [decimals, n] = [...votes].sort((a, b) => b[1] - a[1])[0]!;
    if (n > onKnob.length / 2) for (const c of onKnob) c.readout!.decimals = decimals;
  }

  // merge overlapping display regions
  const displays: Display[] = eqDisplay ? [eqDisplay] : [];
  const merged: typeof displayRegions = [];
  for (const d of displayRegions) {
    if (eqDisplay && overlaps(eqDisplay, d.box)) continue;
    // the same display: they overlap substantially (two displays may touch along an edge)
    const shared = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const target = merged.find((m) => shared(m.box, d.box) > Math.min(area(m.box), area(d.box)) * 0.3);
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
    // the curve is where a changed pixel stands out from the background (where it moved away, the background shows)
    const standing = d.frames.flatMap((f) => curvePoints.filter(([x, y]) => colorDistance(pixel(f, x, y), bg) > 60).map(([x, y]) => pixel(f, x, y)));
    const curve = standing.length >= 10 ? dominantColorOf(standing) : dominantAt(d.frames[0]!, curvePoints);
    const grid = dominantColor(base, box, subtle);
    // a row of evenly spaced, equal lights a control switches on and off is an LED meter showing what it sets
    const leds = ledChain(d.frames.map((f) => diffMask(f, base, 30, noise)), width, box);
    if (leds) {
      const lit = maskPoints(diffMask(d.frames[d.frames.length - 1]!, base, 30, noise), width, box);
      const color = hex(lit.length ? dominantAt(d.frames[d.frames.length - 1]!, lit) : bg);
      displays.push({
        kind: "bar", ...leds.box, background: hex(bg), grid: color, curve: color, text: color,
        bar: { source: "reduction", fromDb: 0, toDb: 20, color, origin: leds.vertical ? "bottom" : "left", segments: leds.count },
      });
      continue;
    }
    // a display that the threshold, ratio or knee of a compressor or gate bend is its transfer curve
    const curveLike = !d.eq && d.params.some((p) => /thresh|ratio|knee|reduction|range/i.test(p.name));
    // a filled area below a compressor curve: the lower right differs from the upper left (both away from the curve)
    let fill: string | undefined;
    if (curveLike) {
      const at = (fx: number, fy: number) => medianColor(base, clampBox({ x: Math.round(box.x + box.w * fx) - 2, y: Math.round(box.y + box.h * fy) - 2, w: 5, h: 5 }, base));
      const below = at(0.85, 0.85), above = at(0.15, 0.15);
      if (colorDistance(below, above) > 12) fill = hex(below);
    }
    displays.push({
      kind: d.eq ? "eq" : "generic", ...(curveLike ? { role: "curve" as const } : {}), ...(fill ? { fill } : {}), ...box,
      background: hex(bg), grid: hex(grid), curve: hex(curve), text: hex(luminance(bg) > 128 ? [40, 40, 40] : [170, 170, 170]),
    });
  }

  const series = await meterSeries(probe);
  if (series.length) {
    const plain = series.find((s) => !s.turned);
    const meter = options.meterReduction && plain ? await analyzeMeter(probe, plain.shots, animation, options.meterReduction) : undefined;
    if (meter) displays.push(meter);
    const meters = await analyzeLevelMeters(probe, series, animation, [...displays.filter((d) => d.kind === "meter"), ...controls], options.meterReduction);
    // a display that moves with the signal is an analyzer or a meter, whatever control also changes it
    const inside = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    for (let i = displays.length - 1; i >= 0; i--) {
      const d = displays[i]!;
      if (d.kind !== "generic") continue;
      if (meters.some((m) => inside(m, d) > area(d) * 0.5)) displays.splice(i, 1);
    }
    // a moving dot on a transfer curve is part of that curve; a graph found in pieces is one graph
    const covered = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const kept = meters.filter((m) => !(m.role === "analyzer" && displays.some((d) => d.kind !== "bar" && covered(d, m) > area(m) * 0.5)));
    for (let i = 0; i < kept.length; i++) {
      for (let j = kept.length - 1; j > i; j--) {
        if (kept[i]!.role === "analyzer" && kept[j]!.role === "analyzer" && overlaps(kept[i]!, kept[j]!, 8)) {
          Object.assign(kept[i]!, union([kept[i]!, kept[j]!]));
          kept.splice(j, 1);
        }
      }
    }
    displays.push(...kept);
  }

  // scales of curves and graphs: the numbers along their axes, read where they stand
  for (const d of displays) {
    if (d.kind !== "generic" || !d.role) continue;
    const scale = await readScale(base, d);
    if (scale) d.scale = scale;
  }

  // exclusion mask for static analysis
  const occupied = new Uint8Array(width * height);
  const mark = (b: Box, pad: number) => {
    const c = clampBox(grow(b, pad), base);
    for (let y = c.y; y < c.y + c.h; y++) occupied.fill(1, y * width + c.x, y * width + c.x + c.w);
  };
  for (const c of controls) {
    if (c.rotary) {
      // a knob covers a disc, not its bounding box: labels sit in the corners
      const r = Math.max(c.w, c.h) / 2 + 2;
      const b = clampBox(grow(c, 3), base);
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (Math.hypot(x + 0.5 - (c.x + c.w / 2), y + 0.5 - (c.y + c.h / 2)) <= r) occupied[y * width + x] = 1;
    } else mark(c, 3);
    if (c.readout) mark(c.readout, 2);
  }
  // meters only add a needle: their scale, texts and background belong to the static layout
  for (const d of displays) if (d.kind !== "meter" && d.kind !== "bar") mark(d, 1);

  // discs first: their rims would merge with texts next to them
  const circles = findCircles(base, occupied, dominantColor(base, { x: 0, y: 0, w: width, h: height }));
  const textExclude = occupied.slice();
  for (const c of circles) {
    const box = clampBox(grow({ x: Math.floor(c.cx - c.r), y: Math.floor(c.cy - c.r), w: Math.ceil(2 * c.r) + 1, h: Math.ceil(2 * c.r) + 1 }, 2), base);
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (Math.hypot(x + 0.5 - c.cx, y + 0.5 - c.cy) <= c.r + 2.5) textExclude[y * width + x] = 1;
  }

  // texts and labels
  const blocks = textBlocks(base, textExclude);
  // read the texts (tesseract, optional); without it labels are derived from parameter names
  const ocr = await recognizeBlocks(base, blocks.map((b) => ({ box: clampBox(grow(b.box, 1), base), color: b.color, background: b.background })));
  // texts covered by something that moves (a dot on a sphere): read them where it has moved away
  for (let i = 0; i < blocks.length; i++) {
    if (plausibleText(ocr[i], 70)) continue;
    const box = blocks[i]!.box;
    for (const set of changeSets) {
      let hits = 0;
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) hits += set.changed[y * width + x]!;
      if (hits < area(box) * 0.05) continue;
      const reads = await Promise.all(set.frames.map((f) => recognizeBlocks(f, [{ box: clampBox(grow(box, 1), base), color: blocks[i]!.color, background: blocks[i]!.background }])));
      for (const [read] of reads) if (read && read.confidence > (ocr[i]?.confidence ?? 0) && plausibleText(read, 70)) ocr[i] = read;
    }
  }
  // Rows of numbers (a scale, "-12 -6 0 +6 +12"): read as one line (single small numbers read worse), split at
  // the gaps between them so that each stands where it stands in the original, letters a tick mark or a stroke
  // turns a digit into put right ("T" for a "0" with the tick above it).
  const numeric = blocks.map((_, i) => i).filter((i) => {
    const t = ocr[i]?.text ?? "";
    const digits = (t.match(/\d/g) ?? []).length, letters = (t.match(/\p{L}/gu) ?? []).length;
    return digits >= 2 && digits >= (digits + letters) * 0.6 && /\s/.test(t.trim());
  });
  const asDigit: Record<string, string> = { T: "0", O: "0", o: "0", D: "0", Q: "0", l: "1", I: "1", "|": "1", ı: "1", i: "1", S: "5", s: "5", B: "8", "«": "+", "»": "+", "t": "+" };
  for (const i of numeric.reverse()) {
    const b = blocks[i]!, read = ocr[i]!;
    const tokens = read.text.trim().split(/\s+/);
    const words = splitWords(base, clampBox(grow(b.box, 1), base), b.color, b.background).filter((w) => w.h >= b.box.h * 0.5);
    if (words.length !== tokens.length || words.length < 2) continue;
    // (a faint "+" in front of a number reads as "ı", "«" or "t" – there it is a sign, not a 1)
    const fixed = tokens.map((t) => [...t].map((ch, k) => (k === 0 && t.length > 1 && /[ı«»t]/.test(ch) ? "+" : asDigit[ch] ?? ch)).join(""));
    if (!fixed.every((t) => /^[+-]?\d+(?:[.,]\d+)?%?$/.test(t))) continue;
    blocks.splice(i, 1, ...words.map((w) => ({ ...b, box: w })));
    ocr.splice(i, 1, ...words.map((w, k) => ({ text: fixed[k]!, confidence: Math.max(read.confidence, 75), box: w })));
  }
  if (process.env.VCH_GUI_DEBUG) blocks.forEach((b, i) => console.error(`text block ${b.box.x},${b.box.y} ${b.box.w}x${b.box.h} ink ${hex(b.color)} on ${hex(b.background)}: "${ocr[i]?.text ?? ""}" (${Math.round(ocr[i]?.confidence ?? 0)})`));
  const readText = (i: number, minConfidence = 70) => (plausibleText(ocr[i], minConfidence) ? ocr[i]!.text : undefined);
  /** box of the recognised words (icons next to the text are left out) */
  const readBox = (i: number) => (plausibleText(ocr[i]) && ocr[i]!.box ? ocr[i]!.box! : blocks[i]!.box);
  const wordCounts = new Map<string, number>();
  for (const c of controls) for (const w of new Set(c.name.toLowerCase().split(/\s+/))) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
  // A parameter name stands in for an unreadable block only where nothing else was read there ("4" above a knob
  // is no "Knee") and where the block is as tall as the labels that were read (a logo badge is no "SIDECHAIN").
  const readHeights = blocks.flatMap((b, i) => (readText(i) && /\p{L}{2}/u.test(ocr[i]!.text) ? [readBox(i).h] : []));
  const labelHeight = readHeights.length >= 2 ? percentile(readHeights, 0.5) : undefined;
  const readOther = (i: number) => Boolean(findTesseract() && ocr[i] && ocr[i]!.confidence >= 60 && ocr[i]!.text.trim().length > 0);
  // …and of their colour (a piece of a bevel is no label)
  const readColors = blocks.flatMap((b, i) => (readText(i) && /\p{L}{2}/u.test(ocr[i]!.text) ? [b.color] : []));
  const labelColor = readColors.length >= 2 ? dominantColorOf(readColors) : undefined;
  const inventable = (i: number) => !readOther(i) &&
    (labelHeight === undefined || Math.abs(Math.log(blocks[i]!.box.h / labelHeight)) < 0.35) &&
    (labelColor === undefined || readColors.some((c) => colorDistance(c, blocks[i]!.color) < 60));
  const texts: TextItem[] = [];
  const used = new Set<number>();

  // vertical words: letters stacked in a column ("L E F T" beside a sphere) – split into letters by ink rows,
  // read side by side, drawn letter by letter
  const narrow = blocks.map((b, i) => ({ ...b, i })).filter((b) => b.box.w <= 20 && b.box.h <= 60 && !plausibleText(ocr[b.i], 92));
  const taken = new Set<number>();
  for (const first of [...narrow].sort((a, b) => a.box.y - b.box.y)) {
    if (taken.has(first.i)) continue;
    const column = [first];
    for (;;) {
      const region = union(column.map((b) => b.box));
      const next = narrow
        .filter((b) => !taken.has(b.i) && !column.includes(b) && b.box.y >= region.y + region.h - 2 && b.box.y - (region.y + region.h) < 12)
        .filter((b) => Math.abs(b.box.x + b.box.w / 2 - (first.box.x + first.box.w / 2)) < 4)
        .sort((a, b) => a.box.y - b.box.y)[0];
      if (!next) break;
      column.push(next);
    }
    if (column.length < 2) continue;
    const region = union(column.map((b) => b.box));
    const bg = first.background;
    const ink = (x: number, y: number) => !textExclude[y * width + x] && colorDistance(pixel(base, x, y), bg) > 60;
    const glyphs: Box[] = [];
    let open: { y0: number; x0: number; x1: number } | undefined;
    for (let y = region.y; y <= region.y + region.h; y++) {
      let x0 = Infinity, x1 = -Infinity;
      if (y < region.y + region.h) for (let x = region.x; x < region.x + region.w; x++) if (ink(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
      if (x1 >= x0) open = open ? { y0: open.y0, x0: Math.min(open.x0, x0), x1: Math.max(open.x1, x1) } : { y0: y, x0, x1 };
      else if (open) { glyphs.push({ x: open.x0, y: open.y0, w: open.x1 - open.x0 + 1, h: y - open.y0 }); open = undefined; }
    }
    const letterH = percentile(glyphs.map((g) => g.h), 0.5);
    const letterBoxes = glyphs.filter((g) => g.h >= letterH * 0.6 && g.h <= letterH * 1.4);
    if (letterBoxes.length < 3 || letterBoxes.length !== glyphs.length) continue;
    const h = letterH + 8;
    const gap = Math.round(h * 0.3);
    const w = letterBoxes.reduce((sum, g) => sum + g.w + gap, gap);
    const strip: Image = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    for (let p = 0; p < w * h; p++) strip.data.set([bg[0], bg[1], bg[2], 255], p * 4);
    let x0 = gap;
    for (const g of letterBoxes) {
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        if (!ink(g.x + x, g.y + y) && colorDistance(pixel(base, g.x + x, g.y + y), bg) > 60) continue;
        const from = ((g.y + y) * width + g.x + x) * 4, to = ((4 + y) * w + x0 + x) * 4;
        strip.data.set(base.data.subarray(from, from + 4), to);
      }
      x0 += g.w + gap;
    }
    const [read] = await recognizeBlocks(strip, [{ box: { x: 0, y: 0, w, h }, color: first.color, background: bg }]);
    const word = commonWord(read?.text.replace(/[^\p{L}\p{N}]/gu, "") ?? "", read?.confidence ?? 0);
    // a word of letters (dashed borders read as "1111" or "||||" are not)
    if (!read || read.confidence < 60 || word.length !== letterBoxes.length || !/^\p{L}+$/u.test(word) || new Set(word.toUpperCase()).size < 2) continue;
    for (const b of column) { taken.add(b.i); used.add(b.i); }
    letterBoxes.forEach((g, k) => {
      texts.push({ ...g, text: word[k]!, color: hex(first.color), size: fontSize(word[k]!, g.h), bold: first.bold, align: "left", role: "text" });
    });
  }

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
      .map((b) => ({ ...b, text: readText(b.i) ?? nameLike(ocr[b.i]?.text, c.name) ?? (inventable(b.i) ? fitLabel(c.name, b.box.w, b.box.h, b.uppercase, wordCounts) : undefined) }))
      .filter((b): b is typeof b & { text: string } => b.text !== undefined);
    const best = candidates.sort((a, b) => a.score - b.score)[0];
    if (!best) continue;
    used.add(best.i);
    const text = best.text;
    const labelBox = readText(best.i) ? readBox(best.i) : best.box;
    texts.push({ ...labelBox, text, color: hex(best.color), size: fontSize(text, labelBox.h), bold: best.bold, align: best.align, role: "label" });
  }
  const titleCandidate = blocks
    .map((b, i) => ({ ...b, i }))
    .filter(({ box, i }) => !used.has(i) && box.y < height * 0.35 && box.h >= 14 && box.h <= 60)
    // readable blocks first (a large icon is not the title), then the tallest
    .sort((a, b) => Number(plausibleText(ocr[b.i], 60)) - Number(plausibleText(ocr[a.i], 60)) || b.box.h - a.box.h)[0];
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
    const [read] = await recognizeBlocks(base, [{ box: clampBox(grow(box, 1), base), color: titleCandidate.color, background: titleCandidate.background }]);
    const estimate = title.length * box.h * (titleCandidate.uppercase ? 0.78 : 0.62);
    // without text recognition the plugin name stands in where it fits; with it, an unreadable block is no title
    const text = plausibleText(read, 60) ? read.text : !findTesseract() && Math.abs(Math.log(estimate / box.w)) < 0.6 ? (titleCandidate.uppercase ? title.toUpperCase() : title) : undefined;
    if (text) {
      const textBox = plausibleText(read, 60) && read.box ? read.box : box;
      texts.push({ ...textBox, text, color: hex(titleCandidate.color), size: fontSize(text, textBox.h), bold: titleCandidate.bold, align: "left", role: "title" });
    }
  }

  // all other readable texts (subtitles, section names, notes)
  blocks.forEach((b, i) => {
    if (used.has(i)) return;
    const text = readText(i, 75);
    if (!text) return;
    used.add(i);
    const box = readBox(i);
    texts.push({ ...box, text, color: hex(b.color), size: fontSize(text, box.h), bold: b.bold, align: "left", role: "text" });
  });

  // background, panels and lines
  // texts are no panels – but a large block nothing could be read in is graphics (a badge, a knob), and its
  // areas are panels
  const glyphArea = (labelHeight ?? 10) ** 2 * 12;
  blocks.forEach((b, i) => {
    if (used.has(i) || area(b.box) <= glyphArea) mark(b.box, 2);
  });
  for (let p = 0; p < occupied.length; p++) if (textExclude[p]) occupied[p] = 1;
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

  // panels and lines inside a disc are pieces of it
  const insideCircle = (b: Box) => circles.some((c) => Math.hypot(b.x + b.w / 2 - c.cx, b.y + b.h / 2 - c.cy) < c.r && Math.max(b.w, b.h) < c.r * 2 + 2);
  for (const list of [panels, lines] as const) {
    const kept = (list as (Panel | Line)[]).filter((item) => !insideCircle("x1" in item ? { x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2), w: Math.abs(item.x2 - item.x1) + 1, h: Math.abs(item.y2 - item.y1) + 1 } : item));
    list.length = 0;
    (list as (Panel | Line)[]).push(...kept);
  }

  const insideDisplay = (b: Box) => displays.filter((d) => d.kind !== "meter" && d.kind !== "bar").some((d) => {
    const ix = Math.max(0, Math.min(b.x + b.w, d.x + d.w) - Math.max(b.x, d.x));
    const iy = Math.max(0, Math.min(b.y + b.h, d.y + d.h) - Math.max(b.y, d.y));
    return ix * iy > area(b) * 0.5;
  });
  const lineBox = (l: Line): Box => ({ x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1) + 1, h: Math.abs(l.y2 - l.y1) + 1 });
  const keptPanels = panels.filter((p) => !insideDisplay(p));
  const keptLines = lines.filter((l) => !insideDisplay(lineBox(l)));
  // a read text must fit its box: two digits "found" in a large picture are no text
  const fits = (t: TextItem) => {
    const natural = Math.max(1, t.text.length) * t.size * 0.55;
    return t.w / natural > 0.4 && t.w / natural < 2.5;
  };
  const keptTexts = texts.filter((t) => !insideDisplay(t) && (t.text.length === 1 || fits(t)));
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
    ...(circles.length ? { circles } : {}),
    lines: lines.slice(0, 80),
    texts,
    controls,
    displays,
    hidden: [...probe.invisible, ...hiddenSwitches],
  };
}
