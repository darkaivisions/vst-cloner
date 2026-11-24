/**
 * Live view of a job for the app's side panel: every render vch-host writes (measuring the original, verifying the
 * clone) is boiled down to a level curve and a third-octave spectrum of input and output, together with the
 * controls that differ from their default; training and the rebuilt editor arrive through `liveEvents`.
 * Jobs run side by side, so everything is routed through AsyncLocalStorage to the job it belongs to.
 * At most four renders per second are summarised – the newest wins, the ones in between are skipped.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { hostRenders, liveEvents, type HostRendered, type LiveEvent } from "@vst-cloner/capture";
import { fft } from "@vst-cloner/clone";
import { decodeWav, readCapture, readProfile, type Audio, type Parameter, type Profile } from "@vst-cloner/profile";

/** points of a level curve */
const ENVELOPE_POINTS = 240;
/** third-octave band centres from 25 Hz to 20 kHz */
export const BAND_CENTRES = Array.from({ length: 30 }, (_, i) => 25 * Math.pow(2, i / 3));
const FFT_SIZE = 4096;
/** frames averaged for a spectrum (spread over the whole render) */
const MAX_FRAMES = 48;
const MIN_INTERVAL_MS = 250;
const FLOOR_DB = -120;

export type LivePhase = "measure" | "verify";

/** A render as the app draws it. Levels in dBFS; `ref*` is the original's render of the same setting (verifying). */
export interface LiveAudio {
  type: "audio";
  phase: LivePhase;
  id: string;
  /** controls away from their default, as the plugin names and shows them */
  controls: { name: string; text: string }[];
  seconds: number;
  envIn: number[];
  envOut: number[];
  envRef?: number[];
  bandsIn: number[];
  bandsOut: number[];
  bandsRef?: number[];
}

export type LiveData = LiveAudio | LiveEvent;

export interface JobLive {
  send: (data: LiveData) => void;
  /** what the job is doing now; renders of the clone are compared with the original */
  phase: LivePhase;
  parameters?: Parameter[];
  /** the measured profile (verifying): its renders are the reference */
  profilePath?: string;
  /** every render as it arrives, before throttling (the live editor follows them) */
  onRendered?: (render: HostRendered) => void;
}

export const jobLive = new AsyncLocalStorage<JobLive>();

interface State {
  busy: boolean;
  last: number;
  pending?: HostRendered;
  inputs: Map<string, Promise<Audio>>;
  profile?: Promise<Profile | undefined>;
}
const states = new WeakMap<JobLive, State>();

hostRenders.listener = (render) => {
  const live = jobLive.getStore();
  if (!live) return;
  live.onRendered?.(render);
  const state: State = states.get(live) ?? { busy: false, last: 0, inputs: new Map() };
  states.set(live, state);
  state.pending = render;
  void drain(live, state);
};

liveEvents.listener = (event) => jobLive.getStore()?.send(event);

async function drain(live: JobLive, state: State): Promise<void> {
  if (state.busy || !state.pending) return;
  const wait = state.last + MIN_INTERVAL_MS - Date.now();
  state.busy = true;
  try {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const render = state.pending;
    state.pending = undefined;
    if (!render) return;
    state.last = Date.now();
    const summary = await summarise(live, state, render);
    if (summary) live.send(summary);
  } catch {
    // a render file that is gone already (the job cleaned up): the next one follows
  } finally {
    state.busy = false;
  }
  if (state.pending) void drain(live, state);
}

async function summarise(live: JobLive, state: State, render: HostRendered): Promise<LiveAudio | undefined> {
  if (!state.inputs.has(render.input)) state.inputs.set(render.input, readFile(render.input).then((b) => decodeWav(new Uint8Array(b))));
  const [input, output] = await Promise.all([state.inputs.get(render.input)!, readFile(render.output).then((b) => decodeWav(new Uint8Array(b)))]);
  const seconds = output.channels[0]!.length / output.sampleRate;
  const original = live.phase === "verify" ? await originalRender(live, state, render.id) : undefined;
  const reference = original?.audio;
  // the clone numbers its parameters its own way: the setting is named as the original's render of it
  const controls = original
    ? changedControls(original.parameters, original.params)
    : changedControls(live.parameters, render.params);
  return {
    type: "audio",
    phase: live.phase,
    id: render.id,
    controls,
    seconds,
    envIn: envelope(input, seconds),
    envOut: envelope(output, seconds),
    bandsIn: bands(input),
    bandsOut: bands(output),
    ...(reference ? { envRef: envelope(reference, seconds), bandsRef: bands(reference) } : {}),
  };
}

