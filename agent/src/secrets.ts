import { AsyncEntry } from "@napi-rs/keyring";
import type { ProviderConfig } from "./providers.ts";

/**
 * API keys live in the OS credential store (Secret Service / KWallet on Linux,
 * Windows Credential Manager, macOS Keychain). Environment variables take precedence.
 */
const SERVICE = "vst-cloner";

export type KeySource = "env" | "keychain" | "none";

export interface ResolvedKey {
  key?: string;
  source: KeySource;
  /** Name of the environment variable, if the key came from there. */
  variable?: string;
}

export class KeychainError extends Error {
  constructor(action: string, cause: unknown) {
    super(
      `cannot ${action} the system keychain: ${(cause as Error)?.message ?? cause}. ` +
        "On Linux a Secret Service provider (GNOME Keyring or KWallet) must be running. " +
        "Alternatively set the provider's API key environment variable.",
    );
    this.name = "KeychainError";
  }
}

const entry = (providerId: string) => new AsyncEntry(SERVICE, `api-key:${providerId}`);

export async function resolveApiKey(provider: ProviderConfig): Promise<ResolvedKey> {
  for (const variable of provider.env ?? []) {
    const value = process.env[variable];
    if (value) return { key: value, source: "env", variable };
  }
  if (process.env.VCH_NO_KEYCHAIN) return { source: "none" };
  try {
    const key = await entry(provider.id).getPassword();
    return key ? { key, source: "keychain" } : { source: "none" };
  } catch (error) {
    throw new KeychainError("read from", error);
  }
}

export async function storeApiKey(providerId: string, key: string): Promise<void> {
  try {
    await entry(providerId).setPassword(key);
  } catch (error) {
    throw new KeychainError("write to", error);
  }
}

export async function deleteApiKey(providerId: string): Promise<boolean> {
  try {
    return await entry(providerId).deletePassword();
  } catch (error) {
    throw new KeychainError("delete from", error);
  }
}
