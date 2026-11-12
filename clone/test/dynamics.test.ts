import { test } from "node:test";
import assert from "node:assert/strict";
import type { Parameter } from "@vst-cloner/profile";
import { nelderMead } from "../src/dsp/optimize.ts";
import { BLOCK, simulateGain, staticReduction, type CompressorParams } from "../src/dynamics/model.ts";
import { fitInteraction, fromLatent, pack, predictParams, tableAt, toLatent, type ParamTable } from "../src/dynamics/fit.ts";
import { detectDynamics, NotDynamicsError } from "../src/dynamics/plan.ts";

const params: CompressorParams = {
  thresholdDb: -20, ratio: 4, kneeDb: 6, makeupDb: 0, attack: 0.01, release: 0.1, charge: 0, slow: 4, slowKneeDb: 1, detectorTime: 0, drive: 0, rippleTime: 0.001, ripple: 0,
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
  // "Saturation" contains "ratio" but is not one
  const s = detectDynamics([parameter(0, "Threshold"), parameter(1, "Saturation"), parameter(2, "Comp Ratio"), parameter(3, "Attack")]);
  assert.equal(s.roles.saturation, 1);
  assert.equal(s.roles.ratio, 2);
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

test("interaction: automatic makeup and input gain are found and combine like the original", () => {
  // original: makeup = 0.5 × reduction at 0 dB (threshold and ratio controls), plus an input gain control
  const auto = (p: CompressorParams) => 0.5 * staticReduction(0, p);
  const original = (thresholdDb: number, ratio: number, inputDb: number): CompressorParams => {
    const p = { ...params, thresholdDb, ratio };
    return { ...p, thresholdDb: thresholdDb - inputDb, makeupDb: auto(p) + inputDb };
  };
  const sweep = (index: number, at: (v: number) => CompressorParams): ParamTable => ({
    index, name: String(index), discrete: false,
    points: [0, 0.25, 0.5, 0.75, 1].map((value) => ({ value, packed: pack(at(value)) })),
  });
  const threshold = (v: number) => -40 + 40 * v, ratio = (v: number) => 2 + 8 * v, gain = (v: number) => 24 * v;
  const base = original(threshold(0.5), ratio(0.5), gain(0));
  const tables = [
    sweep(0, (v) => original(threshold(v), ratio(0.5), 0)),
    sweep(1, (v) => original(threshold(0.5), ratio(v), 0)),
    sweep(2, (v) => original(threshold(0.5), ratio(0.5), gain(v))),
  ];
  const interaction = fitInteraction(base, tables);
  assert.equal(interaction.autoMakeup, 0.5);
  assert.deepEqual(tables.map((t) => t.inputGain === true), [false, false, true]);
  const packed = pack(base);
  fromLatent(toLatent(packed, 3, interaction), interaction).forEach((v, i) => assert.ok(v === packed[i] || Math.abs(v - packed[i]!) < 1e-9)); // round trip
  const baseValues = new Map([[0, 0.5], [1, 0.5], [2, 0]]);
  for (const [t, r, g] of [[0, 1, 0], [1, 0, 1], [0.25, 0.75, 0.5]] as const) {
    const predicted = predictParams(base, baseValues, tables, new Map([[0, t], [1, r], [2, g]]), interaction);
    const expected = original(threshold(t), ratio(r), gain(g));
    assert.ok(Math.abs(predicted.thresholdDb - expected.thresholdDb) < 1e-6, `threshold ${predicted.thresholdDb} vs ${expected.thresholdDb}`);
    assert.ok(Math.abs(predicted.ratio - expected.ratio) < 1e-6);
    assert.ok(Math.abs(predicted.makeupDb - expected.makeupDb) < 0.01, `makeup ${predicted.makeupDb} vs ${expected.makeupDb}`);
  }
});

test("dynamics header: parameters with the original's names, tables in clone indices", async () => {
  const { generateDynamicsHeader } = await import("../src/dynamics/codegen.ts");
  const base = { ...params, charge: 1, slowKneeDb: 1 };
  const model = {
    type: "compressor" as const, version: 1 as const, sampleRate: 48000,
    structure: { detector: "rms" as const, topology: "feedforward" as const },
    base, baseValues: [{ index: 3, value: 0.5 }, { index: 7, value: 0 }],
    tables: [
      { index: 3, name: "Peak Reduction", discrete: false, points: [{ value: 0, packed: pack(base) }, { value: 1, packed: pack({ ...base, thresholdDb: -40 }) }] },
      { index: 7, name: "Limit", discrete: true, points: [{ value: 0, packed: pack(base) }, { value: 1, packed: pack({ ...base, ratio: 12 }) }] },
    ],
    report: { structures: [], renders: [] },
  };
  const parameters = [
    { ...parameter(3, "Peak Reduction"), texts: [{ value: 0, text: "0.00" }, { value: 1, text: "100.00" }] },
    { ...parameter(7, "Limit", true), texts: [{ value: 0, text: "Off" }, { value: 1, text: "On" }] },
  ];
  const { header, params: cloneParams } = generateDynamicsHeader(model, parameters, "Test Clone");
  assert.deepEqual(cloneParams.map((p) => [p.name, p.kind]), [["Peak Reduction", "continuous"], ["Limit", "toggle"]]);
  assert.match(header, /vch::Detector::rms/);
  assert.match(header, /\{ 0, false, 2, tableValues0, tablePacked0, 0\.5 \}/);
  assert.match(header, /\{ 1, true, 2, tableValues1, tablePacked1, 0\.0 \}/);
  assert.match(header, /numTables = 2/);
});

test("pchip: passes through the points, stays monotone, no overshoot", async () => {
  const { pchip } = await import("../src/dynamics/fit.ts");
  const xs = [0, 0.15, 0.25, 0.5, 1], ys = [0.6, 4.8, 6.0, 8.7, 12.7];
  xs.forEach((x, i) => assert.ok(Math.abs(pchip(xs, ys, x) - ys[i]!) < 1e-12));
  let previous = -Infinity;
  for (let x = 0; x <= 1; x += 0.01) {
    const y = pchip(xs, ys, x);
    assert.ok(y >= previous - 1e-12 && y >= 0.6 - 1e-12 && y <= 12.7 + 1e-12);
    previous = y;
  }
  // a plateau stays flat (no overshoot between equal values)
  assert.ok(Math.abs(pchip([0, 1, 2, 3], [0, 5, 5, 9], 1.5) - 5) < 1e-12);
});
