import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CancelledError, throwIfCancelled } from "@vst-cloner/capture";

const EXE = process.platform === "win32" ? "vch-gui.exe" : "vch-gui";

export interface GuiStep {
  id: string;
  params: { index: number; value: number }[];
  png?: boolean;
}

export interface GuiShot {
  id: string;
  file: string;
  png: string;
  width: number;
  height: number;
}

export interface GuiSnapshotResult {
  width: number;
  height: number;
  shots: Map<string, GuiShot>;
  /** titles of windows the plugin opened besides its editor (moved out of the way before capturing) */
  dialogs: string[];
}

const onPath = (exe: string) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, exe)).find((p) => existsSync(p));

/** Locates vch-gui: $VCH_GUI, the repository build directory, then PATH. */
export function findGuiHost(): string {
  if (process.env.VCH_GUI) return process.env.VCH_GUI;
  const buildDir = fileURLToPath(new URL("../../../host/build/", import.meta.url));
  for (const config of ["Release", "RelWithDebInfo", "Debug", ""]) {
    const candidate = join(buildDir, "vch-gui_artefacts", config, EXE);
    if (existsSync(candidate)) return candidate;
  }
  const found = onPath(EXE);
  if (!found) throw new Error("vch-gui nicht gefunden – bitte den Host neu bauen (npm run host:build)");
  return found;
}

/** Whether GUI capture can run invisibly (Linux: Xvfb installed). */
export function virtualDisplayAvailable(): boolean {
  return process.platform !== "linux" || Boolean(process.env.VCH_DISPLAY) || Boolean(onPath("Xvfb"));
}

/**
 * Runs `fn` with an invisible X display (Linux, Xvfb). On other platforms the real desktop is used.
 * $VCH_DISPLAY selects an existing display instead.
 */
export async function withVirtualDisplay<T>(fn: (display: string | undefined) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (process.platform !== "linux") return fn(undefined);
  if (process.env.VCH_DISPLAY) return fn(process.env.VCH_DISPLAY);

  const xvfb = onPath("Xvfb");
  if (!xvfb) throw new Error("Xvfb fehlt – bitte installieren (Arch/CachyOS: sudo pacman -S xorg-server-xvfb)");

  let number = 90;
  while (existsSync(`/tmp/.X11-unix/X${number}`) || existsSync(`/tmp/.X${number}-lock`)) number++;
  const display = `:${number}`;
  const server = spawn(xvfb, [display, "-screen", "0", "3200x2000x24", "-nolisten", "tcp", "-noreset"], { stdio: "ignore" });

  try {
    for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`); i++) {
      throwIfCancelled(signal);
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!existsSync(`/tmp/.X11-unix/X${number}`)) throw new Error("Xvfb ist nicht gestartet");
    return await fn(display);
  } finally {
    server.kill();
  }
}

/**
 * Notices that some plugins draw inside their editor on every start (trial versions) and that only react to the mouse.
 * The click hits the button that just continues using the plugin ("Evaluate") – never buy or licence buttons.
 */
const STARTUP_CLICKS: { match: RegExp; clicks: { dx: number; dy: number }[] }[] = [
  // FabFilter evaluation notice: "Evaluate" button, centred dialog
  { match: /fabfilter/i, clicks: [{ dx: -1, dy: -3 }] },
];

export function startupClicks(plugin: string): { dx: number; dy: number }[] {
  return STARTUP_CLICKS.find((entry) => entry.match.test(plugin))?.clicks ?? [];
}

/** Opens the plugin editor, applies each step and captures it. Raw RGBA files are written to `outputDir`. */
export async function runGuiSnapshot(
  options: {
    plugin: string;
    identifier?: string;
    outputDir: string;
    steps: GuiStep[];
    display: string | undefined;
    settleMs?: number;
    stepMs?: number;
    signal?: AbortSignal;
    onShot?: (shot: GuiShot, done: number) => void;
  },
): Promise<GuiSnapshotResult> {
  throwIfCancelled(options.signal);
  await mkdir(options.outputDir, { recursive: true });
  const jobPath = join(options.outputDir, `job-${Date.now()}.json`);
  await writeFile(jobPath, JSON.stringify({
    plugin: options.plugin,
    ...(options.identifier ? { identifier: options.identifier } : {}),
    output: options.outputDir,
    settleMs: options.settleMs ?? 3000,
    stepMs: options.stepMs ?? 300,
    clicks: startupClicks(options.plugin),
    steps: options.steps,
  }));

  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(options.display ? { DISPLAY: options.display } : {}) };
    const child = spawn(findGuiHost(), ["snapshot", jobPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const shots = new Map<string, GuiShot>();
    const dialogs: string[] = [];
    let size = { width: 0, height: 0 };
    let error: string | undefined;
    let done = false;
    let buffer = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === "window") size = { width: message.width, height: message.height };
          else if (message.type === "shot") {
            shots.set(message.id, message);
            options.onShot?.(message, shots.size);
          } else if (message.type === "dialog") {
            if (!dialogs.includes(message.title)) dialogs.push(message.title);
          } else if (message.type === "error") error = message.message;
          else if (message.type === "done") done = true;
        } catch {
          // ignore non-JSON output
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.on("error", (e) => reject(new Error(`vch-gui konnte nicht gestartet werden: ${e.message}`)));
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(new CancelledError());
      else if (error) reject(new Error(`Plugin-Oberfläche: ${error}`));
      else if (!done) reject(new Error(`vch-gui wurde unerwartet beendet (Exit ${code})\n${stderr.trim().split("\n").slice(-8).join("\n")}`));
      else resolve({ ...size, shots, dialogs });
    });
  });
}
