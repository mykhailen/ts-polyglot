// Compiles generated glue into a Node-API addon with the compiler that compiler.ts picked: MSVC on
// Windows, or a gcc- or clang-compatible driver on Linux and macOS.
//
// The platforms differ in how an addon reaches the Node-API functions that node itself exports.
// Windows links an import library for node.exe. Linux leaves them undefined until node loads the
// addon. macOS allows that only when asked, with `-undefined dynamic_lookup`.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Compiler } from "./compiler.ts";

const napiHeaders = dirname(fileURLToPath(import.meta.resolve("node-api-headers/package.json")));
const MSVC_MISSING = 'ts-polyglot: needs the Visual Studio C++ build tools ("Desktop development with C++")';

export interface AddonBuild {
  language: "c" | "cpp";
  /** The generated glue source file. */
  glue: string;
  /** What to link after the glue: Rust's static library and the native libraries rustc lists. */
  libs: string[];
  /** The .node to write. Its directory is the working directory. */
  out: string;
  debug: boolean;
  /** Where shared build files live, such as MSVC's Node-API import library. */
  cacheRoot: string;
}

export function compileAddon(compiler: Compiler, build: AddonBuild): void {
  if (compiler.family === "msvc") compileWithMsvc(build);
  else compileWithUnix(compiler.command, compiler.source, build);
}

function compileWithMsvc(build: AddonBuild): void {
  // vcvars64.bat and the import library below are x64-only.
  if (process.arch !== "x64") throw new Error(`ts-polyglot: on Windows only x64 Node is supported for now; this Node is ${process.arch}`);
  const vc = msvcEnvironment();
  const cppFlags = build.language === "cpp" ? ["/EHsc", "/std:c++17"] : [];
  const optimize = build.debug ? ["/Zi", "/Od"] : ["/O2"];
  const linkFlags = build.debug ? ["/DEBUG"] : [];
  const libs = [nodeApiImportLib(vc, build.cacheRoot), ...build.libs];
  const args = ["/nologo", ...optimize, "/MD", "/LD", `/I${join(napiHeaders, "include")}`, ...cppFlags, build.glue, "/link", `/OUT:${build.out}`, ...linkFlags, ...libs];
  run(join(vc.tools, "cl.exe"), args, dirname(build.out), { env: vc.env, missing: MSVC_MISSING });
}

function compileWithUnix(command: string[], source: string, build: AddonBuild): void {
  const [program, ...wrapped] = command;
  const cpp = build.language === "cpp";
  const from = source === "default" ? "the default" : `from ${source}`;
  const install = process.platform === "darwin"
    ? "Install the Xcode Command Line Tools (xcode-select --install)"
    : "Install gcc or clang (on Debian or Ubuntu: sudo apt install build-essential)";
  const missing = `ts-polyglot: can't run the ${cpp ? "C++" : "C"} compiler "${command.join(" ")}" (${from}). ${install}, or set ${cpp ? "CXX" : "CC"} to a compiler.`;
  try {
    run(program!, [...wrapped, ...unixArgs(build, process.platform, process.arch)], dirname(build.out), { missing });
  } catch (error) {
    // Without the Command Line Tools, macOS's /usr/bin/cc is a shim that fails like this.
    if (/xcrun: error: invalid active developer path/.test((error as Error).message)) {
      throw new Error("ts-polyglot: the Xcode Command Line Tools aren't installed. Run xcode-select --install.");
    }
    throw error;
  }
}

/** The arguments for a gcc- or clang-style build, after the command and any wrapper arguments. */
export function unixArgs(build: AddonBuild, platform: NodeJS.Platform, arch: string): string[] {
  // macOS also has to build for Node's architecture, which isn't the compiler's default when an x64
  // Node runs under Rosetta.
  const link = platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup", "-arch", arch === "arm64" ? "arm64" : "x86_64"]
    : ["-shared", "-fPIC"];
  return [
    ...(build.debug ? ["-g", "-O0"] : ["-O2"]),
    // With default visibility, the glue's calls to the user's functions go through the PLT, and on
    // Linux a same-named function in node or libc (random, crc32, ...) wins. Hidden keeps them inside
    // the addon; NAPI_MODULE_INIT marks its own entry points visible.
    "-fvisibility=hidden",
    `-I${join(napiHeaders, "include")}`,
    ...(build.language === "cpp" ? ["-std=c++17"] : []),
    ...link,
    build.glue,
    ...build.libs,
    "-o",
    build.out,
  ];
}

/** rustc builds for its own host, so on macOS it's told Node's architecture, as the C side is. */
export function rustTargetArgs(platform: NodeJS.Platform, arch: string): string[] {
  if (platform !== "darwin") return [];
  return ["--target", arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
}

/** MSVC's linker reads .lib archives; gcc and clang read lib*.a ones. */
export function rustStaticLibName(compiler: Compiler): string {
  return compiler.family === "msvc" ? "user.lib" : "libuser.a";
}

interface Toolchain {
  env: NodeJS.ProcessEnv;
  /** Directory of cl.exe and lib.exe. */
  tools: string;
}
let toolchain: Toolchain | undefined;

function msvcEnvironment(): Toolchain {
  if (toolchain) return toolchain;
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const install = existsSync(vswhere)
    ? execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim()
    : "";
  if (!install) throw new Error(MSVC_MISSING);
  // vcvars64.bat sets PATH, INCLUDE and LIB for the compiler. Capture the environment it produces.
  // It looks for vswhere.exe on PATH itself.
  const vcvars = join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const path = `${dirname(vswhere)};${process.env.PATH ?? ""}`;
  const env: NodeJS.ProcessEnv = {};
  for (const line of execSync(`"${vcvars}" >nul && set`, { encoding: "utf8", env: { ...process.env, PATH: path } }).split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  toolchain = { env, tools: join(env.VCToolsInstallDir ?? "", "bin", "Hostx64", "x64") };
  return toolchain;
}

/** Addons call Node-API functions that node.exe exports; they link against an import library for them. */
function nodeApiImportLib(vc: Toolchain, cacheRoot: string): string {
  const lib = join(cacheRoot, "node_api.lib");
  if (!existsSync(lib)) {
    mkdirSync(cacheRoot, { recursive: true });
    const def = join(napiHeaders, "def", "node_api.def");
    run(join(vc.tools, "lib.exe"), ["/nologo", `/def:${def}`, "/machine:x64", `/out:${lib}`], cacheRoot, { env: vc.env, missing: MSVC_MISSING });
  }
  return lib;
}

/** Runs a build tool and returns its stderr. Throws `missing` if the tool isn't there, and all its output if it fails. */
export function run(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; missing: string }): string {
  const result = spawnSync(command, args, { cwd, env: options.env, encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error(options.missing);
  if (result.status !== 0) {
    throw new Error(`ts-polyglot: ${basename(command)} failed\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error ?? ""}`);
  }
  return result.stderr;
}
