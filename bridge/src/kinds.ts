import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginInfo, type HostInfo } from "@vst-cloner/capture";
import { classifyPlugin, type EffectClass } from "@vst-cloner/clone";
import type { Parameter } from "@vst-cloner/profile";
import { dataDir } from "./paths.ts";

/** What kind of effect a plugin is: one of the classes vst-cloner has an engine for, an instrument, or another effect. */
export type PluginKind = EffectClass | "instrument" | "other" | "unknown";

/** Groups for filtering: the effect classes, plus filters, other effects and instruments. */
export type PluginGroup = EffectClass | "filter" | "other" | "instrument" | "unknown";

export interface KindInfo {
  kind: PluginKind;
  /** what the plugin does, for filtering: a phaser counts as modulation even without an engine of its own */
  group: PluginGroup;
  /** vst-cloner has an engine for its class (otherwise it becomes a universal clone) */
  engine: boolean;
  /** short name for a badge: "Reverb", "Phaser", "Instrument" … */
  label: string;
  /** the category the plugin reports ("Fx|EQ", "Phaser Plugin" …) */
  category?: string;
}

const CLASS_LABELS: Record<EffectClass, string> = {
  eq: "EQ", dynamics: "Dynamics", distortion: "Distortion", delay: "Delay", modulation: "Modulation", reverb: "Reverb",
};

/** Words of a category that say nothing about the effect. */
const GENERIC = /^(fx|effects?|plugins?|mono|stereo|surround|ambisonics?|instrument|tools?|utility|other|analy[sz]er)$/i;

/** A word for an effect without a class of its own, from its category: "Phaser Plugin" → "Phaser", "Fx|Spatial" → "Spatial". */
export function categoryLabel(category: string): string | undefined {
  for (const part of category.split("|")) {
    const word = part.trim().replace(/\s*plugin$/i, "").trim();
    if (word && !GENERIC.test(word)) return word.length > 18 ? `${word.slice(0, 17)}…` : word;
  }
  if (/tool|utility|analy[sz]er/i.test(category)) return "Utility";
  return undefined;
}

/** Group of an effect without a class engine, by the words of its category and name. */
const GROUP_PATTERNS: [PluginGroup, RegExp][] = [
  ["eq", /\beq\b|equali[sz]/i],
  ["dynamics", /compress|limit|gate|expand|dynamic|transient/i],
  ["distortion", /distort|overdrive|fuzz|satur|amp\b|amplifier|waveshap|crush/i],
  ["delay", /delay|echo/i],
  ["modulation", /chorus|flang|phas|trem|vibrat|modulat|rotary|leslie/i],
  ["reverb", /reverb|room|hall|plate/i],
  ["filter", /filter|wah/i],
];

/** The kind of a plugin from what the host reports about it (the same classification the clone flow uses). */
export function pluginKind(info: Pick<HostInfo, "parameters" | "plugin"> & Partial<Pick<HostInfo, "mainInputChannels">>): KindInfo {
  const category = info.plugin.category || undefined;
  const { effectClass } = classifyPlugin(info);
  if (effectClass) return { kind: effectClass, group: effectClass, engine: true, label: CLASS_LABELS[effectClass], ...(category ? { category } : {}) };
  if (info.plugin.isInstrument || info.mainInputChannels === 0 || /instrument|synth|generator/i.test(info.plugin.category)) {
    return { kind: "instrument", group: "instrument", engine: false, label: "Instrument", ...(category ? { category } : {}) };
  }
  const label = categoryLabel(info.plugin.category);
  const text = `${info.plugin.category} ${info.plugin.name}`;
  const group = GROUP_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
  return { kind: "other", group, engine: false, label: label ?? (group === "other" ? "Other" : GROUP_LABELS[group]), ...(category ? { category } : {}) };
}

const GROUP_LABELS: Record<PluginGroup, string> = { ...CLASS_LABELS, filter: "Filter", other: "Other", instrument: "Instrument", unknown: "?" };

/** The kind of a measured plugin from its profile (parameters and manifest): no loading needed. */
export function profileKind(manifest: { plugin?: { name?: string; category?: string } } | undefined, parameters: Parameter[]): KindInfo {
  return pluginKind({
    parameters,
    plugin: { name: manifest?.plugin?.name ?? "", category: manifest?.plugin?.category ?? "", isInstrument: false } as HostInfo["plugin"],
  });
}

// ---- cache: loading every plugin takes ~40 ms natively, seconds through yabridge – done once per plugin version ----

/** raise when the classification rules change: every plugin is looked at again */
const KIND_VERSION = 2;
const cachePath = () => join(dataDir(), "plugin-kinds.json");
type Cache = { version: number; entries: Record<string, KindInfo & { mtimeMs: number }> };
let cache: Cache | undefined;

async function loadCache(): Promise<Cache> {
  if (cache) return cache;
  try {
    const stored = JSON.parse(await readFile(cachePath(), "utf8")) as Cache;
    cache = stored.version === KIND_VERSION ? stored : { version: KIND_VERSION, entries: {} };
  } catch {
    cache = { version: KIND_VERSION, entries: {} };
  }
  return cache;
}

/** Kinds of the given plugins: from the cache where the bundle has not changed, otherwise by loading it (4 at a time). */
export async function pluginKinds(paths: string[], timeoutMs = 30_000): Promise<Record<string, KindInfo>> {
  const store = await loadCache();
  const result: Record<string, KindInfo> = {};
  let changed = false;
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        result[path] = { kind: "unknown", group: "unknown", engine: false, label: "missing" };
        continue;
      }
      const cached = store.entries[path];
      if (cached && cached.mtimeMs === mtimeMs) {
        const { mtimeMs: _, ...kind } = cached;
        result[path] = kind;
        continue;
      }
      let kind: KindInfo;
      try {
        kind = pluginKind(await pluginInfo(path, { signal: AbortSignal.timeout(timeoutMs) }));
      } catch {
        kind = { kind: "unknown", group: "unknown", engine: false, label: "does not load" };
      }
      result[path] = kind;
      store.entries[path] = { ...kind, mtimeMs };
      changed = true;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (changed) await writeFile(cachePath(), JSON.stringify(store));
  return result;
}
