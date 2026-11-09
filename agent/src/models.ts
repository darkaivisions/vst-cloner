import { findCatalogModel, loadCatalog, type CatalogCost } from "./catalog.ts";
import type { ProviderConfig } from "./providers.ts";

export interface ModelInfo {
  id: string;
  name?: string;
  /** Context window in tokens, if known. */
  contextLength?: number;
  toolCall?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  /** USD per million tokens; zero for local providers. */
  cost?: CatalogCost;
  /** Local servers: whether the model is currently loaded. */
  loaded?: boolean;
  /** Where the metadata came from. */
  metadata: ("provider" | "catalog")[];
}

export class ProviderRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderRequestError";
    if (status !== undefined) this.status = status;
  }
}

const DEFAULT_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/** Extracts the human-readable message from typical JSON error bodies. */
export function errorMessage(body: string): string {
  try {
    const json = JSON.parse(body);
    const message = json?.error?.message ?? json?.message ?? json?.detail ?? (typeof json?.error === "string" ? json.error : undefined);
    if (typeof message === "string") return message.slice(0, 300);
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 300);
}

async function getJson(url: string, headers: Record<string, string> = {}, init: RequestInit = {}, timeoutMs = 10000): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = (error as Error & { cause?: { code?: string } }).cause?.code;
    throw new ProviderRequestError(`cannot reach ${new URL(url).origin}${cause ? ` (${cause})` : ""}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const message = errorMessage(await response.text().catch(() => ""));
    const keyProblem = response.status === 401 || response.status === 403 || /api.?key/i.test(message);
    throw new ProviderRequestError(
      `${new URL(url).origin} returned HTTP ${response.status}${keyProblem ? " – check the API key" : ""}${message ? `: ${message}` : ""}`,
      response.status,
    );
  }
  return response.json();
}

/** Root of a local server without the trailing /v1. */
const serverRoot = (baseURL: string) => baseURL.replace(/\/v1\/?$/, "");

const bearer = (key?: string): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

async function listFromProvider(provider: ProviderConfig, apiKey: string | undefined): Promise<Omit<ModelInfo, "metadata">[]> {
  const base = provider.baseURL ?? DEFAULT_URLS[provider.kind] ?? "";

  switch (provider.listing) {
    case "openai":
    case "openai-compatible": {
      const data = await getJson(`${base}/models`, bearer(apiKey));
      return (data.data ?? []).map((m: any) => ({ id: m.id }));
    }

    case "anthropic": {
      const data = await getJson(`${base}/models?limit=1000`, { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" });
      return (data.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name }));
    }

    case "google": {
      const models: Omit<ModelInfo, "metadata">[] = [];
      let pageToken = "";
      do {
        const data = await getJson(`${base}/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`, { "x-goog-api-key": apiKey ?? "" });
        for (const m of data.models ?? []) {
          if (!(m.supportedGenerationMethods ?? []).includes("generateContent")) continue;
          models.push({ id: String(m.name).replace(/^models\//, ""), name: m.displayName, contextLength: m.inputTokenLimit });
        }
        pageToken = data.nextPageToken ?? "";
      } while (pageToken);
      return models;
    }

    case "mistral": {
      const data = await getJson(`${base}/models`, bearer(apiKey));
      return (data.data ?? [])
        .filter((m: any) => m.capabilities?.completion_chat !== false)
        .map((m: any) => ({ id: m.id, name: m.name ?? undefined, contextLength: m.max_context_length, toolCall: m.capabilities?.function_calling }));
    }

    case "openrouter": {
      const data = await getJson(`${base}/models`, bearer(apiKey));
      return (data.data ?? []).map((m: any) => {
        const params: string[] = m.supported_parameters ?? [];
        const perMillion = (v: unknown) => (v === undefined || v === null ? undefined : Number(v) * 1e6);
        return {
          id: m.id,
          name: m.name,
          contextLength: m.context_length,
          toolCall: params.includes("tools"),
          structuredOutput: params.includes("structured_outputs") || params.includes("response_format"),
          reasoning: params.includes("reasoning"),
          cost: { input: perMillion(m.pricing?.prompt), output: perMillion(m.pricing?.completion) },
        };
      });
    }

    case "ollama": {
      const root = serverRoot(base);
      const tags = await getJson(`${root}/api/tags`);
      const running = await getJson(`${root}/api/ps`).catch(() => ({ models: [] }));
      const loaded = new Set<string>((running.models ?? []).map((m: any) => m.name));
      return Promise.all(
        (tags.models ?? []).map(async (m: any) => {
          const show = await getJson(`${root}/api/show`, { "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ model: m.name }) }).catch(() => undefined);
          const info = show?.model_info ?? {};
          const contextKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
          const capabilities: string[] = show?.capabilities ?? [];
          if (capabilities.length > 0 && !capabilities.includes("completion")) return undefined;
          return {
            id: m.name,
            ...(contextKey ? { contextLength: info[contextKey] } : {}),
            ...(show ? { toolCall: capabilities.includes("tools") } : {}),
            ...(capabilities.includes("thinking") ? { reasoning: true } : {}),
            loaded: loaded.has(m.name),
          };
        }),
      ).then((list) => list.filter((m): m is NonNullable<typeof m> => m !== undefined));
    }

    case "lmstudio": {
      const root = serverRoot(base);
      try {
        const data = await getJson(`${root}/api/v0/models`, bearer(apiKey));
        return (data.data ?? [])
          .filter((m: any) => m.type === "llm" || m.type === "vlm")
          .map((m: any) => ({
            id: m.id,
            contextLength: m.loaded_context_length ?? m.max_context_length,
            ...(Array.isArray(m.capabilities) ? { toolCall: m.capabilities.includes("tool_use") } : {}),
            loaded: m.state === "loaded",
          }));
      } catch {
        const data = await getJson(`${base}/models`, bearer(apiKey));
        return (data.data ?? []).map((m: any) => ({ id: m.id }));
      }
    }

    case "llamacpp": {
      const [models, props] = await Promise.all([
        getJson(`${base}/models`, bearer(apiKey)),
        getJson(`${serverRoot(base)}/props`, bearer(apiKey)).catch(() => undefined),
      ]);
      const contextLength = props?.default_generation_settings?.n_ctx;
      return (models.data ?? []).map((m: any) => ({ id: m.id, ...(contextLength ? { contextLength } : {}), loaded: true }));
    }

    case "vllm": {
      const data = await getJson(`${base}/models`, bearer(apiKey));
      return (data.data ?? []).map((m: any) => ({ id: m.id, contextLength: m.max_model_len, loaded: true }));
    }
  }
}

/** Lists the models of a provider, enriched with catalogue metadata. */
export async function listModels(provider: ProviderConfig, apiKey: string | undefined): Promise<ModelInfo[]> {
  const [models, { catalog }] = await Promise.all([listFromProvider(provider, apiKey), loadCatalog()]);

  return models
    .map((m) => {
      const entry = findCatalogModel(catalog, provider.catalogId, m.id);
      const info: ModelInfo = { ...m, metadata: ["provider"] };
      if (entry) {
        info.metadata.push("catalog");
        info.name ??= entry.name;
        info.contextLength ??= entry.limit?.context;
        info.toolCall ??= entry.tool_call;
        info.structuredOutput ??= entry.structured_output;
        info.reasoning ??= entry.reasoning;
        if (!provider.local) info.cost ??= entry.cost;
      }
      if (provider.local) info.cost = { input: 0, output: 0 };
      return info;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Metadata for a single model without listing the provider (catalogue only). */
export async function describeModel(provider: ProviderConfig, modelId: string): Promise<ModelInfo> {
  const { catalog } = await loadCatalog();
  const entry = findCatalogModel(catalog, provider.catalogId, modelId);
  const info: ModelInfo = { id: modelId, metadata: entry ? ["catalog"] : [] };
  if (entry) {
    if (entry.name) info.name = entry.name;
    if (entry.limit?.context) info.contextLength = entry.limit.context;
    if (entry.tool_call !== undefined) info.toolCall = entry.tool_call;
    if (entry.structured_output !== undefined) info.structuredOutput = entry.structured_output;
    if (entry.reasoning !== undefined) info.reasoning = entry.reasoning;
    if (entry.cost && !provider.local) info.cost = entry.cost;
  }
  if (provider.local) info.cost = { input: 0, output: 0 };
  return info;
}
