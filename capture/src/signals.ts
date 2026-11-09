import { encodeWav, sha256Hex, type Audio, type Segment, type SegmentKind, type TestSignalSet } from "@vst-cloner/profile";
import { createGaussian } from "./random.ts";

export const SIGNAL_GENERATOR_VERSION = 1;

const dbToGain = (db: number) => 10 ** (db / 20);

interface SegmentSpec {
  id: string;
  kind: SegmentKind;
  seconds: number;
  params?: Record<string, number>;
}

export type SignalPreset = "full" | "eq";

export const SIGNAL_PRESETS: SignalPreset[] = ["full", "eq"];

/** Short sequence for linear, time-invariant effects (EQs, filters): impulse response + sweep as cross-check. */
export function eqSegmentSpecs(sampleRate: number): SegmentSpec[] {
  return [
    { id: "lead", kind: "silence", seconds: 0.05 },
    { id: "impulse", kind: "impulse", seconds: 1, params: { amplitude: 0.5 } },
    {
      id: "sweep",
      kind: "logSweep",
      seconds: 1.5,
      params: { f1: 20, f2: Math.min(20000, 0.45 * sampleRate), amplitude: 0.25, fadeSeconds: 0.01 },
    },
    { id: "gap-1", kind: "silence", seconds: 0.25 },
  ];
}

export function segmentSpecs(preset: SignalPreset, sampleRate: number, seed = 1): SegmentSpec[] {
  return preset === "eq" ? eqSegmentSpecs(sampleRate) : defaultSegmentSpecs(sampleRate, seed);
}

/** Default measurement sequence: covers linear (impulse, sweep), nonlinear (noise) and dynamic (levels, bursts) behavior. */
export function defaultSegmentSpecs(sampleRate: number, seed = 1): SegmentSpec[] {
  const levelSteps = { frequency: 1000, fromDb: -60, toDb: 0, stepDb: 6, stepSeconds: 0.25 };
  const stepCount = Math.floor((levelSteps.toDb - levelSteps.fromDb) / levelSteps.stepDb) + 1;
  const burst = { frequency: 1000, lowDb: -30, highDb: -6, lowSeconds: 0.5, highSeconds: 0.5, releaseSeconds: 1 };

  return [
    { id: "lead", kind: "silence", seconds: 0.25 },
    { id: "impulse", kind: "impulse", seconds: 0.5, params: { amplitude: 0.5 } },
    { id: "gap-1", kind: "silence", seconds: 0.25 },
    {
      id: "sweep",
      kind: "logSweep",
      seconds: 3,
      params: { f1: 20, f2: Math.min(20000, 0.45 * sampleRate), amplitude: 0.5, fadeSeconds: 0.01 },
    },
    { id: "gap-2", kind: "silence", seconds: 0.5 },
    { id: "noise", kind: "noise", seconds: 2, params: { seed, rmsDb: -18 } },
    { id: "gap-3", kind: "silence", seconds: 0.5 },
    { id: "levels", kind: "levelSteps", seconds: stepCount * levelSteps.stepSeconds, params: levelSteps },
    { id: "gap-4", kind: "silence", seconds: 0.5 },
    {
      id: "burst",
      kind: "toneBurst",
      seconds: burst.lowSeconds + burst.highSeconds + burst.releaseSeconds,
      params: burst,
    },
  ];
}

function param(segment: Segment, name: string): number {
  const value = segment.params?.[name];
  if (value === undefined) throw new Error(`segment ${segment.id}: missing parameter '${name}'`);
  return value;
}

function renderSegment(segment: Segment, sampleRate: number, out: Float32Array): void {
  const n = segment.length;
  const o = segment.start;

  switch (segment.kind) {
    case "silence":
      return;

    case "impulse":
      out[o] = param(segment, "amplitude");
      return;

    case "logSweep": {
      const f1 = param(segment, "f1");
      const f2 = param(segment, "f2");
      const amplitude = param(segment, "amplitude");
      const fade = Math.max(1, Math.round(param(segment, "fadeSeconds") * sampleRate));
      const duration = n / sampleRate;
      const k = Math.log(f2 / f1);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const phase = ((2 * Math.PI * f1 * duration) / k) * (Math.exp((t / duration) * k) - 1);
        const envelope = Math.min(1, i / fade, (n - 1 - i) / fade);
        out[o + i] = amplitude * envelope * Math.sin(phase);
      }
      return;
    }

    case "noise": {
      const gaussian = createGaussian(param(segment, "seed"));
      const gain = dbToGain(param(segment, "rmsDb"));
      for (let i = 0; i < n; i++) out[o + i] = Math.max(-1, Math.min(1, gaussian() * gain));
      return;
    }

    case "levelSteps": {
      const frequency = param(segment, "frequency");
      const fromDb = param(segment, "fromDb");
      const stepDb = param(segment, "stepDb");
      const stepLength = Math.round(param(segment, "stepSeconds") * sampleRate);
      for (let i = 0; i < n; i++) {
        const level = fromDb + Math.floor(i / stepLength) * stepDb;
        out[o + i] = dbToGain(level) * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
      }
      return;
    }

    case "toneBurst": {
      const frequency = param(segment, "frequency");
      const low = dbToGain(param(segment, "lowDb"));
      const high = dbToGain(param(segment, "highDb"));
      const highStart = Math.round(param(segment, "lowSeconds") * sampleRate);
      const highEnd = highStart + Math.round(param(segment, "highSeconds") * sampleRate);
      for (let i = 0; i < n; i++) {
        const gain = i >= highStart && i < highEnd ? high : low;
        out[o + i] = gain * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
      }
      return;
    }
  }
}

/** Renders the signal described by a TestSignalSet (all channels identical). */
export function renderTestSignal(set: Pick<TestSignalSet, "sampleRate" | "channels" | "length" | "segments">): Audio {
  const mono = new Float32Array(set.length);
  for (const segment of set.segments) renderSegment(segment, set.sampleRate, mono);
  return {
    sampleRate: set.sampleRate,
    channels: Array.from({ length: set.channels }, () => mono.slice()),
  };
}

export function signalHash(audio: Audio): string {
  return sha256Hex(encodeWav(audio));
}

export interface GeneratedSignal {
  audio: Audio;
  set: TestSignalSet;
}

export function generateTestSignal(options: { sampleRate: number; channels: number; seed?: number; preset?: SignalPreset }): GeneratedSignal {
  const { sampleRate, channels, seed = 1, preset = "full" } = options;
  const segments: Segment[] = [];
  let start = 0;

  for (const spec of segmentSpecs(preset, sampleRate, seed)) {
    const length = Math.max(1, Math.round(spec.seconds * sampleRate));
    segments.push({ id: spec.id, kind: spec.kind, start, length, ...(spec.params ? { params: spec.params } : {}) });
    start += length;
  }

  const partial = { sampleRate, channels, length: start, segments };
  const audio = renderTestSignal(partial);
  return {
    audio,
    set: { generatorVersion: SIGNAL_GENERATOR_VERSION, preset, ...partial, sha256: signalHash(audio) },
  };
}

/** Regenerates the input signal of a profile. `verified` is false if the hash differs (e.g. other generator version). */
export function regenerateTestSignal(set: TestSignalSet): { audio: Audio; verified: boolean } {
  const audio = renderTestSignal(set);
  return { audio, verified: signalHash(audio) === set.sha256 };
}
