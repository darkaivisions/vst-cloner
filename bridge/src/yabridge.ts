/**
 * yabridge check: a Windows plugin bridged by yabridge may already be all a user needs on Linux. Before it is
 * cloned, the app shows whether it runs: one second of a sine through it, and whether sound comes out.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHost, type RenderJob } from "@vst-cloner/capture";
import { decodeWav, encodeWav } from "@vst-cloner/profile";

export interface YabridgeCheck {
  /** it processed audio: output of the right length, finite, not silent */
  runs: boolean;
  /** seconds the render of one second of audio took (loading through Wine included) */
  seconds: number;
  /** level of the output (dBFS) */
  outputDb?: number;
  problem?: string;
}

const SAMPLE_RATE = 48000;

export async function checkYabridge(plugin: string, identifier?: string): Promise<YabridgeCheck> {
  const dir = await mkdtemp(join(tmpdir(), "vch-yabridge-"));
  const started = Date.now();
  try {
    const sine = new Float32Array(SAMPLE_RATE).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
    await writeFile(join(dir, "input.wav"), encodeWav({ sampleRate: SAMPLE_RATE, channels: [sine, sine] }));
    const job: RenderJob = {
      plugin, ...(identifier ? { identifier } : {}),
      sampleRate: SAMPLE_RATE, blockSize: 512, channels: 2, prerollSeconds: 0.1, tailSeconds: 0, input: "input.wav",
      renders: [{ id: "check", output: "out.wav", params: [] }],
    };
    await writeFile(join(dir, "job.json"), JSON.stringify(job));
    try {
      await runHost(["render", join(dir, "job.json")]);
    } catch (error) {
      return { runs: false, seconds: (Date.now() - started) / 1000, problem: (error as Error).message.split("\n")[0] };
    }
    const seconds = (Date.now() - started) / 1000;
    const out = decodeWav(await readFile(join(dir, "out.wav"))).channels;
    let sum = 0, n = 0, finite = true;
    for (const channel of out) for (const v of channel) {
      if (!Number.isFinite(v)) finite = false;
      sum += v * v;
      n++;
    }
    const outputDb = 10 * Math.log10(sum / Math.max(n, 1) + 1e-20);
    if (!finite) return { runs: false, seconds, problem: "the output holds invalid samples (NaN/∞)" };
    if (outputDb < -90) return { runs: false, seconds, outputDb, problem: "the output stays silent" };
    return { runs: true, seconds, outputDb };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
