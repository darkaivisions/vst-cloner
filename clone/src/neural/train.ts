import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CancelledError, regenerateTestSignal, throwIfCancelled } from "@vst-cloner/capture";
import { encodeWav, type Profile } from "@vst-cloner/profile";
import { run, type Logger } from "../build.ts";
import type { MeasuredSteps } from "@vst-cloner/capture";
import type { NeuralModel } from "./codegen.ts";
import { neuralPositions } from "./plan.ts";

const TRAIN_SCRIPT = fileURLToPath(new URL("../../../dsp/neural/train.py", import.meta.url));

/** Same location as the app's data (bridge/src/paths.ts): the Python environment lives next to profiles and clones. */
function dataDir(): string {
  if (process.env.VCH_DATA_DIR) return process.env.VCH_DATA_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "vst-cloner");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "vst-cloner");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "vst-cloner");
}

export const neuralEnvironmentDir = () => join(dataDir(), "python");

/** Python with PyTorch for training: $VCH_PYTHON, or the environment created by setupNeuralEnvironment(). */
export function neuralPython(): string | undefined {
  if (process.env.VCH_PYTHON) return process.env.VCH_PYTHON;
  const python = process.platform === "win32" ? join(neuralEnvironmentDir(), "Scripts", "python.exe") : join(neuralEnvironmentDir(), "bin", "python");
  return existsSync(python) ? python : undefined;
}

/**
 * Creates the Python environment for training (~3 GB with CUDA): a venv in the data directory with PyTorch,
 * NumPy and soundfile. With an NVIDIA card the CUDA build of PyTorch, otherwise the CPU build (training is then
 * much slower). Needs Python ≥ 3.10 on the PATH.
 */
export async function setupNeuralEnvironment(log: Logger, signal?: AbortSignal): Promise<string> {
  const dir = neuralEnvironmentDir();
  const system = process.platform === "win32" ? "python" : "python3";
  log("info", `Creating the training environment in ${dir} (PyTorch, ~3 GB – takes a few minutes) …`);
  await mkdir(dirname(dir), { recursive: true });
  await run(system, ["-m", "venv", dir], dirname(dir), log, signal);
  const python = neuralPython() ?? join(dir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const cuda = await hasNvidiaGpu();
  log("info", cuda ? "NVIDIA card found: installing PyTorch with CUDA" : "No NVIDIA card found: installing PyTorch for the CPU (training takes much longer)");
  await run(python, ["-m", "pip", "install", "--upgrade", "pip"], dir, log, signal);
  await run(python, ["-m", "pip", "install", "torch", "numpy", "soundfile",
    "--index-url", cuda ? "https://download.pytorch.org/whl/cu128" : "https://download.pytorch.org/whl/cpu",
    "--extra-index-url", "https://pypi.org/simple"], dir, log, signal);
  return python;
}

function hasNvidiaGpu(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("nvidia-smi", ["-L"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export interface NeuralTrainOptions {
  log: Logger;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
  /** training time budget in minutes */
  minutes?: number;
  hidden?: number;
}

export interface NeuralTrainResult {
  model: NeuralModel;
  trainEsr: number;
  validateEsr?: number;
  steps: number;
  seconds: number;
}

/** Writes what train.py reads (an extracted profile: JSON files, the regenerated input, the captures). */
async function extractForTraining(profile: Profile, dir: string): Promise<void> {
  await mkdir(join(dir, "captures"), { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(profile.manifest));
  await writeFile(join(dir, "parameters.json"), JSON.stringify(profile.parameters));
  await writeFile(join(dir, "captures.json"), JSON.stringify(profile.captures));
  // controls that move in steps: the network sees the middle of the position (see neuralPositions)
  const plan = profile.manifest.capture.plan as { selectedParameters?: number[]; steps?: MeasuredSteps[] } | undefined;
  const selected = new Set(plan?.selectedParameters ?? []);
  const positions = neuralPositions(profile.parameters.parameters.filter((p) => selected.has(p.index)), plan?.steps);
  await writeFile(join(dir, "positions.json"), JSON.stringify(Object.fromEntries(positions)));
  const input = regenerateTestSignal(profile.testSignals).audio;
  await writeFile(join(dir, "input.wav"), encodeWav(input));
  for (const render of profile.captures.renders) {
    const data = profile.files.get(render.file);
    if (!data) throw new Error(`profile: ${render.file} is missing`);
    await writeFile(join(dir, render.file), data);
  }
}

/** Trains the network on the GPU (or CPU) with dsp/neural/train.py; progress and messages come as JSON lines. */
export async function trainNeural(profile: Profile, options: NeuralTrainOptions): Promise<NeuralTrainResult> {
  const { log } = options;
  throwIfCancelled(options.signal);
  const python = neuralPython();
  if (!python) throw new Error("The training environment is missing – set it up first (vch neural-setup, or the button in the app)");
  const work = await mkdtemp(join(tmpdir(), "vch-neural-"));
  try {
    await extractForTraining(profile, join(work, "data"));
    const minutes = options.minutes ?? 20;
    const args = [TRAIN_SCRIPT, "--data", join(work, "data"), "--out", join(work, "out"), "--minutes", String(minutes), "--hidden", String(options.hidden ?? 64)];
    const result = await new Promise<NeuralTrainResult & { modelPath: string }>((resolve, reject) => {
      const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => child.kill();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let buffer = "";
      let final: (NeuralTrainResult & { modelPath: string }) | undefined;
      let failure: string | undefined;
      const stderr: string[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line);
          } catch {
            log("detail", line);
            continue;
          }
          if (message.type === "info") log("info", String(message.message));
          else if (message.type === "progress") {
            const budget = Number(message.budget) || minutes * 60;
            const seconds = Number(message.seconds) || 0;
            options.onProgress?.(Math.min(seconds, budget), budget, `Training: step ${message.step}, error ${Number(message.loss).toFixed(4)}`);
          } else if (message.type === "error") failure = String(message.message);
          else if (message.type === "result") {
            final = {
              model: undefined as unknown as NeuralModel,
              modelPath: String(message.model),
              trainEsr: Number(message.trainEsr),
              ...(message.validateEsr !== null && message.validateEsr !== undefined ? { validateEsr: Number(message.validateEsr) } : {}),
              steps: Number(message.steps),
              seconds: Number(message.seconds),
            };
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          stderr.push(line);
          if (stderr.length > 30) stderr.shift();
          log("detail", line);
        }
      });
      child.on("error", (error) => reject(new Error(`Training could not be started: ${error.message}`)));
      child.on("exit", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted) reject(new CancelledError());
        else if (final && code === 0) resolve(final);
        else reject(new Error(`Training failed${failure ? `: ${failure}` : ` (exit ${code})`}\n${stderr.slice(-8).join("\n")}`));
      });
    });
    const model = JSON.parse(await readFile(result.modelPath, "utf8")) as NeuralModel;
    const { modelPath: _, ...rest } = result;
    return { ...rest, model };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
