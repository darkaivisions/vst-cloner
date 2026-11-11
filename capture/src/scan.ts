import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export interface PluginEntry {
  path: string;
  name: string;
  format: "VST3" | "LV2";
  /** "yabridge" for bridged Windows plugins */
  source: "native" | "yabridge";
  /** built by vst-cloner */
  clone: boolean;
}

export function pluginSearchDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const common = process.env.COMMONPROGRAMFILES ?? "C:\\Program Files\\Common Files";
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(common, "VST3"), join(local, "Programs", "Common", "VST3"), join(process.env.APPDATA ?? "", "LV2")];
  }
  if (process.platform === "darwin") {
    return [join(home, "Library/Audio/Plug-Ins/VST3"), "/Library/Audio/Plug-Ins/VST3", join(home, "Library/Audio/Plug-Ins/LV2")];
  }
  return [join(home, ".vst3"), "/usr/lib/vst3", "/usr/local/lib/vst3", join(home, ".lv2"), "/usr/lib/lv2", "/usr/local/lib/lv2"];
}

async function isLv2Plugin(bundle: string): Promise<boolean> {
  try {
    const manifest = await readFile(join(bundle, "manifest.ttl"), "utf8");
    return /lv2:Plugin\b|lv2#Plugin/.test(manifest) && /\.(so|dll|dylib)\b/.test(manifest);
  } catch {
    return false;
  }
}

/** Finds VST3 and LV2 bundles in the standard plugin folders (without loading them). */
export async function scanPlugins(options: { clonesDir?: string; dirs?: string[] } = {}): Promise<PluginEntry[]> {
  const found = new Map<string, PluginEntry>();
  const clones = options.clonesDir;

  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".vst3" || (ext === ".lv2" && entry.isDirectory())) {
        if (ext === ".lv2" && !(await isLv2Plugin(path))) continue;
        const name = basename(entry.name, extname(entry.name));
        found.set(path, {
          path,
          name,
          format: ext === ".vst3" ? "VST3" : "LV2",
          source: /[\\/]yabridge[\\/]/i.test(path) ? "yabridge" : "native",
          clone: (clones !== undefined && path.startsWith(clones)) || / clone$/i.test(name),
        });
      } else if (entry.isDirectory() && depth > 0) {
        await walk(path, depth - 1);
      }
    }
  };

  for (const dir of options.dirs ?? pluginSearchDirs()) if (existsSync(dir)) await walk(dir, 3);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
}

