/**
 * Live preview of the editor capture: every picture the capture takes reaches the job that started it (through
 * AsyncLocalStorage – jobs run side by side), at most five per second, scaled down, as a PNG data URL.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { encodePng, guiPreview, type Image } from "@vst-cloner/clone";

export type PreviewSink = (src: string, label: string) => void;

/** the preview receiver of the job a piece of work belongs to */
export const jobPreview = new AsyncLocalStorage<PreviewSink>();

const MIN_INTERVAL_MS = 200;
const MAX_WIDTH = 520;
const state = new WeakMap<PreviewSink, { last: number; busy: boolean }>();

/** Box-filtered copy at most `maxWidth` wide (pictures are shown small). */
export function scaleDown(image: Image, maxWidth: number): Image {
  const factor = Math.ceil(image.width / maxWidth);
  if (factor <= 1) return image;
  const width = Math.floor(image.width / factor), height = Math.floor(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const p = ((y * factor + dy) * image.width + x * factor + dx) * 4;
      r += image.data[p]!; g += image.data[p + 1]!; b += image.data[p + 2]!;
    }
    const n = factor * factor, q = (y * width + x) * 4;
    data[q] = r / n; data[q + 1] = g / n; data[q + 2] = b / n; data[q + 3] = 255;
  }
  return { width, height, data };
}

guiPreview.listener = (picture) => {
  const sink = jobPreview.getStore();
  if (!sink) return;
  const s = state.get(sink) ?? { last: 0, busy: false };
  state.set(sink, s);
  const now = Date.now();
  if (s.busy || now - s.last < MIN_INTERVAL_MS) return;
  s.busy = true;
  s.last = now;
  void (async () => {
    try {
      const data = new Uint8Array(await readFile(picture.file));
      if (data.length < picture.width * picture.height * 4) return;
      const small = scaleDown({ width: picture.width, height: picture.height, data }, MAX_WIDTH);
      sink(`data:image/png;base64,${Buffer.from(encodePng(small, { opaque: true, level: 1 })).toString("base64")}`, picture.label);
    } catch {
      // a picture that is gone already: the next one follows
    } finally {
      s.busy = false;
    }
  })();
};
