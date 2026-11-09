import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.ts";
import { PRESETS, parseModelRef, type ProviderConfig } from "./providers.ts";
import type { RoleName } from "./roles.ts";

export interface LlmConfig {
  version: 1;
  providers: ProviderConfig[];
  /** Model reference per role, e.g. { builder: "anthropic/claude-sonnet-5" } */
  roles: Partial<Record<RoleName, string>>;
}

export const configPath = () => join(configDir(), "llm.json");

const empty = (): LlmConfig => ({ version: 1, providers: [], roles: {} });

export async function loadConfig(): Promise<LlmConfig> {
  let text: string;
  try {
    text = await readFile(configPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<LlmConfig>;
  if (parsed.version !== 1) throw new Error(`${configPath()}: unsupported config version ${parsed.version}`);
  return { version: 1, providers: parsed.providers ?? [], roles: parsed.roles ?? {} };
}

/** Writes atomically. The file never contains API keys. */
export async function saveConfig(config: LlmConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, configPath());
}

export function findProvider(config: LlmConfig, id: string): ProviderConfig {
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) {
    const known = config.providers.map((p) => p.id).join(", ") || "none";
    throw new Error(`unknown provider '${id}' (configured: ${known}). Add it with 'vch llm add'.`);
  }
  return provider;
}

const ID = /^[a-z0-9][a-z0-9_-]*$/;

export function providerFromPreset(presetName: string, overrides: { id?: string; baseURL?: string; catalogId?: string; name?: string } = {}): ProviderConfig {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`unknown preset '${presetName}' (available: ${Object.keys(PRESETS).join(", ")})`);
  const { description: _description, probeURL: _probeURL, ...base } = preset;
  const id = overrides.id ?? presetName;
  if (!ID.test(id)) throw new Error(`invalid provider id '${id}' (lowercase letters, digits, '-' and '_')`);
  const provider: ProviderConfig = { ...base, id };
  if (overrides.baseURL) provider.baseURL = overrides.baseURL.replace(/\/+$/, "");
  if (overrides.catalogId) provider.catalogId = overrides.catalogId;
  if (overrides.name) provider.name = overrides.name;
  if (provider.kind === "openai-compatible" && !provider.baseURL) throw new Error(`preset '${presetName}' requires --base-url`);
  return provider;
}

export function upsertProvider(config: LlmConfig, provider: ProviderConfig): LlmConfig {
  const providers = config.providers.filter((p) => p.id !== provider.id);
  providers.push(provider);
  return { ...config, providers };
}

export function removeProvider(config: LlmConfig, id: string): LlmConfig {
  findProvider(config, id);
  const roles = Object.fromEntries(Object.entries(config.roles).filter(([, ref]) => ref && parseModelRef(ref).providerId !== id));
  return { ...config, providers: config.providers.filter((p) => p.id !== id), roles };
}
