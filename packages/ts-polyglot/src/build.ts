// Turns a C, C++ or Rust file into a Node-API addon (.node) with one JavaScript function per
// exported native function, plus the ES module (.mjs) that loads the addon and exports those
// functions. Windows builds with MSVC, Linux and macOS with a gcc- or clang-compatible compiler:
// compiler.ts picks it and toolchain.ts runs it. Rust also needs rustc on PATH.
//
// What the glue calls, and with which C types, is the language's bridge: C and C++ glue `#include`s
// the source file (C++ through static shims that catch exceptions), and a Rust file becomes a module
// of a small crate whose `extern "C"` wrappers are compiled to a static library the glue links. The
// glue itself (glue.ts, marshal.ts) is the same for every language.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCompiler } from "./compiler.ts";
import { glueSource, moduleSource } from "./glue.ts";
import { languageModule, languageOf, parseModule } from "./languages/index.ts";
import { compileAddon } from "./toolchain.ts";

// Bump to rebuild every cached addon after changing the generated code or the compiler flags.
const GLUE_VERSION = 15;
// Linux and macOS bind an addon's symbols lazily, so a function the native file declares but never
// defines would kill node at its first call. RTLD_NOW fails the import instead, catchably. Windows
// has no dlopen flags; its linker already refuses such an addon.
const dlopenFlags: number | undefined = constants.dlopen.RTLD_NOW;
// TS_POLYGLOT_DEBUG=1 builds unoptimized addons with debug info (.pdb files on Windows), so a native
// debugger attached to node can stop in the C, C++ or Rust source.
const debug = process.env.TS_POLYGLOT_DEBUG === "1";
// TS_POLYGLOT_CACHE_DIR moves the cache: tests need a fresh one, and CI can keep one between runs.
const cacheRoot = process.env.TS_POLYGLOT_CACHE_DIR
  ? resolve(process.env.TS_POLYGLOT_CACHE_DIR)
  : fileURLToPath(new URL("../node_modules/.cache/ts-polyglot/", import.meta.url));

/** Builds the addon for a native file unless it's cached, and returns the path of the module that loads it. */
export function buildAddon(file: string, source: string): string {
  const language = languageOf(file);
  if (!language) throw new Error(`ts-polyglot: not a C, C++ or Rust file: ${file}`);
  const owner = languageModule(language);
  const module = parseModule(source, language);
  const compiler = resolveCompiler(file, owner.glue);
  // The platform is in the key because one checkout can be used from Windows and from WSL or a
  // container; the compiler, so that switching compilers rebuilds.
  const key = createHash("sha256")
    .update(JSON.stringify([GLUE_VERSION, debug, process.version, process.platform, process.arch, compiler.family === "msvc" ? "msvc" : compiler.command, language, source]))
    .digest("hex")
    .slice(0, 16);
  const dir = join(cacheRoot, key);
  const name = basename(file).replace(/\W/g, "_");
  const addon = join(dir, `${name}.node`);
  // Written after the addon, so it's there only when the build finished.
  const loader = join(dir, `${name}.mjs`);
  if (existsSync(loader)) return loader;

  mkdirSync(dir, { recursive: true });
  const bridge = owner.bridge({ file, module, dir, compiler, debug });
  const glue = join(dir, owner.glue === "cpp" ? "glue.cpp" : "glue.c");
  writeFileSync(glue, glueSource(module, bridge));
  compileAddon(compiler, { language: owner.glue, glue, libs: bridge.libs, out: addon, debug, cacheRoot });
  writeFileSync(loader, moduleSource(file, addon, module, dlopenFlags));
  return loader;
}
