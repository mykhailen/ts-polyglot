# Cross-platform compilers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and load C, C++ and Rust addons on Linux and macOS as well as Windows. Each OS uses
its usual compiler by default, and gcc or clang can be chosen on Linux and macOS.

**Architecture:**
- A new `compiler.ts` decides which compiler builds a file (env, package.json, or default). It spawns
  nothing.
- A new `toolchain.ts` holds the build recipes: today's MSVC code moved out of `build.ts`, plus a
  gcc/clang recipe for Linux and macOS.
- `build.ts` keeps glue generation and the cache, and adds the platform and the compiler to the cache
  key.
- Tests use `node:test`. Unit tests cover `src/`, and end-to-end tests run `dist/` with real
  compilers: on Windows here, on Linux in Docker, and on all three OSes in GitHub Actions.

**Tech Stack:** TypeScript 7.1 beta, Node 22.18+ (type stripping, `node:test`), Node-API through
`node-api-headers`, MSVC, gcc and clang, rustc, Docker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-22-cross-platform-compilers-design.md`

## Global Constraints

- Node `>=22.18`. `typescript` stays pinned to `7.1.0-beta`.
- `dist/` is what runs: `exports["./register"]` and the mapper's `exec` point there. Anything that
  exercises `tsc`, the editor, the probe or `node --import ts-polyglot/register` builds first.
- `src/` stays runnable by Node's type stripping: erasable syntax only (no `enum`, `namespace` or
  parameter properties), `.ts` extensions on relative imports, and `import type` for types.
- No new dependencies. Tests use `node:test` and `node:assert/strict`.
- Comments say why, not what. Match the density of the existing files.
- Bump `GLUE_VERSION` whenever the generated C, C++ or Rust, or the compiler flags, change.
- Compiler resolution spawns nothing. Importing a file whose addon is cached spawns no process: no
  compiler probe, no `vswhere`, no `vcvars64.bat`.
- Windows: MSVC only, x64 Node only. `compiler`, `CC` and `CXX` are ignored there.
- A given source file gets the same TypeScript declarations on every OS, because the parser's type
  tables are platform-independent.
- Work on branch `cross-platform-compilers`. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Spaces in paths.** Windows user profiles like `C:\Users\Jane Doe` put spaces in the cache, glue
   and `.node` paths, and those must survive `cl`, `link`, `rustc` and `cc`. Task 4's end-to-end cache
   directory has a space in its name.
2. **A package.json saved with a UTF-8 BOM** (by Windows editors) and read on Linux or macOS. Node
   accepts it, so the resolver must too. Task 2: `reads a package.json that starts with a BOM`.
3. **No package.json anywhere above the file, or parent directories that don't exist.** Resolution
   reaches the filesystem root and uses the default without throwing. Task 2: `falls back to the
   default when no package.json is found`.
4. **Switching compilers with a warm cache.** The second compiler must rebuild, not reuse the first
   one's addon. Task 4: `CC overrides package.json for C only` runs after the clang test, in the same
   cache directory.
5. **A Windows shell that already has `CC`/`CXX` set** (MSYS2, conda). The build still uses MSVC.
   Task 4: `Windows ignores compiler, CC and CXX`.

---

### Task 1: Test runner, and C `long` as 64-bit

**Files:**
- Modify: `package.json` (scripts)
- Modify: `packages/ts-polyglot/package.json` (scripts)
- Modify: `packages/ts-polyglot/tsconfig.json`
- Modify: `packages/ts-polyglot/tsconfig.build.json`
- Modify: `packages/ts-polyglot/src/signatures.ts:34-41` (`C_TYPES`)
- Modify: `packages/ts-polyglot/src/build.ts:16` (`GLUE_VERSION`)
- Modify: `packages/ts-polyglot/README.md` (Limits)
- Create: `packages/ts-polyglot/test/signatures.test.ts`

**Interfaces:**
- Produces:
  - Root `npm test`, which runs `npm test --workspaces --if-present`.
  - The package's `test` script, which builds `dist/` and then runs `node --test` over `test/**/*.test.ts`.
  - Test files go in `packages/ts-polyglot/test/`, and fixtures go in `packages/ts-polyglot/test/fixtures/`. The fixtures are excluded from the package's type check.

- [ ] **Step 1: Wire up the runner**
  - Root `package.json` scripts: `"test": "npm test --workspaces --if-present"`.
  - `packages/ts-polyglot/package.json` scripts: `"test": "npm run build && node --test \"test/**/*.test.ts\""`.
  - `packages/ts-polyglot/tsconfig.json`: `"include": ["src", "test"]`, `"exclude": ["test/fixtures"]`.
  - `packages/ts-polyglot/tsconfig.build.json`: `"include": ["src"]`. It extends `tsconfig.json`, and its `rootDir: "src"` would reject the tests.

- [ ] **Step 2: Write the failing test** `packages/ts-polyglot/test/signatures.test.ts`

```ts
// The parser's type tables, which the mapper and the runtime share.
import assert from "node:assert/strict";
import test from "node:test";

