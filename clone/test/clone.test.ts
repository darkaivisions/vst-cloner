import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTestSignal } from "@vst-cloner/capture";
import { encodeWav, type CaptureRender, type Parameter, type Profile } from "@vst-cloner/profile";
import {
  analogMagnitudeSquared,
  bandSections,
  butterworthQs,
  buildPlugin,
  cascadeDb,
  classifyShape,
  cppString,
  detectEq,
  digitize,
  fitEq,
  generateModelHeader,

  parseSlope,
  parseValue,
  planEq,
  prototypes,
  tableNorm,
  tableValue,
  verifyClone,
  type DigitalSection,
  type ShapeFit,
} from "../src/index.ts";

const SR = 48000;
const dbAt = (sections: DigitalSection[], f: number) => cascadeDb(sections, SR, new Float64Array([f]))[0]!;

test("butterworth section Qs for even and odd orders", () => {
  assert.deepEqual(butterworthQs(2).qs.map((q) => q.toFixed(4)), ["0.7071"]);
  assert.deepEqual(butterworthQs(3), { qs: [butterworthQs(3).qs[0]!], firstOrder: true });
  assert.equal(butterworthQs(3).qs[0]!.toFixed(4), "1.0000");
  assert.deepEqual(butterworthQs(4).qs.map((q) => q.toFixed(3)), ["0.541", "1.307"]);
  assert.deepEqual(butterworthQs(5).qs.map((q) => q.toFixed(3)), ["0.618", "1.618"]);
});

test("bell peaks at its gain for both designs", () => {
  for (const design of ["bilinear", "matched"] as const) {
    const s = [digitize(prototypes.bell(1000, 12, 1), design, SR)];
    assert.ok(Math.abs(dbAt(s, 1000) - 12) < 0.05, `${design}: ${dbAt(s, 1000)}`);
    assert.ok(Math.abs(dbAt(s, 20)) < 0.1);
  }
});

test("matched design avoids cramping near Nyquist", () => {
  const analog = prototypes.bell(15000, 12, 2);
  const analogDb = (f: number) => 10 * Math.log10(analogMagnitudeSquared(analog, f / 15000));
  const matched = [digitize(analog, "matched", SR)];
  const bilinear = [digitize(analog, "bilinear", SR)];
  for (const f of [12000, 17000, 19000]) {
    assert.ok(Math.abs(dbAt(matched, f) - analogDb(f)) < 1, `matched follows the analog prototype at ${f} Hz`);
    assert.ok(Math.abs(dbAt(bilinear, f) - analogDb(f)) > 3, `bilinear is cramped at ${f} Hz`);
  }
});

test("matched high-pass keeps a 12 dB/oct slope", () => {
  const s = [digitize(prototypes.highPass2(1000, Math.SQRT1_2), "matched", SR)];
  const slope = dbAt(s, 100) - dbAt(s, 50);
  assert.ok(Math.abs(slope - 12) < 0.2, `slope ${slope}`);
  assert.ok(Math.abs(dbAt(s, 1000) + 3.01) < 0.1);
});

test("display values and labels are parsed", () => {
  assert.deepEqual(parseValue("1219.8 Hz"), { value: 1219.8, unit: "Hz" });
  assert.deepEqual(parseValue("2.5 kHz"), { value: 2500, unit: "Hz" });
  assert.deepEqual(parseValue("+6.00 dB"), { value: 6, unit: "dB" });
  assert.equal(parseValue("-INF dB")!.value, -Infinity);
  assert.equal(classifyShape("Low Shelf"), "lowShelf");
  assert.equal(classifyShape("High Cut"), "highCut");
  assert.equal(classifyShape("Peak"), "bell");
  assert.equal(classifyShape("Flat Tilt"), "unsupported");
  assert.deepEqual(parseSlope("24 dB/oct"), { label: "24 dB/oct", order: 4, approximate: false });
  assert.equal(parseSlope("Brickwall").approximate, true);
});

// ---- synthetic plugin ------------------------------------------------------------------------

const freqOf = (n: number) => 10 * 3000 ** n;
const qOf = (n: number) => 0.1 * 100 ** n;
const gainOf = (n: number) => -30 + 60 * n;
const SHAPES = ["Bell", "Low Shelf", "High Cut"];
const SLOPES = ["12 dB/oct", "24 dB/oct"];

/** How the simulated plugin really works (unknown to the fit). */
const TRUTH: Record<string, ShapeFit> = {
  Bell: { design: "matched", freqScale: 1, qScale: Math.SQRT1_2 },
  "Low Shelf": { design: "matched", freqScale: 1, qScale: Math.SQRT1_2, qExponent: 0.5 },
  "High Cut": { design: "matched", freqScale: 1, qScale: Math.SQRT1_2, qMode: "scaleLast" },
};
const KIND = { Bell: "bell", "Low Shelf": "lowShelf", "High Cut": "highCut" } as const;

