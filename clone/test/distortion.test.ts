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