import { findFunctions } from "../src/signatures.ts";

test("C long crosses as 64-bit on every OS", () => {
  const [fn] = findFunctions("long echo_long(long x) { return x; }", "c");
  assert.equal(fn?.returns.c, "int64_t");
  assert.equal(fn?.params[0]?.kind.fromJs, "napi_get_value_int64");
});

test("unsigned long is skipped on every OS", () => {
  assert.deepEqual(findFunctions("unsigned long f(unsigned long x) { return x; }", "c"), []);
});

test("int stays 32-bit", () => {
  const [fn] = findFunctions("int add(int a, int b) { return a + b; }", "c");
  assert.equal(fn?.returns.c, "int32_t");
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm test`
Expected: the build succeeds and the runner finds the file. The first two tests FAIL (`int32_t` vs `int64_t`, and one function found instead of none), and `int stays 32-bit` passes.

- [ ] **Step 4: Change `C_TYPES`**
  - In `signatures.ts`, map `long` to `I64` and delete `"unsigned long"`.
  - Add a why-comment. `long` is 32-bit on Windows and 64-bit on Linux and macOS, so it crosses as 64-bit everywhere. `unsigned long` would need 64-bit unsigned values, which come with the `bigint` work.
  - In `build.ts`, set `GLUE_VERSION = 2`, because the glue generated for `long` changes.
  - Package README, Limits: the `int64_t`/`i64` bullet becomes "`long`, `long long`, `int64_t` and `i64` become JavaScript numbers, so values above 2^53 lose precision. `unsigned long` is skipped: 64-bit unsigned values aren't supported yet."

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test`, then `npm run typecheck`
Expected: `npm test` reports 3 passing tests. `npm run typecheck` shows no errors, and it now covers `test/` too.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/ts-polyglot
git commit -m "Add the test runner; C long crosses as 64-bit on every OS"
```

---

### Task 2: Compiler resolution

**Files:**
- Create: `packages/ts-polyglot/src/compiler.ts`
- Create: `packages/ts-polyglot/test/compiler.test.ts`
- Modify: `packages/ts-polyglot/README.md` (a new `## Compilers` section after "Use it in a project")

**Interfaces:**
- Produces (from `compiler.ts`):

```ts
export type Compiler =
  | { family: "msvc" }
  | {
      family: "unix";
      /** The command and any leading arguments, such as ["ccache", "gcc"]. */
      command: string[];
      /** Where the choice came from: "CC", "CXX", the package.json's path, or "default". */
      source: string;
    };
export interface ResolveOptions {
  platform?: NodeJS.Platform; // default process.platform
  env?: NodeJS.ProcessEnv; // default process.env
}
/** `language` is the language being compiled: Rust's glue is "c". Spawns nothing. */
export function resolveCompiler(file: string, language: "c" | "cpp", options?: ResolveOptions): Compiler;
/** The C++ driver that goes with a C compiler ("gcc-13" → "g++-13"), or undefined. Keeps the directory. */
export function cppCompilerFor(c: string): string | undefined;
```

**How `resolveCompiler` decides** (from the spec, in order):
1. If `platform === "win32"`, return `{ family: "msvc" }` without reading env or files.
2. Look at `env.CC` (C) or `env.CXX` (C++), trimmed. If it's non-empty, `command` is the value split on `/\s+/`, and `source` is `"CC"` or `"CXX"`.
3. Otherwise, walk from `dirname(file)` up to the filesystem root. In each directory, read `package.json` if it exists (skip `ENOENT` and `ENOTDIR`), strip a leading U+FEFF, and `JSON.parse` it. The first one with an own `"ts-polyglot"` key wins, and the search stops there:
   - If the field isn't a plain object, throw.
   - If it has no `compiler`, go to step 4.
   - If `compiler` isn't a string, throw. If it's `"msvc"`, throw.
   - A value containing `/` or `\` becomes `resolve(dirname(pkg), value)`. A bare name is kept as is and looked up on PATH.
   - For C++, use `cppCompilerFor(value)`. If that's undefined, throw.
   - `source` is the package.json's path.
4. The default is `["cc"]` for C and `["c++"]` for C++, with `source: "default"`.

`cppCompilerFor` replaces the first match in the basename, trying in order:
- `clang` not followed by `++` becomes `clang++`;
- `gcc` becomes `g++`;
- `cc` as a whole `-`-separated word becomes `c++`.

Use `node:path` `dirname`/`basename`/`join`.

**Error text (exact):**
- `ts-polyglot: can't parse ${pkg}: ${error.message}`
- `ts-polyglot: "ts-polyglot" in ${pkg} must be an object`
- `ts-polyglot: "compiler" in ${pkg} must be a string`
- `ts-polyglot: "compiler": "msvc" in ${pkg} only works on Windows`
- `ts-polyglot: can't tell which C++ compiler goes with "${value}" in ${pkg}. Set CXX to one.`

- [ ] **Step 1: Write the failing tests** `packages/ts-polyglot/test/compiler.test.ts`

```ts
// Which compiler builds a file. Platform and env are passed in, so every OS is covered from any OS.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { after } from "node:test";

import { cppCompilerFor, resolveCompiler } from "../src/compiler.ts";

const root = mkdtempSync(join(tmpdir(), "ts-polyglot-compiler-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A directory under the temp root, with a package.json made from an object or written as raw text. */
function project(name: string, packageJson?: unknown): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (packageJson !== undefined) {
    writeFileSync(join(dir, "package.json"), typeof packageJson === "string" ? packageJson : JSON.stringify(packageJson));
  }
  return dir;
}
const linux = { platform: "linux", env: {} } as const;
const unix = (command: string[], source: string) => ({ family: "unix", command, source });

test("Windows always uses MSVC", () => {
  const dir = project("win", { "ts-polyglot": { compiler: "gcc" } });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform: "win32", env: { CC: "gcc" } }), { family: "msvc" });
});

test("Linux and macOS default to cc and c++", () => {
  const dir = project("plain", { name: "plain" });
  for (const platform of ["linux", "darwin"] as const) {
    assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform, env: {} }), unix(["cc"], "default"));
    assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", { platform, env: {} }), unix(["c++"], "default"));
  }
});

test("package.json picks the compiler, and C++ gets the matching driver", () => {
  const dir = project("clang", { "ts-polyglot": { compiler: "clang" } });
  const pkg = join(dir, "package.json");
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix(["clang"], pkg));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", linux), unix(["clang++"], pkg));
});

test("the search goes upward past package.json files without the field", () => {
  const top = project("up", { "ts-polyglot": { compiler: "gcc" } });
  const inner = project(join("up", "inner"), { name: "inner" });
  assert.deepEqual(resolveCompiler(join(inner, "src", "a.c"), "c", linux), unix(["gcc"], join(top, "package.json")));
});

test("the nearest ts-polyglot field wins, even without a compiler", () => {
  project("near", { "ts-polyglot": { compiler: "gcc" } });
  const inner = project(join("near", "inner"), { "ts-polyglot": {} });
  assert.deepEqual(resolveCompiler(join(inner, "a.c"), "c", linux), unix(["cc"], "default"));
});

test("a relative compiler path is relative to its package.json", () => {
  const dir = project("relative", { "ts-polyglot": { compiler: "./tools/gcc-13" } });
  const pkg = join(dir, "package.json");
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix([join(dir, "tools", "gcc-13")], pkg));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", linux), unix([join(dir, "tools", "g++-13")], pkg));
});

test("CC and CXX override package.json, each for its own language", () => {
  const dir = project("env", { "ts-polyglot": { compiler: "clang" } });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform: "linux", env: { CC: "ccache gcc" } }), unix(["ccache", "gcc"], "CC"));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", { platform: "linux", env: { CC: "gcc" } }), unix(["clang++"], join(dir, "package.json")));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", { platform: "linux", env: { CXX: "g++-13" } }), unix(["g++-13"], "CXX"));
});

test("an empty CC counts as unset", () => {
  const dir = project("empty-env", { name: "x" });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform: "linux", env: { CC: "  " } }), unix(["cc"], "default"));
});

test("msvc on Linux or macOS is an error naming the package.json", () => {
  const dir = project("msvc", { "ts-polyglot": { compiler: "msvc" } });
  assert.throws(
    () => resolveCompiler(join(dir, "a.c"), "c", { platform: "darwin", env: {} }),
    (error: Error) => error.message.includes("only works on Windows") && error.message.includes(join(dir, "package.json")),
  );
});

test("bad settings are errors", () => {
  const notString = project("not-string", { "ts-polyglot": { compiler: 42 } });
  assert.throws(() => resolveCompiler(join(notString, "a.c"), "c", linux), /"compiler" in .* must be a string/);
  const notObject = project("not-object", { "ts-polyglot": "clang" });
  assert.throws(() => resolveCompiler(join(notObject, "a.c"), "c", linux), /must be an object/);
  const broken = project("broken", "{ not json");
  assert.throws(() => resolveCompiler(join(broken, "a.c"), "c", linux), /can't parse/);
});

test("a C++ file needs CXX when the C compiler has no C++ counterpart", () => {
  const dir = project("tcc", { "ts-polyglot": { compiler: "tcc" } });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix(["tcc"], join(dir, "package.json")));
  assert.throws(() => resolveCompiler(join(dir, "a.cpp"), "cpp", linux), /Set CXX/);
});

test("reads a package.json that starts with a BOM", () => {
  const dir = project("bom", "\uFEFF" + JSON.stringify({ "ts-polyglot": { compiler: "clang" } }));
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix(["clang"], join(dir, "package.json")));
});

test("falls back to the default when no package.json is found", () => {
  // Directories that don't exist, right under the filesystem root: the search has to end there.
  const file = join(parse(root).root, "ts-polyglot-no-such-dir", "deeper", "a.c");
  assert.deepEqual(resolveCompiler(file, "c", linux), unix(["cc"], "default"));
});

test("C++ drivers match their C compilers", () => {
  const pairs = {
    gcc: "g++", clang: "clang++", cc: "c++", "gcc-13": "g++-13", "clang-18": "clang++-18",
    "x86_64-linux-gnu-gcc": "x86_64-linux-gnu-g++", "x86_64-linux-gnu-cc": "x86_64-linux-gnu-c++",
  };
  for (const [c, cpp] of Object.entries(pairs)) assert.equal(cppCompilerFor(c), cpp, c);
  assert.equal(cppCompilerFor(join("opt", "llvm", "bin", "clang")), join("opt", "llvm", "bin", "clang++"));
  assert.equal(cppCompilerFor("tcc"), undefined);
  assert.equal(cppCompilerFor("clang++"), undefined);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test`
Expected: `compiler.test.ts` FAILS with a module-not-found error for `../src/compiler.ts`.

- [ ] **Step 3: Implement `resolveCompiler` and `cppCompilerFor` in `src/compiler.ts`**, as specified above. Start with a header comment saying what the file decides and that it spawns nothing, so the mapper can use it later.

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test`, then `npm run typecheck`
Expected: all of `compiler.test.ts` and `signatures.test.ts` pass, and the type check shows no errors.

- [ ] **Step 5: Document it.** Add a `## Compilers` section to the package README:
  - the defaults table from the spec ("What a user sees");
  - `"ts-polyglot": { "compiler": "clang" }`, with the allowed values, how relative paths work, and the C++ driver rule;
  - `CC`/`CXX`, including wrappers, with the precedence: `CC`/`CXX`, then package.json, then the default;
  - that Windows always uses MSVC for now and ignores these settings.

- [ ] **Step 6: Commit**

```bash
git add packages/ts-polyglot
git commit -m "Pick the compiler from CC/CXX, package.json or the platform default"
```

---

### Task 3: Build recipes for every platform

**Files:**
- Create: `packages/ts-polyglot/src/toolchain.ts`
- Modify: `packages/ts-polyglot/src/build.ts` (imports, key, `buildAddon`, `rustStaticLib`; remove `Toolchain`, `msvc`, `nodeApiImportLib`, `run`, `napiHeaders`)
- Create: `packages/ts-polyglot/test/toolchain.test.ts`
- Modify: `examples/native-demo/add.cpp`, `scripts/lsp-probe.cjs:145`
- Modify: `README.md`, `packages/ts-polyglot/README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `Compiler` and `resolveCompiler` from Task 2.
- Produces (from `toolchain.ts`):

```ts
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
export function compileAddon(compiler: Compiler, build: AddonBuild): void;
/** The arguments for a gcc- or clang-style build, after the command and any wrapper arguments. */
export function unixArgs(build: AddonBuild, platform: NodeJS.Platform, arch: string): string[];
export function rustStaticLibName(compiler: Compiler): string; // "user.lib" for msvc, "libuser.a" for unix
export function rustTargetArgs(platform: NodeJS.Platform, arch: string): string[];
/** Runs a build tool and returns its stderr. Throws `missing` on ENOENT, or all the tool's output if it fails. */
export function run(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; missing: string }): string;
```

**Values the spec pins:**
- `unixArgs` returns, in order:
  - `-O2`, or `-g -O0` when `debug`;
  - `` `-I${node-api-headers include dir}` ``;
  - `-std=c++17` for `cpp`;
  - on darwin: `-bundle -undefined dynamic_lookup -arch <arm64 | x86_64>`, from `arch` (`"arm64"` stays `arm64`, anything else becomes `x86_64`); elsewhere: `-shared -fPIC`;
  - `glue`, then `...libs`, then `-o out`.
- `rustTargetArgs`: on darwin, `["--target", "aarch64-apple-darwin" | "x86_64-apple-darwin"]`; elsewhere, `[]`.
- `compileAddon` for `msvc`:
  - throws `` `ts-polyglot: on Windows only x64 Node is supported for now; this Node is ${process.arch}` `` when `process.arch !== "x64"`;
  - otherwise runs today's `cl.exe` command unchanged, linking `node_api.lib`. That library is now made in `build.cacheRoot`.
- `compileAddon` for `unix`:
  - runs `command[0]` with `[...command.slice(1), ...unixArgs(build, process.platform, process.arch)]` in `dirname(out)`;
  - if the output contains `xcrun: error: invalid active developer path`, rethrows as `ts-polyglot: the Xcode Command Line Tools aren't installed. Run xcode-select --install.`
- The `missing` text for a compiler is `` `ts-polyglot: can't run the ${"C" | "C++"} compiler "${command.join(" ")}" (${source === "default" ? "the default" : `from ${source}`}). ${install}, or set ${"CC" | "CXX"} to a compiler.` ``, where `install` is:
  - on darwin: `Install the Xcode Command Line Tools (xcode-select --install)`;
  - elsewhere: `Install gcc or clang (on Debian or Ubuntu: sudo apt install build-essential)`.
- The `missing` text for rustc: `ts-polyglot: can't run rustc, which builds .rs files. Install Rust from https://rustup.rs.`
- The `build.ts` cache key array is `[GLUE_VERSION, debug, process.version, process.platform, process.arch, compiler.family === "msvc" ? "msvc" : compiler.command, language, source]`.
- `buildAddon` resolves the compiler with `resolveCompiler(file, language === "cpp" ? "cpp" : "c")` before the cache check, and calls `compileAddon` instead of `cl.exe`.
- `rustStaticLib(file, functions, dir, libName)` names its output `rustStaticLibName(compiler)` and puts `rustTargetArgs(process.platform, process.arch)` before the codegen flags.

- [ ] **Step 1: Write the failing tests** `packages/ts-polyglot/test/toolchain.test.ts`

```ts
// The gcc/clang command lines, checked without running a compiler, so macOS is covered from any OS.
import assert from "node:assert/strict";
import test from "node:test";

import { rustStaticLibName, rustTargetArgs, unixArgs, type AddonBuild } from "../src/toolchain.ts";

const build: AddonBuild = { language: "c", glue: "glue.c", libs: ["libuser.a", "-lm"], out: "a.node", debug: false, cacheRoot: "cache" };

test("Linux builds a position-independent shared library", () => {
  const args = unixArgs(build, "linux", "x64");
  for (const flag of ["-shared", "-fPIC", "-O2"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.some((arg) => arg.startsWith("-I") && /node-api-headers[\\/]include$/.test(arg)), args.join(" "));
  assert.ok(!args.includes("-std=c++17"));
  // GNU ld resolves left to right: libraries come after the glue that uses them.
  assert.ok(args.indexOf("glue.c") < args.indexOf("libuser.a"));
  assert.deepEqual(args.slice(-2), ["-o", "a.node"]);
});

test("C++ gets C++17", () => {
  assert.ok(unixArgs({ ...build, language: "cpp", glue: "glue.cpp" }, "linux", "x64").includes("-std=c++17"));
});

test("debug builds are unoptimized, with debug info", () => {
  const args = unixArgs({ ...build, debug: true }, "linux", "x64");
  assert.ok(args.includes("-g") && args.includes("-O0") && !args.includes("-O2"), args.join(" "));
});

test("macOS builds a bundle for Node's architecture that finds Node-API at load time", () => {
  const arm = unixArgs(build, "darwin", "arm64");
  const at = arm.indexOf("-bundle");
  assert.deepEqual(arm.slice(at, at + 5), ["-bundle", "-undefined", "dynamic_lookup", "-arch", "arm64"]);
  assert.ok(!arm.includes("-shared"));
  assert.ok(unixArgs(build, "darwin", "x64").includes("x86_64"));
});

test("rustc targets Node's architecture on macOS only", () => {
  assert.deepEqual(rustTargetArgs("darwin", "arm64"), ["--target", "aarch64-apple-darwin"]);
  assert.deepEqual(rustTargetArgs("darwin", "x64"), ["--target", "x86_64-apple-darwin"]);
  assert.deepEqual(rustTargetArgs("linux", "x64"), []);
  assert.deepEqual(rustTargetArgs("win32", "x64"), []);
});

test("the Rust static library is named for the linker that reads it", () => {
  assert.equal(rustStaticLibName({ family: "msvc" }), "user.lib");
  assert.equal(rustStaticLibName({ family: "unix", command: ["cc"], source: "default" }), "libuser.a");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test`
Expected: `toolchain.test.ts` FAILS with a module-not-found error for `../src/toolchain.ts`.

- [ ] **Step 3: Create `src/toolchain.ts`.**
  - Move the MSVC code out of `build.ts`: `Toolchain`, `msvc()` (renamed `msvcEnvironment()`), `nodeApiImportLib()` (now taking `cacheRoot`), `run()` with its new `missing` option, and `napiHeaders`.
  - Add `unixArgs`, `rustTargetArgs`, `rustStaticLibName` and `compileAddon`, all as pinned above.
  - The old non-Windows throw in `msvc()` goes away: `resolveCompiler` decides the family now.

- [ ] **Step 4: Rewire `build.ts`** as pinned above.
  - Update the header comment: Windows builds with MSVC, Linux and macOS with a gcc- or clang-compatible compiler (see `compiler.ts`), and Rust also needs `rustc` on PATH.
  - Pass `missing` (the rustc text) to the `rustc` call.

- [ ] **Step 5: Make the example portable**
  - `examples/native-demo/add.cpp`: line 1 becomes `// Both styles work: a function with C linkage, and a plain C++ function with C++ linkage.`, and lines 2–3 become `extern "C" int add(int a, int b) {`.
  - `scripts/lsp-probe.cjs:145`: `cpp.replace("int add(int a, int b)", "int add(int a)")`.

- [ ] **Step 6: Run everything on Windows**

Run: `npm test`, `npm run typecheck`, `npm run example`, `node scripts/lsp-probe.cjs`
Expected:
- the tests and the type check pass;
- the example prints `add(1, 2) = 3`, `multiply(6, 7) = 42`, `hypotenuse(3, 4) = 5`, `is_right_triangle(3, 4, 5) = true`, `fib(50) = 12586269025` and `is_prime(97) = true`, and `add("1", 2) threw`. The new key forces a rebuild;
- the probe's `main.ts after edit` line reports an "Expected 1 arguments, but got 2" error at `add(1, 2)`, which shows the scripted edit still applies.

- [ ] **Step 7: Update the docs**
  - `README.md`:
    - Status becomes "works on Windows, Linux and macOS";
    - "Try it" lists the needs per OS: the VS 2022 C++ build tools, gcc or clang, or the Xcode Command Line Tools, plus Rust for `.rs` files.
  - `packages/ts-polyglot/README.md`:
    - drop "Windows only" from the intro;
    - the snippet comment becomes `// extern "C" int add(int a, int b)`;
    - "How it works" says the platform's compiler builds the glue, not MSVC;
    - Limits replaces "Needs Windows…" with "Needs a C/C++ compiler (see Compilers) and, for Rust, `rustc` on PATH. On Windows, Node must be x64.";
    - `TS_POLYGLOT_DEBUG` mentions `-g -O0` off Windows.
  - `CLAUDE.md`:
    - the intro sentence about Windows/MSVC;
    - the Runtime bullet ("compiles it with the platform's compiler");
    - Layout: add `compiler.ts` and `toolchain.ts`, and change the `build.ts` row to "Node-API glue generation, the Rust wrapper crate, the addon cache";
    - the `TS_POLYGLOT_DEBUG` line;
    - Environment: `toolchain.ts` finds `cl.exe`;
    - the `GLUE_VERSION` convention adds "or the compiler flags";
    - open work: drop item 4, renumber, and add "More toolchains: MinGW gcc and clang-cl on Windows (needs a per-OS `compiler` setting), Windows on arm64".

- [ ] **Step 8: Commit**

```bash
git add -A packages examples scripts README.md CLAUDE.md
git commit -m "Build addons with gcc or clang on Linux and macOS"
```

---

### Task 4: End-to-end tests with real compilers

**Files:**
- Modify: `packages/ts-polyglot/src/build.ts` (`cacheRoot`)
- Create: `packages/ts-polyglot/test/e2e.test.ts`
- Create: `packages/ts-polyglot/test/fixtures/project/{tsconfig.json,main.ts,add.cpp,values.c,numbers.rs}`
- Create: `packages/ts-polyglot/test/fixtures/clang/{package.json,tsconfig.json,main.ts,which.c,which.cpp}`
- Modify: `CLAUDE.md`, `packages/ts-polyglot/README.md`

**Interfaces:**
- Consumes: `buildAddon` and the error texts from Task 3, and the `npm test` script from Task 1.
- Produces: the `TS_POLYGLOT_CACHE_DIR` environment variable. When it's set and non-empty, the addon cache is `resolve(process.env.TS_POLYGLOT_CACHE_DIR)`. Otherwise it's today's `node_modules/.cache/ts-polyglot/`.

- [ ] **Step 1: Write the fixtures**

Both fixtures get this `tsconfig.json`:

```json
{
  "compilerOptions": { "target": "esnext", "module": "nodenext", "strict": true, "noEmit": true },
  "contentMappers": [{ "package": "ts-polyglot", "extensions": [".c", ".cpp", ".rs"] }]
}
```

`project/`: it has no package.json, so the default compiler applies.
- `add.cpp`: `extern "C" int add(int a, int b)` returns `a + b`, and `int multiply(int a, int b)` returns `a * b`.
- `values.c`: `long echo_long(long x) { return x; }`.
- `numbers.rs`: `pub fn fib(n: u32) -> i64`, the same body as `examples/native-demo/numbers.rs`.
- `main.ts`:

```ts
import { add, multiply } from "./add.cpp";
import { fib } from "./numbers.rs";
import { echo_long } from "./values.c";

console.log(JSON.stringify({ add: add(2, 3), multiply: multiply(6, 7), fib: fib(50), echo: echo_long(-5), wide: echo_long(2 ** 40) }));
```

`clang/`:
- `package.json`: `{ "name": "clang-fixture", "private": true, "type": "module", "ts-polyglot": { "compiler": "clang" } }`.
- `which.c`: `int c_by_clang(void)`, which returns 1 under `#ifdef __clang__` and 0 otherwise.
- `which.cpp`: `int cpp_by_clang()`, the same.
- `main.ts`:

```ts
import { c_by_clang } from "./which.c";
import { cpp_by_clang } from "./which.cpp";

console.log(JSON.stringify({ c: c_by_clang(), cpp: cpp_by_clang() }));
```

- [ ] **Step 2: Write the failing tests** `packages/ts-polyglot/test/e2e.test.ts`

```ts
// Runs the real tsc and the real node over the projects in test/fixtures, against the dist/ that
// `npm test` builds. The addon cache is a fresh directory with a space in its name: every run
// compiles from scratch, and paths with spaces get exercised.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const tsc = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin", "tsc");
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
const cache = mkdtempSync(join(tmpdir(), "ts-polyglot test "));
after(() => rmSync(cache, { recursive: true, force: true }));

const windows = process.platform === "win32";
const linux = process.platform === "linux";

function typecheck(name: string) {
  const result = spawnSync(process.execPath, [tsc, "-p", ".", "--runExternalCode", "--pretty", "false"], { cwd: fixture(name), encoding: "utf8" });
  return { errors: result.stdout.split(/\r?\n/).filter((line) => /: error TS\d+/.test(line)), output: result.stdout + result.stderr };
}

/** Runs a fixture's main.ts, which prints one JSON object. CC and CXX come only from `env`. */
function run(name: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.CC;
  delete inherited.CXX;
  const result = spawnSync(process.execPath, ["--import", "ts-polyglot/register", "main.ts"], {
    cwd: fixture(name),
    encoding: "utf8",
    env: { ...inherited, TS_POLYGLOT_CACHE_DIR: cache, ...env },
  });
  return { status: result.status, stderr: result.stderr, output: result.status === 0 ? JSON.parse(result.stdout) : undefined };
}

test("tsc type-checks the fixtures without errors", () => {
  for (const name of ["project", "clang"]) {
    const { errors, output } = typecheck(name);
    assert.deepEqual(errors, [], output);
  }
});

test("C, C++ and Rust functions run", () => {
  const { status, stderr, output } = run("project");
  assert.equal(status, 0, stderr);
  assert.equal(output.add, 5);
  assert.equal(output.multiply, 42);
  assert.equal(output.fib, 12586269025);
  assert.equal(output.echo, -5);
});

test("addons are built in TS_POLYGLOT_CACHE_DIR", () => {
  run("project");
  assert.ok(readdirSync(cache).length > 0, `nothing was built in ${cache}`);
});

test("C long keeps 64 bits on Linux and macOS", { skip: windows }, () => {
  assert.equal(run("project").output.wide, 2 ** 40);
});

test("package.json picks clang on Linux and macOS", { skip: windows }, () => {
  const { status, stderr, output } = run("clang");
  assert.equal(status, 0, stderr);
  assert.deepEqual(output, { c: 1, cpp: 1 });
});

// Same cache as the test above, so this also checks that a different compiler rebuilds. On macOS,
// gcc is Apple clang, hence Linux only.
test("CC overrides package.json for C only", { skip: !linux }, () => {
  const { status, stderr, output } = run("clang", { CC: "gcc" });
  assert.equal(status, 0, stderr);
  assert.deepEqual(output, { c: 0, cpp: 1 });
});

test("a missing compiler is an error that says where the choice came from", { skip: windows }, () => {
  const { status, stderr } = run("clang", { CC: "/nonexistent/cc" });
  assert.notEqual(status, 0);
  assert.match(stderr, /can't run the C compiler "\/nonexistent\/cc" \(from CC\)/);
});

test("Windows ignores compiler, CC and CXX", { skip: !windows }, () => {
  const { status, stderr, output } = run("clang", { CC: "/nonexistent/cc", CXX: "/nonexistent/c++" });
  assert.equal(status, 0, stderr);
  assert.deepEqual(output, { c: 0, cpp: 0 });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npm test`
Expected on Windows: `addons are built in TS_POLYGLOT_CACHE_DIR` FAILS with "nothing was built in …", because the variable is ignored and the addons land in the default cache. The other tests pass.

- [ ] **Step 4: Honor `TS_POLYGLOT_CACHE_DIR` in `build.ts`.** Add a why-comment: tests need a fresh cache, and CI can keep one between runs.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected on Windows: everything passes except the 4 skipped Linux/macOS tests. Every `npm test` run builds the fixtures' addons from scratch, roughly 5–10 s.

- [ ] **Step 6: Update the docs**
  - `CLAUDE.md`:
    - "There are no tests yet" becomes what `npm test` covers;
    - Commands gets `npm test   # build, then unit tests and end-to-end tests with real tsc, node and compilers`;
    - add a `TS_POLYGLOT_CACHE_DIR` bullet;
    - Layout gets a `packages/ts-polyglot/test/` row;
    - open work item 1 becomes the remaining tests: more parser cases, and mapper `transform` and span mappings.
  - Package README: Builds are cached in `node_modules/.cache/ts-polyglot`, and `TS_POLYGLOT_CACHE_DIR` moves that cache.

- [ ] **Step 7: Commit**

```bash
git add -A packages CLAUDE.md
git commit -m "End-to-end tests with real compilers; TS_POLYGLOT_CACHE_DIR"
```

---

### Task 5: Linux in Docker, and a portable LSP probe

**Files:**
- Create: `scripts/linux.Dockerfile`, `scripts/linux.cjs`
- Modify: `package.json` (`"test:linux": "node scripts/linux.cjs"`)
- Modify: `scripts/lsp-probe.cjs:10,16`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the root `npm ci`, `npm run typecheck`, `npm test` and `npm run example`, and `node scripts/lsp-probe.cjs`.
- Produces: `npm run test:linux`.

- [ ] **Step 1: Make the probe portable**
  - `lsp-probe.cjs:10` becomes `const tsc = path.join(root, "node_modules/typescript/bin/tsc");`.
  - Line 16 spawns `process.execPath` with `[tsc, "--lsp", "--stdio"]`.
  - That launcher passes stdio through: `stdio: "inherit"` on Windows, `execve` elsewhere.

Run: `node scripts/lsp-probe.cjs`
Expected: the same results as after Task 3: hover, definitions, references, both renames, and the post-edit error.

- [ ] **Step 2: Write `scripts/linux.Dockerfile`**
  - Start from `node:22-bookworm`, which already has gcc, g++ and make.
  - `apt-get install -y --no-install-recommends clang`.
  - Install Rust with rustup, `--profile minimal`, into `/usr/local/cargo` with `RUSTUP_HOME=/usr/local/rustup`, and put `/usr/local/cargo/bin` on `PATH`.
  - Add a header comment saying what the image is for.

- [ ] **Step 3: Write `scripts/linux.cjs`**
  - Run `docker build --tag ts-polyglot-linux --file scripts/linux.Dockerfile scripts`.
  - Then run `docker run --rm --volume <repo>:/src:ro ts-polyglot-linux bash -c "<copy> && cd /work && npm ci && npm run typecheck && npm test && npm run example && node scripts/lsp-probe.cjs"`.
  - `<copy>` is `mkdir /work && tar -C /src --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C /work -xf -`.
  - Add a why-comment: the Windows `node_modules` holds junctions and Windows binaries.
  - Use `spawnSync` with `stdio: "inherit"`, and exit with docker's status.
  - Add `"test:linux"` to the root scripts.

- [ ] **Step 4: Run it**

If `docker info` can't reach the engine, start Docker Desktop and wait for `docker info` to succeed.

Run: `npm run test:linux`
Expected:
- `npm ci` succeeds;
- the type check is clean;
- `npm test` passes, with only `Windows ignores compiler, CC and CXX` skipped;
- the example prints the same values as on Windows;
- the probe prints the same results.

Any failure is a defect in Task 3's Linux recipe. Fix it there, and run `npm test` on Windows again too.

- [ ] **Step 5: Update `CLAUDE.md`**
  - Commands gets `npm run test:linux   # the same checks in a Linux container (needs Docker Desktop running)`.
  - Environment adds: Docker Desktop is used for Linux checks, and WSL's Ubuntu has no compilers or Node.
  - Layout gets the two new scripts.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts CLAUDE.md
git commit -m "Run the checks on Linux in Docker; make the LSP probe portable"
```

---

### Task 6: GitHub Actions on Windows, Linux and macOS

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`, `CLAUDE.md` (Layout)

**Interfaces:**
- Consumes: the root `npm ci`, `npm run typecheck`, `npm test` and `npm run example`.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**
  - Trigger on `push` and `pull_request`.
  - One `test` job with `strategy.fail-fast: false` and
    `matrix.os: [windows-latest, ubuntu-latest, ubuntu-24.04-arm, macos-latest, macos-15-intel]`.
    Comment that the arm64 Linux and Intel macOS lines need those runners on the account, so drop a
    line if its job never starts.
  - Steps:
    - `actions/checkout@v4`;
    - `actions/setup-node@v4` with `node-version: 22`;
    - on Linux, a bash step: `command -v clang || (sudo apt-get update && sudo apt-get install -y clang)`;
    - a bash step: `command -v rustc || (curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && echo "$HOME/.cargo/bin" >> "$GITHUB_PATH")`;
    - `npm ci`, `npm run typecheck`, `npm test`, `npm run example`.

- [ ] **Step 2: Lint it**

Run: `docker run --rm -v "<repo>:/repo" --workdir /repo rhysd/actionlint:latest -color`
Expected: no findings.

- [ ] **Step 3: Update the docs**
  - `README.md`: one line saying CI runs the type check, the tests and the example on Windows, Linux and macOS. Also say it starts once the repo is on GitHub.
  - `CLAUDE.md` Layout: a `.github/workflows/ci.yml` row.

- [ ] **Step 4: Commit**

```bash
git add .github README.md CLAUDE.md
git commit -m "CI on Windows, Linux and macOS"
```
