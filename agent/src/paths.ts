import { homedir } from "node:os";
import { join } from "node:path";

const APP = "vst-cloner";

/** Per-user configuration directory (override with VCH_CONFIG_DIR). */
export function configDir(): string {
  if (process.env.VCH_CONFIG_DIR) return process.env.VCH_CONFIG_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", APP);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP);
}

/** Per-user cache directory (override with VCH_CACHE_DIR). */
export function cacheDir(): string {
  if (process.env.VCH_CACHE_DIR) return process.env.VCH_CACHE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP, "cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", APP);
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), APP);
}
