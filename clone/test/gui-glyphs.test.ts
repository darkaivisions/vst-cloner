import assert from "node:assert/strict";
import { test } from "node:test";
import { glyphTemplates, readGlyphs, type Glyph } from "../src/gui/glyphs.ts";

// 3×5 glyphs drawn as strings ("#" ink)
const glyph = (rows: string[], x: number): Glyph => {
  const w = rows[0]!.length, h = rows.length;
  return { x, y: 0, w, h, mask: Float32Array.from(rows.join("").split("").map((c) => (c === "#" ? 1 : 0))) };
};
const L = ["#..", "#..", "#..", "#..", "###"], F = ["###", "#..", "##.", "#..", "#.."], H = ["#.#", "#.#", "###", "#.#", "#.#"];

test("glyphs of a block read for sure are templates, and read another block of the same font", () => {
  const templates = [...glyphTemplates([glyph(L, 0), glyph(F, 4)], "LF"), ...glyphTemplates([glyph(H, 0), glyph(F, 4)], "HF")];
  const read = readGlyphs([glyph(H, 20), glyph(L, 24), glyph(F, 28)], templates);
  assert.deepEqual(read.map((r) => r.candidates[0]?.char), ["H", "L", "F"]);
});

test("a glyph without a template has no candidates, and touching glyphs are cut apart", () => {
  const templates = glyphTemplates([glyph(L, 0), glyph(F, 4), glyph(H, 8)], "LFH");
  const touching = glyph(L.map((row, k) => row + F[k]), 30);
  const read = readGlyphs([touching, glyph(["###", "..#", "###", "#..", "###"], 40)], templates);
  assert.deepEqual(read.map((r) => r.candidates[0]?.char), ["L", "F", undefined]);
});
