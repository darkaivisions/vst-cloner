import assert from "node:assert/strict";
import { test } from "node:test";
import { fitAxis, misreadScaleValue, scaleNumber, toFrame } from "../src/gui/analyze.ts";

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

test("a graph found where its traces were grows to its frame, not into a panel of the same colour", () => {
  // 100×80: graph background 30 with vertical grid lines every 20 px and a grid row at y 30, a frame line at
  // y 60, below it a panel of the graph's colour without grid lines; traces were seen in x 20…79, y 35…54
  const width = 100, height = 80, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const grid = y < 60 && (x % 20 === 10 || y === 30), frame = y === 60;
    const v = frame ? 120 : grid ? 60 : 30;
    data.set([v, v, v, 255], (y * width + x) * 4);
  }
  const box = toFrame({ width, height, data } as never, { x: 20, y: 35, w: 60, h: 20 }, [30, 30, 30]);
  assert.deepEqual(box, { x: 0, y: 0, w: 100, h: 60 });
});
