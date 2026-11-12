import { test } from "node:test";
import assert from "node:assert/strict";
import type { Parameter } from "@vst-cloner/profile";
import { classifyPlugin } from "../src/batch.ts";
import { analyseResponse, compareResponses, predictDelay } from "../src/delay/fit.ts";
import { HP_OFF, LP_OFF, OFF_DB, packDelay, processDelay, unpackDelay, type DelayParams } from "../src/delay/model.ts";
import { delayProbe, detectDelay, echoDb, NotDelayError } from "../src/delay/plan.ts";

const SR = 48000;
const structure = { drySign: 1, wetSign: 1, feedbackSign: 1 };
const params: DelayParams = { delaySeconds: 0.25, dryDb: 0, wetDb: -6, feedbackDb: -6, loopLp: LP_OFF, loopHp: HP_OFF, wetLp: LP_OFF, wetHp: HP_OFF };
const response = (p: DelayParams, s = structure) => processDelay([1], p, s, SR, 3 * SR);

test("delay model: repeats at multiples of the delay, each one feedback quieter", () => {
  const h = response(params);
  assert.equal(h[0], 1);
  assert.ok(Math.abs(h[12000]! - 0.5012) < 1e-3);
  assert.ok(Math.abs(h[24000]! - 0.5012 ** 2) < 1e-3);
  assert.equal(h[6000], 0);
  // fractional delays are interpolated
  const f = response({ ...params, delaySeconds: 100.5 / SR, feedbackDb: OFF_DB });
  assert.ok(Math.abs(f[100]! - f[101]!) < 1e-6 && f[100]! > 0.2);
  // packed values survive the round trip, "off" stays off
  assert.deepEqual(unpackDelay(packDelay(params)).feedbackDb, params.feedbackDb);
  const unfiltered = response(unpackDelay(packDelay(params)));
  assert.ok(compareResponses(unfiltered, h, SR).rmsDb < 1e-6);
});

test("delay analysis recovers time, levels, feedback and filters from an impulse response", () => {
  const plain = analyseResponse(response(params), SR);
  assert.ok(Math.abs(plain.params.delaySeconds - 0.25) < 1e-4);
  assert.ok(Math.abs(plain.params.wetDb + 6) < 0.3 && Math.abs(plain.params.feedbackDb + 6) < 0.3 && Math.abs(plain.params.dryDb) < 0.1);
  assert.ok(plain.echoes >= 4);

  const filtered = { ...params, loopLp: 2000, wetHp: 300, feedbackDb: -3 };
  const found = analyseResponse(response(filtered), SR);
  assert.ok(Math.abs(Math.log(found.params.loopLp / 2000)) < 0.25, `loop low-pass ${found.params.loopLp}`);
  assert.ok(Math.abs(Math.log(found.params.wetHp / 300)) < 0.35, `wet high-pass ${found.params.wetHp}`);
  assert.ok(compareResponses(processDelay([1], found.params, found.structure, SR, 3 * SR), response(filtered), SR).rmsDb < 1.5);

  // inverted repeats
  const inverted = analyseResponse(response(params, { drySign: 1, wetSign: -1, feedbackSign: -1 }), SR);
  assert.deepEqual([inverted.structure.wetSign, inverted.structure.feedbackSign], [-1, -1]);

  // nothing but the dry signal: the rest comes from the fallback, the echo is off
  const dry = analyseResponse(response({ ...params, wetDb: OFF_DB }), SR, params);
  assert.equal(dry.echoes, 0);
  assert.equal(dry.params.wetDb, OFF_DB);
  assert.equal(dry.params.delaySeconds, params.delaySeconds);
});

test("delay tables combine: time controls multiply, levels add in dB", () => {
  const at = (p: Partial<DelayParams>) => packDelay({ ...params, ...p });
  const model = {
    base: params,
    baseValues: [{ index: 0, value: 0.5 }, { index: 1, value: 0.5 }],
    tables: [
      { index: 0, name: "Time", discrete: false, points: [{ value: 0, packed: at({ delaySeconds: 0.125 }) }, { value: 0.5, packed: at({}) }, { value: 1, packed: at({ delaySeconds: 0.5 }) }] },
      { index: 1, name: "Note", discrete: true, points: [{ value: 0.5, packed: at({}) }, { value: 1, packed: at({ delaySeconds: 0.125, wetDb: -12 }) }] },
    ],
  };
  const p = predictDelay(model, new Map([[0, 1], [1, 1]]));
  assert.ok(Math.abs(p.delaySeconds - 0.25) < 1e-9);
  assert.ok(Math.abs(p.wetDb + 12) < 1e-9);
});

const parameter = (index: number, name: string, value = 0.5): Parameter => ({
  index, id: String(index), name, default: value, value, automatable: true, discrete: false, numSteps: 0, meta: false, boolean: false, label: "",
} as unknown as Parameter);

test("delays are recognised by category or name and a time control", () => {
  const named = (...names: string[]) => names.map((n, i) => parameter(i, n));
  const m = detectDelay(named("Time", "Feedback", "LPF", "Dry/Wet"), "Fx|Delay|Mono", "ZamDelay");
  assert.deepEqual([m.roles.time, m.roles.feedback, m.roles.filter, m.roles.mix], [0, 1, 2, 3]);
  assert.ok(detectDelay(named("BPM", "FEEDBACK", "LEVEL"), "Delay Plugin", "Gxdigital_delay"));
  assert.throws(() => detectDelay(named("Time", "Feedback"), "Fx", "Chorus"), NotDelayError);
  assert.throws(() => detectDelay(named("Time", "Feedback"), "Delay Plugin", "PitchedDelay"), NotDelayError);
  assert.throws(() => detectDelay(named("Time", "Feedback"), "Delay Plugin", "GxMultiBandDelay"), NotDelayError);
  assert.throws(() => detectDelay(named("Gain", "Mix"), "Delay Plugin", "Echo"), NotDelayError);
  const plugin = (name: string, category: string) => ({ name, category, isInstrument: false }) as never;
  assert.equal(classifyPlugin({ parameters: named("Time", "Feedback", "Gain", "Threshold", "Attack"), plugin: plugin("Gxduck_delay", "Delay Plugin") }).effectClass, "delay");
});

test("delay probe opens the mix when the initial state has no echo", () => {
  const input = new Float32Array(2 * SR);
  input[100] = 0.5;
  input[SR + 100] = 0.3; // start of the next segment
  const withEcho = new Float32Array(input.length), dryOnly = new Float32Array(input.length);
  withEcho[100] = dryOnly[100] = 0.5;
  withEcho[100 + 12000] = 0.25;
  assert.ok(echoDb(withEcho, input, SR) > -7 && echoDb(dryOnly, input, SR) < -100);
  const probe = delayProbe([parameter(0, "Time"), parameter(1, "Mix", 0)], "Delay Plugin", "Echo")!;
  assert.equal(probe.candidates.length, 5);
  assert.equal(probe.choose([dryOnly, withEcho, withEcho, withEcho, withEcho], input, SR), 1);
  assert.equal(probe.choose([withEcho, withEcho, withEcho, withEcho, withEcho], input, SR), 0);
});
