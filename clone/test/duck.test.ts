import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTestSignal } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { duckTrack, fitDuck, showsDucking, type DuckInput } from "../src/delay/duck.ts";
import { HP_OFF, LP_OFF, OFF_DB, packDelay, processDelay, unpackDelay, type DelayParams } from "../src/delay/model.ts";
import { isDuckingDelay } from "../src/delay/plan.ts";

const SR = 48000;
const plain: DelayParams = { delaySeconds: 0.25, dryDb: 0, wetDb: 0, feedbackDb: OFF_DB, loopLp: LP_OFF, loopHp: HP_OFF, wetLp: LP_OFF, wetHp: HP_OFF };
const ducked: DelayParams = { ...plain, duckThresholdDb: -30, duckAttack: 0.05, duckRelease: 0.3 };
const structure = { drySign: 1, wetSign: 1, feedbackSign: 1, duckSmoothSeconds: 0.1 };

/** the duck test signal at a low rate (fast) and its duck segment */
function duckInput(sampleRate = 16000): DuckInput & { set: ReturnType<typeof generateTestSignal>["set"] } {
  const { set, audio } = generateTestSignal({ sampleRate, channels: 1, preset: "duck" });
  const segment = set.segments.find((s) => s.kind === "duck")!;
  return {
    set, sampleRate, signal: audio.channels[0]!, start: segment.start, length: segment.length, probeFrequency: segment.params!.probeFrequency!,
    probeAmplitude: 10 ** (segment.params!.probeDb! / 20), triggerAt: Math.round(Math.min(segment.params!.impulseSeconds!, segment.params!.burstsSeconds!) * sampleRate),
  };
}

test("ducking: a loud input turns the echo down, a quiet one does not, and the loop is not ducked", () => {
  const signal = new Float32Array(2 * SR);
  for (let n = 0; n < 0.5 * SR; n++) signal[n] = 0.5 * Math.sin((2 * Math.PI * 440 * n) / SR); // −6 dB, above −30
  const out = processDelay(signal, ducked, structure, SR);
  const open = processDelay(signal, plain, { ...structure, duckSmoothSeconds: 0 }, SR);
  const level = (y: Float32Array, from: number, to: number) => {
    let s = 0;
    for (let n = Math.round(from * SR); n < Math.round(to * SR); n++) s += (y[n]! - signal[n]!) ** 2;
    return 10 * Math.log10(s + 1e-30);
  };
  // the echo while the input is loud is far down, and comes back after the release
  assert.ok(level(out, 0.4, 0.5) < level(open, 0.4, 0.5) - 20);
  assert.ok(Math.abs(level(out, 1.6, 1.7) - level(open, 1.6, 1.7)) < 1);
  // a quiet input (below the threshold) is not ducked
  const quiet = signal.map((v) => v * 0.01); // −46 dB
  const q = processDelay(quiet, ducked, structure, SR), qOpen = processDelay(quiet, plain, structure, SR);
  assert.ok(Math.max(...q.map((v, i) => Math.abs(v - qOpen[i]!))) < 1e-9);
  // ducking values survive packing; old models (15 values) have none
  assert.deepEqual(unpackDelay(packDelay(ducked)).duckAttack?.toFixed(6), "0.050000");
  assert.equal(unpackDelay(packDelay(plain).slice(0, 15)).duckThresholdDb, 6);
});

test("ducking: the probe shows the echo's gain, and the detector values are found from it", () => {
  const input = duckInput();
  const dry = 1;
  const output = processDelay(input.signal, ducked, structure, input.sampleRate, input.start + input.length);
  const track = duckTrack(output, input, dry)!;
  assert.ok(track && showsDucking(track));
  // without ducking the echo stays open (0 dB)
  const open = duckTrack(processDelay(input.signal, plain, structure, input.sampleRate, input.start + input.length), input, dry)!;
  const deviation = Math.max(...[...open].filter((v) => !Number.isNaN(v)).map(Math.abs));
  assert.ok(deviation < 0.5, `open track ${deviation}`);
  // windows that hold the loud impulse's echo are left out, and only those
  assert.ok([...open].filter((v) => Number.isNaN(v)).length < 20);

  const found = fitDuck(track, input, structure.duckSmoothSeconds);
  assert.ok(Math.abs(found.thresholdDb + 30) < 2, `threshold ${found.thresholdDb}`);
  assert.ok(Math.abs(Math.log(found.attack / 0.05)) < 0.3, `attack ${found.attack}`);
  assert.ok(Math.abs(Math.log(found.release / 0.3)) < 0.2, `release ${found.release}`);
  assert.ok(found.error < 1, `error ${found.error}`);
  // the glide's time constant too, when it is not given
  assert.ok(Math.abs(Math.log(fitDuck(track, input).smooth / 0.1)) < 0.2);
});

test("ducking delays are recognised by name or by a detector's attack and release", () => {
  const p = (index: number, name: string) => ({ index, name, automatable: true, value: 0.5, default: 0.5, numSteps: 0, discrete: false } as unknown as Parameter);
  assert.equal(isDuckingDelay([p(0, "TIME"), p(1, "FEEDBACK")], "Gxduck_delay"), true);
  assert.equal(isDuckingDelay([p(0, "Time"), p(1, "Attack"), p(2, "RELESE")], "Some Delay"), true);
  assert.equal(isDuckingDelay([p(0, "Time"), p(1, "Feedback"), p(2, "Mix")], "ZamDelay"), false);
});
