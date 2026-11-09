import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Catalog } from "../src/index.ts";

const configDir = await mkdtemp(join(tmpdir(), "vch-agent-test-"));
process.env.VCH_CONFIG_DIR = configDir;
process.env.VCH_CACHE_DIR = configDir;
process.env.VCH_NO_KEYCHAIN = "1";

const {
  errorMessage,
  findCatalogModel,
  listModels,
  loadConfig,
  parseModelRef,
  providerFromPreset,
  removeProvider,
  resolveModel,
  saveConfig,
  setCatalogForTesting,
  upsertProvider,
  UsageMeter,
} = await import("../src/index.ts");

const catalog: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-5": { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true, structured_output: true, limit: { context: 1000000 }, cost: { input: 2, output: 10, cache_read: 0.2 } },
    },
  },
  alibaba: {
    id: "alibaba",
    name: "Alibaba",
    models: { "qwen3-8b": { id: "qwen3-8b", name: "Qwen3 8B", tool_call: true, limit: { context: 131072 }, cost: { input: 0.1, output: 0.4 } } },
  },
};
setCatalogForTesting(catalog);

let server: Server;
let baseURL: string;

before(async () => {
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/tags") return json(200, { models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text:latest" }] });
    if (req.url === "/api/ps") return json(200, { models: [{ name: "qwen3:8b" }] });
    if (req.url === "/api/show") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const model = JSON.parse(body).model as string;
        if (model.startsWith("nomic")) return json(200, { capabilities: ["embedding"], model_info: {} });
        return json(200, { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3.context_length": 40960 } });
      });
      return;
    }
    if (req.url === "/v1/models") {
      if (req.headers.authorization !== "Bearer good-key") return json(401, { error: { message: "Incorrect API key provided" } });
      return json(200, { data: [{ id: "claude-sonnet-5" }, { id: "my-finetune" }] });
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await rm(configDir, { recursive: true, force: true });
});

test("model references split at the first slash", () => {
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude-sonnet-5"), { providerId: "openrouter", modelId: "anthropic/claude-sonnet-5" });
  assert.deepEqual(parseModelRef("ollama/qwen3:8b"), { providerId: "ollama", modelId: "qwen3:8b" });
  assert.throws(() => parseModelRef("nomodel"), /invalid model reference/);
  assert.throws(() => parseModelRef("x/"), /invalid model reference/);
});

test("presets create providers; custom requires a base URL", () => {
  const ollama = providerFromPreset("ollama");
  assert.equal(ollama.local, true);
  assert.equal(ollama.kind, "openai-compatible");
  assert.throws(() => providerFromPreset("custom"), /requires --base-url/);
  assert.equal(providerFromPreset("custom", { id: "groq", baseURL: "https://api.groq.com/openai/v1/" }).baseURL, "https://api.groq.com/openai/v1");
  assert.throws(() => providerFromPreset("openai", { id: "Bad Id" }), /invalid provider id/);
  assert.throws(() => providerFromPreset("nope"), /unknown preset/);
});

test("config round trip; removing a provider clears its roles", async () => {
  let config = await loadConfig();
  assert.deepEqual(config, { version: 1, providers: [], roles: {} });

  config = upsertProvider(config, providerFromPreset("ollama"));
  config = upsertProvider(config, providerFromPreset("anthropic"));
  config.roles = { builder: "anthropic/claude-sonnet-5", analyst: "ollama/qwen3:8b" };
  await saveConfig(config);

  const loaded = await loadConfig();
  assert.deepEqual(loaded, config);
  if (process.platform !== "win32") assert.equal((await stat(join(configDir, "llm.json"))).mode & 0o777, 0o600);

  const removed = removeProvider(loaded, "anthropic");
  assert.deepEqual(removed.roles, { analyst: "ollama/qwen3:8b" });
  assert.equal(removed.providers.length, 1);
});

test("catalogue lookup matches provider ids and local model names", () => {
  assert.equal(findCatalogModel(catalog, "anthropic", "claude-sonnet-5")?.name, "Claude Sonnet 5");
  assert.equal(findCatalogModel(catalog, "openrouter", "anthropic/claude-sonnet-5")?.name, "Claude Sonnet 5");
  assert.equal(findCatalogModel(catalog, undefined, "qwen3:8b")?.name, "Qwen3 8B");
  assert.equal(findCatalogModel(catalog, undefined, "unknown-model"), undefined);
});

