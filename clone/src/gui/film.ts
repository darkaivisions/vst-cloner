/**
 * Films of a plugin editor (vch-gui, step "film"): frames recorded while an audio programme plays. The file holds
 * per frame a header (uint32 ms, float32 input level in dBFS, uint32 size) and the frame XOR the previous one,
 * raw-deflate compressed – frames that barely change cost almost nothing.
 */
import { readFile } from "node:fs/promises";
import { inflateSync } from "fflate";
import type { FilmProgramme } from "./capture.ts";
import type { Image } from "./image.ts";

export interface FilmFrame {
  /** ms from the start of the programme */
  t: number;
  /** input level of the programme at that moment (dBFS; −200 = digital silence) */
  levelDb: number;
  image: Image;
}

/** All frames of a film, decoded. */
export async function readFilm(file: string, width: number, height: number): Promise<FilmFrame[]> {
  const bytes = await readFile(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: FilmFrame[] = [];
  let previous = new Uint8Array(width * height * 4);
  for (let at = 0; at + 12 <= bytes.length;) {
    const t = view.getUint32(at, true), levelDb = view.getFloat32(at + 4, true), size = view.getUint32(at + 8, true);
    const delta = inflateSync(bytes.subarray(at + 12, at + 12 + size));
    const data = new Uint8Array(previous.length);
    for (let i = 0; i < data.length; i++) data[i] = previous[i]! ^ (delta[i] ?? 0);
    frames.push({ t, levelDb, image: { width, height, data } });
    previous = data;
    at += 12 + size;
  }
  return frames;
}

/**
 * The programme of the meter films: digital silence, a sine rising from −60 to −3 dBFS, held, then silence again –
 * meters show their scale on the way up, gates their state in silence, and the end shows how meters fall back.
 */
export const METER_FILM: FilmProgramme = {
  frameMs: 50,
  frequency: 1000,
  segments: [{ ms: 600 }, { ms: 2400, fromDb: -60, toDb: -3 }, { ms: 500, fromDb: -3 }, { ms: 1500 }],
};

/** Start and end (ms) of each segment of a programme. */
export function segmentTimes(programme: FilmProgramme): { from: number; to: number; silent: boolean }[] {
  let t = 0;
  return programme.segments.map((s) => {
    const r = { from: t, to: t + s.ms, silent: s.fromDb === undefined };
    t += s.ms;
    return r;
  });
}
