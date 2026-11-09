import type { LanguageModel } from "ai";
import { findProvider, type LlmConfig } from "./config.ts";
import { describeModel, listModels, type ModelInfo } from "./models.ts";
import { createLanguageModel, formatModelRef, parseModelRef, type ProviderConfig } from "./providers.ts";
import { isRoleName } from "./roles.ts";
import { resolveApiKey, type KeySource } from "./secrets.ts";
import { UsageMeter } from "./usage.ts";

export interface ResolvedModel {
  ref: string;
  provider: ProviderConfig;
  modelId: string;
  model: LanguageModel;
  info: ModelInfo;
  keySource: KeySource;
  meter: UsageMeter;
}

/**
 * Resolves "<provider>/<model>" or a role name ("builder") to a ready-to-use model.
 * With `detailed`, metadata is fetched from the provider (e.g. context of a local model).
 */
export async function resolveModel(config: LlmConfig, refOrRole: string, options: { detailed?: boolean } = {}): Promise<ResolvedModel> {
  let ref = refOrRole;
  if (isRoleName(refOrRole)) {
    const assigned = config.roles[refOrRole];
    if (!assigned) throw new Error(`no model assigned to role '${refOrRole}'. Use 'vch llm role ${refOrRole} <provider>/<model>'.`);
    ref = assigned;
  }

  const { providerId, modelId } = parseModelRef(ref);
  const provider = findProvider(config, providerId);
  const key = await resolveApiKey(provider);

  if (!provider.local && !key.key) {
    const env = provider.env?.length ? ` or set $${provider.env[0]}` : "";
    throw new Error(`no API key for '${provider.id}'. Run 'vch llm key ${provider.id}'${env}.`);
  }

  let info: ModelInfo | undefined;
  if (options.detailed) {
    const models = await listModels(provider, key.key).catch(() => undefined);
    info = models?.find((m) => m.id === modelId);
  }
  info ??= await describeModel(provider, modelId);

  return {
    ref: formatModelRef(provider.id, modelId),
    provider,
    modelId,
    model: createLanguageModel(provider, modelId, key.key),
    info,
    keySource: key.source,
    meter: new UsageMeter(),
  };
}
