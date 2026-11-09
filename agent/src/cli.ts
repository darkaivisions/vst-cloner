import { parseArgs } from "node:util";
import { generateText } from "ai";
import { loadCatalog } from "./catalog.ts";
import { configPath, findProvider, loadConfig, providerFromPreset, removeProvider, saveConfig, upsertProvider } from "./config.ts";
import { discoverProviders } from "./discovery.ts";
import { resolveModel } from "./llm.ts";
import { listModels, type ModelInfo } from "./models.ts";
import { testModel, type ProbeName } from "./probe.ts";
import { PRESETS, parseModelRef } from "./providers.ts";
import { isRoleName, ROLE_NAMES, ROLES } from "./roles.ts";
import { deleteApiKey, resolveApiKey, storeApiKey } from "./secrets.ts";
import { formatUsage } from "./usage.ts";

const USAGE = `vch llm — language model providers

Usage:
  vch llm status                          Providers, keys, roles and local servers
  vch llm discover [--add]                Find local servers and API keys in the environment
  vch llm presets                         List provider presets
  vch llm add <preset> [options]          Add a provider
      --id <id>                           Provider id (default: preset name)
      --base-url <url>                    Endpoint (required for 'custom')
      --catalog <models.dev id>           Metadata source for context/prices (e.g. groq, deepseek)
      --name <text>                       Display name
  vch llm key <provider> [--from-env <VAR>] [--delete]
                                          Store an API key in the system keychain
                                          (prompted without echo, or read from stdin)
  vch llm remove <provider>
  vch llm models <provider> [--filter <regex>] [--tools] [--json]
  vch llm test <provider/model|role> [--only text,tools,structured] [--json]
                                          Live check: text, tool calling, structured output
  vch llm role [<role> <provider/model>] [--force]
                                          Show or assign models to roles (${ROLE_NAMES.join(", ")})
  vch llm ask <provider/model|role> <prompt…>
  vch llm catalog [--refresh]             models.dev catalogue status

Config: ${configPath()} (contains no keys)
`;

