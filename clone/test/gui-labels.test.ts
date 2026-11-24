import assert from "node:assert/strict";
import { test } from "node:test";
import { labelWord } from "../src/gui/analyze.ts";

test("labels misread through look-alike glyphs become the editor word", () => {
  assert.equal(labelWord("FRED", true), "FREQ");
  assert.equal(labelWord("o8", true), "DB");
  assert.equal(labelWord("Bw", true), "BW");
  // a word of the plugin's own parameter names counts too
  assert.equal(labelWord("Wobb1e", false, ["Wobble"]), "Wobble");
});

test("readings that are right, numbers and unknown words stay as read", () => {
  for (const word of ["dB", "ms", "Hz", "Attack", "GAIN", "08", "710", "Hello"]) assert.equal(labelWord(word, true), undefined, word);
});
