import { decodeWav, type Profile, type Segment } from "@vst-cloner/profile";
import { fft, nextPowerOfTwo } from "./fft.ts";

/** Log-spaced analysis frequencies (default 1/24 octave from 20 Hz to 20 kHz or 0.45·fs). */
export function logGrid(sampleRate: number, pointsPerOctave = 24, fMin = 20, fMax = 20000): Float64Array {
  const top = Math.min(fMax, 0.45 * sampleRate);
  const count = Math.floor(Math.log2(top / fMin) * pointsPerOctave) + 1;
  const grid = new Float64Array(count);
  for (let i = 0; i < count; i++) grid[i] = fMin * 2 ** (i / pointsPerOctave);
  return grid;
}

/** Magnitude response in dB of an impulse response at the given frequencies. */
export function magnitudeDb(impulse: Float32Array | Float64Array, sampleRate: number, frequencies: Float64Array): Float64Array {
  const size = nextPowerOfTwo(impulse.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(impulse);
  fft(re, im);

  const result = new Float64Array(frequencies.length);
  const binHz = sampleRate / size;
  const db = (k: number) => 10 * Math.log10(Math.max(re[k]! ** 2 + im[k]! ** 2, 1e-30));

  for (let i = 0; i < frequencies.length; i++) {
    const position = frequencies[i]! / binHz;
    const k = Math.floor(position);
    const t = position - k;
    result[i] = k + 1 < size / 2 ? db(k) * (1 - t) + db(k + 1) * t : db(Math.min(k, size / 2));
  }
  return result;
}

export function findSegment(profile: Profile, kind: Segment["kind"]): Segment {
  const segment = profile.testSignals.segments.find((s) => s.kind === kind);
  if (!segment) throw new Error(`profile has no '${kind}' segment in its test signal`);
  return segment;
}

/** Impulse response of a capture (first channel), cut from the impulse segment and scaled to unit amplitude. */
export function captureImpulseResponse(profile: Profile, renderId: string): Float32Array {
  const render = profile.captures.renders.find((r) => r.id === renderId);
  if (!render) throw new Error(`unknown render ${renderId}`);
  const data = profile.files.get(render.file);
  if (!data) throw new Error(`missing ${render.file}`);

  const segment = findSegment(profile, "impulse");
  const amplitude = segment.params?.amplitude ?? 1;
  const audio = decodeWav(data);
  const channel = audio.channels[0]!;
  const ir = channel.slice(segment.start, segment.start + segment.length);
  for (let i = 0; i < ir.length; i++) ir[i] = ir[i]! / amplitude;
  return ir;
}

/** Levels below this are not compared: measurements end in numerical noise far below audibility. */
export const COMPARE_FLOOR_DB = -80;

const floored = (v: number) => Math.max(v, COMPARE_FLOOR_DB);

export function rmsDifference(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (floored(a[i]!) - floored(b[i]!)) ** 2;
  return Math.sqrt(sum / a.length);
}

export function maxDifference(a: Float64Array, b: Float64Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(floored(a[i]!) - floored(b[i]!)));
  return max;
}