/** the original's render with the same id, from the profile (read once per job) */
async function originalRender(live: JobLive, state: State, id: string): Promise<{ audio: Audio; params: HostRendered["params"]; parameters: Parameter[] } | undefined> {
  if (!live.profilePath) return undefined;
  state.profile ??= readProfile(live.profilePath).catch(() => undefined);
  const profile = await state.profile;
  const render = profile?.captures.renders.find((r) => r.id === id);
  if (!profile || !render) return undefined;
  return { audio: readCapture(profile, render), params: render.params.map((p) => ({ index: p.index, value: p.value, text: p.text ?? "" })), parameters: profile.parameters.parameters };
}

function changedControls(parameters: Parameter[] | undefined, params: HostRendered["params"]): LiveAudio["controls"] {
  const byIndex = new Map((parameters ?? []).map((p) => [p.index, p]));
  return params
    .filter((p) => {
      const parameter = byIndex.get(p.index);
      return parameter && !parameter.meta && Math.abs(p.value - parameter.default) > 1e-4;
    })
    .map((p) => ({ name: byIndex.get(p.index)!.name, text: p.text }));
}

const db = (power: number) => (power > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(power)) : FLOOR_DB);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** RMS level in ENVELOPE_POINTS equal slices of `seconds` (all channels together), in dBFS */
export function envelope(audio: Audio, seconds: number): number[] {
  const slice = (seconds * audio.sampleRate) / ENVELOPE_POINTS;
  const result: number[] = [];
  for (let k = 0; k < ENVELOPE_POINTS; k++) {
    const from = Math.floor(k * slice), to = Math.max(from + 1, Math.floor((k + 1) * slice));
    let sum = 0, n = 0;
    for (const channel of audio.channels) {
      for (let i = from; i < Math.min(to, channel.length); i++) sum += channel[i]! * channel[i]!;
      n += Math.max(0, Math.min(to, channel.length) - from);
    }
    result.push(round1(n ? db(sum / n) : FLOOR_DB));
  }
  return result;
}

/** level per third-octave band (Hann-windowed frames averaged over the render, first channel), in dB */
export function bands(audio: Audio): number[] {
  const x = audio.channels[0]!;
  const power = new Float64Array(FFT_SIZE / 2);
  const frames = Math.max(1, Math.min(MAX_FRAMES, Math.floor(x.length / FFT_SIZE)));
  const hop = frames > 1 ? (x.length - FFT_SIZE) / (frames - 1) : 0;
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const start = Math.floor(f * hop);
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
      im[i] = 0;
    }
    fft(re, im);
    for (let i = 0; i < FFT_SIZE / 2; i++) power[i]! += re[i]! * re[i]! + im[i]! * im[i]!;
  }
  const binHz = audio.sampleRate / FFT_SIZE;
  // normalised so that a full-scale sine reads about 0 dB in its band
  const norm = 4 / (frames * FFT_SIZE * FFT_SIZE * 0.375);
  return BAND_CENTRES.map((centre) => {
    const lo = centre / Math.pow(2, 1 / 6), hi = centre * Math.pow(2, 1 / 6);
    let sum = 0;
    for (let i = Math.max(1, Math.floor(lo / binHz)); i <= Math.min(FFT_SIZE / 2 - 1, Math.ceil(hi / binHz)); i++) {
      const f = i * binHz;
      if (f >= lo && f < hi) sum += power[i]!;
    }
    // bands narrower than one bin (low frequencies): the nearest bin
    if (sum === 0) sum = power[Math.min(FFT_SIZE / 2 - 1, Math.max(1, Math.round(centre / binHz)))]!;
    return round1(db(sum * norm));
  });
}
