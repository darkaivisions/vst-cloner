export interface Audio {
  sampleRate: number;
  /** One Float32Array per channel, all of equal length. */
  channels: Float32Array[];
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function audioLength(audio: Audio): number {
  return audio.channels[0]?.length ?? 0;
}

/** Encodes audio as a 32-bit IEEE float WAV file. */
export function encodeWav(audio: Audio): Uint8Array {
  const numChannels = audio.channels.length;
  const frames = audioLength(audio);
  const dataBytes = frames * numChannels * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_FLOAT, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * numChannels * 4, true);
  view.setUint16(32, numChannels * 4, true);
  view.setUint16(34, 32, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setFloat32(offset, audio.channels[ch]![frame]!, true);
      offset += 4;
    }
  }
  return bytes;
}

/** Decodes PCM (16/24/32 bit) and IEEE float (32/64 bit) WAV files. */
export function decodeWav(bytes: Uint8Array): Audio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bits = 0;
  let blockAlign = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  for (let pos = 12; pos + 8 <= bytes.length; ) {
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    const available = Math.min(size, bytes.length - body);
    const id = tag(pos);

    if (id === "fmt " && available >= 16) {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bits = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && available >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = available;
    }
    pos = body + size + (size & 1);
  }

  if (dataOffset < 0 || numChannels === 0 || sampleRate === 0) throw new Error("missing fmt or data chunk");

  const supported =
    (format === FORMAT_PCM && (bits === 16 || bits === 24 || bits === 32)) ||
    (format === FORMAT_FLOAT && (bits === 32 || bits === 64));
  if (!supported || blockAlign !== numChannels * (bits / 8)) {
    throw new Error(`unsupported WAV sample format (format ${format}, ${bits} bit)`);
  }

  const frames = Math.floor(dataBytes / blockAlign);
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
  const bytesPerSample = bits / 8;

  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const p = dataOffset + frame * blockAlign + ch * bytesPerSample;
      let value: number;
      if (format === FORMAT_FLOAT) {
        value = bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
      } else if (bits === 16) {
        value = view.getInt16(p, true) / 32768;
      } else if (bits === 24) {
        value = (((bytes[p + 2]! << 24) | (bytes[p + 1]! << 16) | (bytes[p]! << 8)) >> 8) / 8388608;
      } else {
        value = view.getInt32(p, true) / 2147483648;
      }
      channels[ch]![frame] = value;
    }
  }

  return { sampleRate, channels };
}
