import { decodeWav, encodeWav24, type Audio } from "./wav.ts";
import type { CaptureRender, Profile } from "./types.ts";

/**
 * A capture as stored in a profile: 24-bit PCM, divided by its peak so that the full range is used (`scale` in
 * captures.json). 24 bits relative to the peak keep everything down to −138 dB of it – far below what any fit
 * or network resolves – and take a quarter less space than 32-bit float (deflate packs them better as well:
 * ZamComp 42 → 31 MB per 40 renders).
 */
export function encodeCapture(audio: Audio): { bytes: Uint8Array; scale: number } {
  let peak = 0;
  for (const channel of audio.channels) for (const v of channel) peak = Math.max(peak, Math.abs(v));
  // the largest sample maps to the largest positive code, 8388607
  const scale = peak > 0 && Number.isFinite(peak) ? (peak * 8388608) / 8388607 : 1;
  return { bytes: encodeWav24(audio, scale), scale };
}

/** Audio of a capture at its true level: the WAV file times its `scale` (older profiles: 32-bit float, no scale). */
export function readCapture(profile: Pick<Profile, "files">, render: Pick<CaptureRender, "file" | "scale">): Audio {
  const data = profile.files.get(render.file);
  if (!data) throw new Error(`profile: ${render.file} is missing`);
  const audio = decodeWav(data);
  const scale = render.scale ?? 1;
  if (scale !== 1) for (const channel of audio.channels) for (let i = 0; i < channel.length; i++) channel[i]! *= scale;
  return audio;
}
