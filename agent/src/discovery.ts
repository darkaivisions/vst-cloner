import { PRESETS } from "./providers.ts";

export interface DiscoveredProvider {
  preset: string;
  name: string;
  local: boolean;
  available: boolean;
  /** e.g. server version or the environment variable holding a key */
  detail: string;
}

async function probe(url: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: response.status === 401, detail: `HTTP ${response.status}` };
    const body = (await response.json().catch(() => ({}))) as { version?: string; data?: unknown[] };
    if (body.version) return { ok: true, detail: `version ${body.version}` };
    if (Array.isArray(body.data)) return { ok: true, detail: `${body.data.length} models` };
    return { ok: true, detail: "running" };
  } catch {
    return { ok: false, detail: "not running" };
  }
}

/** Finds running local servers and cloud API keys present in the environment. */
export async function discoverProviders(timeoutMs = 1500): Promise<DiscoveredProvider[]> {
  return Promise.all(
    Object.entries(PRESETS)
      .filter(([name]) => name !== "custom")
      .map(async ([name, preset]) => {
        if (preset.local && preset.probeURL) {
          const result = await probe(preset.probeURL, timeoutMs);
          return { preset: name, name: preset.name, local: true, available: result.ok, detail: `${result.detail} (${preset.baseURL})` };
        }
        const variable = (preset.env ?? []).find((v) => process.env[v]);
        return {
          preset: name,
          name: preset.name,
          local: false,
          available: Boolean(variable),
          detail: variable ? `key in $${variable}` : "no key in environment",
        };
      }),
  );
}
