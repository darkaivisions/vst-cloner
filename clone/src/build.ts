import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CancelledError, throwIfCancelled } from "@vst-cloner/capture";
import { generateGuiHeader } from "./gui/codegen.ts";

export type LogLevel = "info" | "detail" | "warn";
export type Logger = (level: LogLevel, message: string) => void;

export interface BuildResult {
  vst3: string;
  lv2: string;
  installed: string[];
}

const TEMPLATES_DIR = fileURLToPath(new URL("../../plugin-template/", import.meta.url));

/** Plugin templates: parametric EQ engine, compressor engine. */
export type PluginTemplate = "eq" | "dynamics";
const REPO_DIR = fileURLToPath(new URL("../../", import.meta.url));

function cacheRoot(): string {
  if (process.env.VCH_CACHE_DIR) return process.env.VCH_CACHE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "vst-cloner", "cache");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "vst-cloner");
}

const onPath = (exe: string) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => existsSync(join(dir, process.platform === "win32" ? `${exe}.exe` : exe)));

/** JUCE checkout: $VCH_JUCE_DIR, the one used by vch-host, its FetchContent copy, or none (CMake downloads it). */
export async function findJuceDir(): Promise<string | undefined> {
  if (process.env.VCH_JUCE_DIR) return process.env.VCH_JUCE_DIR;
  const hostBuild = join(REPO_DIR, "host", "build");
  try {
    const cache = await readFile(join(hostBuild, "CMakeCache.txt"), "utf8");
    const match = /^VCH_JUCE_DIR:PATH=(.+)$/m.exec(cache);
    if (match?.[1] && existsSync(join(match[1], "CMakeLists.txt"))) return match[1];
  } catch {
    // host not configured
  }
  const fetched = join(hostBuild, "_deps", "juce-src");
  return existsSync(join(fetched, "CMakeLists.txt")) ? fetched : undefined;
}

