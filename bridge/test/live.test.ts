import assert from "node:assert/strict";
import { test } from "node:test";
import { BAND_CENTRES, bands, envelope } from "../src/live.ts";

const rate = 48000;
const sine = (seconds: number, frequency: number, peakDb: number, silentFrom = Infinity) => {
  const a = Math.pow(10, peakDb / 20);
  return Float32Array.from({ length: seconds * rate }, (_, i) => (i / rate >= silentFrom ? 0 : a * Math.sin((2 * Math.PI * frequency * i) / rate)));
};

test("a sine shows in its third-octave band at its peak level", () => {
  const levels = bands({ sampleRate: rate, channels: [sine(2, 1000, -6)] });
  const band = BAND_CENTRES.findIndex((c) => Math.abs(Math.log2(c / 1000)) < 1 / 6);
  assert.ok(Math.abs(levels[band]! - -6) < 1, `band ${BAND_CENTRES[band]} Hz: ${levels[band]} dB`);
  assert.ok(levels.every((v, i) => i === band || v < levels[band]! - 20 || Math.abs(i - band) === 1), levels.join(" "));
});

test("the level curve follows the RMS level and floors silence", () => {
  const curve = envelope({ sampleRate: rate, channels: [sine(4, 1000, -6, 2)] }, 4);
  assert.equal(curve.length, 240);
  assert.ok(Math.abs(curve[60]! - -9) < 0.2, `${curve[60]}`);
  assert.equal(curve[200], -120);
});