const OPTIONS = {
  id: { type: "string" },
  "base-url": { type: "string" },
  catalog: { type: "string" },
  name: { type: "string" },
  "from-env": { type: "string" },
  delete: { type: "boolean" },
  add: { type: "boolean" },
  filter: { type: "string" },
  tools: { type: "boolean" },
  only: { type: "string" },
  json: { type: "boolean" },
  force: { type: "boolean" },
  refresh: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

const need = (positionals: string[], index: number, what: string): string => {
  const value = positionals[index];
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
};

const formatTokens = (n: number | undefined) =>
  n === undefined ? "?" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

const flag = (value: boolean | undefined) => (value === undefined ? "?" : value ? "yes" : "no");

const round = (n: number) => Number(n.toPrecision(4));

const price = (m: ModelInfo) =>
  m.cost?.input === undefined || m.cost.output === undefined
    ? "?"
    : m.cost.input === 0 && m.cost.output === 0
      ? "free"
      : `$${round(m.cost.input)}/$${round(m.cost.output)}`;

/** Reads a secret without echo on a terminal, or from stdin when piped. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }

  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function commandStatus(): Promise<void> {
  const config = await loadConfig();
  console.log(`Config: ${configPath()}\n`);

  if (config.providers.length === 0) console.log("No providers configured. Start with 'vch llm discover' or 'vch llm add <preset>'.");
  else {
    console.log("Providers:");
    for (const p of config.providers) {
      let key: string;
      if (p.local) key = "local, no key needed";
      else {
        try {
          const resolved = await resolveApiKey(p);
          key = resolved.source === "env" ? `key from $${resolved.variable}` : resolved.source === "keychain" ? "key in keychain" : "NO KEY – run 'vch llm key " + p.id + "'";
        } catch (error) {
          key = (error as Error).message;
        }
      }
      console.log(`  ${p.id.padEnd(12)} ${p.name}${p.baseURL ? ` (${p.baseURL})` : ""} – ${key}`);
    }
  }

  console.log("\nRoles:");
  for (const role of ROLE_NAMES) console.log(`  ${role.padEnd(12)} ${config.roles[role] ?? "(not set)"} – ${ROLES[role].description}`);

  console.log("\nLocal servers:");
  for (const d of (await discoverProviders()).filter((d) => d.local)) {
    console.log(`  ${d.available ? "●" : "○"} ${d.name.padEnd(18)} ${d.detail}`);
  }
}

async function commandDiscover(values: Values): Promise<void> {
  const found = await discoverProviders();
  let config = await loadConfig();
  const added: string[] = [];

  for (const d of found) {
    const configured = config.providers.some((p) => p.id === d.preset);
    console.log(`${d.available ? "●" : "○"} ${d.name.padEnd(18)} ${d.detail}${configured ? " [configured]" : ""}`);
    if (values.add && d.available && !configured) {
      config = upsertProvider(config, providerFromPreset(d.preset));
      added.push(d.preset);
    }
  }

  if (added.length > 0) {
    await saveConfig(config);
    console.log(`\nAdded: ${added.join(", ")}`);
  } else if (!values.add && found.some((d) => d.available && !config.providers.some((p) => p.id === d.preset))) {
    console.log("\nRun 'vch llm discover --add' to add the available providers.");
  }
}

function commandPresets(): void {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const extra = preset.local ? preset.baseURL : preset.env?.length ? `$${preset.env.join(", $")}` : "";
    console.log(`  ${name.padEnd(12)} ${preset.description}${extra ? ` – ${extra}` : ""}`);
  }
}

async function commandAdd(positionals: string[], values: Values): Promise<void> {
  const presetName = need(positionals, 0, "preset (see 'vch llm presets')");
  const provider = providerFromPreset(presetName, {
    ...(values.id ? { id: values.id } : {}),
    ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
    ...(values.catalog ? { catalogId: values.catalog } : {}),
    ...(values.name ? { name: values.name } : {}),
  });

  if (provider.catalogId) {
    const { catalog } = await loadCatalog();
    if (Object.keys(catalog).length > 0 && !catalog[provider.catalogId]) console.warn(`Warning: '${provider.catalogId}' is not a models.dev provider id`);
    const entry = catalog[provider.catalogId];
    if (entry?.env && !provider.env) provider.env = entry.env;
  }

  const config = await loadConfig();
  await saveConfig(upsertProvider(config, provider));
  console.log(`Added provider '${provider.id}' (${provider.name}).`);

  if (!provider.local) {
    const key = await resolveApiKey(provider).catch(() => ({ source: "none" as const }));
    if (key.source === "none") console.log(`Next: store the API key with 'vch llm key ${provider.id}'.`);
  }
  console.log(`List models with 'vch llm models ${provider.id}'.`);
}

async function commandKey(positionals: string[], values: Values): Promise<void> {
  const config = await loadConfig();
  const provider = findProvider(config, need(positionals, 0, "provider id"));

  if (values.delete) {
    console.log((await deleteApiKey(provider.id)) ? `Removed key for '${provider.id}' from the keychain.` : "No key stored.");
    return;
  }

  let key: string;
  if (values["from-env"]) {
    key = process.env[values["from-env"]] ?? "";
    if (!key) throw new UsageError(`$${values["from-env"]} is empty`);
  } else {
    key = await readSecret(`API key for ${provider.name}: `);
  }
  if (!key) throw new UsageError("no key entered");

  await storeApiKey(provider.id, key);
  console.log(`Stored key for '${provider.id}' in the system keychain.`);

  try {
    const models = await listModels(provider, key);
    console.log(`Verified: ${models.length} models available.`);
  } catch (error) {
    console.warn(`Warning: key stored, but listing models failed: ${(error as Error).message}`);
  }
}

async function commandRemove(positionals: string[]): Promise<void> {
  const id = need(positionals, 0, "provider id");
  const config = await loadConfig();
  await saveConfig(removeProvider(config, id));
  await deleteApiKey(id).catch(() => false);
  console.log(`Removed provider '${id}'.`);
}

async function commandModels(positionals: string[], values: Values): Promise<void> {
  const config = await loadConfig();
  const provider = findProvider(config, need(positionals, 0, "provider id"));
  const key = await resolveApiKey(provider);
  let models = await listModels(provider, key.key);

  if (values.filter) {
    const re = new RegExp(values.filter, "i");
    models = models.filter((m) => re.test(m.id) || (m.name !== undefined && re.test(m.name)));
  }
  if (values.tools) models = models.filter((m) => m.toolCall === true);

  if (values.json) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  if (models.length === 0) {
    console.log("No models found.");
    return;
  }

  const width = Math.min(48, Math.max(...models.map((m) => m.id.length)));
  console.log(`${"model".padEnd(width)}  context  tools  json   $/M in/out${provider.local ? "  loaded" : ""}`);
  for (const m of models) {
    const row = `${m.id.padEnd(width)}  ${formatTokens(m.contextLength).padStart(7)}  ${flag(m.toolCall).padEnd(5)}  ${flag(m.structuredOutput).padEnd(5)}  ${price(m)}`;
    console.log(provider.local ? `${row.padEnd(width + 40)}  ${m.loaded ? "●" : ""}` : row);
  }
  console.log(`\n${models.length} models. Use them as '${provider.id}/<model>'.`);
}

async function commandTest(positionals: string[], values: Values): Promise<number> {
  const config = await loadConfig();
  const target = await resolveModel(config, need(positionals, 0, "model reference or role"), { detailed: true });
  const only = values.only?.split(",").map((s) => s.trim()) as ProbeName[] | undefined;

  if (!values.json) console.error(`Testing ${target.ref} …`);
  const report = await testModel(target, only ? { only } : {});

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Model:    ${report.ref}${target.info.name ? ` (${target.info.name})` : ""}`);
    console.log(`Context:  ${formatTokens(report.contextLength)} tokens`);
    for (const r of report.results) console.log(`${r.ok ? "✔" : "✘"} ${r.name.padEnd(10)} ${String(r.milliseconds).padStart(6)} ms  ${r.detail}`);
    console.log(`Usage:    ${formatUsage(report.usage)}`);
    for (const role of ROLE_NAMES) {
      const fit = report.roles[role];
      console.log(`Role ${role.padEnd(8)} ${fit.suitable ? "suitable" : `not suitable (${fit.reasons.join(", ")})`}`);
    }
    for (const note of report.notes) console.log(`Note:     ${note}`);
  }
  return report.results.every((r) => r.ok) ? 0 : 1;
}

async function commandRole(positionals: string[], values: Values): Promise<void> {
  const config = await loadConfig();

  if (positionals.length === 0) {
    for (const role of ROLE_NAMES) console.log(`${role.padEnd(10)} ${config.roles[role] ?? "(not set)"}`);
    return;
  }

  const role = need(positionals, 0, "role");
  if (!isRoleName(role)) throw new UsageError(`unknown role '${role}' (roles: ${ROLE_NAMES.join(", ")})`);
  const ref = need(positionals, 1, "model reference <provider>/<model>");
  const { providerId, modelId } = parseModelRef(ref);
  findProvider(config, providerId);

  const target = await resolveModel(config, ref);
  const req = ROLES[role];
  const problems: string[] = [];
  if (req.tools && target.info.toolCall === false) problems.push("model does not support tool calling");
  if (req.structuredOutput && target.info.structuredOutput === false) problems.push("model does not support structured output");
  if (target.info.contextLength !== undefined && target.info.contextLength < req.minContext) problems.push(`context ${target.info.contextLength} < ${req.minContext}`);

  if (problems.length > 0 && !values.force) {
    throw new Error(`${ref} is not suitable for '${role}': ${problems.join(", ")}. Use --force to assign anyway.`);
  }

  config.roles[role] = `${providerId}/${modelId}`;
  await saveConfig(config);
  console.log(`Role '${role}' → ${ref}`);
  if (target.info.metadata.length === 0) console.log(`Capabilities unknown – verify with 'vch llm test ${ref}'.`);
}

async function commandAsk(positionals: string[]): Promise<void> {
  const config = await loadConfig();
  const target = await resolveModel(config, need(positionals, 0, "model reference or role"));
  const prompt = positionals.slice(1).join(" ");
  if (!prompt) throw new UsageError("missing prompt");

  const result = await generateText({ model: target.model, prompt, maxRetries: 1 });
  target.meter.add(result.totalUsage, target.info.cost);
  console.log(result.text);
  console.error(`\n[${target.ref} – ${formatUsage(target.meter.get())}]`);
}

async function commandCatalog(values: Values): Promise<void> {
  const result = await loadCatalog(values.refresh ? { refresh: true } : {});
  const providers = Object.keys(result.catalog).length;
  const models = Object.values(result.catalog).reduce((sum, p) => sum + Object.keys(p.models ?? {}).length, 0);
  console.log(`models.dev catalogue: ${providers} providers, ${models} models (source: ${result.source}${result.fetchedAt ? `, ${result.fetchedAt.toISOString()}` : ""})`);
  if (result.error) console.log(`Last update failed: ${result.error}`);
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const [command = "status", ...positionals] = parsed.positionals;
  const { values } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "status": await commandStatus(); return 0;
      case "discover": await commandDiscover(values); return 0;
      case "presets": commandPresets(); return 0;
      case "add": await commandAdd(positionals, values); return 0;
      case "key": await commandKey(positionals, values); return 0;
      case "remove": await commandRemove(positionals); return 0;
      case "models": await commandModels(positionals, values); return 0;
      case "test": return await commandTest(positionals, values);
      case "role": await commandRole(positionals, values); return 0;
      case "ask": await commandAsk(positionals); return 0;
      case "catalog": await commandCatalog(values); return 0;
      default: throw new UsageError(`unknown command '${command}'`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`Error: ${error.message}\n\nRun 'vch llm --help' for usage.`);
      return 2;
    }
    console.error(`Error: ${(error as Error).message}`);
    return 1;
  }
}
