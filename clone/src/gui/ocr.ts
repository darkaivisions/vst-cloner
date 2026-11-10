import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { colorDistance, encodePng, pixel, type Box, type Image, type Rgb } from "./image.ts";

/** Text recognition of editor labels with tesseract (optional – without it labels are derived from parameter names). */

const EXE = process.platform === "win32" ? "tesseract.exe" : "tesseract";

let cachedPath: string | null | undefined;

/** Path of tesseract ($VCH_TESSERACT, PATH, usual Windows location) or undefined. */
export function findTesseract(): string | undefined {
  if (cachedPath !== undefined) return cachedPath ?? undefined;
  const candidates = [
    process.env.VCH_TESSERACT,
    ...(process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, EXE)),
    ...(process.platform === "win32" ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Tesseract-OCR", EXE)] : []),
  ];
  cachedPath = candidates.find((p): p is string => Boolean(p) && existsSync(p!)) ?? null;
  return cachedPath ?? undefined;
}

export interface OcrResult {
  text: string;
  /** bounding box of the recognised words in image coordinates (ink only) */
  box?: Box;
  /** mean word confidence, 0…100 */
  confidence: number;
}

const SCALE = 4;
const PAD = 12;

/**
 * Renders a text block as dark text on white (whatever the original colours), enlarged for recognition.
 * Each pixel is placed on the line between background and text colour.
 */
export function prepareTextImage(img: Image, box: Box, text: Rgb, background: Rgb): Image {
  const span = Math.max(30, colorDistance(text, background));
  const w = box.w * SCALE + 2 * PAD, h = box.h * SCALE + 2 * PAD;
  const out: Image = { width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) };
  const ink = (x: number, y: number) => {
    const cx = Math.min(img.width - 1, Math.max(0, x)), cy = Math.min(img.height - 1, Math.max(0, y));
    // 0 = background, 1 = full text colour (small deviations from the background count as background)
    return Math.min(1, Math.max(0, (colorDistance(pixel(img, cx, cy), background) / span - 0.15) / 0.7));
  };
  for (let y = 0; y < box.h * SCALE; y++) {
    for (let x = 0; x < box.w * SCALE; x++) {
      // bilinear sampling of the ink amount
      const sx = box.x + (x + 0.5) / SCALE - 0.5, sy = box.y + (y + 0.5) / SCALE - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const v = ink(x0, y0) * (1 - fx) * (1 - fy) + ink(x0 + 1, y0) * fx * (1 - fy) + ink(x0, y0 + 1) * (1 - fx) * fy + ink(x0 + 1, y0 + 1) * fx * fy;
      const g = Math.round(255 * (1 - v));
      const i = ((y + PAD) * w + x + PAD) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = g;
    }
  }
  return out;
}

/** Parses tesseract's TSV output: words of level 5 with their confidence. */
export function parseTsv(tsv: string): OcrResult | undefined {
  const words: { text: string; conf: number; left: number; top: number; width: number; height: number }[] = [];
  for (const line of tsv.split("\n").slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue;
    const text = cols[11]!.trim();
    const conf = Number(cols[10]);
    if (text && conf >= 0) words.push({ text, conf, left: Number(cols[6]), top: Number(cols[7]), width: Number(cols[8]), height: Number(cols[9]) });
  }
  // icons at the edges (checkboxes, arrows) are read as symbol-only words; uncertain words are noise
  const hasAlnum = (t: string) => /[\p{L}\p{N}]/u.test(t);
  while (words.length && (!hasAlnum(words[0]!.text) || words[0]!.conf < 40)) words.shift();
  while (words.length && (!hasAlnum(words[words.length - 1]!.text) || words[words.length - 1]!.conf < 40)) words.pop();
  if (!words.length) return undefined;
  const letters = words.reduce((n, w) => n + w.text.length, 0);
  const left = Math.min(...words.map((w) => w.left)), top = Math.min(...words.map((w) => w.top));
  const right = Math.max(...words.map((w) => w.left + w.width)), bottom = Math.max(...words.map((w) => w.top + w.height));
  return {
    text: words.map((w) => w.text).join(" "),
    confidence: words.reduce((s, w) => s + w.conf * w.text.length, 0) / letters,
    box: { x: left, y: top, w: right - left, h: bottom - top },
  };
}

/** Converts a box in the prepared (enlarged, padded) image back to image coordinates. */
const toImage = (b: Box, origin: Box): Box => {
  const x = origin.x + (b.x - PAD) / SCALE, y = origin.y + (b.y - PAD) / SCALE;
  const x2 = origin.x + (b.x + b.w - PAD) / SCALE, y2 = origin.y + (b.y + b.h - PAD) / SCALE;
  return { x: Math.floor(x), y: Math.floor(y), w: Math.max(1, Math.ceil(x2) - Math.floor(x)), h: Math.max(1, Math.ceil(y2) - Math.floor(y)) };
};

/** Recognises several single-line text blocks. Returns undefined entries for blocks without a usable result. */
export async function recognizeBlocks(
  img: Image,
  blocks: { box: Box; color: Rgb; background: Rgb }[],
  options: { languages?: string; concurrency?: number } = {},
): Promise<(OcrResult | undefined)[]> {
  const exe = findTesseract();
  if (!exe || !blocks.length) return blocks.map(() => undefined);
  const dir = await mkdtemp(join(tmpdir(), "vch-ocr-"));
  try {
    const results: (OcrResult | undefined)[] = new Array(blocks.length).fill(undefined);
    let next = 0;
    const worker = async () => {
      while (next < blocks.length) {
        const i = next++;
        const { box, color, background } = blocks[i]!;
        const file = join(dir, `${i}.png`);
        await writeFile(file, encodePng(prepareTextImage(img, box, color, background)));
        const tsv = await new Promise<string>((resolve) => {
          execFile(exe, [file, "stdout", "-l", options.languages ?? "eng+deu", "--psm", "7", "-c", "tessedit_do_invert=0", "tsv"],
            { timeout: 15000, env: { ...process.env, OMP_THREAD_LIMIT: "1" } },
            (error, stdout) => resolve(error ? "" : stdout));
        });
        const result = parseTsv(tsv);
        results[i] = result && result.box ? { ...result, box: toImage(result.box, box) } : result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, blocks.length) }, worker));
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether a recognised text looks like real text (not noise from icons or graphics). */
export function plausibleText(result: OcrResult | undefined, minConfidence = 70): result is OcrResult {
  if (!result || result.confidence < minConfidence) return false;
  const t = result.text;
  const alnum = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alnum === 0) return false;
  const numeric = /^[+-]?[\d.,]+\s*(%|dB|Hz|kHz|ms|s)?$/i.test(t);
  if (alnum === 1 && !numeric) return false;
  // very short words that are no numbers are often misread graphics – require more certainty
  if (alnum <= 3 && !numeric && result.confidence < 88) return false;
  // mostly symbols → probably an icon
  return alnum / t.replace(/\s/g, "").length >= 0.5;
}
