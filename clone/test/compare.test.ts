import { test } from "node:test";
import assert from "node:assert/strict";
import { spectralDeviationDb } from "../src/dsp/spectral.ts";
import { bestClone, type CloneComparison } from "../src/compare.ts";

const noise = (n: number, seed: number) => {
  let s = seed;
  return Float32Array.from({ length: n }, () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1);
};

test("the spectral deviation ignores the phase but not the level", () => {
  const a = noise(48000, 1);
  assert.equal(spectralDeviationDb(a, a, 48000), 0);
  const quieter = a.map((x) => x / 2);
  assert.ok(Math.abs(spectralDeviationDb(a, quieter, 48000) - 6.02) < 0.05);
  // other noise with the same spectrum: a different signal sample by sample, nearly the same sound
  assert.ok(spectralDeviationDb(a, noise(48000, 2), 48000) < 2);
});

test("the best clone is the one closest in sound", () => {
  const result = (name: string, spectral: number, esr: number, missing: string[] = []): CloneComparison =>
    ({ name, clonePath: name, esr: { mean: esr, median: esr }, spectralDb: { mean: spectral, median: spectral }, missing });
  assert.equal(bestClone([result("neural", 5.3, 0.3), result("reverb", 2.5, 0.67)])?.name, "reverb");
  assert.equal(bestClone([result("delay", 4, 0.8, ["Sync BPM"]), result("neural", 4, 0.3)])?.name, "neural");
});
