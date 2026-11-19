import { fft } from "./fft.ts";

const FRAME = 4096;
/** third-octave bands from 63 Hz to 16 kHz (centre frequencies; the edges lie a sixth of an octave either side) */
const CENTRES = Array.from({ length: 25 }, (_, i) => 63 * 2 ** (i / 3));
/**
 * Band energies more than this far below the loudest band of the original count as silence. With 60 dB a clone
 * at 0.65 % error (gxts9) still showed 2.9 dB from bands near the floor; with 40 dB it shows 0.9 dB, and the order
 * of clones that differ (ZamDelay, MVerb: class engine vs. network) stays the same.
 */
const FLOOR_DB = 40;

function bandEnergies(signal: Float32Array, sampleRate: number): Float64Array[] {
  const window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const edges = CENTRES.map((c) => [Math.max(1, Math.round((c * 2 ** (-1 / 6) * FRAME) / sampleRate)), Math.round((c * 2 ** (1 / 6) * FRAME) / sampleRate)] as const);
  const frames: Float64Array[] = [];
  for (let start = 0; start + FRAME <= signal.length; start += FRAME) {
    const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) re[i] = signal[start + i]! * window[i]!;
    fft(re, im);
    const bands = new Float64Array(CENTRES.length);
    edges.forEach(([lo, hi], b) => {
      let e = 0;
      for (let k = lo; k <= Math.min(hi, FRAME / 2); k++) e += re[k]! ** 2 + im[k]! ** 2;
      bands[b] = e;
    });
    frames.push(bands);
  }
  return frames;
}

/**
 * Spectral deviation of a clone from the original in dB: the level difference of third-octave bands in consecutive
 * frames of 85 ms (at 48 kHz), averaged over all bands that are audible in either signal. Unlike the error-to-signal
 * ratio it ignores the phase, so a reverb or chorus that sounds the same but whose diffuse tail differs sample by
 * sample is not counted as wrong; levels, tone and how they develop over time are.
 */
export function spectralDeviationDb(original: Float32Array, clone: Float32Array, sampleRate: number): number {
  const n = Math.min(original.length, clone.length);
  const a = bandEnergies(original.subarray(0, n), sampleRate);
  const b = bandEnergies(clone.subarray(0, n), sampleRate);
  let loudest = 0;
  for (const frame of a) for (const e of frame) loudest = Math.max(loudest, e);
  if (loudest === 0) return 0;
  const floor = loudest * 10 ** (-FLOOR_DB / 10);
  let sum = 0, count = 0;
  for (let f = 0; f < a.length; f++) {
    for (let k = 0; k < CENTRES.length; k++) {
      const x = a[f]![k]!, y = b[f]![k]!;
      if (x < floor && y < floor) continue;
      sum += Math.abs(10 * Math.log10(Math.max(x, floor) / Math.max(y, floor)));
      count++;
    }
  }
  return count ? sum / count : 0;
}
