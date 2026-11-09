import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Message = { type: string; id?: number; ok?: boolean; result?: any; error?: string; job?: string; kind?: string; [key: string]: unknown };

let child: ChildProcessWithoutNullStreams;
let dataDir: string;
const messages: Message[] = [];
const waiters: ((m: Message) => boolean)[] = [];
let nextId = 1;

function waitFor(predicate: (m: Message) => boolean, timeoutMs = 120000): Promise<Message> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for bridge message")), timeoutMs);
    waiters.push((m) => {
      if (!predicate(m)) return false;
      clearTimeout(timer);
      resolve(m);
      return true;
    });
  });
}

async function call(method: string, params: Record<string, unknown> = {}): Promise<Message> {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return waitFor((m) => m.type === "response" && m.id === id);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vch-bridge-test-"));
  const script = fileURLToPath(new URL("../bin/bridge.ts", import.meta.url));
  child = spawn(process.execPath, [script], {
    env: { ...process.env, VCH_DATA_DIR: dataDir, VCH_CONFIG_DIR: dataDir, VCH_CACHE_DIR: dataDir, VCH_NO_KEYCHAIN: "1" },
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!(message)) waiters.splice(i, 1);
  });
  await waitFor((m) => m.type === "ready", 20000);
});

after(async () => {
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  await rm(dataDir, { recursive: true, force: true });
});

test("ping and app info", async () => {
  assert.deepEqual((await call("ping")).result, { pong: true });
  const info = await call("app.info");
  assert.equal(info.ok, true);
  assert.equal(info.result.dataDir, dataDir);
  assert.equal(info.result.profilesDir, join(dataDir, "profiles"));
});

test("errors are reported as responses", async () => {
  const unknown = await call("does.not.exist");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error!, /unknown method/);
  const missing = await call("plugins.info", {});
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /Parameter „path“ fehlt/);
});

test("empty library and LLM status", async () => {
  assert.deepEqual((await call("profiles.list")).result, []);
  const status = await call("llm.status");
  assert.equal(status.ok, true);
  assert.deepEqual(status.result.providers, []);
  assert.ok(status.result.presets.some((p: { id: string }) => p.id === "ollama"));
});

test("provider management", async () => {
  assert.equal((await call("llm.add", { preset: "ollama" })).ok, true);
  assert.equal((await call("llm.setRole", { role: "builder", model: "ollama/qwen3:8b" })).ok, true);
  const status = await call("llm.status");
  assert.equal(status.result.providers[0].key, "local");
  assert.equal(status.result.roles.find((r: { role: string }) => r.role === "builder").model, "ollama/qwen3:8b");
  assert.equal((await call("llm.remove", { provider: "ollama" })).ok, true);
});

const plugin = process.env.VCH_TEST_PLUGIN;
test("capture job streams stage, progress and result", { skip: plugin && existsSync(plugin) ? false : "set VCH_TEST_PLUGIN" }, async () => {
  const started = await call("capture.start", { path: plugin, mode: "generic" });
  assert.equal(started.ok, true);
  const job = started.result.job as string;
  const done = await waitFor((m) => m.job === job && (m.kind === "done" || m.kind === "failed"));
  assert.equal(done.kind, "done", String(done.error));
  const events = messages.filter((m) => m.job === job);
  assert.equal(events[0]!.kind, "stage");
  assert.ok(events.some((m) => m.kind === "progress"));
  const list = await call("profiles.list");
  assert.equal(list.result.length, 1);
  assert.equal(list.result[0].renders, (done.result as { renders: number }).renders);
});
