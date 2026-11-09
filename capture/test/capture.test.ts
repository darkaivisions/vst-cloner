import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfile, type Parameter } from "@vst-cloner/profile";
import { capture } from "../src/capture.ts";
import { DEFAULT_PLAN, PlanTooLargeError, planCaptures, resolveFixedValues, sweepValues } from "../src/plan.ts";
import { generateTestSignal, regenerateTestSignal } from "../src/signals.ts";

const continuous = (index: number, name: string, value = 0.5): Parameter => ({
  index, id: String(index), name, default: value, value, numSteps: 2147483647, discrete: false, boolean: false, automatable: true,
});

const stepped = (index: number, name: string, steps: number, texts: string[] = []): Parameter => ({
  index, id: String(index), name, default: 0, value: 0, numSteps: steps, discrete: true, boolean: steps === 2, automatable: true,
  texts: texts.map((text, i) => ({ value: i / (texts.length - 1), text })),
});

test("test signal is deterministic and regenerable", () => {
  const a = generateTestSignal({ sampleRate: 48000, channels: 2 });
  const b = generateTestSignal({ sampleRate: 48000, channels: 2 });
  assert.equal(a.set.sha256, b.set.sha256);
  assert.equal(regenerateTestSignal(a.set).verified, true);
  assert.equal(a.audio.channels.length, 2);
  assert.equal(a.audio.channels[0]!.length, a.set.length);

  const other = generateTestSignal({ sampleRate: 48000, channels: 2, seed: 2 });
  assert.notEqual(other.set.sha256, a.set.sha256);
});

test("test signal stays within full scale and segments are contiguous", () => {
  const { audio, set } = generateTestSignal({ sampleRate: 44100, channels: 1 });
  let peak = 0;
  for (const v of audio.channels[0]!) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1, `peak ${peak}`);

  let position = 0;
  for (const segment of set.segments) {
    assert.equal(segment.start, position);
    position += segment.length;
  }
  assert.equal(position, set.length);
});

test("sweep values skip the base value and cover discrete steps", () => {
  assert.deepEqual(sweepValues(continuous(0, "Gain", 0.5), 5), [0, 0.25, 0.75, 1]);
  assert.deepEqual(sweepValues(stepped(1, "Mode", 3), 5), [0.5, 1]);
});

test("plan contains default, sweeps and random renders with unique ids", () => {
  const params = [continuous(0, "Gain"), stepped(1, "Mode", 3), stepped(2, "Bypass", 2), { ...continuous(3, "Meter"), automatable: false }];
  const plan = planCaptures(params, { ...DEFAULT_PLAN, random: 3 });

  assert.deepEqual(plan.selected.map((p) => p.name), ["Gain", "Mode"]);
  assert.equal(plan.renders[0]!.kind, "default");
  assert.equal(plan.renders.filter((r) => r.kind === "sweep").length, 4 + 2);
  assert.equal(plan.renders.filter((r) => r.kind === "random").length, 3);
  assert.equal(new Set(plan.renders.map((r) => r.id)).size, plan.renders.length);

  const again = planCaptures(params, { ...DEFAULT_PLAN, random: 3 });
  assert.deepEqual(again, plan);
});

test("plan respects include filter and render limit", () => {
  const params = Array.from({ length: 10 }, (_, i) => continuous(i, `Band ${i} Gain`));
  assert.equal(planCaptures(params, { ...DEFAULT_PLAN, include: /^Band 3 /, random: 0 }).selected.length, 1);
  assert.throws(() => planCaptures(params, { ...DEFAULT_PLAN, maxRenders: 10 }), PlanTooLargeError);
});

test("fixed values are applied to every render and not swept", () => {
  const params = [stepped(0, "Band 1 Used", 2, ["Unused", "Used"]), continuous(1, "Band 1 Gain")];
  const fixed = resolveFixedValues(params, ["band 1 used=Used"]);
  assert.deepEqual(fixed, [{ index: 0, value: 1 }]);

  const plan = planCaptures(params, { ...DEFAULT_PLAN, random: 2, fixed });
  assert.deepEqual(plan.selected.map((p) => p.index), [1]);
  for (const render of plan.renders) assert.deepEqual(render.params[0], { index: 0, value: 1 });

  assert.deepEqual(resolveFixedValues(params, ["1=0.25"]), [{ index: 1, value: 0.25 }]);
  assert.throws(() => resolveFixedValues(params, ["Band 1 Used=Maybe"]), /known: Unused, Used/);
  assert.throws(() => resolveFixedValues(params, ["Nope=1"]), /unknown parameter/);
  assert.throws(() => resolveFixedValues(params, ["1=2"]), /normalized/);
});

// Integration test with a real plugin: VCH_TEST_PLUGIN=/path/to/plugin.vst3 npm test
const testPlugin = process.env.VCH_TEST_PLUGIN;

test("capture a real plugin", { skip: !testPlugin || !existsSync(testPlugin) ? "set VCH_TEST_PLUGIN" : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "vch-test-"));
  try {
    const output = join(dir, "test.vcprofile");
    const profile = await capture({
      plugin: testPlugin!,
      output,
      sampleRate: 48000,
      blockSize: 512,
      channels: 2,
      prerollSeconds: 0.1,
      tailSeconds: 0.2,
      plan: { ...DEFAULT_PLAN, points: 2, random: 1, maxRenders: 50 },
    });
    const loaded = await readProfile(output);
    assert.equal(loaded.captures.renders.length, profile.captures.renders.length);
    assert.ok(loaded.captures.renders.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