function texts(f: (n: number) => string, count = 11) {
  return Array.from({ length: count }, (_, i) => ({ value: i / (count - 1), text: f(i / (count - 1)) }));
}

function syntheticParameters(): Parameter[] {
  const params: Parameter[] = [];
  const add = (p: Omit<Parameter, "index" | "id" | "automatable" | "boolean">) =>
    params.push({ index: params.length, id: String(params.length), automatable: true, boolean: p.numSteps === 2, ...p });
  for (const band of [1, 2]) {
    add({ name: `Band ${band} Used`, default: 0, value: 0, numSteps: 2, discrete: true, texts: [{ value: 0, text: "Unused" }, { value: 1, text: "Used" }] });
    add({ name: `Band ${band} Frequency`, default: 0.5, value: 0.5, numSteps: 2147483647, discrete: false, texts: texts((n) => `${freqOf(n).toFixed(1)} Hz`) });
    add({ name: `Band ${band} Gain`, default: 0.5, value: 0.5, numSteps: 2147483647, discrete: false, texts: texts((n) => `${gainOf(n).toFixed(2)} dB`) });
    add({ name: `Band ${band} Q`, default: 0.5, value: 0.5, numSteps: 2147483647, discrete: false, texts: texts((n) => qOf(n).toFixed(3)) });
    add({ name: `Band ${band} Shape`, default: 0, value: 0, numSteps: 3, discrete: true, texts: SHAPES.map((text, i) => ({ value: i / 2, text })) });
    add({ name: `Band ${band} Slope`, default: 0, value: 0, numSteps: 2, discrete: true, texts: SLOPES.map((text, i) => ({ value: i, text })) });
  }
  add({ name: "Bypass", default: 0, value: 0, numSteps: 2, discrete: true, texts: [{ value: 0, text: "Off" }, { value: 1, text: "On" }] });
  return params;
}

function filterSignal(input: Float32Array, sections: DigitalSection[]): Float32Array {
  let x = Float64Array.from(input);
  for (const s of sections) {
    const y = new Float64Array(x.length);
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < x.length; i++) {
      const out = s.b0 * x[i]! + z1;
      z1 = s.b1 * x[i]! - s.a1 * out + z2;
      z2 = s.b2 * x[i]! - s.a2 * out;
      y[i] = out;
    }
    x = y;
  }
  return Float32Array.from(x);
}

function syntheticProfile(): Profile {
  const parameters = syntheticParameters();
  const plan = planEq(parameters, { seed: 7 });
  const signal = generateTestSignal({ sampleRate: SR, channels: 1, preset: "eq" });
  const files = new Map<string, Uint8Array>();
  const renders: CaptureRender[] = [];
  const at = (values: Map<number, number>, index: number) => values.get(index) ?? parameters[index]!.value!;

  for (const r of plan.renders) {
    const values = new Map(r.params.map((p) => [p.index, p.value]));
    const used = at(values, 0) > 0.5;
    const shape = SHAPES[Math.round(at(values, 4) * 2)]!;
    const settings = {
      kind: KIND[shape as keyof typeof KIND],
      frequency: freqOf(at(values, 1)),
      gainDb: gainOf(at(values, 2)),
      q: qOf(at(values, 3)),
      order: at(values, 5) > 0.5 ? 4 : 2,
    };
    const sections = used ? bandSections(settings, TRUTH[shape]!, SR) : [];
    const file = `captures/${r.id}.wav`;
    files.set(file, encodeWav({ sampleRate: SR, channels: [filterSignal(signal.audio.channels[0]!, sections)] }));
    renders.push({
      id: r.id, file, kind: r.kind, ...(r.purpose ? { purpose: r.purpose } : {}), ...(r.label ? { label: r.label } : {}),
      params: r.params.map((p) => {
        const param = parameters[p.index]!;
        const text = param.discrete ? param.texts![Math.round(p.value * (param.numSteps - 1))]!.text : p.index % 6 === 1
          ? `${freqOf(p.value).toFixed(1)} Hz` : p.index % 6 === 2 ? `${gainOf(p.value).toFixed(2)} dB` : qOf(p.value).toFixed(3);
        return { ...p, text };
      }),
      latencySamples: 0, peak: 1, mono: true,
    });
  }

  return {
    manifest: {
      format: "vcprofile", schemaVersion: 1, id: "synthetic", createdAt: new Date().toISOString(),
      generator: { name: "test", version: "0" },
      plugin: { name: "Synthetic EQ", manufacturer: "Test", version: "1", format: "VST3", identifier: "synthetic" },
      capture: { host: { name: "test", version: "0" }, os: "test", sampleRate: SR, blockSize: 512, channels: 1, prerollSeconds: 0, tailSeconds: 0.25 },
    },
    parameters: { parameters },
    testSignals: signal.set,
    captures: { renders },
    files,
  };
}

