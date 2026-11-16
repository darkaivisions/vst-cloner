import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, ClipTable, processDistortion, type DistortionParams } from "../src/distortion/model.ts";
import { packDistortion, unpackDistortion } from "../src/distortion/fit.ts";
import { detectDistortion, NotDistortionError } from "../src/distortion/plan.ts";
import type { Parameter } from "@vst-cloner/profile";

const params: DistortionParams = {
  inputDb: 12, preHp: 80, preBellFreq: 700, preBellDb: -3, preBellQ: 1, preBell2Freq: 200, preBell2Db: 2, preBell2Q: 0.8, preLp: 9000,
  clipPos: 1, clipNeg: 0.8, hardness: 5, railPos: 4, railNeg: 4,
  postBellFreq: 120, postBellDb: 6, postBellQ: 0.6, shelfFreq: 2500, shelfDb: 4, postLp: 12000, postHp: 60, outputDb: -15,
};

test("clipping curve: unity slope at zero, asymmetric limits, monotone", () => {
  assert.ok(Math.abs(clip(1e-4, params) / 1e-4 - 1) < 1e-6);
  assert.ok(Math.abs(clip(100, params) - 1) < 0.01);
  assert.ok(Math.abs(clip(-100, params) + 0.8) < 0.01);
  let previous = -Infinity;
  for (let v = -5; v <= 5; v += 0.01) {
    const y = clip(v, params);
    assert.ok(y > previous);
    previous = y;
  }
  const table = new ClipTable(params);
  for (let v = -3; v <= 3; v += 0.137) assert.ok(Math.abs(table.at(v) - clip(v, params)) < 1e-4);
});

test("distortion model: packing round trip, delay shifts the output", () => {
  const back = unpackDistortion(packDistortion(params));
  for (const [k, v] of Object.entries(params)) assert.ok(Math.abs((back as unknown as Record<string, number>)[k]! - v) < 1e-9, k);
  const signal = new Float32Array(2000).map((_, i) => 0.3 * Math.sin(i / 7));
  const plain = processDistortion(signal, params, 48000);
  const delayed = processDistortion(signal, params, 48000, 32);
  for (let i = 32; i < 2000; i++) assert.ok(Math.abs(delayed[i]! - plain[i - 32]!) < 1e-12);
});

const parameter = (index: number, name: string): Parameter => ({
  index, id: String(index), name, default: 0.5, numSteps: 0x7fffffff, discrete: false, boolean: false, automatable: true,
});

test("distortion plugins are recognised by their controls or category", () => {
  const m = detectDistortion([parameter(0, "LEVEL"), parameter(1, "TONE"), parameter(2, "DRIVE")]);
  assert.equal(m.roles.drive, 2);
  assert.equal(m.roles.tone, 1);
  assert.equal(m.roles.level, 0);
  assert.ok(detectDistortion([parameter(0, "Volume")], "Fx|Distortion"));
  assert.throws(() => detectDistortion([parameter(0, "Frequency")]), NotDistortionError);
});

test("distortion detection: a gain control alone, tools, several bands and built-in modulation are no distortion", () => {
  const names = (...list: string[]) => list.map((name, index) => parameter(index, name));
  // decoders, mixers and tuners have gains too
  assert.throws(() => detectDistortion(names("Bypass", "OutGain"), "Plugin", "ambix_decoder_o5"), NotDistortionError);
  assert.throws(() => detectDistortion(names("Input Gain 0", "Mix 0 0"), "Utility Plugin", "Mixer'n'Trigger"), NotDistortionError);
  assert.throws(() => detectDistortion(names("GAIN", "THRESHOLD", "LEVEL"), "Analyser Plugin", "GxTuner"), NotDistortionError);
  assert.throws(() => detectDistortion(names("Drive", "Decay", "Range", "Freq", "Mix"), "Filter Plugin", "Auto-wah"), NotDistortionError);
  // one drive per band, tape with wow and flutter, amp with tremolo
  assert.throws(() => detectDistortion(names("DRIVE1", "DRIVE2", "DRIVE3", "GAIN"), "Distortion Plugin"), /Mehrband/);
  assert.throws(() => detectDistortion(names("Drive", "WowDepth", "FlutterDepth"), "Filter Plugin", "GxTape"), /Modulation/);
  assert.throws(() => detectDistortion(names("Gain", "Tone", "Volume", "Speed", "Intensity"), "Amplifier Plugin"), /Modulation/);
  // amps by category or name, the drive is the control named so
  assert.equal(detectDistortion(names("MasterGain", "PreGain", "Distortion", "Drive"), "Simulator Plugin").roles.drive, 2);
  assert.ok(detectDistortion(names("InputLevel", "OutputLevel", "GainStages"), "Fx", "Swanky Amp"));
  assert.ok(detectDistortion(names("Pre Amp", "Middle", "Master Volume"), "Amplifier Plugin"));
});

