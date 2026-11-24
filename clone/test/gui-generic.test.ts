import assert from "node:assert/strict";
import { test } from "node:test";
import { generateGuiHeader, genericGuiModel } from "../src/index.ts";
import type { CloneParam } from "../src/eq/params.ts";

const param = (i: number, kind: CloneParam["kind"]): CloneParam => ({
  id: `p${i}`, name: `Control ${i}`, original: 10 + i, kind, defaultValue: kind === "continuous" ? 5 : 0,
  points: [[0, 0], [1, 10]], ...(kind === "choice" ? { choices: ["A", "B", "C"] } : {}),
});

test("an original without an editor: every control of the clone in a grid inside the editor", () => {
  const params = [...Array.from({ length: 9 }, (_, i) => param(i, "continuous")), param(9, "toggle"), param(10, "choice")];
  const model = genericGuiModel(params, "Some Plugin")!;
  assert.deepEqual(model.controls.map((c) => c.param), params.map((p) => p.original));
  assert.deepEqual(model.controls.map((c) => c.kind), [...Array(9).fill("rotary"), "toggle", "choice"]);
  for (const c of model.controls) assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= model.width && c.y + c.h <= model.height, `${c.name} inside`);
  // the default of a continuous control sits where it is on the original's curve (5 of 0…10)
  assert.equal(model.controls[0]!.value, 0.5);
  assert.equal(model.texts[0]!.text, "Some Plugin");
});

test("the clone's editor header without a rebuilt layout is the generic one", () => {
  const header = generateGuiHeader(undefined, [param(0, "continuous")], "X");
  assert.match(header, /present = true/);
  assert.match(generateGuiHeader(undefined, []), /present = false/);
});
