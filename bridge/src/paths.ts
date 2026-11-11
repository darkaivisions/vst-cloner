import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { scanPlugins as scanAll } from "@vst-cloner/capture";
import { homedir } from "node:os";
import { join } from "node:path";

/** User data directory for profiles and clones (override with VCH_DATA_DIR). */
export function dataDir(): string {
  if (process.env.VCH_DATA_DIR) return process.env.VCH_DATA_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "vst-cloner");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "vst-cloner");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "vst-cloner");
}

export const profilesDir = () => join(dataDir(), "profiles");
export const clonesDir = () => join(dataDir(), "clones");

export type { PluginEntry } from "@vst-cloner/capture";

/** Finds VST3 and LV2 bundles in the standard plugin folders (without loading them); marks own clones. */
export const scanPlugins = () => scanAll({ clonesDir: clonesDir() });

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
