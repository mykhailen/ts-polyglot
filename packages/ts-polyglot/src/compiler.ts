// Decides which compiler builds a C, C++ or Rust file: MSVC on Windows; elsewhere CC/CXX, then the
// closest package.json with a "ts-polyglot" field, then cc/c++. It spawns nothing, so it's cheap
// enough to run on every import, and the mapper can call it to compile for diagnostics later.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type Compiler =
  | { family: "msvc" }
  | {
      family: "unix";
      /** The command and any leading arguments, such as ["ccache", "gcc"]. */
      command: string[];
      /** Where the choice came from, for error messages: "CC", "CXX", the package.json's path, or "default". */
      source: string;
    };

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Picks the compiler for C or C++ code. A Rust file's glue is C. */
export function resolveCompiler(file: string, language: "c" | "cpp", options: ResolveOptions = {}): Compiler {
  const { platform = process.platform, env = process.env } = options;
  // MSVC is the only Windows toolchain for now. The settings are ignored there rather than rejected:
  // package.json is shared, and a team that picks clang for Linux mustn't break its Windows machines.
  if (platform === "win32") return { family: "msvc" };

  const variable = language === "cpp" ? "CXX" : "CC";
  const fromEnv = env[variable]?.trim();
  // Split like make does, so a wrapper such as `ccache gcc` works.
  if (fromEnv) return { family: "unix", command: fromEnv.split(/\s+/), source: variable };

  const setting = findSetting(dirname(file));
  if (setting && setting.compiler !== undefined) {
    const { pkg, compiler } = setting;
    if (typeof compiler !== "string") throw new Error(`ts-polyglot: "compiler" in ${pkg} must be a string`);
    if (compiler === "msvc") throw new Error(`ts-polyglot: "compiler": "msvc" in ${pkg} only works on Windows`);
    // A path is relative to its package.json, like other paths in it; a bare name is found on PATH.
    const c = /[\\/]/.test(compiler) ? resolve(dirname(pkg), compiler) : compiler;
    if (language === "c") return { family: "unix", command: [c], source: pkg };
    const cpp = cppCompilerFor(c);
    if (!cpp) throw new Error(`ts-polyglot: can't tell which C++ compiler goes with "${compiler}" in ${pkg}. Set CXX to one.`);
    return { family: "unix", command: [cpp], source: pkg };
  }
  return { family: "unix", command: [language === "cpp" ? "c++" : "cc"], source: "default" };
}

const CPP_DRIVERS = [
  [/clang(?!\+\+)/, "clang++"],
  [/gcc/, "g++"],
  [/(?<=^|-)cc(?=-|$)/, "c++"],
] as const;

/** The C++ driver that goes with a C compiler, keeping its directory, prefix and version suffix. */
export function cppCompilerFor(c: string): string | undefined {
  const name = basename(c);
  for (const [pattern, replacement] of CPP_DRIVERS) {
    if (pattern.test(name)) return join(dirname(c), name.replace(pattern, replacement));
  }
  return undefined;
}

/** The closest package.json with a "ts-polyglot" field, searching upward from `dir`. */
function findSetting(dir: string): { pkg: string; compiler: unknown } | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const pkg = join(current, "package.json");
    const json = readPackageJson(pkg);
    if (typeof json === "object" && json !== null && Object.hasOwn(json, "ts-polyglot")) {
      const setting: unknown = json["ts-polyglot"];
      if (typeof setting !== "object" || setting === null || Array.isArray(setting)) {
        throw new Error(`ts-polyglot: "ts-polyglot" in ${pkg} must be an object`);
      }
      return { pkg, compiler: (setting as { compiler?: unknown }).compiler };
    }
    if (dirname(current) === current) return undefined;
  }
}

function readPackageJson(pkg: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(pkg, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  try {
    // Windows editors may save a BOM. Node accepts one in package.json, and JSON.parse doesn't.
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`ts-polyglot: can't parse ${pkg}: ${(error as Error).message}`);
  }
}
