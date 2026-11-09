import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export type ProviderKind = "openai" | "anthropic" | "google" | "mistral" | "openrouter" | "openai-compatible";

/** How the model list of a provider is fetched. */
export type ListingKind = ProviderKind | "ollama" | "lmstudio" | "llamacpp" | "vllm";

export interface ProviderConfig {
  /** Unique id chosen by the user, used in model references ("<id>/<model>"). */
  id: string;
  name: string;
  kind: ProviderKind;
  listing: ListingKind;
  baseURL?: string;
  /** models.dev provider id for metadata (context, tools, prices). */
  catalogId?: string;
  /** Local servers: no API key needed, no costs. */
  local: boolean;
  /** Environment variables checked for an API key before the keychain. */
  env?: string[];
}

export interface Preset extends Omit<ProviderConfig, "id"> {
  description: string;
  /** Root URL used to detect a running local server. */
  probeURL?: string;
}

export const PRESETS: Record<string, Preset> = {
  openai: {
    name: "OpenAI", kind: "openai", listing: "openai", catalogId: "openai", local: false,
    env: ["OPENAI_API_KEY"], description: "GPT models (api.openai.com)",
  },
  anthropic: {
    name: "Anthropic", kind: "anthropic", listing: "anthropic", catalogId: "anthropic", local: false,
    env: ["ANTHROPIC_API_KEY"], description: "Claude models (api.anthropic.com)",
  },
  google: {
    name: "Google Gemini", kind: "google", listing: "google", catalogId: "google", local: false,
    env: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"], description: "Gemini models (Google AI Studio key)",
  },
  mistral: {
    name: "Mistral", kind: "mistral", listing: "mistral", catalogId: "mistral", local: false,
    env: ["MISTRAL_API_KEY"], description: "Mistral models (api.mistral.ai)",
  },
  openrouter: {
    name: "OpenRouter", kind: "openrouter", listing: "openrouter", catalogId: "openrouter", local: false,
    env: ["OPENROUTER_API_KEY"], description: "Hundreds of models from many vendors with one key",
  },
  ollama: {
    name: "Ollama", kind: "openai-compatible", listing: "ollama", baseURL: "http://127.0.0.1:11434/v1", local: true,
    probeURL: "http://127.0.0.1:11434/api/version", description: "Local models via Ollama",
  },
  lmstudio: {
    name: "LM Studio", kind: "openai-compatible", listing: "lmstudio", baseURL: "http://127.0.0.1:1234/v1", local: true,
    catalogId: "lmstudio", probeURL: "http://127.0.0.1:1234/v1/models", description: "Local models via LM Studio",
  },
  llamacpp: {
    name: "llama.cpp server", kind: "openai-compatible", listing: "llamacpp", baseURL: "http://127.0.0.1:8080/v1", local: true,
    probeURL: "http://127.0.0.1:8080/v1/models", description: "Local llama-server (llama.cpp)",
  },
  vllm: {
    name: "vLLM", kind: "openai-compatible", listing: "vllm", baseURL: "http://127.0.0.1:8000/v1", local: true,
    probeURL: "http://127.0.0.1:8000/v1/models", description: "Local or self-hosted vLLM server",
  },
  custom: {
    name: "OpenAI-compatible", kind: "openai-compatible", listing: "openai-compatible", local: false,
    description: "Any OpenAI-compatible endpoint (requires --base-url)",
  },
};

/** Model reference "<providerId>/<modelId>"; the model id itself may contain slashes. */
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`invalid model reference '${ref}', expected <provider>/<model>`);
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function formatModelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function createLanguageModel(provider: ProviderConfig, modelId: string, apiKey: string | undefined): LanguageModel {
  const baseURL = provider.baseURL;
  const auth = <T extends object>(settings: T) => ({ ...settings, ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) });

  switch (provider.kind) {
    case "openai":
      return createOpenAI(auth({}))(modelId);
    case "anthropic":
      return createAnthropic(auth({}))(modelId);
    case "google":
      return createGoogle(auth({}))(modelId);
    case "mistral":
      return createMistral(auth({}))(modelId);
    case "openrouter":
      return createOpenRouter(auth({}))(modelId);
    case "openai-compatible":
      if (!baseURL) throw new Error(`provider '${provider.id}' needs a base URL`);
      return createOpenAICompatible({
        name: provider.id,
        baseURL,
        ...(apiKey ? { apiKey } : {}),
        includeUsage: true,
        supportsStructuredOutputs: true,
      })(modelId);
  }
}
