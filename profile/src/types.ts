export const PROFILE_FORMAT = "vcprofile";
export const SCHEMA_VERSION = 1;

export interface PluginInfo {
  name: string;
  descriptiveName?: string;
  manufacturer: string;
  version: string;
  format: string;
  category?: string;
  identifier: string;
  uniqueId?: number;
  isInstrument?: boolean;
  mainInputChannels?: number;
  mainOutputChannels?: number;
  latencySamples?: number;
  tailSeconds?: number;
  file?: { name: string; sha256: string };
}

export interface CaptureSettings {
  host: { name: string; version: string };
  os: string;
  sampleRate: number;
  blockSize: number;
  channels: number;
  prerollSeconds: number;
  tailSeconds: number;
  plan?: Record<string, unknown>;
}

export interface Manifest {
  format: typeof PROFILE_FORMAT;
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  createdAt: string;
  generator: { name: string; version: string };
  plugin: PluginInfo;
  capture: CaptureSettings;
  notes?: string;
}

export interface ParameterText {
  value: number;
  text: string;
}

export interface Parameter {
  index: number;
  id: string;
  name: string;
  label?: string;
  default: number;
  value?: number;
  numSteps: number;
  discrete: boolean;
  boolean: boolean;
  automatable: boolean;
  meta?: boolean;
  category?: number;
  texts?: ParameterText[];
}

export interface ParameterSet {
  parameters: Parameter[];
}

export type SegmentKind = "silence" | "impulse" | "logSweep" | "noise" | "levelSteps" | "toneBurst";

export interface Segment {
  id: string;
  kind: SegmentKind;
  start: number;
  length: number;
  params?: Record<string, number>;
}

export interface TestSignalSet {
  generatorVersion: number;
  sampleRate: number;
  channels: number;
  length: number;
  sha256: string;
  segments: Segment[];
}

export interface ParameterValue {
  index: number;
  value: number;
  text?: string;
}

export type RenderKind = "default" | "sweep" | "random" | "custom";

export interface CaptureRender {
  id: string;
  file: string;
  kind: RenderKind;
  sweepParameter?: number;
  params: ParameterValue[];
  latencySamples: number;
  peak: number;
}

export interface CaptureIndex {
  renders: CaptureRender[];
}

export interface Profile {
  manifest: Manifest;
  parameters: ParameterSet;
  testSignals: TestSignalSet;
  captures: CaptureIndex;
  /** Additional files by archive path, e.g. "captures/r0001.wav", "spec.md", "model/clone.dsp". */
  files: Map<string, Uint8Array>;
}
