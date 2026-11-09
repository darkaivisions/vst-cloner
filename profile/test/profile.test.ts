import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  decodeProfile,
  decodeWav,
  encodeProfile,
  encodeWav,
  ProfileValidationError,
  type Profile,
} from "../src/index.ts";

function sampleProfile(): Profile {
  const wav = encodeWav({ sampleRate: 48000, channels: [new Float32Array([0, 0.5, -0.5, 1.5])] });
  return {
    manifest: {
      format: "vcprofile",
      schemaVersion: 1,
      id: "test-id",
      createdAt: "2026-11-09T12:00:00.000Z",
      generator: { name: "test", version: "0" },
      plugin: { name: "Test EQ", manufacturer: "Acme", version: "1.0", format: "VST3", identifier: "VST3-Test" },
      capture: {
        host: { name: "vch-host", version: "0.1.0" },
        os: "linux-x64",
        sampleRate: 48000,
        blockSize: 512,
        channels: 1,
        prerollSeconds: 0.5,
        tailSeconds: 1,
      },
    },
    parameters: {
      parameters: [
        { index: 0, id: "gain", name: "Gain", default: 0.5, numSteps: 2147483647, discrete: false, boolean: false, automatable: true },
      ],
    },
    testSignals: {
      generatorVersion: 1,
      sampleRate: 48000,
      channels: 1,
      length: 4,
      sha256: "0".repeat(64),
      segments: [{ id: "impulse", kind: "impulse", start: 0, length: 4, params: { amplitude: 0.5 } }],
    },
    captures: {
      renders: [{ id: "r0000", file: "captures/r0000.wav", kind: "default", params: [{ index: 0, value: 0.25 }], latencySamples: 0, peak: 1.5 }],
    },
    files: new Map([["captures/r0000.wav", wav]]),
  };
}

test("WAV float32 round trip keeps values above 0 dBFS", () => {
  const audio = { sampleRate: 44100, channels: [new Float32Array([0, 0.25, -1, 2]), new Float32Array([1, -0.5, 0, -3])] };
  const decoded = decodeWav(encodeWav(audio));
  assert.equal(decoded.sampleRate, 44100);
  assert.deepEqual(decoded.channels, audio.channels);
});

test("WAV decoder reads 16-bit and 24-bit PCM", () => {
  const header = (bits: number, dataBytes: number) => {
    const bytes = new Uint8Array(44 + dataBytes);
    const view = new DataView(bytes.buffer);
    bytes.set(strToU8("RIFF"), 0);
    view.setUint32(4, 36 + dataBytes, true);
    bytes.set(strToU8("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000 * (bits / 8), true);
    view.setUint16(32, bits / 8, true);
    view.setUint16(34, bits, true);
    bytes.set(strToU8("data"), 36);
    view.setUint32(40, dataBytes, true);
    return { bytes, view };
  };

  const pcm16 = header(16, 4);
  pcm16.view.setInt16(44, 16384, true);
  pcm16.view.setInt16(46, -32768, true);
  assert.deepEqual([...decodeWav(pcm16.bytes).channels[0]!], [0.5, -1]);

  const pcm24 = header(24, 3);
  pcm24.bytes.set([0x00, 0x00, 0xc0], 44); // -0.5
  assert.deepEqual([...decodeWav(pcm24.bytes).channels[0]!], [-0.5]);
});

test("profile encode/decode round trip", () => {
  const profile = sampleProfile();
  const decoded = decodeProfile(encodeProfile(profile));
  assert.deepEqual(decoded.manifest, profile.manifest);
  assert.deepEqual(decoded.parameters, profile.parameters);
  assert.deepEqual(decoded.captures, profile.captures);
  assert.deepEqual(decoded.files.get("captures/r0000.wav"), profile.files.get("captures/r0000.wav"));
});

test("modified file is detected by checksum", () => {
  const entries = unzipSync(encodeProfile(sampleProfile()));
  entries["captures/r0000.wav"] = new Uint8Array([1, 2, 3]);
  assert.throws(() => decodeProfile(zipSync(entries)), (e: Error) => e instanceof ProfileValidationError && /checksum mismatch/.test(e.message));
});

test("unlisted file is rejected", () => {
  const entries = unzipSync(encodeProfile(sampleProfile()));
  entries["extra.bin"] = new Uint8Array([1]);
  assert.throws(() => decodeProfile(zipSync(entries)), /not listed/);
});

test("schema violations are reported", () => {
  const profile = sampleProfile();
  (profile.manifest as { schemaVersion: number }).schemaVersion = 2;
  assert.throws(() => encodeProfile(profile), /manifest.json\/schemaVersion/);
});

test("missing capture file and unknown parameter are reported", () => {
  const profile = sampleProfile();
  profile.files.clear();
  profile.captures.renders[0]!.params[0]!.index = 7;
  assert.throws(() => encodeProfile(profile), (e: Error) => /missing capture file/.test(e.message) && /unknown parameter index 7/.test(e.message));
});

test("unsafe paths are rejected", () => {
  const profile = sampleProfile();
  profile.files.set("../evil.txt", new Uint8Array([1]));
  assert.throws(() => encodeProfile(profile), /unsafe file path/);
});