test("EQ detection and display tables", () => {
  const mapping = detectEq(syntheticParameters());
  assert.equal(mapping.bands.length, 2);
  assert.equal(mapping.templateBand, 1);
  assert.deepEqual(mapping.shapes!.map((s) => s.kind), ["bell", "lowShelf", "highCut"]);
  const table = mapping.tables[1]!;
  assert.equal(table.log, true);
  assert.ok(Math.abs(tableValue(table, 0.5) - freqOf(0.5)) / freqOf(0.5) < 0.01);
  assert.ok(Math.abs(tableNorm(table, 1000) - Math.log(100) / Math.log(3000)) < 0.005);
});

test("EQ plan switches other bands off and covers every shape", () => {
  const plan = planEq(syntheticParameters(), { seed: 1 });
  const renders = plan.renders.filter((r) => r.purpose);
  assert.ok(renders.every((r) => r.params.some((p) => p.index === 6 && p.value === 0)), "band 2 off");
  assert.ok(renders.every((r) => r.params.some((p) => p.index === 0 && p.value === 1)), "band 1 on");
  for (const shape of SHAPES) assert.ok(renders.some((r) => r.label!.startsWith(shape)), shape);
  assert.ok(renders.some((r) => r.purpose === "validate"));
});

test("fit recovers the hidden filter conventions of a synthetic EQ", () => {
  const model = fitEq(syntheticProfile());
  for (const r of model.report.shapes) {
    assert.ok(r.train && r.train.rmsDb < 0.05, `${r.label} train ${r.train?.rmsDb}`);
    assert.ok(r.validate && r.validate.rmsDb < 0.1, `${r.label} validate ${r.validate?.rmsDb}`);
  }
  const bell = model.shapes.find((s) => s.label === "Bell")!.fit!;
  assert.ok(Math.abs(bell.qScale - Math.SQRT1_2) < 0.01, `bell qScale ${bell.qScale}`);
  const shelf = model.shapes.find((s) => s.label === "Low Shelf")!.fit!;
  assert.ok(Math.abs((shelf.qExponent ?? 1) - 0.5) < 0.05, `shelf exponent ${shelf.qExponent}`);
});

test("model header contains all parameters and escapes text", () => {
  const profile = syntheticProfile();
  const model = fitEq(profile);
  const { header, params } = generateModelHeader(model, profile.parameters.parameters, "Grün EQ");
  assert.equal(params.length, 12, "2 bands × (used, freq, gain, q, shape, slope)");
  assert.match(header, /numBands = 2;/);
  assert.match(header, /slopeOrders\[\] = \{ 2, 4 \}/);
  assert.equal(cppString('a"b\\'), '"a\\"b\\\\"');
  assert.equal(cppString("ü"), '"\\xc3""\\xbc"""');
});

// Builds the JUCE plugin and checks that the C++ engine matches the TypeScript model: VCH_TEST_BUILD=1 npm test
test("built clone matches the model", { skip: process.env.VCH_TEST_BUILD ? false : "set VCH_TEST_BUILD=1", timeout: 900000 }, async () => {
  const profile = syntheticProfile();
  const model = fitEq(profile);
  const out = await mkdtemp(join(tmpdir(), "vch-clone-test-"));
  try {
    const { header } = generateModelHeader(model, profile.parameters.parameters, "vch test clone");
    const build = await buildPlugin({ pluginName: "vch test clone", modelHeader: header, outputDir: out, log: () => {} });
    assert.ok(existsSync(build.vst3) && existsSync(build.lv2));
    const report = await verifyClone(profile, model, build.vst3, { log: () => {} });
    assert.ok(report.engineMaxDb < 0.1, `engine differs from model by ${report.engineMaxDb} dB (${report.engineWorst})`);
    assert.ok(report.overall.rmsDb < 0.1, `clone vs synthetic original ${report.overall.rmsDb}`);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});


test("gui labels: parameter names are prettified and fitted to the measured text width", async () => {
  const { prettifyName, fitLabel } = await import("../src/gui/analyze.ts");
  assert.equal(prettifyName("Output dB"), "Output dB");
  assert.equal(prettifyName("SpreadEnabled"), "Spread Enabled");
  assert.equal(prettifyName("Band 3 Frequency"), "Frequency");
  const counts = new Map([["tone", 3], ["bass", 1], ["input", 1], ["level", 2]]);
  assert.equal(fitLabel("Tone Bass", 26, 10, false, counts), "Bass");
  assert.equal(fitLabel("Input Level", 32, 10, false, counts), "Input");
  assert.equal(fitLabel("Limit", 127, 56, false), "Limit");
  assert.equal(fitLabel("Limit", 300, 12, false), undefined);
});
