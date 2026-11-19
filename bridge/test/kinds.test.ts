import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostInfo } from "@vst-cloner/capture";
import { categoryLabel, pluginKind } from "../src/kinds.ts";

const info = (name: string, category: string, isInstrument = false) =>
  ({ parameters: [], plugin: { name, category, isInstrument }, mainInputChannels: isInstrument ? 0 : 2 }) as unknown as HostInfo;

test("category words name effects without a class: generic words are skipped", () => {
  assert.equal(categoryLabel("Phaser Plugin"), "Phaser");
  assert.equal(categoryLabel("Fx|Spatial"), "Spatial");
  assert.equal(categoryLabel("Fx|Tools|Mono"), "Utility");
  assert.equal(categoryLabel("Fx|Stereo"), undefined);
});

test("effects without an engine are grouped by what they do, instruments apart", () => {
  const phaser = pluginKind(info("GxPhaser", "Phaser Plugin"));
  assert.deepEqual([phaser.group, phaser.engine, phaser.label], ["modulation", false, "Phaser"]);
  const eq = pluginKind(info("3 Band EQ", "Fx|EQ"));
  assert.deepEqual([eq.group, eq.label], ["eq", "EQ"]);
  assert.equal(pluginKind(info("TAL-Filter-2", "Filter Plugin")).group, "filter");
  assert.equal(pluginKind(info("Dexed", "Instrument|Synth", true)).group, "instrument");
  assert.equal(pluginKind(info("Cycle Shifter", "Fx|Stereo")).label, "Other");
});
