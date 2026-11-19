import { test } from "node:test";
import assert from "node:assert/strict";
import type { Parameter } from "@vst-cloner/profile";
import { DEFAULT_PLAN } from "@vst-cloner/capture";
import { MAX_NEURAL_CONTROLS, NEURAL_SURVEY_POINTS, neuralControls, neuralRenderCounts, neuralSurvey, outputPositions, planNeural } from "../src/neural/plan.ts";
import { generateNeuralHeader, type NeuralModel } from "../src/neural/codegen.ts";
import { formatNeuralVerify, neuralReportVerdict, neuralVerdict } from "../src/neural/workflow.ts";
import { median } from "../src/neural/verify.ts";

const parameter = (index: number, name: string, extra: Partial<Parameter> = {}): Parameter => ({
  index, id: String(index), name, default: 0.5, numSteps: 0x7fffffff, discrete: false, boolean: false, automatable: true, ...extra,
});

test("universal plan: every setting moves all controls, the cross-check uses settings of its own", () => {
  const parameters = [parameter(0, "Drive"), parameter(1, "Mode", { discrete: true, numSteps: 3 }), parameter(2, "Bypass"), parameter(3, "Meter", { meta: true })];
  const plan = planNeural(parameters, { ...DEFAULT_PLAN });
  assert.deepEqual(plan.selected.map((p) => p.index), [0, 1]);
  const counts = neuralRenderCounts(2);
  assert.equal(plan.renders.length, 1 + counts.train + counts.validate);
  assert.equal(plan.renders[0]!.kind, "default");
  const random = plan.renders.filter((r) => r.kind === "random");
  for (const r of random) assert.deepEqual(r.params.map((p) => p.index), [0, 1]);
  // discrete controls take one of their steps
  for (const r of random) assert.ok([0, 0.5, 1].includes(r.params[1]!.value));
  const key = (r: (typeof random)[number]) => r.params.map((p) => p.value.toFixed(6)).join(",");
  const train = new Set(random.filter((r) => r.purpose === "train").map(key));
  assert.ok(random.filter((r) => r.purpose === "validate").every((r) => !train.has(key(r))));
  // same seed, same plan
  assert.deepEqual(planNeural(parameters, { ...DEFAULT_PLAN }).renders, plan.renders);
});

test("universal plan: the number of controls is capped, more controls get more settings", () => {
  const many = Array.from({ length: 40 }, (_, i) => parameter(i, `P${i}`));
  assert.equal(neuralControls(many).length, MAX_NEURAL_CONTROLS);
  assert.ok(neuralRenderCounts(8).train > neuralRenderCounts(1).train);
  assert.ok(neuralRenderCounts(100).train <= 400);
});

test("universal survey: a control reported as continuous that moves in steps is found, a continuous one is not", () => {
  const xs = Array.from({ length: NEURAL_SURVEY_POINTS }, (_, i) => i / (NEURAL_SURVEY_POINTS - 1));
  const signal = (gain: number) => Float32Array.from({ length: 256 }, (_, i) => gain * Math.sin(i * 0.3));
  // a selector with three positions: below 0.3, up to 0.6, above
  const selector = xs.map((x) => signal(x < 0.3 ? 1 : x <= 0.6 ? 0.2 : 3));
  const found = outputPositions(xs, selector)!;
  assert.equal(found.values.length, 3);
  assert.ok(found.bounds[0]![1] < 0.3 && found.bounds[1]![0] >= 0.3 && found.bounds[2]![0] > 0.6);
  // a gain knob, also with a flat stretch at the bottom where it is off
  assert.equal(outputPositions(xs, xs.map((x) => signal(0.1 + x))), undefined);
  assert.equal(outputPositions(xs, xs.map((x) => signal(Math.max(0, x - 0.3)))), undefined);
  // the survey sets each continuous control at every point; the plan then picks positions at random
  const parameters = [parameter(0, "Type"), parameter(1, "Mode", { discrete: true, numSteps: 3 })];
  const survey = neuralSurvey(parameters, { ...DEFAULT_PLAN })!;
  assert.equal(survey.renders.length, NEURAL_SURVEY_POINTS);
  const steps = survey.evaluate(selector, new Float32Array(256), 48000);
  assert.deepEqual(steps.map((s) => s.index), [0]);
  const plan = planNeural(parameters, { ...DEFAULT_PLAN, steps });
  const types = new Set(plan.renders.filter((r) => r.kind === "random").map((r) => r.params[0]!.value));
  assert.deepEqual([...types].sort(), [...steps[0]!.values].sort());
});

