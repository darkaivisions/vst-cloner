import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "fflate";
import { METER_FILM, readFilm, segmentTimes } from "../src/gui/film.ts";

test("films: frames are stored as the XOR of the previous one and come back whole", async () => {
  const width = 3, height = 2;
  const frames = [new Uint8Array(24).fill(10), new Uint8Array(24).fill(10), Uint8Array.from({ length: 24 }, (_, i) => i)];
  const parts: Uint8Array[] = [];
  let previous = new Uint8Array(24);
  frames.forEach((f, k) => {
    const delta = f.map((v, i) => v ^ previous[i]!);
    const packed = deflateSync(delta, { level: 1 });
    const header = new DataView(new ArrayBuffer(12));
    header.setUint32(0, k * 50, true);
    header.setFloat32(4, k === 0 ? -200 : -20, true);
    header.setUint32(8, packed.length, true);
    parts.push(new Uint8Array(header.buffer), packed);
    previous = f;
  });
  const file = join(await mkdtemp(join(tmpdir(), "film-")), "x.film");
  await writeFile(file, Buffer.concat(parts));
  const read = await readFilm(file, width, height);
  assert.equal(read.length, 3);
  assert.deepEqual([...read[2]!.image.data], [...frames[2]!]);
  assert.equal(read[1]!.t, 50);
  assert.equal(read[0]!.levelDb, -200);
});

test("the meter film: silence, a rising sine, held, silence again", () => {
  const times = segmentTimes(METER_FILM);
  assert.deepEqual(times.map((t) => t.silent), [true, false, false, true]);
  assert.equal(times[3]!.to, 5000);
});
