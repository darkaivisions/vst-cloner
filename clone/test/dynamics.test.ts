import { test } from "node:test";
import assert from "node:assert/strict";
import type { Parameter } from "@vst-cloner/profile";
import { nelderMead } from "../src/dsp/optimize.ts";
import { BLOCK, simulateGain, staticReduction, type CompressorParams } from "../src/dynamics/model.ts";
import { pack, predictParams, tableAt, type ParamTable } from "../src/dynamics/fit.ts";
import { detectDynamics, NotDynamicsError } from "../src/dynamics/plan.ts";

const params: CompressorParams = {
  thresholdDb: -20, ratio: 4, kneeDb: 6, makeupDb: 0, attack: 0.01, release: 0.1, charge: 0, slow: 4, slowKneeDb: 1,
};

test("static curve: no reduction below the knee, slope 1 − 1/ratio above, continuous knee", () => {
  assert.equal(staticReduction(-40, params), 0);
  assert.ok(Math.abs(staticReduction(0, params) - 15) < 1e-9); // 20 dB over threshold at 4:1
  const below = staticReduction(-23 - 1e-6, params), above = staticReduction(-23 + 1e-6, params);
  assert.ok(Math.abs(below - above) < 1e-5);
  const edge = staticReduction(-17 - 1e-6, params), past = staticReduction(-17 + 1e-6, params);
  assert.ok(Math.abs(edge - past) < 1e-5);
});

test("gain computer: attack reaches the static value, release returns to zero", () => {
  const sr = 48000, blocks = Math.round(sr / BLOCK);
  const levels = new Float64Array(blocks * 2).fill(-60);
  levels.fill(0, 0, blocks); // 1 s at 0 dB, then 1 s quiet
  const gains = simulateGain(levels, params, { detector: "rms", topology: "feedforward" }, sr);
  assert.ok(Math.abs(gains[blocks - 1]! + 15) < 0.01);
  assert.ok(Math.abs(gains[2 * blocks - 1]!) < 0.01);
  // one attack time constant: 63 % of the way
  const tau = Math.round((0.01 * sr) / BLOCK);
  assert.ok(Math.abs(gains[tau - 1]! / -15 - 0.63) < 0.05);
});

test("nelder–mead finds the minimum of a shifted quadratic", () => {
  const r = nelderMead((x) => (x[0]! - 3) ** 2 + 10 * (x[1]! + 1) ** 2, [0, 0]);
  assert.ok(Math.abs(r.x[0]! - 3) < 1e-3 && Math.abs(r.x[1]! + 1) < 1e-3);
});

const parameter = (index: number, name: string, discrete = false): Parameter => ({
  index, id: String(index), name, default: 0.5, numSteps: discrete ? 2 : 0x7fffffff, discrete, boolean: discrete, automatable: true,
});

test("compressors are recognised by their parameter names", () => {
  const m = detectDynamics([parameter(0, "Peak Reduction"), parameter(1, "Gain"), parameter(2, "Limit", true), parameter(3, "Bypass", true)]);
  assert.equal(m.roles.reduction, 0);
  assert.equal(m.roles.makeup, 1);
  assert.equal(m.roles.limit, 2);
  assert.throws(() => detectDynamics([parameter(0, "Frequency"), parameter(1, "Gain")]), NotDynamicsError);
});

test("parameter tables: base values reproduce the base model, changes add up", () => {
  const table = (index: number, change: Partial<CompressorParams>): ParamTable => ({
    index, name: String(index), discrete: false,
    points: [{ value: 0, packed: pack(params) }, { value: 1, packed: pack({ ...params, ...change }) }],
  });
  const tables = [table(0, { thresholdDb: -40 }), table(1, { makeupDb: 10 })];
  const baseValues = new Map([[0, 0], [1, 0]]);
  assert.deepEqual(tableAt(tables[0]!, 0.5)[0], -30);
  const same = predictParams(params, baseValues, tables, new Map());
  assert.ok(Math.abs(same.thresholdDb + 20) < 1e-9 && Math.abs(same.makeupDb) < 1e-9);
  const both = predictParams(params, baseValues, tables, new Map([[0, 1], [1, 1]]));
  assert.ok(Math.abs(both.thresholdDb + 40) < 1e-9 && Math.abs(both.makeupDb - 10) < 1e-9);
});