test("universal clone header: weights in the engine's layout, conditioning inputs mapped to clone parameters", () => {
  const H = 2;
  const model: NeuralModel = {
    sampleRate: 48000, parameters: [3], names: ["Drive"], hidden: H, inputs: 2, outputs: 1,
    lstm: {
      W: [[1, 2, 3, 4, 5, 6, 7, 8], [10, 20, 30, 40, 50, 60, 70, 80]],
      U: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8]],
      b: [0, 0, 0, 0, 0, 0, 0, 0],
    },
    dense: { W: [[0.5, -0.5]], b: [0.25] },
    film: { W1: [[1], [2]], b1: [0, 0], W2: [[1, 0], [0, 1], [1, 1], [0, 0], [0.5, 0.5]], b2: [1, 1, 0, 0, 1] },
  };
  const { header, params } = generateNeuralHeader(model, [parameter(3, "Drive")], "Test");
  assert.equal(params.length, 1);
  assert.match(header, /hidden = 2;/);
  assert.match(header, /numConditions = 1;/);
  assert.match(header, /conditionParams\[1\] = \{ 0 \}/);
  assert.match(header, /lstmWx\[8\] = \{ 1\.0, 2\.0, 3\.0/);
  assert.match(header, /lstmWc\[8\] = \{ 10\.0, 20\.0/);
  // U stays hidden-major: the weights of h0 to all gates, then those of h1
  assert.match(header, /lstmU\[16\] = \{ 0\.10000000149011\d*, 0\.20000000298023\d*/);
  assert.match(header, /filmW2\[10\]/);
  // a model from before the level row keeps 0 dB; one with it switches the gain on
  assert.match(header, /filmLevel = false;/);
  const leveled = generateNeuralHeader({ ...model, film: { ...model.film, W2: [...model.film.W2, [0.1, 0.1]], b2: [...model.film.b2, 0] } }, [parameter(3, "Drive")], "Test");
  assert.match(leveled.header, /filmLevel = true;/);
  // a stepped control is snapped to the middle of its position before the network sees it
  assert.match(header, /snapCondition \(int condition, float value\)\n\{\n    \(void\) condition;/);
  const stepped = generateNeuralHeader({ ...model, positions: [{ values: [0.1, 0.6], bounds: [[0, 0.2], [0.5, 1]] }] }, [parameter(3, "Drive")], "Test");
  assert.match(stepped.header, /case 0:[\s\S]*mid\[\] = \{ 0\.10000000149011\d*f, 0\.60000002384185\d*f \}[\s\S]*snapPosition \(lo, hi, mid, 2, value\)/);
  assert.throws(() => generateNeuralHeader({ ...model, film: { ...model.film, W2: model.film.W2.slice(1) } }, [parameter(3, "Drive")], "Test"), /FiLM output/);
  assert.throws(() => generateNeuralHeader({ ...model, parameters: [3, 4] }, [parameter(3, "Drive"), parameter(4, "Tone")], "Test"), /LSTM input weights/);
});

test("universal clone rating: thresholds on the error share", () => {
  assert.equal(neuralVerdict(0.005), "excellent");
  assert.equal(neuralVerdict(0.04), "good");
  assert.equal(neuralVerdict(0.5), "inaccurate");
});

test("the verdict follows the typical setting, the mean and the outliers are reported", () => {
  assert.equal(median([0.3, 0.01, 0.02]), 0.02);
  assert.equal(median([0.01, 0.02, 0.03, 10]), 0.025);
  const report = { clone: "x", renders: 4, esr: 2.5, median: 0.025, outliers: 1, worst: [{ label: "setting 3", esr: 10 }] };
  assert.equal(neuralReportVerdict(report), "very good");
  assert.equal(neuralReportVerdict({ esr: 0.2 }), "inaccurate");
  const text = formatNeuralVerify(report).join("\n");
  assert.match(text, /typical setting 2\.50 %/);
  assert.match(text, /mean 250\.0 % \(4\.0 dB\); 1 setting off by half the signal or more/);
});
