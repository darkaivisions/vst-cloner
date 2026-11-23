/**
 * Stages the runtime of the desktop app for an AppImage: Node, the TypeScript packages with their production
 * dependencies, vch-host and vch-gui, the plugin templates, JUCE and the training script – laid out as in the
 * repository (the code finds templates and host relative to itself) and packed into one archive. The app unpacks it
 * on its first start (src-tauri/src/lib.rs): Tauri's resource copy would lose the workspace symlinks in node_modules,
 * and an AppImage is read-only.
 *
 *   node scripts/stage-runtime.ts      → apps/desktop/src-tauri/runtime/vch-runtime.tar.zst
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = join(ROOT, "apps", "desktop", "src-tauri", "runtime");
const STAGE = join(ROOT, ".vch-work", "runtime-stage");
const PACKAGES = ["profile", "capture", "agent", "clone", "bridge"];

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const log = (text: string) => console.log(`stage-runtime: ${text}`);
const copy = (from: string, to: string, filter?: (path: string) => boolean) =>
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, ...(filter ? { filter } : {}) });

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// the packages: sources and bins, no tests
const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
writeFileSync(join(STAGE, "package.json"), JSON.stringify({ ...rootPackage, workspaces: PACKAGES, devDependencies: {} }, null, 2));
for (const name of PACKAGES) {
  copy(join(ROOT, name), join(STAGE, name), (path) => !/[\\/](test|node_modules)([\\/]|$)/.test(relative(ROOT, path)));
}

// production dependencies of the packages (hoisted in the root node_modules); workspace packages as symlinks
const listed = execFileSync("npm", ["ls", "--all", "--omit=dev", "--parseable", ...PACKAGES.flatMap((p) => ["--workspace", p])], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\n").map((line) => line.trim()).filter((line) => line.startsWith(join(ROOT, "node_modules")));
const modules = [...new Set(listed)];
for (const dir of modules) {
  const target = join(STAGE, relative(ROOT, dir));
  if (existsSync(target)) continue;
  mkdirSync(dirname(target), { recursive: true });
  copy(dir, target);
}
log(`${modules.length} modules`);

// host and editor host
for (const exe of ["vch-host", "vch-gui"]) {
  const file = join(ROOT, "host", "build", `${exe}_artefacts`, "Release", exe);
  if (!existsSync(file)) throw new Error(`${exe} is not built (npm run host:configure && npm run host:build)`);
  mkdirSync(join(STAGE, "host", "build", `${exe}_artefacts`, "Release"), { recursive: true });
  cpSync(file, join(STAGE, "host", "build", `${exe}_artefacts`, "Release", exe));
}

// plugin templates, training script
copy(join(ROOT, "plugin-template"), join(STAGE, "plugin-template"), (path) => !/[\\/]build([\\/]|$)/.test(relative(ROOT, path)));
copy(join(ROOT, "dsp", "neural"), join(STAGE, "dsp", "neural"), (path) => !/__pycache__/.test(path));

// JUCE where findJuceDir() looks (host/build/_deps/juce-src): modules and the CMake helpers, no examples or docs
const juce = process.env.VCH_JUCE_DIR ?? (() => {
  const cache = readFileSync(join(ROOT, "host", "build", "CMakeCache.txt"), "utf8");
  return /^VCH_JUCE_DIR:PATH=(.+)$/m.exec(cache)?.[1] ?? join(ROOT, "host", "build", "_deps", "juce-src");
})();
if (!existsSync(join(juce, "CMakeLists.txt"))) throw new Error(`JUCE not found at ${juce} (set VCH_JUCE_DIR)`);
copy(juce, join(STAGE, "host", "build", "_deps", "juce-src"), (path) => {
  const rel = relative(juce, path);
  return !/^(\.git|examples|docs)([\\/]|$)/.test(rel) && !/^extras[\\/](?!Build)/.test(rel);
});

// Node itself (the version running this script: ≥ 22.18, it runs TypeScript)
mkdirSync(join(STAGE, "node", "bin"), { recursive: true });
cpSync(process.execPath, join(STAGE, "node", "bin", "node"));
writeFileSync(join(STAGE, "VERSION"), `${version}\n`);

mkdirSync(OUT_DIR, { recursive: true });
const archive = join(OUT_DIR, "vch-runtime.tar.zst");
execFileSync("tar", ["--zstd", "-cf", archive, "-C", STAGE, "."], { stdio: "inherit" });
writeFileSync(join(OUT_DIR, "VERSION"), `${version}\n`);
log(`${archive} (${(Number(execFileSync("stat", ["-c", "%s", archive], { encoding: "utf8" })) / 1e6).toFixed(0)} MB)`);
