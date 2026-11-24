/**
 * Reading small labels by the editor's own glyphs. Tesseract fails on tiny pixel fonts (ZamEQ2's "DB" reads as
 * "w"), but the same font also writes labels it does read ("MASTER", "PEAKS", "-12"): their glyphs, cut apart at
 * the empty columns between them, are templates for the blocks nothing could be read in.
 */
import type { Box, Image, Rgb } from "./image.ts";
import { inkMeasure } from "./ocr.ts";

export interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  /** ink amount per pixel (0…1), row by row, w·h – kept soft, so that anti-aliasing at another sub-pixel
   *  position counts as a small difference */
  mask: Float32Array;
}

/** A text block's glyphs: ink columns separated by empty ones, each cropped to its ink. */
export function cutGlyphs(img: Image, box: Box, text: Rgb, background: Rgb): Glyph[] {
  const ink = inkMeasure(img, box, text, background);
  const on = (x: number, y: number) => ink(x, y) > 0.5;
  const glyphs: Glyph[] = [];
  let start = -1;
  for (let x = box.x; x <= box.x + box.w; x++) {
    let any = false;
    if (x < box.x + box.w) for (let y = box.y; y < box.y + box.h && !any; y++) any = on(x, y);
    if (any && start < 0) start = x;
    if (!any && start >= 0) {
      let top = Infinity, bottom = -Infinity;
      for (let y = box.y; y < box.y + box.h; y++) for (let gx = start; gx < x; gx++) if (on(gx, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      const w = x - start, h = bottom - top + 1;
      const mask = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let gx = 0; gx < w; gx++) mask[y * w + gx] = ink(start + gx, top + y);
      glyphs.push({ x: start, y: top, w, h, mask });
      start = -1;
    }
  }
  return glyphs;
}

/** a glyph that stands for a character, with its height above the line's bottom */
export interface GlyphTemplate {
  char: string;
  glyph: Glyph;
  /** bottom of the glyph above the bottom of its line (a "-" floats, a "B" stands on it) */
  lift: number;
  /** height of its line (the tallest glyph) */
  line: number;
}

/** Templates from a block read for sure: only where the glyphs and the characters pair up one to one. */
export function glyphTemplates(glyphs: Glyph[], text: string): GlyphTemplate[] {
  const chars = [...text.replace(/\s+/g, "")];
  if (!glyphs.length || chars.length !== glyphs.length) return [];
  const bottom = Math.max(...glyphs.map((g) => g.y + g.h)), line = Math.max(...glyphs.map((g) => g.h));
  return glyphs.map((glyph, i) => ({ char: chars[i]!, glyph, lift: bottom - (glyph.y + glyph.h), line }));
}

/** Share of pixels two glyphs disagree on, at the best shift of up to a pixel. */
export function glyphDistance(a: Glyph, b: Glyph): number {
  if (Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1) return 1;
  const w = Math.max(a.w, b.w), h = Math.max(a.h, b.h);
  let best = 1;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    let differ = 0, inked = 0;
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
      const va = x >= 0 && y >= 0 && x < a.w && y < a.h ? a.mask[y * a.w + x]! : 0;
      const bx = x + dx, by = y + dy;
      const vb = bx >= 0 && by >= 0 && bx < b.w && by < b.h ? b.mask[by * b.w + bx]! : 0;
      differ += Math.abs(va - vb);
      inked += Math.max(va, vb);
    }
    best = Math.min(best, differ / Math.max(1e-6, inked));
  }
  return best;
}

/** Characters a glyph may be: templates of the same line size and place on it, closest first. */
export function glyphCandidates(g: Glyph, line: { bottom: number; height: number }, templates: GlyphTemplate[], maxDistance = 0.3): { char: string; d: number }[] {
  const lift = line.bottom - (g.y + g.h);
  const best = new Map<string, number>();
  for (const t of templates) {
    // the same size of line and the same place on it (a "-" is no "_")
    if (Math.abs(t.line - line.height) > 1 || Math.abs(t.lift - lift) > 1) continue;
    const d = glyphDistance(g, t.glyph);
    if (d <= maxDistance && d < (best.get(t.char) ?? Infinity)) best.set(t.char, d);
  }
  return [...best].map(([char, d]) => ({ char, d })).sort((a, b) => a.d - b.d);
}

/** a block's glyphs with what each may be; a glyph matching nothing that is several glyphs wide is cut apart */
export function readGlyphs(glyphs: Glyph[], templates: GlyphTemplate[]): { glyph: Glyph; candidates: { char: string; d: number }[]; space: boolean }[] {
  if (!glyphs.length) return [];
  const line = { bottom: Math.max(...glyphs.map((g) => g.y + g.h)), height: Math.max(...glyphs.map((g) => g.h)) };
  const out: { glyph: Glyph; candidates: { char: string; d: number }[]; space: boolean }[] = [];
  glyphs.forEach((g, i) => {
    const space = i > 0 && g.x - (glyphs[i - 1]!.x + glyphs[i - 1]!.w) > line.height * 0.5;
    const candidates = glyphCandidates(g, line, templates);
    const parts = candidates.length ? [g] : splitTouching([g], templates);
    const read = parts.length > 1 ? parts.map((p) => ({ glyph: p, candidates: glyphCandidates(p, line, templates) })) : [];
    // (cut apart only where every piece is a glyph: an "M" is wide, not two letters)
    if (read.length > 1 && read.every((r) => r.candidates.length)) read.forEach((r, k) => out.push({ ...r, space: space && k === 0 }));
    else out.push({ glyph: g, candidates, space });
  });
  return out;
}

/**
 * Glyphs that touch (ZamEQ2's "DB" is one ink column run) are cut apart: a glyph about n times as wide as the
 * templates of its line height is cut into n at the columns with the least ink.
 */
export function splitTouching(glyphs: Glyph[], templates: GlyphTemplate[]): Glyph[] {
  return glyphs.flatMap((g) => {
    const widths = templates.filter((t) => Math.abs(t.glyph.h - g.h) <= 1 && /[\p{L}\p{N}]/u.test(t.char)).map((t) => t.glyph.w).sort((a, b) => a - b);
    if (widths.length < 3) return [g];
    const typical = widths[widths.length >> 1]!;
    const parts = Math.round((g.w + 1) / (typical + 1));
    if (parts < 2 || g.w < typical * 1.6) return [g];
    const inkIn = (x: number) => { let n = 0; for (let y = 0; y < g.h; y++) n += g.mask[y * g.w + x]!; return n; };
    const cuts: number[] = [];
    for (let k = 1; k < parts; k++) {
      // the thinnest column near where the k-th glyph should end is its last one (where two glyphs touch)
      const at = Math.round((k * g.w) / parts) - 1;
      let best = at;
      for (let x = Math.max(0, at - 1); x <= Math.min(g.w - 2, at + 1); x++) if (inkIn(x) < inkIn(best)) best = x;
      cuts.push(best + 1);
    }
    const edges = [0, ...cuts, g.w];
    const pieces: Glyph[] = [];
    for (let k = 0; k + 1 < edges.length; k++) {
      const start = edges[k]!, end = edges[k + 1]!, w = end - start;
      let top = g.h, bottom = -1;
      for (let y = 0; y < g.h; y++) for (let x = start; x < end; x++) if (g.mask[y * g.w + x]! > 0.5) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      if (bottom < top) continue;
      const h = bottom - top + 1, mask = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = g.mask[(top + y) * g.w + start + x]!;
      pieces.push({ x: g.x + start, y: g.y + top, w, h, mask });
    }
    return pieces;
  });
}
