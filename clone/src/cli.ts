import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readProfile, writeProfile } from "@vst-cloner/profile";
import { strToU8 } from "fflate";
import type { Logger } from "./build.ts";
import { EFFECT_CLASSES, runBatch, type EffectClass } from "./batch.ts";
import { verifyClone } from "./verify.ts";
import { analyze, cloneProfile, formatModelReport, formatVerifyReport, MODEL_FILE, storedModel } from "./workflow.ts";
import { cloneDynamicsProfile, isDynamicsProfile } from "./dynamics/workflow.ts";
import { cloneDistortionProfile, isDistortionProfile } from "./distortion/workflow.ts";
import { cloneDelayProfile, isDelayProfile } from "./delay/workflow.ts";

export const USAGE = `Cloning:
  vch clone   <profile> [-o <dir>] [--name <text>] [--install] [--refit] [--no-verify]
              [--gui] [--refit-gui] [--plugin <original>]
                                        Analyse, build the clone (VST3 + LV2) and compare it with the original;
                                        --gui also rebuilds the editor of the original (Linux: needs Xvfb)
  vch analyze <profile> [--save] [--json]
                                        Fit the model and show how well it matches
  vch verify  <profile> <clone.vst3>    Compare a built clone with the original measurements
  vch batch   --class <eq|dynamics|distortion|delay> -o <dir> [--match <regex>] [--limit <n>] [--gui]
              [--force] [--yabridge] [--all-formats] [--timeout <s>] [plugin …]
                                        Capture and clone every installed plugin of one class (nothing is
                                        installed); report in <dir>/report.md, one log per plugin
`;

const OPTIONS = {
  output: { type: "string", short: "o" },
  name: { type: "string" },
  install: { type: "boolean" },
  refit: { type: "boolean" },
  "no-verify": { type: "boolean" },
  gui: { type: "boolean" },
  "refit-gui": { type: "boolean" },
  plugin: { type: "string" },
  class: { type: "string" },
  match: { type: "string" },
  limit: { type: "string" },
  force: { type: "boolean" },
  yabridge: { type: "boolean" },
  "all-formats": { type: "boolean" },
  timeout: { type: "string" },
  save: { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
} as const;

function logger(verbose: boolean): Logger {
  const started = Date.now();
  const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
  return (level, message) => {
    if (level === "detail" && !verbose) return;
    const prefix = level === "warn" ? "!" : level === "detail" ? "·" : "›";
    console.error(`${stamp()} ${prefix} ${message}`);
  };
}

export async function main(command: string, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const log = logger(values.verbose ?? false);
  if (command === "batch") return batchCommand(values, positionals, log);
  const profilePath = positionals[0] ? resolve(positionals[0]) : undefined;
  if (!profilePath) {
    console.error(`Error: missing profile path\n\n${USAGE}`);
    return 2;
  }

  try {
    switch (command) {
      case "clone": {
        const loaded = await readProfile(profilePath);
        if (isDelayProfile(loaded) || isDistortionProfile(loaded) || isDynamicsProfile(loaded)) {
          const clone = isDelayProfile(loaded) ? cloneDelayProfile : isDistortionProfile(loaded) ? cloneDistortionProfile : cloneDynamicsProfile;
          const result = await clone({
            profilePath,
            ...(values.output ? { outputDir: resolve(values.output) } : {}),
            ...(values.name ? { pluginName: values.name } : {}),
            ...(values.install ? { install: true } : {}),
            ...(values.refit ? { refit: true } : {}),
            ...(values["no-verify"] ? { skipVerify: true } : {}),
            ...(values.gui ? { gui: true } : {}),
            ...(values["refit-gui"] ? { gui: true, refitGui: true } : {}),
            ...(values.plugin ? { pluginPath: resolve(values.plugin) } : {}),
            log,
          });
          console.log(`VST3: ${result.build.vst3}\nLV2:  ${result.build.lv2}`);
          for (const path of result.build.installed) console.log(`Installed: ${path}`);
          return 0;
        }
        const result = await cloneProfile({
          profilePath,
          ...(values.output ? { outputDir: resolve(values.output) } : {}),
          ...(values.name ? { pluginName: values.name } : {}),
          ...(values.install ? { install: true } : {}),
          ...(values.refit ? { refit: true } : {}),
          ...(values["no-verify"] ? { skipVerify: true } : {}),
          ...(values.gui ? { gui: true } : {}),
          ...(values["refit-gui"] ? { gui: true, refitGui: true } : {}),
          ...(values.plugin ? { pluginPath: resolve(values.plugin) } : {}),
          log,
        });
        console.log(`VST3: ${result.build.vst3}\nLV2:  ${result.build.lv2}`);
        for (const path of result.build.installed) console.log(`Installed: ${path}`);
        return 0;
      }

      case "analyze": {
        const profile = await readProfile(profilePath);
        const model = analyze(profile, log);
        if (values.json) console.log(JSON.stringify(model.report, null, 2));
        else for (const line of formatModelReport(model)) console.log(line);
        if (values.save) {
          profile.files.set(MODEL_FILE, strToU8(JSON.stringify(model, null, 1)));
          await writeProfile(profilePath, profile);
          log("info", `Model saved in ${profilePath}`);
        }
        return 0;
      }

      case "verify": {
        const clonePath = positionals[1];
        if (!clonePath) throw new Error("missing clone plugin path");
        const profile = await readProfile(profilePath);
        const model = storedModel(profile) ?? analyze(profile, log);
        const report = await verifyClone(profile, model, resolve(clonePath), { log });
        if (values.json) console.log(JSON.stringify(report, null, 2));
        else for (const line of formatVerifyReport(report)) console.log(line);
        return 0;
      }

      default:
        throw new Error(`unknown command '${command}'`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    return 1;
  }
}

async function batchCommand(values: Record<string, string | boolean | undefined>, positionals: string[], log: Logger): Promise<number> {
  const effectClass = values.class as EffectClass | undefined;
  if (!effectClass || !EFFECT_CLASSES.includes(effectClass) || typeof values.output !== "string") {
    console.error(`Error: batch needs --class <${EFFECT_CLASSES.join("|")}> and -o <dir>\n\n${USAGE}`);
    return 2;
  }
  const controller = new AbortController();
  process.once("SIGINT", () => {
    log("warn", "Abbruch – der Bericht enthält alle fertigen Plugins, ein neuer Start setzt dort fort");
    controller.abort();
  });
  try {
    const report = await runBatch({
      effectClass,
      outputDir: resolve(values.output),
      ...(positionals.length ? { plugins: positionals.map((p) => resolve(p)) } : {}),
      ...(typeof values.match === "string" ? { match: new RegExp(values.match, "i") } : {}),
      ...(typeof values.limit === "string" ? { limit: Number(values.limit) } : {}),
      ...(typeof values.timeout === "string" ? { timeoutSeconds: Number(values.timeout) } : {}),
      gui: values.gui === true,
      force: values.force === true,
      yabridge: values.yabridge === true,
      allFormats: values["all-formats"] === true,
      log,
      signal: controller.signal,
    });
    const tried = report.rows.filter((r) => r.status !== "skipped");
    console.log(`${tried.filter((r) => r.status === "ok").length} von ${tried.length} geklont – ${join(resolve(values.output), "report.md")}`);
    return 0;
  } catch (error) {
    if (controller.signal.aborted) return 130;
    throw error;
  }
}
