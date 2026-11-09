import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Parameter } from "@vst-cloner/profile";

const EXE = process.platform === "win32" ? "vch-host.exe" : "vch-host";

export interface HostPluginDescription {
  name: string;
  descriptiveName: string;
  manufacturer: string;
  version: string;
  format: string;
  category: string;
  identifier: string;
  fileOrIdentifier: string;
  uniqueId: number;
  isInstrument: boolean;
}

export interface HostInfo {
  type: "info";
  plugin: HostPluginDescription;
  mainInputChannels: number;
  mainOutputChannels: number;
  latencySamples: number;
  tailSeconds: number;
  stateBytes: number;
  parameters: Parameter[];
}

export interface HostRenderMessage {
  type: "render";
  id: string;
  index: number;
  output: string;
  latencySamples: number;
  peak: number;
  params: { index: number; value: number; text: string }[];
  milliseconds: number;
}

export type HostMessage =
  | HostInfo
  | HostRenderMessage
  | { type: "list"; plugins: HostPluginDescription[] }
  | { type: "start"; plugin: HostPluginDescription; renders: number; outputChannels: number }
  | { type: "done"; renders: number }
  | { type: "error"; message: string };

export interface RenderJob {
  plugin: string;
  identifier?: string;
  state?: string;
  sampleRate: number;
  blockSize: number;
  channels: number;
  prerollSeconds: number;
  tailSeconds: number;
  input: string;
  renders: { id: string; params: { index: number; value: number }[]; output: string }[];
}

export class HostError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = "") {
    super(message);
    this.name = "HostError";
    this.stderr = stderr;
  }
}

/** Locates vch-host: $VCH_HOST, the repository build directory, then PATH. */
export function findHost(): string {
  const fromEnv = process.env.VCH_HOST;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new HostError(`VCH_HOST points to a missing file: ${fromEnv}`);
    return fromEnv;
  }

  const buildDir = fileURLToPath(new URL("../../host/build/", import.meta.url));
  const candidates = [
    join(buildDir, "vch-host_artefacts", "Release", EXE),
    join(buildDir, "vch-host_artefacts", "RelWithDebInfo", EXE),
    join(buildDir, "vch-host_artefacts", "Debug", EXE),
    join(buildDir, "vch-host_artefacts", EXE),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, EXE)),
  ];

  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new HostError("vch-host not found. Build it with `npm run host:configure && npm run host:build` or set VCH_HOST.");
  return found;
}

/** Runs vch-host and returns its JSON messages. `onMessage` receives them as they arrive. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

export function runHost(
  args: string[],
  options: { hostPath?: string; onMessage?: (m: HostMessage) => void; signal?: AbortSignal } = {},
): Promise<HostMessage[]> {
  const hostPath = options.hostPath ?? findHost();
  throwIfCancelled(options.signal);

  return new Promise((resolve, reject) => {
    const child = spawn(hostPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const messages: HostMessage[] = [];
    let buffered = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as HostMessage;
          messages.push(message);
          options.onMessage?.(message);
        } catch {
          stderr += `[unparsed stdout] ${line}\n`;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16384);
    });

    child.on("error", (error) => reject(new HostError(`cannot start vch-host: ${error.message}`)));
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", onAbort);
      const error = messages.find((m) => m.type === "error");
      if (options.signal?.aborted) reject(new CancelledError());
      else if (error) reject(new HostError(error.message, stderr));
      else if (code !== 0) reject(new HostError(`vch-host exited with ${signal ?? `code ${code}`}`, stderr));
      else resolve(messages);
    });
  });
}

export async function hostVersion(hostPath?: string): Promise<string> {
  const path = hostPath ?? findHost();
  return new Promise((resolve, reject) => {
    const child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

export async function pluginInfo(
  plugin: string,
  options: { identifier?: string; sampleRate?: number; channels?: number; hostPath?: string; signal?: AbortSignal } = {},
): Promise<HostInfo> {
  const args = ["info", plugin];
  if (options.identifier) args.push("--id", options.identifier);
  if (options.sampleRate) args.push("--sample-rate", String(options.sampleRate));
  if (options.channels) args.push("--channels", String(options.channels));

  const messages = await runHost(args, {
    ...(options.hostPath ? { hostPath: options.hostPath } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const info = messages.find((m): m is HostInfo => m.type === "info");
  if (!info) throw new HostError("vch-host returned no plugin info");
  return info;
}
