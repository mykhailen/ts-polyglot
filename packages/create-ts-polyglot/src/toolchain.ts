// Reports whether the compilers ts-polyglot will need are installed. It mirrors how ts-polyglot finds
// them (MSVC through vswhere on Windows; CC/CXX, then cc and c++ elsewhere; rustc on PATH), reports
// rather than blocks, and takes `run` and `exists` as options so the tests need no compiler.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface ToolCheck {
  tool: string;
  found: boolean;
  /** How to install it, for when it isn't found. */
  hint: string;
}

export interface ToolcheckOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  exists?: (path: string) => boolean;
  /** Runs a command and returns its stdout, or undefined when it's missing or fails. */
  run?: (command: string, args: string[]) => string | undefined;
}

const MSVC_HINT = 'Install the Visual Studio 2022 Build Tools with "Desktop development with C++": https://visualstudio.microsoft.com/visual-cpp-build-tools/';
const RUST_HINT = "Install Rust from https://rustup.rs (only .rs files need it)";

export function checkToolchain(options: ToolcheckOptions = {}): ToolCheck[] {
  const { platform = process.platform, env = process.env, nodeVersion = process.version, exists = existsSync, run = runQuietly } = options;
  const checks: ToolCheck[] = [{ tool: "Node 22.18+", found: nodeAtLeast(nodeVersion, 22, 18), hint: "ts-polyglot runs TypeScript files directly, which needs Node 22.18 or newer: https://nodejs.org" }];

  if (platform === "win32") {
    // Windows paths even when the check runs elsewhere, so the tests cover this branch on every OS.
    const vswhere = win32.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const install = exists(vswhere)
      ? run(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"])?.trim()
      : undefined;
    checks.push({ tool: "C/C++ compiler (MSVC)", found: Boolean(install), hint: MSVC_HINT });
  } else {
    const hint = platform === "darwin"
      ? "Install the Xcode Command Line Tools: xcode-select --install"
      : "Install gcc or clang (on Debian or Ubuntu: sudo apt install build-essential)";
    // Split like make does, so CC="ccache gcc" asks for ccache, as ts-polyglot will.
    const cc = env.CC?.trim().split(/\s+/) ?? ["cc"];
    const cxx = env.CXX?.trim().split(/\s+/) ?? ["c++"];
    checks.push({ tool: "C compiler", found: run(cc[0], [...cc.slice(1), "--version"]) !== undefined, hint });
    checks.push({ tool: "C++ compiler", found: run(cxx[0], [...cxx.slice(1), "--version"]) !== undefined, hint });
  }
  checks.push({ tool: "Rust", found: run("rustc", ["--version"]) !== undefined, hint: RUST_HINT });
  return checks;
}

export interface FindNodeOptions {
  execPath?: string;
  platform?: NodeJS.Platform;
  run?: ToolcheckOptions["run"];
}

/**
 * The node for the native debugger to launch, by full path: the one running the scaffold, unless
 * that's bun or deno, which can't run the hook; then the first node on PATH.
 */
export function findNode(options: FindNodeOptions = {}): string {
  const { execPath = process.execPath, platform = process.platform, run = runQuietly } = options;
  if (/^node(\.exe)?$/i.test((platform === "win32" ? win32 : posix).basename(execPath))) return execPath;
  const found = run(platform === "win32" ? "where.exe" : "which", ["node"])?.split(/\r?\n/)[0]?.trim();
  return found || execPath;
}

function nodeAtLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.replace(/^v/, "").split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

function runQuietly(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : undefined;
}
