export interface AppInfo {
  version: string;
  platform: string;
  node: string;
  dataDir: string;
  profilesDir: string;
  clonesDir: string;
  llmConfig: string;
  host: { found: boolean; path?: string; version?: string };
  tools: { cmake: boolean; compiler: boolean };
}

export interface PluginEntry {
  path: string;
  name: string;
  format: "VST3" | "LV2";
  source: "native" | "yabridge";
  clone: boolean;
}

export interface PluginInfo {
  path: string;
  name: string;
  manufacturer: string;
  version: string;
  format: string;
  category: string;
  inputs: number;
  outputs: number;
  latency: number;
  parameters: number;
  eq?: { bands: number; shapes: string[]; renders: number };
  /** compressor/limiter recognised by its parameter names */
  dynamics?: { roles: string[]; renders: number };
  genericRenders: number;
}

export interface CaptureResult {
  profile: string;
  renders: number;
  bytes: number;
  name: string;
}

export interface ProfileSummary {
  path: string;
  file: string;
  bytes: number;
  name: string;
  manufacturer: string;
  format: string;
  createdAt: string;
  renders: number;
  planner: string;
  hasModel: boolean;
  verdict?: string;
  rmsDb?: number;
  pluginName?: string;
}

export interface CloneResult {
  kind: "eq" | "dynamics";
  pluginName: string;
  vst3: string;
  lv2: string;
  installed: string[];
  shapes: { label: string; kind: string; supported: boolean; note?: string; check?: number }[];
  /** compressors: description of the model and comparison with the original */
  summary?: string[];
  dynamics?: {
    overall: { rmsDb: number; maxDb: number };
    validate?: { rmsDb: number; maxDb: number };
    worst: { label: string; rmsDb: number; maxDb: number }[];
    verdict: string;
    renders: number;
  };
  /** rebuilt editor: number of controls, similarity with the original editor (0…1) */
  gui?: { controls: number; similarity?: number; colorSimilarity?: number; comparePng?: string };
  verify?: {
    overall: { renders: number; rmsDb: number; maxDb: number };
    limited?: { renders: number; rmsDb: number; maxDb: number; labels: string[] };
    shapes: { label: string; renders: number; rmsDb: number; maxDb: number; verdict: string }[];
    verdict: string;
  };
}
