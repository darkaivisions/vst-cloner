import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { encodeWav, readProfile, type Profile } from "@vst-cloner/profile";
import { capture, type CapturePlanner, type CaptureProgress } from "./capture.ts";
import { HostError, pluginInfo, runHost } from "./host.ts";
import { DEFAULT_PLAN, PlanTooLargeError, planCaptures, resolveFixedValues, type PlanOptions } from "./plan.ts";
import { generateTestSignal, regenerateTestSignal } from "./signals.ts";

const USAGE = `vch — vst-cloner capture tool

Usage:
  vch list    <plugin>                  List plugin types in a file/bundle
  vch info    <plugin> [--json]         Show plugin parameters
  vch plan    <plugin> [plan options]   Show what a capture would render
  vch capture <plugin> -o <file.vcprofile> [options]
  vch inspect <file.vcprofile> [--json] Validate a profile and show a summary
  vch extract <file.vcprofile> <dir>    Unpack captures and the regenerated input signal
  vch signal  <out.wav> [--sample-rate <hz>] [--channels <n>]
                                        Write the test signal (e.g. for capturing in a DAW)
  vch llm …                             Language model providers (see 'vch llm --help')

  vch clone   <profile> [-o <dir>] [--name <text>] [--install] [--refit] [--no-verify] [--gui] [-v]
                                        Analyse, build the clone (VST3 + LV2), compare it with the original
  vch analyze <profile> [--save] [--json]
                                        Fit the EQ model and show how well it matches
  vch verify  <profile> <clone.vst3>    Compare a built clone with the original measurements

Capture options:
  -o, --output <file>       Output profile (.vcprofile)
  --id <identifier>         Plugin type inside a bundle (see 'vch list')
  --sample-rate <hz>        Default 48000
  --block-size <n>          Default 512
  --channels <n>            Default 2
  --preroll <seconds>       Silence before each render, default 0.5
  --tail <seconds>          Recorded tail after the signal, default 2
  --class <name>            Effect-class specific plan: 'eq' (replaces the generic sweep plan;
                            --points/--random/--include/--exclude are then ignored)
  --notes <text>            Free text stored in the manifest
  --keep-work               Keep the temporary working directory

Plan options:
  --points <n>              Sweep points per continuous parameter, default ${DEFAULT_PLAN.points}
  --random <n>              Random parameter combinations, default ${DEFAULT_PLAN.random}
  --seed <n>                Seed for noise and random combinations, default ${DEFAULT_PLAN.seed}
  --include <regex>         Only parameters whose name matches
  --exclude <regex>         Skip parameters whose name matches, default "${DEFAULT_PLAN.exclude?.source}"
  --max-renders <n>         Safety limit, default ${DEFAULT_PLAN.maxRenders}
  --set <param>=<value>     Fixed value for every render (repeatable). <param> is a name or
                            index, <value> a normalized number or a display text, e.g.
                            --set "Band 1 Used=Used" --set "Band 1 Shape=Bell"

Environment:
  VCH_HOST                  Path to the vch-host executable
`;

const OPTIONS = {
  output: { type: "string", short: "o" },
  id: { type: "string" },
  "sample-rate": { type: "string" },
  "block-size": { type: "string" },
  channels: { type: "string" },
  preroll: { type: "string" },
  tail: { type: "string" },
  notes: { type: "string" },
  "keep-work": { type: "boolean" },
  points: { type: "string" },
  random: { type: "string" },
  seed: { type: "string" },
  include: { type: "string" },
  exclude: { type: "string" },
  "max-renders": { type: "string" },
  set: { type: "string", multiple: true },
  class: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

function number(values: Values, name: keyof Values, fallback: number, integer = false): number {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new UsageError(`--${name} expects a ${integer ? "non-negative integer" : "non-negative number"}, got '${raw}'`);
  }
  return value;
}