test("distortion detection: drive control or category, other effect classes excluded", async () => {
  const { detectDistortion } = await import("../src/distortion/plan.ts");
  const { detectDynamics } = await import("../src/dynamics/plan.ts");
  const param = (index: number, name: string) =>
    ({ index, id: String(index), name, default: 0.5, numSteps: 0, discrete: false, boolean: false, automatable: true, meta: false }) as unknown as import("@vst-cloner/profile").Parameter;
  const pedal = [param(0, "DRIVE"), param(1, "TONE"), param(2, "LEVEL")];
  assert.deepEqual(detectDistortion(pedal, "Distortion Plugin").roles, { drive: 0, tone: 1, level: 2 });
  assert.throws(() => detectDistortion([param(0, "Drive"), param(1, "Feedback"), param(2, "Time")], "Delay Plugin"));
  assert.throws(() => detectDistortion([param(0, "Mix")], ""));
  const ducker = [param(0, "Threshold"), param(1, "Release"), param(2, "Time")];
  assert.ok(detectDynamics(ducker));
  assert.throws(() => detectDynamics(ducker, "Delay Plugin"));
});

test("distortion probe: a silent initial state gets a working point, a sounding one keeps it", async () => {
  const { distortionProbe } = await import("../src/distortion/plan.ts");
  const { silentObservation } = await import("../src/distortion/fit.ts");
  const probe = distortionProbe([parameter(0, "DRIVE"), parameter(1, "FUZZ"), parameter(2, "LEVEL")], "Distortion Plugin")!;
  // initial state, each drive-like control on its own and both together, at 0.75 and at 1
  assert.deepEqual(probe.candidates.map((c) => c.map((v) => `${v.index}=${v.value}`).join(",")),
    ["", "0=0.75", "1=0.75", "0=0.75,1=0.75", "0=1", "1=1", "0=1,1=1"]);
  const input = new Float32Array(48000).map((_, i) => 0.3 * Math.sin(i / 5));
  const scaled = (gainDb: number) => input.map((v) => v * 10 ** (gainDb / 20));
  // a switch-on thump in the first part does not count as sound
  const thump = new Float32Array(48000).map((_, i) => (i < 9600 ? 0.5 * Math.exp(-i / 2000) : 0));
  const pick = (gains: number[], first = scaled(gains[0]!)) => probe.choose([first, ...gains.slice(1).map(scaled)], input, 48000);
  assert.equal(pick([-6, -3, 0, 0, 0, 0, 0]), 0);
  assert.equal(pick([-200, -80, -20, -10, -30, -5, 0], thump), 2);
  assert.equal(pick([-200, -80, -60, -50, -45, -35, -30]), 6);
  assert.equal(pick([-200, -200, -200, -200, -200, -200, -200]), 0);
  assert.equal(distortionProbe([parameter(0, "Frequency")]), undefined);

  const step = (levelDb: number, gainDb: number) => ({ frequency: 1000, levelDb, gainDb, harmonicsDb: [] });
  assert.ok(silentObservation({ steps: [step(-30, -160), step(-6, -150)] }));
  assert.ok(!silentObservation({ steps: [step(-30, -160), step(-6, -20)] }));
});
