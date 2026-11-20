import { test } from "node:test";
import assert from "node:assert/strict";
import type { Parameter } from "@vst-cloner/profile";
import { renderTestSignal, segmentSpecs } from "@vst-cloner/capture";
import { classifyPlugin } from "../src/batch.ts";
import { HP_OFF, LP_OFF, MOD_OFF, OFF_DB, packDelay, processDelay, unpackDelay, type DelayParams } from "../src/delay/model.ts";
import { measureModulation } from "../src/delay/modulation.ts";
import { detectModulation, NotDelayError } from "../src/delay/plan.ts";
import { delayReading, lfoDeviation, lfoStart } from "../src/delay/fit.ts";

const sr = 48000, period = Math.round(0.04 * sr);
const chorus = (extra: Partial<DelayParams> = {}): DelayParams => ({
  delaySeconds: 0.01, dryDb: 0, wetDb: -6, feedbackDb: OFF_DB, loopLp: LP_OFF, loopHp: HP_OFF, wetLp: LP_OFF, wetHp: HP_OFF,
  modDepthSeconds: 0.003, modRate: 1.5, modPhase: 0.7, ...extra,
});
const clicks = (seconds: number) => {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i += period) x[i] = 1;
  return x;
};
const structure = { drySign: 1, wetSign: 1, feedbackSign: 1 };

test("an LFO on the delay time is read off the clicks: centre, depth, rate, phase and level", () => {
  const p = chorus();
  const out = processDelay(clicks(5), p, structure, sr);
  const m = measureModulation({ h: out, period }, sr)!;
  assert.ok(Math.abs(m.centre - 0.01) < 2e-5, `centre ${m.centre}`);
  assert.ok(Math.abs(m.depth - 0.003) < 3e-5, `depth ${m.depth}`);
  assert.ok(Math.abs(m.rate - 1.5) < 0.005, `rate ${m.rate}`);
  assert.ok(Math.abs(m.gain - 0.5) < 0.01, `gain ${m.gain}`);
  // without an LFO nothing is reported
  assert.equal(measureModulation({ h: processDelay(clicks(5), chorus({ modDepthSeconds: MOD_OFF }), structure, sr), period }, sr), undefined);
});

test("the LFO's start is found from renders at several rates", () => {
  const input = { sampleRate: sr, start: 0, length: 0, amplitude: 1, preroll: 24000, clicks: { start: 4800, length: 5 * sr, amplitude: 1, period } };
  const lead = 800, phase = 0.4;
  const measured = [0.5, 1.3, 2.9, 6].map((rate) => {
    const p = chorus({ modRate: rate, modPhase: phase });
    const out = processDelay(clicks(5), p, { ...structure, modLead: lead }, sr, undefined, input.preroll + input.clicks.start);
    return measureModulation({ h: out, period }, sr)!;
  });
  const start = lfoStart(measured.map((m) => delayReading(m, sr)), input);
  // the clicks show the delay at the moment a repeat leaves the line: up to the read offset the start comes back
  const deviation = Math.abs(((start.phase - phase + Math.PI) % (2 * Math.PI)) - Math.PI);
  assert.ok(Math.abs(start.lead - lead) < 600 && deviation < 0.3, `lead ${start.lead} phase ${start.phase}`);
});

test("old delay models (8 packed values) unpack without an LFO", () => {
  const packed = packDelay(chorus()).slice(0, 8);
  const p = unpackDelay(packed);
  assert.ok(Math.abs(p.modDepthSeconds! - MOD_OFF) < 1e-12);
  assert.equal(packDelay(chorus()).length, 15);
});

test("two LFOs are compared with their phases aligned", () => {
  const a = { centre: 0.01, depth: 0.003, rate: 2, phase: 0, taps: 100, gain: 0.5, residual: 0 };
  assert.ok(lfoDeviation(a, { ...a, phase: 2.5 }, 5) < 1e-4);
  assert.ok(lfoDeviation(a, { ...a, depth: 0.001 }, 5) > 0.001);
  assert.ok(Math.abs(lfoDeviation(a, undefined, 5) - 0.003 / Math.SQRT2) < 1e-9);
});

test("chorus, flanger, vibrato, phaser and tremolo are recognised; rotary speakers are not", () => {
  const p = (index: number, name: string): Parameter => ({ index, id: String(index), name, default: 0.5, value: 0.5, numSteps: 0, discrete: false, boolean: false, automatable: true, meta: false, label: "", category: 0 }) as unknown as Parameter;
  const params = [p(0, "Level"), p(1, "Delay"), p(2, "Depth"), p(3, "Freq")];
  assert.ok(detectModulation(params, "Chorus", "GxChorus-Stereo"));
  assert.ok(detectModulation(params, "Modulator", "Flanger"));
  assert.ok(detectModulation(params, "Phaser Plugin", "GxPhaser"));
  assert.ok(detectModulation(params, "Modulator", "Tremolo"));
  assert.throws(() => detectModulation(params, "Modulator", "Rotary Speaker"), NotDelayError);
  assert.equal(classifyPlugin({ parameters: params, plugin: { name: "GxChorus-Stereo", category: "Chorus" } as never, mainInputChannels: 2 }).effectClass, "modulation");
});

test("the modulation signal has a train of clicks", () => {
  const specs = segmentSpecs("modulation", sr);
  assert.ok(specs.some((s) => s.kind === "clicks"));
  const segments = [{ id: "clicks", kind: "clicks" as const, start: 10, length: 200, params: { periodSeconds: 50 / sr, amplitude: 0.5 } }];
  const audio = renderTestSignal({ sampleRate: sr, channels: 1, length: 300, segments });
  const ones = [...audio.channels[0]!.keys()].filter((i) => audio.channels[0]![i] !== 0);
  assert.deepEqual(ones, [10, 60, 110, 160]);
});

test("a tremolo is read off the dry part of the clicks", async () => {
  const { measureTremolo } = await import("../src/delay/modulation.ts");
  const p = chorus({ modDepthSeconds: MOD_OFF, wetDb: OFF_DB, tremDepth: 0.6, modRate: 4, modPhase: 0 });
  const out = processDelay(clicks(5), p, structure, sr);
  const m = measureTremolo({ h: out, period }, sr)!;
  assert.ok(Math.abs(m.rate - 4) < 0.02, `rate ${m.rate}`);
  assert.ok(Math.abs(m.depth - 0.6) < 0.05, `depth ${m.depth}`);
  assert.ok(Math.abs(m.level - 1) < 0.05, `level ${m.level}`);
});

test("a phaser is read off the notches of the clicks", async () => {
  const { measurePhaser } = await import("../src/delay/modulation.ts");
  const p = chorus({ modDepthSeconds: MOD_OFF, dryDb: 0, wetDb: 0, phaserCentre: 600, phaserOctaves: 1.5, phaserFeedback: 0, modRate: 0.8, modPhase: 0 });
  const out = processDelay(clicks(5), p, { ...structure, phaserStages: 4 }, sr);
  const m = measurePhaser({ h: out, period }, sr)!;
  assert.ok(m, "no phaser found");
  assert.equal(m.stages, 4);
  assert.ok(Math.abs(m.rate - 0.8) < 0.03, `rate ${m.rate}`);
  assert.ok(Math.abs(Math.log2(m.centre / 600)) < 0.25, `centre ${m.centre}`);
  assert.ok(Math.abs(m.octaves - 1.5) < 0.3, `octaves ${m.octaves}`);
});