function regex(source: string | undefined, name: string): RegExp | undefined {
  if (source === undefined) return undefined;
  if (source === "") return undefined;
  try {
    return new RegExp(source, "i");
  } catch (error) {
    throw new UsageError(`--${name}: ${(error as Error).message}`);
  }
}

function planOptions(values: Values): PlanOptions {
  const exclude = values.exclude !== undefined ? regex(values.exclude, "exclude") : DEFAULT_PLAN.exclude;
  const include = regex(values.include, "include");
  return {
    points: number(values, "points", DEFAULT_PLAN.points, true),
    random: number(values, "random", DEFAULT_PLAN.random, true),
    seed: number(values, "seed", DEFAULT_PLAN.seed, true),
    maxRenders: number(values, "max-renders", DEFAULT_PLAN.maxRenders, true),
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

function requirePositional(positionals: string[], index: number, what: string): string {
  const value = positionals[index];
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function printProgress(event: CaptureProgress): void {
  switch (event.stage) {
    case "info":
      console.error(`Loading ${event.plugin} …`);
      break;
    case "plan":
      console.error(`Parameters: ${event.parameters}, measured: ${event.selected}, renders: ${event.renders}`);
      break;
    case "workdir":
      break;
    case "render":
      if (process.stderr.isTTY) process.stderr.write(`\rRendering ${event.done}/${event.total} (${event.id})   `);
      else if (event.done === event.total || event.done % 25 === 0) console.error(`Rendered ${event.done}/${event.total}`);
      if (event.done === event.total && process.stderr.isTTY) process.stderr.write("\n");
      break;
    case "write":
      console.error(`Writing ${event.path}`);
      break;
  }
}

async function commandList(positionals: string[]): Promise<void> {
  const messages = await runHost(["list", resolve(requirePositional(positionals, 0, "plugin path"))]);
  for (const message of messages) {
    if (message.type !== "list") continue;
    if (message.plugins.length === 0) console.log("No supported plugin found.");
    for (const p of message.plugins) console.log(`${p.name} (${p.manufacturer}, ${p.format} ${p.version})\n  --id "${p.identifier}"`);
  }
}

async function commandInfo(positionals: string[], values: Values): Promise<void> {
  const info = await pluginInfo(resolve(requirePositional(positionals, 0, "plugin path")), {
    ...(values.id ? { identifier: values.id } : {}),
    sampleRate: number(values, "sample-rate", 48000),
    channels: number(values, "channels", 2, true),
  });

  if (values.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  const p = info.plugin;
  console.log(`${p.name} — ${p.manufacturer} (${p.format} ${p.version}, ${p.category || "no category"})`);
  console.log(`Channels: ${info.mainInputChannels} in / ${info.mainOutputChannels} out, latency ${info.latencySamples} samples`);
  console.log(`Parameters (${info.parameters.length}):`);
  for (const param of info.parameters) {
    const texts = param.texts ?? [];
    const range = texts.length > 0 ? `${texts[0]!.text} … ${texts[texts.length - 1]!.text}` : "";
    const steps = param.discrete && param.numSteps < 1000 ? `, ${param.numSteps} steps` : "";
    const flags = [!param.automatable && "not automatable", param.meta && "meta"].filter(Boolean).join(", ");
    console.log(`  [${param.index}] ${param.name}${param.label ? ` (${param.label})` : ""}: ${range}${steps}${flags ? ` [${flags}]` : ""}`);
  }
}

async function commandPlan(positionals: string[], values: Values): Promise<void> {
  const info = await pluginInfo(resolve(requirePositional(positionals, 0, "plugin path")), values.id ? { identifier: values.id } : {});
  const options = { ...planOptions(values), fixed: resolveFixedValues(info.parameters, values.set ?? []) };
  const plan = planCaptures(info.parameters, { ...options, maxRenders: Number.MAX_SAFE_INTEGER });
  for (const f of options.fixed) {
    const p = info.parameters.find((x) => x.index === f.index)!;
    console.log(`Fixed: [${p.index}] ${p.name} = ${f.value}`);
  }
  const signalSeconds = generateTestSignal({ sampleRate: 1000, channels: 1 }).set.length / 1000;
  const perRender = signalSeconds + number(values, "tail", 2) + number(values, "preroll", 0.5);

  console.log(`Measured parameters (${plan.selected.length} of ${info.parameters.length}):`);
  for (const p of plan.selected) {
    const sweeps = plan.renders.filter((r) => r.sweepParameter === p.index).length;
    console.log(`  [${p.index}] ${p.name}: ${sweeps} sweep renders`);
  }
  console.log(`Renders: ${plan.renders.length} (limit ${options.maxRenders}), audio per render ≈ ${perRender.toFixed(1)} s`);
  if (plan.renders.length > options.maxRenders) console.log(new PlanTooLargeError(plan.renders.length, options.maxRenders).message);
}

async function loadPlanner(name: string | undefined): Promise<CapturePlanner | undefined> {
  if (name === undefined || name === "generic") return undefined;
  if (name === "eq") return (await import("@vst-cloner/clone")).eqPlanner;
  throw new UsageError(`unknown --class '${name}' (available: eq)`);
}

async function commandCapture(positionals: string[], values: Values): Promise<void> {
  const plugin = requirePositional(positionals, 0, "plugin path");
  if (!values.output) throw new UsageError("missing --output <file.vcprofile>");
  const output = resolve(values.output.endsWith(".vcprofile") ? values.output : `${values.output}.vcprofile`);

  const planner = await loadPlanner(values.class);
  const started = Date.now();
  const profile = await capture({
    plugin,
    output,
    ...(planner ? { planner } : {}),
    ...(values.id ? { identifier: values.id } : {}),
    sampleRate: number(values, "sample-rate", 48000),
    blockSize: number(values, "block-size", 512, true),
    channels: number(values, "channels", 2, true),
    prerollSeconds: number(values, "preroll", 0.5),
    tailSeconds: number(values, "tail", 2),
    plan: planOptions(values),
    set: values.set ?? [],
    ...(values.notes ? { notes: values.notes } : {}),
    keepWorkDir: values["keep-work"] ?? false,
    onProgress: (event) => {
      printProgress(event);
      if (event.stage === "workdir" && values["keep-work"]) console.error(`Working directory: ${event.path}`);
    },
  });

  const size = (await stat(output)).size;
  console.log(`Saved ${output} (${profile.captures.renders.length} renders, ${formatBytes(size)}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

function summarize(profile: Profile, path: string, bytes: number) {
  const { manifest, captures, testSignals } = profile;
  const kinds: Record<string, number> = {};
  for (const r of captures.renders) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const latencies = [...new Set(captures.renders.map((r) => r.latencySamples))];
  const peak = Math.max(0, ...captures.renders.map((r) => r.peak));
  return {
    path,
    bytes,
    id: manifest.id,
    createdAt: manifest.createdAt,
    plugin: manifest.plugin,
    capture: manifest.capture,
    parameters: profile.parameters.parameters.length,
    renders: captures.renders.length,
    renderKinds: kinds,
    latencySamples: latencies,
    maxPeak: peak,
    signalSeconds: testSignals.length / testSignals.sampleRate,
    signalVerified: regenerateTestSignal(testSignals).verified,
    extraFiles: [...profile.files.keys()].filter((f) => !f.startsWith("captures/")),
  };
}

async function commandInspect(positionals: string[], values: Values): Promise<void> {
  const path = resolve(requirePositional(positionals, 0, "profile path"));
  const profile = await readProfile(path);
  const summary = summarize(profile, path, (await stat(path)).size);

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const p = summary.plugin;
  console.log(`✔ ${path} is valid (${formatBytes(summary.bytes)})`);
  console.log(`Plugin:     ${p.name} — ${p.manufacturer} (${p.format} ${p.version})`);
  console.log(`Captured:   ${summary.createdAt} on ${summary.capture.os}, ${summary.capture.host.name} ${summary.capture.host.version}`);
  console.log(`Audio:      ${summary.capture.sampleRate} Hz, ${summary.capture.channels} ch, signal ${summary.signalSeconds.toFixed(2)} s + tail ${summary.capture.tailSeconds} s`);
  console.log(`Parameters: ${summary.parameters}`);
  console.log(`Renders:    ${summary.renders} (${Object.entries(summary.renderKinds).map(([k, n]) => `${n} ${k}`).join(", ")})`);
  console.log(`Latency:    ${summary.latencySamples.join(", ")} samples, max peak ${summary.maxPeak.toFixed(3)}`);
  console.log(`Signal:     ${summary.signalVerified ? "regenerated, hash matches" : "regenerated, hash differs (other generator version)"}`);
  if (summary.maxPeak > 1) console.log("Note:       output exceeds 0 dBFS (stored losslessly as float)");
  if (summary.extraFiles.length > 0) console.log(`Files:      ${summary.extraFiles.join(", ")}`);
}

async function commandExtract(positionals: string[]): Promise<void> {
  const profile = await readProfile(resolve(requirePositional(positionals, 0, "profile path")));
  const target = resolve(requirePositional(positionals, 1, "target directory"));

  for (const [path, data] of profile.files) {
    const out = join(target, path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data);
  }
  const { audio } = regenerateTestSignal(profile.testSignals);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "input.wav"), encodeWav(audio));
  for (const name of ["manifest", "parameters", "testSignals", "captures"] as const) {
    await writeFile(join(target, `${name === "testSignals" ? "test-signals" : name}.json`), JSON.stringify(profile[name], null, 2) + "\n");
  }
  console.log(`Extracted ${profile.files.size} files and input.wav to ${target}`);
}

async function commandSignal(positionals: string[], values: Values): Promise<void> {
  const out = resolve(requirePositional(positionals, 0, "output WAV path"));
  const { audio, set } = generateTestSignal({
    sampleRate: number(values, "sample-rate", 48000),
    channels: number(values, "channels", 2, true),
    seed: number(values, "seed", 1, true),
  });
  await writeFile(out, encodeWav(audio));
  await writeFile(out.replace(/\.wav$/i, "") + ".segments.json", JSON.stringify(set, null, 2) + "\n");
  console.log(`Wrote ${out} (${(set.length / set.sampleRate).toFixed(2)} s) and segment description`);
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "llm") {
    const llm = await import("@vst-cloner/agent/cli");
    return llm.main(argv.slice(1));
  }
  if (argv[0] === "clone" || argv[0] === "analyze" || argv[0] === "verify") {
    const cloning = await import("@vst-cloner/clone/cli");
    return cloning.main(argv[0], argv.slice(1));
  }

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const [command, ...positionals] = parsed.positionals;
  const { values } = parsed;

  if (!command || values.help) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }

  try {
    switch (command) {
      case "list": await commandList(positionals); break;
      case "info": await commandInfo(positionals, values); break;
      case "plan": await commandPlan(positionals, values); break;
      case "capture": await commandCapture(positionals, values); break;
      case "inspect": await commandInspect(positionals, values); break;
      case "extract": await commandExtract(positionals); break;
      case "signal": await commandSignal(positionals, values); break;
      default: throw new UsageError(`unknown command '${command}'`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`Error: ${error.message}\n\nRun 'vch --help' for usage.`);
      return 2;
    }
    console.error(`Error: ${(error as Error).message}`);
    if (error instanceof HostError && error.stderr.trim()) console.error(`\nvch-host output:\n${error.stderr.trim().split("\n").slice(-20).join("\n")}`);
    return 1;
  }
}