test("usage meter computes cost including cached tokens", () => {
  const meter = new UsageMeter();
  const usage = (input: number, output: number, cacheRead = 0) => ({
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input - cacheRead, cacheReadTokens: cacheRead, cacheWriteTokens: 0 },
    outputTokens: output,
    outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
    totalTokens: input + output,
  });
  meter.add(usage(1_000_000, 100_000, 500_000) as never, { input: 2, output: 10, cache_read: 0.2 });
  const totals = meter.get();
  assert.equal(totals.inputTokens, 1_000_000);
  assert.equal(totals.cachedInputTokens, 500_000);
  assert.ok(Math.abs(totals.cost! - (1 + 0.1 + 1)) < 1e-9, `cost ${totals.cost}`);

  meter.add(usage(10, 10) as never, undefined);
  assert.equal(meter.get().cost, undefined);
});

test("Ollama listing reads capabilities, context and loaded state", async () => {
  const provider = providerFromPreset("ollama", { baseURL: `${baseURL}/v1` });
  const models = await listModels(provider, undefined);
  assert.equal(models.length, 1, "embedding model is filtered out");
  const [qwen] = models;
  assert.equal(qwen!.id, "qwen3:8b");
  assert.equal(qwen!.contextLength, 40960, "provider value wins over catalogue");
  assert.equal(qwen!.toolCall, true);
  assert.equal(qwen!.loaded, true);
  assert.deepEqual(qwen!.cost, { input: 0, output: 0 });
  assert.deepEqual(qwen!.metadata, ["provider", "catalog"]);
});

test("OpenAI-compatible listing uses the key and enriches from the catalogue", async () => {
  const provider = providerFromPreset("custom", { id: "proxy", baseURL: `${baseURL}/v1`, catalogId: "anthropic" });
  await assert.rejects(listModels(provider, "wrong"), /HTTP 401 – check the API key: Incorrect API key provided/);

  const models = await listModels(provider, "good-key");
  assert.deepEqual(models.map((m) => m.id), ["claude-sonnet-5", "my-finetune"]);
  assert.equal(models[0]!.contextLength, 1000000);
  assert.deepEqual(models[1]!.metadata, ["provider"]);
});

test("unreachable server gives a clear error", async () => {
  const provider = providerFromPreset("llamacpp", { baseURL: "http://127.0.0.1:9/v1" });
  await assert.rejects(listModels(provider, undefined), /cannot reach http:\/\/127\.0\.0\.1:9/);
});

test("resolveModel requires keys for cloud providers and resolves roles", async () => {
  let config = upsertProvider(await loadConfig(), providerFromPreset("anthropic"));
  config = upsertProvider(config, providerFromPreset("ollama", { baseURL: `${baseURL}/v1` }));
  config.roles = { builder: "anthropic/claude-sonnet-5", analyst: "ollama/qwen3:8b" };

  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(resolveModel(config, "builder"), /no API key for 'anthropic'/);

  process.env.ANTHROPIC_API_KEY = "test";
  const builder = await resolveModel(config, "builder");
  assert.equal(builder.ref, "anthropic/claude-sonnet-5");
  assert.equal(builder.keySource, "env");
  assert.equal(builder.info.contextLength, 1000000);
  delete process.env.ANTHROPIC_API_KEY;

  const analyst = await resolveModel(config, "analyst", { detailed: true });
  assert.equal(analyst.info.contextLength, 40960);
  assert.equal(analyst.keySource, "none");

  await assert.rejects(resolveModel({ ...config, roles: {} }, "builder"), /no model assigned to role 'builder'/);
});

test("error bodies are reduced to their message", () => {
  assert.equal(errorMessage('{"error":{"message":"bad key"}}'), "bad key");
  assert.equal(errorMessage('{"detail":"Invalid API Key"}'), "Invalid API Key");
  assert.equal(errorMessage("plain text"), "plain text");
});

// Live check against a real model: VCH_TEST_MODEL=ollama/qwen3:8b npm test (uses your normal config)
const liveModel = process.env.VCH_TEST_MODEL;
test("live capability test", { skip: liveModel ? false : "set VCH_TEST_MODEL" }, async () => {
  const { testModel } = await import("../src/probe.ts");
  const { configDir: userConfig } = await import("../src/paths.ts");
  delete process.env.VCH_CONFIG_DIR;
  delete process.env.VCH_NO_KEYCHAIN;
  try {
    let config = await loadConfig();
    const { providerId } = parseModelRef(liveModel!);
    if (!config.providers.some((p) => p.id === providerId)) config = upsertProvider(config, providerFromPreset(providerId));
    const report = await testModel(await resolveModel(config, liveModel!), { only: ["text"] });
    assert.ok(report.results[0]!.ok, `${userConfig()}: ${report.results[0]!.detail}`);
  } finally {
    process.env.VCH_CONFIG_DIR = configDir;
    process.env.VCH_NO_KEYCHAIN = "1";
  }
});
