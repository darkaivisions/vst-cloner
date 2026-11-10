import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

/** 8-bit RGBA image. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rgb = [number, number, number];

export async function loadRaw(path: string, width: number, height: number): Promise<Image> {
  const data = new Uint8Array(await readFile(path));
  if (data.length !== width * height * 4) throw new Error(`${path}: expected ${width}×${height} RGBA`);
  return { width, height, data };
}

export function pixel(img: Image, x: number, y: number): Rgb {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/** Binary mask of pixels whose colour differs by more than `threshold` (max channel difference). */
export function diffMask(a: Image, b: Image, threshold = 24, exclude?: Uint8Array): Uint8Array {
  const mask = new Uint8Array(a.width * a.height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (exclude?.[p]) continue;
    const d = Math.max(Math.abs(a.data[i]! - b.data[i]!), Math.abs(a.data[i + 1]! - b.data[i + 1]!), Math.abs(a.data[i + 2]! - b.data[i + 2]!));
    if (d > threshold) mask[p] = 1;
  }
  return mask;
}

export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) n += v;
  return n;
}

/** Grows a mask by `radius` pixels (square structuring element), separable distance passes. */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number, radiusY = radius): Uint8Array {
  if (radius <= 0 && radiusY <= 0) return mask;
  const pass = (input: Uint8Array, count: number, length: number, index: (line: number, i: number) => number, radius: number) => {
    const out = new Uint8Array(input.length);
    const forward = new Float64Array(length);
    for (let line = 0; line < count; line++) {
      let d = Infinity;
      for (let i = 0; i < length; i++) {
        d = input[index(line, i)] ? 0 : d + 1;
        forward[i] = d;
      }
      d = Infinity;
      for (let i = length - 1; i >= 0; i--) {
        d = input[index(line, i)] ? 0 : d + 1;
        if (Math.min(d, forward[i]!) <= radius) out[index(line, i)] = 1;
      }
    }
    return out;
  };
  const horizontal = radius > 0 ? pass(mask, height, width, (y, x) => y * width + x, radius) : mask;
  return radiusY > 0 ? pass(horizontal, width, height, (x, y) => y * width + x, radiusY) : horizontal;
}

export interface Component extends Box {
  pixels: number;
  cx: number;
  cy: number;
}

/** Connected components (8-neighbourhood) of a mask, largest first. */
export function components(mask: Uint8Array, width: number, height: number, minPixels = 1): Component[] {
  const labels = new Int32Array(mask.length);
  const result: Component[] = [];
  const stack: number[] = [];
  let label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let minX = width, minY = height, maxX = 0, maxY = 0, count = 0, sumX = 0, sumY = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack.push(q);
          }
        }
      }
    }
    if (count >= minPixels) result.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, pixels: count, cx: sumX / count, cy: sumY / count });
  }
  return result.sort((a, b) => b.pixels - a.pixels);
}

export function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

export function overlaps(a: Box, b: Box, margin = 0): boolean {
  return a.x - margin < b.x + b.w && b.x - margin < a.x + a.w && a.y - margin < b.y + b.h && b.y - margin < a.y + a.h;
}

/** Median colour of the pixels in a box (optionally only where `mask` is set). */
export function medianColor(img: Image, box: Box, mask?: Uint8Array): Rgb {
  const channels: number[][] = [[], [], []];
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (mask && !mask[y * img.width + x]) continue;
      const i = (y * img.width + x) * 4;
      channels[0]!.push(img.data[i]!);
      channels[1]!.push(img.data[i + 1]!);
      channels[2]!.push(img.data[i + 2]!);
    }
  }
  const median = (v: number[]) => (v.length ? v.sort((a, b) => a - b)[v.length >> 1]! : 0);
  return [median(channels[0]!), median(channels[1]!), median(channels[2]!)];
}

/** Most frequent colour after quantization (5 bits per channel). */
export function dominantColor(img: Image, box: Box, mask?: Uint8Array): Rgb {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = Math.max(0, box.y); y < Math.min(img.height, box.y + box.h); y++) {
    for (let x = Math.max(0, box.x); x < Math.min(img.width, box.x + box.w); x++) {
      if (mask && !mask[y * img.width + x]) continue;
      const i = (y * img.width + x) * 4;
      const r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      entry.n++;
      entry.r += r;
      entry.g += g;
      entry.b += b;
      counts.set(key, entry);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : [0, 0, 0];
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

// ---- PNG encoding (previews) -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(img: Image): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, img.width);
  view.setUint32(4, img.height);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) raw.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * (img.width * 4 + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
