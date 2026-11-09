import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./paths.ts";

/**
 * Model catalogue from models.dev (context limits, tool support, prices).
 * Cached locally; works offline with the last cached copy.
 */
export const CATALOG_URL = "https://models.dev/api.json";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CatalogCost {
  /** USD per million input tokens */
  input?: number;
  /** USD per million output tokens */
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogModel {
  id: string;
  name?: string;
  family?: string;
  tool_call?: boolean;
  structured_output?: boolean;
  reasoning?: boolean;
  open_weights?: boolean;
  release_date?: string;
  limit?: { context?: number; output?: number };
  cost?: CatalogCost;
  status?: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
}

export type Catalog = Record<string, CatalogProvider>;

export interface CatalogLoadResult {
  catalog: Catalog;
  source: "network" | "cache" | "none";
  fetchedAt?: Date;
  error?: string;
}

const cachePath = () => join(cacheDir(), "models.dev.json");

let memory: CatalogLoadResult | undefined;

async function readCache(): Promise<{ catalog: Catalog; fetchedAt: Date } | undefined> {
  try {
    const path = cachePath();
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { catalog: JSON.parse(text) as Catalog, fetchedAt: info.mtime };
  } catch {
    return undefined;
  }
}

/** Loads the catalogue: fresh cache → network → stale cache → empty. */
export async function loadCatalog(options: { refresh?: boolean; timeoutMs?: number } = {}): Promise<CatalogLoadResult> {
  if (memory && !options.refresh) return memory;

  const cached = await readCache();
  if (cached && !options.refresh && Date.now() - cached.fetchedAt.getTime() < MAX_AGE_MS) {
    return (memory = { catalog: cached.catalog, source: "cache", fetchedAt: cached.fetchedAt });
  }

  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(options.timeoutMs ?? 10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const catalog = JSON.parse(text) as Catalog;
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cachePath(), text);
    return (memory = { catalog, source: "network", fetchedAt: new Date() });
  } catch (error) {
    const message = (error as Error).message;
    if (cached) return (memory = { catalog: cached.catalog, source: "cache", fetchedAt: cached.fetchedAt, error: message });
    return (memory = { catalog: {}, source: "none", error: message });
  }
}

/** For tests: replace the in-memory catalogue. */
export function setCatalogForTesting(catalog: Catalog | undefined): void {
  memory = catalog ? { catalog, source: "cache" } : undefined;
}

const normalize = (id: string) => id.toLowerCase().replace(/[:@].*$/, "").replace(/[^a-z0-9.]+/g, "-");

/**
 * Finds catalogue metadata for a model. Looks in the given catalogue provider first,
 * then matches the bare model name across all providers (useful for local models,
 * e.g. "qwen3:32b" in Ollama → "qwen3-32b").
 */
export function findCatalogModel(catalog: Catalog, catalogProviderId: string | undefined, modelId: string): CatalogModel | undefined {
  if (catalogProviderId) {
    const provider = catalog[catalogProviderId];
    const direct = provider?.models[modelId];
    if (direct) return direct;
  }

  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  const wanted = normalize(bare);
  const fullName = normalize(modelId.replace(/:/g, "-"));

  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider.models)) {
      const candidate = normalize(model.id.includes("/") ? model.id.slice(model.id.lastIndexOf("/") + 1) : model.id);
      if (candidate === wanted || candidate === fullName) return model;
    }
  }
  return undefined;
}
