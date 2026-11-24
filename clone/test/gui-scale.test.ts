import assert from "node:assert/strict";
import { test } from "node:test";
import { fitAxis, misreadScaleValue, scaleNumber } from "../src/gui/analyze.ts";

test("scale numbers: signs, units and a little junk around them", () => {
  assert.equal(scaleNumber("-24"), -24);
  assert.equal(scaleNumber("−12 dB"), -12);
  assert.equal(scaleNumber("|-60"), -60);
  assert.equal(scaleNumber("in-96"), -96);
  assert.equal(scaleNumber("0.5"), 0.5);
  assert.equal(scaleNumber("Threshold"), undefined);
  assert.equal(scaleNumber("dB"), undefined);
});

test("an axis: numbers in even steps on a straight line, misreadings left out", () => {
  // −12 … −72 every 26 px, "-48" misread as "-45"
  const points = [-12, -24, -36, -48, -60, -72].map((value, i) => ({ at: 100 + i * 26, value: value === -48 ? -45 : value }));
  const fit = fitAxis(points)!;
  assert.ok(fit);
  assert.equal(fit.inliers.length, 5);
  assert.ok(Math.abs(fit.a + fit.b * 100 - -12) < 0.01 && Math.abs(fit.b - -12 / 26) < 1e-6);
});

test("no axis from numbers that are no scale", () => {
  // value readouts of different controls side by side
  assert.equal(fitAxis([{ at: 10, value: 3 }, { at: 80, value: -24 }, { at: 150, value: 100 }]), undefined);
  // too few, and uneven steps (2.5 read as 25)
  assert.equal(fitAxis([{ at: 0, value: 0 }, { at: 50, value: 1 }]), undefined);
  assert.equal(fitAxis([{ at: 0, value: 5 }, { at: 100, value: 4 }, { at: 200, value: 25 }]), undefined);
});

test("numbers of an axis read wrong take the axis value where they stand", () => {
  assert.equal(misreadScaleValue("I.", -60.6, 12), -60);
  assert.equal(misreadScaleValue("48", -48.2, 12), -48);
  assert.equal(misreadScaleValue("45", 4.52, 0.5), 4.5);
  // other digits, words, or between two steps: no
  assert.equal(misreadScaleValue("36", -48, 12), undefined);
  assert.equal(misreadScaleValue("dB", -12, 12), undefined);
  assert.equal(misreadScaleValue("I.", -54, 12), undefined);
});
