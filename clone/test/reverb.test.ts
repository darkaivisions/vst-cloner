import { test } from "node:test";
import assert from "node:assert/strict";
import type { Parameter } from "@vst-cloner/profile";
import { classifyPlugin } from "../src/batch.ts";
import { compareReverbs, describeResponse, fitReverbParams, predictReverb } from "../src/reverb/fit.ts";
import { packReverb, processReverb, REVERB_OFF_DB, unpackReverb, type ReverbParams } from "../src/reverb/model.ts";
import { detectReverb, NotReverbError } from "../src/reverb/plan.ts";

const SR = 48000;
const input = { sampleRate: SR, start: 0, length: 4 * SR, amplitude: 1 };
const structure = { drySign: 1 };
const params: ReverbParams = { predelaySeconds: 0.02, dryDb: -6, gainDb: [-25, -22, -30], rt: [1.2, 1.0, 0.6] };
const describe = (p: ReverbParams) => describeResponse(processReverb([1], p, structure, SR, input.length), SR);

test("reverb model: dry level, a tail after the pre-delay, decay times per band", () => {
  const h = processReverb([1], params, structure, SR, input.length);
  assert.ok(Math.abs(h[0]! - 10 ** (-6 / 20)) < 1e-6);
  // nothing before pre-delay + shortest line
  assert.ok(h.slice(1, 960 + 148).every((v) => v === 0));
  const d = describe(params);
  assert.ok(Math.abs(d.dryDb + 6) < 0.01);
  // the bands leak into each other, so the decay times are only roughly those of the network
  d.rt.forEach((rt, b) => assert.ok(Math.abs(Math.log(rt / params.rt[b]!)) < 0.35, `band ${b}: ${rt}`));
  assert.ok(d.rt[0] > d.rt[2]);
  // the two channels carry different tails of the same level
  const other = describeResponse(processReverb([1], params, structure, SR, input.length, 1), SR);
  assert.ok(Math.abs(other.levelDb[1] - d.levelDb[1]) < 1.5);
  // packed values survive the round trip; "off" stays off
  assert.deepEqual(unpackReverb(packReverb(params)).gainDb, params.gainDb);
  assert.equal(describe({ ...params, gainDb: [REVERB_OFF_DB, REVERB_OFF_DB, REVERB_OFF_DB] }).levelDb[1], REVERB_OFF_DB);
});

test("reverb fit sets the model so that its own response shows the measured levels and decay times", () => {
  const measured = describe({ predelaySeconds: 0.06, dryDb: -3, gainDb: [-20, -28, -24], rt: [2.0, 1.4, 0.5] });
  const fit = fitReverbParams(measured, input);
  const got = describe(fit.params);
  got.levelDb.forEach((l, b) => assert.ok(Math.abs(l - measured.levelDb[b]!) < 0.5, `level ${b}: ${l} vs ${measured.levelDb[b]}`));
  got.rt.forEach((rt, b) => assert.ok(Math.abs(Math.log(rt / measured.rt[b]!)) < 0.1, `rt ${b}: ${rt} vs ${measured.rt[b]}`));
  assert.ok(compareReverbs(got, measured).rmsDb < 1);
  assert.ok(compareReverbs(describe(params), measured).rmsDb > 3);
  // no tail: the model is switched off, decay times come from the fallback
  const dry = fitReverbParams(describe({ ...params, gainDb: [REVERB_OFF_DB, REVERB_OFF_DB, REVERB_OFF_DB] }), input, params);
  assert.deepEqual(dry.params.gainDb, [REVERB_OFF_DB, REVERB_OFF_DB, REVERB_OFF_DB]);
  assert.deepEqual(dry.params.rt, params.rt);
});

test("reverb tables combine: decay times multiply, levels add in dB", () => {
  const at = (p: Partial<ReverbParams>) => packReverb({ ...params, ...p });
  const model = {
    base: params,
    baseValues: [{ index: 0, value: 0.5 }, { index: 1, value: 0 }],
    tables: [
      { index: 0, name: "Decay", discrete: false, points: [{ value: 0, packed: at({ rt: [0.6, 0.5, 0.3] }) }, { value: 0.5, packed: at({}) }, { value: 1, packed: at({ rt: [2.4, 2.0, 1.2] }) }] },
      { index: 1, name: "Wet", discrete: false, points: [{ value: 0, packed: at({}) }, { value: 1, packed: at({ gainDb: [-19, -16, -24] }) }] },
    ],
  };
  const p = predictReverb(model, new Map([[0, 1], [1, 1]]));
  assert.ok(Math.abs(p.rt[1] - 2.0) < 1e-9);
  assert.ok(Math.abs(p.gainDb[1] + 16) < 1e-9);
});

const parameter = (index: number, name: string): Parameter => ({
  index, id: String(index), name, default: 0.5, value: 0.5, automatable: true, discrete: false, numSteps: 0, meta: false, boolean: false, label: "",
} as unknown as Parameter);

test("reverbs are recognised by category or name", () => {
  const named = (...names: string[]) => names.map((n, i) => parameter(i, n));
  assert.equal(detectReverb(named("Decay", "Mix"), "Fx|Reverb", "MVerb").mix, 1);
  assert.ok(detectReverb(named("fb1", "damp"), "Fx|Reverb", "MaFreeverb"));
  assert.throws(() => detectReverb(named("Decay"), "Fx", "Compressor"), NotReverbError);
  assert.throws(() => detectReverb(named("Gain"), "Reverb Plugin", "x42 - IR Convolver Mono"), NotReverbError);
  assert.throws(() => detectReverb(named("Decay"), "Reverb Plugin", "GxMultiBandReverb"), NotReverbError);
  const plugin = (name: string, category: string) => ({ name, category, isInstrument: false }) as never;
  assert.equal(classifyPlugin({ parameters: named("Decay", "Gain", "Threshold", "Attack"), plugin: plugin("Hall", "Fx|Reverb") }).effectClass, "reverb");
});