/** Runs a command and forwards its output line by line. */
export function run(command: string, args: string[], cwd: string, log: Logger, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    const tail: string[] = [];
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        log(/\berror\b/i.test(line) ? "warn" : "detail", line);
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => reject(new Error(`cannot run ${command}: ${error.message}`)));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new CancelledError());
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} fehlgeschlagen (Exit ${code}):\n${tail.slice(-15).join("\n")}`));
    });
  });
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clone";
}

/** Four-character plugin code, stable for a plugin name. */
export function pluginCode(name: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const hash = createHash("sha256").update(name).digest();
  return "V" + [0, 1, 2].map((i) => alphabet[hash[i]! % alphabet.length]).join("");
}

function userPluginDirs(): { vst3: string; lv2: string } {
  if (process.platform === "win32") {
    return {
      vst3: join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Common", "VST3"),
      lv2: join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "LV2"),
    };
  }
  if (process.platform === "darwin") {
    return { vst3: join(homedir(), "Library", "Audio", "Plug-Ins", "VST3"), lv2: join(homedir(), "Library", "Audio", "Plug-Ins", "LV2") };
  }
  return { vst3: join(homedir(), ".vst3"), lv2: join(homedir(), ".lv2") };
}

export interface BuildOptions {
  pluginName: string;
  /** contents of CloneModel.h */
  modelHeader: string;
  /** contents of CloneGui.h (layout of the editor); omitted → generic editor */
  guiHeader?: string;
  outputDir: string;
  /** plugin template (default: eq) */
  template?: PluginTemplate;
  install?: boolean;
  log: Logger;
  signal?: AbortSignal;
}

/** Builds the EQ plugin template with a generated model header into VST3 and LV2 bundles. */
export async function buildPlugin(options: BuildOptions): Promise<BuildResult> {
  const { log } = options;
  const template = options.template ?? "eq";
  const templateDir = join(TEMPLATES_DIR, template);
  const workDir = join(cacheRoot(), "builds", template === "eq" ? slugify(options.pluginName) : `${slugify(options.pluginName)}-${template}`);
  const generated = join(workDir, "generated");
  const buildDir = join(workDir, "build");
  const code = pluginCode(options.pluginName);

  await mkdir(join(workDir, "src"), { recursive: true });
  await mkdir(generated, { recursive: true });

  // only touch files whose content changed, so incremental builds stay fast
  const writeIfChanged = async (path: string, content: string) => {
    const previous = existsSync(path) ? await readFile(path, "utf8") : undefined;
    if (previous !== content) await writeFile(path, content);
  };
  await writeIfChanged(join(workDir, "CMakeLists.txt"), await readFile(join(templateDir, "CMakeLists.txt"), "utf8"));
  // template sources plus the files shared by all templates
  const sources = new Map<string, string>();
  for (const file of await readdir(join(TEMPLATES_DIR, "common"))) sources.set(file, join(TEMPLATES_DIR, "common", file));
  for (const file of await readdir(join(templateDir, "src"))) sources.set(file, join(templateDir, "src", file));
  for (const [file, source] of sources) await writeIfChanged(join(workDir, "src", file), await readFile(source, "utf8"));
  for (const file of await readdir(join(workDir, "src"))) if (!sources.has(file)) await rm(join(workDir, "src", file), { force: true });
  await writeIfChanged(join(generated, "CloneModel.h"), options.modelHeader);
  await writeIfChanged(join(generated, "CloneGui.h"), options.guiHeader ?? generateGuiHeader(undefined, []));

  const juceDir = await findJuceDir();
  log("detail", juceDir ? `JUCE: ${juceDir}` : "JUCE 9.0.5 wird heruntergeladen (nur beim ersten Build)");

  const configure = [
    "-S", workDir, "-B", buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCLONE_NAME=${options.pluginName}`,
    `-DCLONE_CODE=${code}`,
    `-DCLONE_GENERATED_DIR=${generated}`,
    ...(juceDir ? [`-DVCH_JUCE_DIR=${juceDir}`] : []),
  ];
  if (!existsSync(join(buildDir, "CMakeCache.txt")) && onPath("ninja")) configure.push("-G", "Ninja");

  log("info", "Plugin-Build wird vorbereitet (CMake) …");
  await run("cmake", configure, workDir, log, options.signal);
  log("info", "Plugin wird kompiliert – beim ersten Mal ca. 1 Minute, danach Sekunden …");
  await run("cmake", ["--build", buildDir, "--config", "Release", "--parallel"], workDir, log, options.signal);

  const artefacts = join(buildDir, "vch_clone_artefacts", "Release");
  const vst3Source = join(artefacts, "VST3", `${options.pluginName}.vst3`);
  const lv2Source = join(artefacts, "LV2", `${options.pluginName}.lv2`);
  for (const path of [vst3Source, lv2Source]) if (!existsSync(path)) throw new Error(`Build fertig, aber ${path} fehlt`);

  await mkdir(options.outputDir, { recursive: true });
  const vst3 = join(options.outputDir, `${options.pluginName}.vst3`);
  const lv2 = join(options.outputDir, `${options.pluginName}.lv2`);
  for (const [from, to] of [[vst3Source, vst3], [lv2Source, lv2]] as const) {
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
  }
  log("info", `Plugin geschrieben: ${vst3}`);
  log("info", `Plugin geschrieben: ${lv2}`);

  const installed: string[] = [];
  if (options.install) {
    const dirs = userPluginDirs();
    for (const [from, dir] of [[vst3, dirs.vst3], [lv2, dirs.lv2]] as const) {
      const target = join(dir, from.slice(options.outputDir.length + 1));
      await mkdir(dir, { recursive: true });
      await rm(target, { recursive: true, force: true });
      await cp(from, target, { recursive: true });
      installed.push(target);
      log("info", `Installiert: ${target}`);
    }
  }

  return { vst3, lv2, installed };
}
