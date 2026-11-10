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
  /** overdrive/distortion recognised by a drive control or its category */
  distortion?: { roles: string[]; renders: number; signalSeconds: number };
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
  kind: "eq" | "dynamics" | "distortion";
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
  /** distortion: errors of the characteristics (small signal and fundamental in dB, harmonics in dB) */
  distortion?: {
    overall: DistortionErrors;
    validate?: DistortionErrors;
    /** time-domain error-to-signal ratio on loud noise (dB) */
    esrDb: number;
    worst: { label: string; total: number; esrDb: number }[];
    verdict: string;
    renders: number;
  };
  /** rebuilt editor: number of controls, similarity with the original editor (0…1) */
  gui?: { controls: number; similarity?: number; colorSimilarity?: number; comparePng?: string; preview?: string };
  verify?: {
    overall: { renders: number; rmsDb: number; maxDb: number };
    limited?: { renders: number; rmsDb: number; maxDb: number; labels: string[] };
    shapes: { label: string; renders: number; rmsDb: number; maxDb: number; verdict: string }[];
    verdict: string;
  };
}

/** Everything the library shows about a saved profile (bridge: profiles.details). */
export interface ProfileDetails {
  path: string;
  file: string;
  bytes: number;
  plugin: { name: string; manufacturer: string; version: string; format: string; category: string; file: string; channels: string; latency: number; parameters: number };
  capture: {
    createdAt: string;
    planner: string;
    plannerName: string;
    sampleRate: number;
    blockSize: number;
    host: string;
    os: string;
    renders: number;
    sweeps: number;
    random: number;
    train: number;
    validate: number;
    notes: string;
  };
  signal?: { seconds: number; segments: { id: string; kind: string; seconds: number }[] };
  parameters: { name: string; from: string; to: string; initial: string; discrete: boolean }[];
  model?: { kind: string; summary: string[] };
  verdict?: { value: number; text: string; pluginName?: string };
  /** editor layout as SVG data URL; comparison original | clone (PNG data URL) if it is in the local cache */
  gui?: { layout: string; controls: number; width: number; height: number; compare?: string };
}

export interface DistortionErrors {
  smallDb: number;
  gainDb: number;
  harmonicsDb: number;
  total: number;
}
