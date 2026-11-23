import assert from "node:assert/strict";
import { test } from "node:test";
import { checkToolchain, requireToolchain } from "../src/toolchain.ts";

// on Windows Visual Studio (and its CMake) are found without PATH
test("missing build tools: reported with an install hint, and the build stops before it starts", { skip: process.platform === "win32" ? "found through vswhere" : false }, () => {
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    const tools = checkToolchain();
    const required = tools.filter((t) => t.required);
    assert.deepEqual(required.map((t) => t.id), ["cmake", "compiler"]);
    assert.ok(required.every((t) => !t.found && t.hint.length > 0));
    assert.throws(() => requireToolchain(), /missing: CMake \(.+\); C\+\+ compiler \(.+\)/);
  } finally {
    process.env.PATH = path;
  }
});
