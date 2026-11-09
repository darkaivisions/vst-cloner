import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readProfile, writeProfile } from "@vst-cloner/profile";
import { strToU8 } from "fflate";
import type { Logger } from "./build.ts";
import { verifyClone } from "./verify.ts";
import { analyze, cloneProfile, formatModelReport, formatVerifyReport, MODEL_FILE, storedModel } from "./workflow.ts";

export const USAGE = `Cloning:
  vch clone   <profile> [-o <dir>] [--name <text>] [--install] [--refit] [--no-verify]
                                        Analyse, build the clone (VST3 + LV2) and compare it with the original
  vch analyze <profile> [--save] [--json]
                                        Fit the model and show how well it matches
  vch verify  <profile> <clone.vst3>    Compare a built clone with the original measurements
`;

const OPTIONS = {
  output: { type: "string", short: "o" },
  name: { type: "string" },
  install: { type: "boolean" },
  refit: { type: "boolean" },
  "no-verify": { type: "boolean" },
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
  const profilePath = positionals[0] ? resolve(positionals[0]) : undefined;
  if (!profilePath) {
    console.error(`Error: missing profile path\n\n${USAGE}`);
    return 2;
  }

  try {
    switch (command) {
      case "clone": {
        const result = await cloneProfile({
          profilePath,
          ...(values.output ? { outputDir: resolve(values.output) } : {}),
          ...(values.name ? { pluginName: values.name } : {}),
          ...(values.install ? { install: true } : {}),
          ...(values.refit ? { refit: true } : {}),
          ...(values["no-verify"] ? { skipVerify: true } : {}),
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
