/**
 * The tools a clone is built with, found the way the build uses them – so that a check saying "all there" means the
 * build finds them too. Required: CMake and a C++ compiler (on Windows Visual Studio with its C++ tools, which also
 * bring a CMake). Optional: what single features need (editor rebuild, reading texts, yabridge, faster builds).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ToolStatus {
  id: string;
  name: string;
  required: boolean;
  found: boolean;
  /** path or version where found */
  detail?: string;
  /** what it is needed for */
  purpose: string;
  /** how to install it on this system */
  hint: string;
}

const WIN = process.platform === "win32";

/** An executable on PATH (with .exe on Windows), or undefined. */
export function onPath(exe: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const file = join(dir, WIN && !exe.endsWith(".exe") ? `${exe}.exe` : exe);
    if (existsSync(file)) return file;
  }
  return undefined;
}

let visualStudioCache: string | null | undefined;
/** Installation directory of the newest Visual Studio (or Build Tools) with the C++ tools; Windows only. */
export function findVisualStudio(): string | undefined {
  if (!WIN) return undefined;
  if (visualStudioCache !== undefined) return visualStudioCache ?? undefined;
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  visualStudioCache = null;
  if (existsSync(vswhere)) {
    try {
      const path = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", timeout: 15000 }).trim();
      if (path && existsSync(path)) visualStudioCache = path;
    } catch {
      // no Visual Studio
    }
  }
  return visualStudioCache ?? undefined;
}

/** CMake: on PATH, else the one Visual Studio brings (Windows) or the usual macOS places. */
export function findCmake(): string | undefined {
  const found = onPath("cmake");
  if (found) return found;
  if (WIN) {
    const vs = findVisualStudio();
    const bundled = vs && join(vs, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe");
    if (bundled && existsSync(bundled)) return bundled;
  }
  if (process.platform === "darwin") {
    for (const path of ["/opt/homebrew/bin/cmake", "/usr/local/bin/cmake", "/Applications/CMake.app/Contents/bin/cmake"]) if (existsSync(path)) return path;
  }
  return undefined;
}

/** The C++ compiler CMake will use: Visual Studio on Windows, c++/g++/clang++ elsewhere. */
export function findCompiler(): string | undefined {
  if (WIN) return findVisualStudio();
  return onPath("c++") ?? onPath("g++") ?? onPath("clang++");
}

/** The package manager of a Linux system, for install hints. */
function packageManager(): "pacman" | "apt" | "dnf" | "zypper" | undefined {
  if (process.platform !== "linux") return undefined;
  if (onPath("pacman")) return "pacman";
  if (onPath("apt")) return "apt";
  if (onPath("dnf")) return "dnf";
  if (onPath("zypper")) return "zypper";
  return undefined;
}

/** Install command for packages named per package manager. */
function install(names: Partial<Record<"pacman" | "apt" | "dnf" | "zypper", string>>, fallback: string): string {
  const pm = packageManager();
  const name = pm && names[pm];
  if (!pm || !name) return fallback;
  return { pacman: `sudo pacman -S ${name}`, apt: `sudo apt install ${name}`, dnf: `sudo dnf install ${name}`, zypper: `sudo zypper install ${name}` }[pm];
}

const VS_HINT = "Install the Visual Studio Build Tools with \"Desktop development with C++\" (visualstudio.microsoft.com/downloads – it includes CMake)";

/** Status of every tool, required ones first. */
export function checkToolchain(): ToolStatus[] {
  const cmake = findCmake(), compiler = findCompiler();
  const tools: ToolStatus[] = [
    {
      id: "cmake", name: "CMake", required: true, found: Boolean(cmake), ...(cmake ? { detail: cmake } : {}),
      purpose: "builds the clones",
      hint: WIN ? VS_HINT : process.platform === "darwin" ? "brew install cmake" : install({ pacman: "cmake", apt: "cmake", dnf: "cmake", zypper: "cmake" }, "Install CMake (cmake.org/download)"),
    },
    {
      id: "compiler", name: WIN ? "Visual Studio C++ tools" : "C++ compiler", required: true, found: Boolean(compiler), ...(compiler ? { detail: compiler } : {}),
      purpose: "compiles the clones",
      hint: WIN ? VS_HINT : process.platform === "darwin" ? "xcode-select --install" : install({ pacman: "base-devel", apt: "build-essential", dnf: "gcc-c++ make", zypper: "gcc-c++ make" }, "Install g++ or clang++"),
    },
  ];
  const optional = (id: string, name: string, exe: string, purpose: string, packages: Parameters<typeof install>[0], fallback: string) => {
    const path = onPath(exe);
    tools.push({ id, name, required: false, found: Boolean(path), ...(path ? { detail: path } : {}), purpose, hint: install(packages, fallback) });
  };
  if (!WIN) optional("ninja", "Ninja", "ninja", "faster clone builds", { pacman: "ninja", apt: "ninja-build", dnf: "ninja-build", zypper: "ninja" }, "Install Ninja");
  if (process.platform === "linux") {
    optional("xvfb", "Xvfb", "Xvfb", "rebuilds the original's editor without a window on your desktop", { pacman: "xorg-server-xvfb", apt: "xvfb", dnf: "xorg-x11-server-Xvfb", zypper: "xvfb-run" }, "Install Xvfb");
    optional("yabridge", "yabridge", "yabridgectl", "Windows plugins on Linux", { pacman: "yabridge" }, "See github.com/robbert-vdh/yabridge");
  }
  optional("tesseract", "Tesseract", "tesseract", "reads the texts of the original's editor", { pacman: "tesseract tesseract-data-eng", apt: "tesseract-ocr", dnf: "tesseract", zypper: "tesseract-ocr" },
    WIN ? "github.com/UB-Mannheim/tesseract/wiki (installer), then add it to PATH" : process.platform === "darwin" ? "brew install tesseract" : "Install tesseract");
  return tools;
}

/** Throws with an install hint when a required tool is missing (before a build starts). */
export function requireToolchain(): { cmake: string } {
  const missing = checkToolchain().filter((t) => t.required && !t.found);
  if (missing.length) throw new Error(`Cannot build the clone – missing: ${missing.map((t) => `${t.name} (${t.hint})`).join("; ")}`);
  return { cmake: findCmake()! };
}
