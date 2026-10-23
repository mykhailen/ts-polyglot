# Cross-platform compilers: design

2026-10-22. The owner agreed on the direction in chat and pre-approved this spec and its plan. Items
marked **[call]** were decided while writing this and weren't discussed with the owner. Revised after
a builder review to account for the `dist/` build step the owner committed in `d5077aa`.

## Why

ts-polyglot builds native addons only on Windows with MSVC. `msvc()` throws on every other platform
([build.ts:139](../../../packages/ts-polyglot/src/build.ts#L139)). The first release must also work on
Linux and macOS. The selling point is "import `./add.cpp` and it works", so the common case needs no
setup. Each OS uses its usual compiler, and a setting exists for people who want a different one.

## What a user sees

**Defaults, with nothing configured:**

| OS | C | C++ | Rust |
| --- | --- | --- | --- |
| Windows x64 | MSVC `cl.exe`, found with `vswhere` (as today) | same | `rustc` on PATH; MSVC links the glue |
| Linux x64, arm64 | `cc` (usually gcc) | `c++` | `rustc` on PATH; `cc` links the glue |
| macOS arm64, x64 | `cc` (Apple clang, from the Xcode Command Line Tools) | `c++` | `rustc` on PATH; `cc` links the glue |

**Choosing a compiler (Linux and macOS only):**

- Search upward from the native file's directory. The first `package.json` that has a
  `"ts-polyglot"` field wins:
  ```json
  "ts-polyglot": { "compiler": "clang" }
  ```
- `compiler` is `gcc`, `clang`, `cc`, or a path to a gcc- or clang-compatible C compiler.
  A bare name is looked up on PATH. A relative path is relative to the directory of the package.json
  it's in **[call]**.
- C++ files use the matching C++ driver, keeping any directory, prefix or version suffix:
  - `gcc` → `g++`, `clang` → `clang++`, `cc` → `c++`;
  - `/usr/lib/llvm-18/bin/clang` → `/usr/lib/llvm-18/bin/clang++`;
  - `gcc-13` → `g++-13`.
- If the name contains none of those, building a C++ file is an error that says to set `CXX`.
- `CC` (C files and the Rust glue) and `CXX` (C++ files) override `compiler`, as in make, node-gyp
  and Rust's `cc` crate. They may include a wrapper such as `ccache gcc`: split them on whitespace.
  An empty or all-whitespace value counts as unset **[call]**.
- Precedence: `CC`/`CXX`, then package.json, then the default.
- `"compiler": "msvc"` on Linux or macOS is an error.

**Windows always uses MSVC in this release.** `compiler`, `CC` and `CXX` are ignored there **[call]**.
In chat this was going to be an error. Ignoring it is better because package.json is committed and
shared: a team that picks clang for its Linux machines shouldn't break its Windows machines. node-gyp
and setuptools also ignore `CC` when they build with MSVC. A Node whose `process.arch` isn't x64 on
Windows is an error saying only x64 is supported.

**Errors.** Each error names the compiler that was tried, where that choice came from (`CC`/`CXX`,
which package.json, or the default), and what to install:

- Linux: gcc or clang (Debian/Ubuntu: `sudo apt install build-essential`).
- macOS: `xcode-select --install`. `/usr/bin/cc` exists even without the tools: it's a shim that
  fails with `xcrun: error: invalid active developer path`. Recognize that message.
- Windows: today's message about the Visual Studio C++ build tools.
- Rust: install it from <https://rustup.rs>.

## Goals

- Importing C, C++ and Rust files works with the default compiler on Windows x64, Linux x64 and arm64,
  and macOS arm64 and x64.
- On Linux and macOS, gcc or clang can be chosen per project (package.json) or per run (env).
- A given source file gets the same TypeScript declarations on every OS.
- It's verified on Windows (this machine), on Linux (Docker on this machine), and on all three OSes in
  GitHub Actions.

## Non-goals for this release

- **Other compilers on Windows** (MinGW gcc, clang, clang-cl) **and Windows on arm64.** MinGW needs
  its own import library format and Rust's GNU target. clang-cl isn't installed on this machine to
  test.
- **Generating the Rust glue in Rust** so that `rustc` links the addon itself. That's only needed once
  Windows has non-MSVC compilers.
- **Cross-compiling.** The addon is always built for the Node that's running.
- **Custom flags, include paths or extra libraries.** `CFLAGS` and `LDFLAGS` aren't read.
- **Compile errors in `tsc` and the editor** (open work item 2). The constraints below keep that
  possible later.
- **Native debugger launch configurations for Linux and macOS.** `.vscode/launch.json` stays
  Windows-only.
- **Headers in the cache key, prebuilt binaries, publishing.**
- **Other Unix-likes** (FreeBSD, Alpine/musl). The Linux recipe may work there, but they aren't tested.

## Anti-goals

- **A setup step for the default case.** A fresh Linux or Mac machine with a compiler installed works
  with zero configuration.
- **Types that differ by OS.** A function exported in TypeScript on one OS exists at runtime on every
  OS, with the same type. The parser's type tables stay platform-independent.
- **Silently wrong values.** The `long` bug below is an example.
- **Slower warm starts.** Importing a file whose addon is already cached spawns no process: no
  compiler probe, no `vswhere`, no `vcvars64.bat`. That's why the cache key uses the compiler
  *command*, not a probed version.

## Constraints

- CLAUDE.md's conventions apply, as committed in `d5077aa`:
  - **`dist/` is what runs.** `exports["./register"]` and the mapper's `exec` point at the JavaScript
    that `tsconfig.build.json` emits. So `tsc --runExternalCode`, the editor, the LSP probe and
    `node --import ts-polyglot/register` all run `dist/`, and anything that exercises them builds
    first.
  - **`src/` stays runnable by Node's type stripping,** so unit tests import it without a build. That
    means erasable syntax only, `.ts` extensions on relative imports, and `import type`.
  - Comments say why. No new dependencies: tests use `node:test`.
- Bump `GLUE_VERSION`, because this changes the glue's types and the build. From now on, bump it
  when compiler flags change too.
- Compiler resolution is a function of the file path, the environment and the platform. Platform and
  env are parameters that default to `process`'s, so unit tests can cover every OS from any OS.
  Resolution reads package.json files but spawns nothing. That makes it cheap enough to run on every
  import and safe for the mapper to call later. One mapper process serves every project, and
  `initialize` has a 5 s timeout.
- `typescript` stays pinned to `7.1.0-beta`. The lockfile already lists every platform's
  `@typescript/typescript-*` package.

## How the build differs per platform

These are the facts for whoever builds this. Today's MSVC recipe in
[build.ts](../../../packages/ts-polyglot/src/build.ts) stays as it is.

| | Windows (MSVC) | Linux | macOS |
| --- | --- | --- | --- |
| Build a `.node` | `cl /LD /MD /O2` (as today) | `-shared -fPIC -fvisibility=hidden -O2` | `-bundle -undefined dynamic_lookup -fvisibility=hidden -O2`, plus `-arch arm64` or `-arch x86_64` from `process.arch` |
| C++ | `/EHsc /std:c++17` | `-std=c++17` | `-std=c++17` |
| `TS_POLYGLOT_DEBUG=1` | `/Zi /Od`, `/DEBUG` | `-g -O0` | `-g -O0` |
| Node-API symbols | import library `node_api.lib`, made from `node_api.def` with `lib.exe` | nothing to do: resolved from `node` at load time | `-undefined dynamic_lookup` |
| Rust static library | `user.lib` | `libuser.a` | `libuser.a` |

- The Node-API include directory comes from `node-api-headers` on every platform.
- **User functions are hidden** (`-fvisibility=hidden`; added after the final review). With default
  visibility, the glue's calls go through the PLT, and on Linux a same-named function in node or libc
  (`random`, `crc32`) silently replaces the user's. `NAPI_MODULE_INIT` keeps its own entry points
  visible.
- **The hook loads addons with `RTLD_NOW`** where `os.constants.dlopen` has it (Linux and macOS; added
  after the final review). Otherwise a function that's declared but never defined passes the import
  and kills node at its first call. With it, the import fails with an error the program can catch.
  Windows already refuses at link time.
- **Rust keeps today's approach.** `rustc --crate-type staticlib` builds the library, and the C glue
  links it. The libraries from `--print native-static-libs` go after the static library on the link
  line. On Linux and macOS, rustc already prints them as `-l` flags.
- **macOS, unverified:** recent Xcode linkers may warn that `-undefined dynamic_lookup` may not work
  with chained fixups. If CI shows that warning, use `-bundle_loader <node binary>` instead, which
  links against node's own exports.
- **macOS:** the addon has to match Node's architecture, not the compiler's default. For example, an
  x64 Node can run under Rosetta on Apple Silicon. That's why the build passes `-arch`. For the same
  reason, `rustc` gets `--target aarch64-apple-darwin` or `--target x86_64-apple-darwin`. If that
  target isn't installed, rustc's own error suggests `rustup target add` **[call]**.

## Fixes that come with this

1. **C `long` is 64-bit on Linux and macOS.** The table maps `long` to `int32_t` and
   `unsigned long` to `uint32_t` ([signatures.ts:35-36](../../../packages/ts-polyglot/src/signatures.ts#L35-L36)).
   That's only right on Windows. On Linux and macOS, `long` values past 2³¹ are cut off with no
   error.
   - Fix: map `long` to `I64` on every OS. On Windows nothing visible changes: converting to the
     32-bit `long` truncates, just as `napi_get_value_int32` does today. The TypeScript type stays
     `number`.
   - Drop `unsigned long` on every OS, so it's skipped like other unsupported types, until 64-bit
     unsigned values arrive with the `bigint` work (open work item 3) **[call]**.
2. **The example's [add.cpp](../../../examples/native-demo/add.cpp) doesn't compile with gcc or
   clang.** It uses `__declspec(dllexport)` and `__cdecl`.
   - Make it portable: keep `extern "C"`, drop those two.
   - Update the snippet in the package README, which shows the same line.
   - The parser keeps accepting those keywords. Don't add a compatibility shim for them **[call]**.
3. **The cache key** ([build.ts:27-30](../../../packages/ts-polyglot/src/build.ts#L27-L30)) gains
   `process.platform` and the resolved compiler command (such as `msvc`, `cc` or `ccache gcc`).
   - Platform: a repo on a Windows drive can also be used from WSL or a container. With the same Node
     version and architecture, Linux would otherwise find a Windows `.node`.
   - The command: switching compilers rebuilds.
   - Upgrading a compiler in place doesn't invalidate the cache, as today.
4. **`scripts/lsp-probe.cjs`** hardcodes `@typescript/typescript-win32-x64/lib/tsc.exe`
   ([lsp-probe.cjs:10](../../../scripts/lsp-probe.cjs#L10)).
   - Run `node <typescript>/bin/tsc` instead, as the lab's e2e test does.
   - The launcher passes stdio through: `stdio: "inherit"` on Windows, `process.execve` elsewhere.
   - The probe's scripted live edit searches `add.cpp` for `int __cdecl add(int a, int b)`. Update
     it along with the example.

## Testing, and what counts as done

Tests go in a new `packages/ts-polyglot/test/`, following the lab's pattern
(`../../../labs/ts-polyglot-trust/packages/iface-mapper/test`): `node:test`, no dependencies,
and the real `tsc --runExternalCode` and real `node` over small fixture projects. `npm test` at the
root runs them.

`npm test` builds `dist/` first, like `typecheck` and `example`. The end-to-end tests exercise
`dist/`, because that's what `tsc` and `node` load, so a stale `dist/` must never be what passes.
Unit tests import `src/` directly.

- **Unit tests (no compilers):**
  - compiler resolution: defaults per platform, the upward package.json search, `CC`/`CXX`
    precedence, C++ driver derivation, Windows ignoring the settings, and `msvc` failing on Linux and
    macOS;
  - the `long`/`unsigned long` table change.
- **End-to-end tests (real compilers):** a fixture with a C, a C++ and a Rust file. `tsc` reports no
  errors, and the runtime output matches, on every OS. On Linux and macOS, also check:
  - a `long` round trip past 2³¹;
  - a fixture with `"compiler": "clang"` and a run with `CC=gcc`, each checked by a C function that
    returns whether `__clang__` is defined. Run the gcc case on Linux only: on macOS, `gcc` is Apple
    clang;
  - `CC=/nonexistent/cc` gives the "not found" error, and the error names `CC`.
- **End-to-end tests build from scratch on every run.** A cache left by an earlier run must not let
  them pass. A new `TS_POLYGLOT_CACHE_DIR` environment variable overrides the addon cache directory.
  The tests point it at a fresh temporary directory, and it's also useful for caching in CI
  **[call]**.

**Linux on this machine.** WSL's Ubuntu has no compilers or Node, but Docker Desktop works.
- One command runs `npm ci`, `npm run typecheck`, `npm test`, `npm run example` and the LSP probe in a
  `node:22` container, with clang and Rust added.
- Don't mount the Windows `node_modules` into the container, because it has junctions and Windows
  binaries.
- `core.autocrlf` is `true` here. Any shell script that runs inside the container needs
  `eol=lf` in `.gitattributes`.

**CI.** A GitHub Actions workflow runs `npm ci`, `npm run typecheck`, `npm test` and `npm run example`
on `windows-latest`, `ubuntu-latest` and `macos-latest` (arm64).
- Add arm64 Linux and Intel macOS runners if they're available. If not, the README says those two use
  the same build steps but aren't tested.
- The repo has no remote yet. macOS gets verified only once the owner pushes to GitHub. Until then,
  macOS support is written but untested.

**Done means:**
- Everything above passes on Windows here and in the Linux container.
- The LSP probe runs on both.
- The workflow is ready to run.
- The docs are updated.

## Docs to update

- `README.md`: the requirements for each OS.
- `packages/ts-polyglot/README.md`:
  - a "Compilers" section covering the defaults, `compiler`, `CC`/`CXX`, precedence and Windows;
  - the types table, without `unsigned long`;
  - Limits ("Needs Windows…").
- `CLAUDE.md`, editing the version committed in `d5077aa`:
  - the intro ("works end to end on Windows with MSVC");
  - Environment (Docker for Linux);
  - Commands (`npm test`, the Linux command);
  - the `GLUE_VERSION` convention;
  - open work (item 4 is done, item 1 is partly done).

## Left to the builder

- Code layout. One option: put compiler resolution and the per-platform recipes in a new
  `src/toolchain.ts`, and keep glue generation and the cache in `build.ts`.
- The exact wording of errors.
- `CC` values with quotes, or paths with spaces, beyond whitespace splitting.
- The Docker image setup and CI action versions.

## Later

- Once Windows has more compilers, one committed `compiler` value will mean different things on
  different OSes. A per-OS form such as `{ "linux": "clang", "win32": "msvc" }` may be needed then.
