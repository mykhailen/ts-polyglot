# ts-polyglot

Import functions from C, C++ and Rust source files into TypeScript: `import { add } from "./add.cpp"`.
It's an npm workspaces monorepo under the MIT license. It started as a proof of concept in the
`ts-polyglot-trust` lab, `../../../labs/ts-polyglot-trust` from here (`packages/native-mapper`), and
was moved here on 2026-10-22.
It builds with MSVC on Windows and with gcc or clang on Linux, and both are tested. The macOS recipe
is written but has never run: there's no Mac here, so only CI exercises it. `npm test` runs unit
tests and end-to-end tests that use the real compilers.

Two halves share one signature parser:

- **Types:** a TypeScript 7.1 *content mapper* (beta feature). `tsc --runExternalCode` and the
  TypeScript 7 language server start [mapper.ts](packages/ts-polyglot/src/mapper.ts), built to
  `dist/mapper.js`. It turns `add.cpp` into `export declare function add(a: number, b: number): number;`,
  with function and parameter names mapped back to the C++ text verbatim.
- **Runtime:** a Node hook (`node --import ts-polyglot/register`). Importing `add.cpp` generates
  Node-API glue, compiles it into a `.node` addon with the platform's compiler (MSVC on Windows; `cc`,
  gcc or clang on Linux and macOS), caches it by source hash, and exports its functions. For Rust,
  `rustc` builds a static library that the same glue links.

**Read [docs/content-mappers.md](docs/content-mappers.md) before touching the mapper.** It has the
protocol facts and the measured behavior (timeouts, how diagnostics block type checking, editor
setup), none of which is written down anywhere else.

## Layout

| Path | What |
| --- | --- |
| `packages/ts-polyglot/src/signatures.ts` | finds exportable functions in C, C++ and Rust; the `Kind` tables say how each type crosses into JavaScript |
| `packages/ts-polyglot/src/declarations.ts` | the virtual TypeScript and span mappings returned by `transform` |
| `packages/ts-polyglot/src/mapper.ts` | the content mapper process (JSON-RPC over stdio) |
| `packages/ts-polyglot/src/protocol.ts` | the protocol types it uses |
| `packages/ts-polyglot/src/build.ts` | Node-API glue generation, the Rust wrapper crate, the addon cache |
| `packages/ts-polyglot/src/compiler.ts` | picks the compiler for a file: `CC`/`CXX`, the `"ts-polyglot"` field in package.json, or the platform default; spawns nothing |
| `packages/ts-polyglot/src/toolchain.ts` | the build commands: MSVC (`vswhere`, `vcvars64.bat`, the Node-API import library) and gcc/clang on Linux and macOS |
| `packages/ts-polyglot/src/register.ts` | the Node resolve hook: an import of a native file resolves to the generated module in the cache |
| `packages/ts-polyglot/test/` | `node:test` suites: unit tests import `src/`; `e2e.test.ts` runs the real `tsc` and `node` (so `dist/`) over the projects in `test/fixtures/`; `pack.test.ts` installs the packed tarball outside the repo, as a user would |
| `packages/ts-polyglot/dist/` | what actually runs: JavaScript and source maps from `tsconfig.build.json`, which `exports` and the mapper's `exec` point at (git-ignored) |
| `examples/native-demo/` | a consumer project: `add.cpp`, `geometry.c`, `numbers.rs`, `main.ts` |
| `packages/create-ts-polyglot/` | `npm create ts-polyglot`. `src/cli.ts` asks with `@clack/prompts` (directory, editor, install) and writes `template/`, which is a working project itself: `_gitignore` becomes `.gitignore` (npm leaves that name out of tarballs), `README.md` has `__NAME__` and a `<!-- vscode -->` section. `src/toolchain.ts` mirrors how ts-polyglot finds the compilers and only reports. `test/e2e.test.ts` runs the built CLI, installs ts-polyglot from a packed tarball into the result, type-checks and runs it |
| `scripts/lsp-probe.cjs` | drives `tsc --lsp` like VS Code against the example, to check editor behavior without an editor |
| `.github/workflows/ci.yml` | GitHub Actions: `npm ci`, typecheck, test and example on Windows, Linux (x64, arm64) and macOS (arm64, x64). Runs on every push to the GitHub repo, `mykhailen/ts-polyglot` |
| `scripts/linux.cjs`, `scripts/linux.Dockerfile` | `npm run test:linux`: copies the repo into a Node 22 container with gcc, clang and Rust, and runs the checks there |

## Commands

```sh
npm install
npm run build                  # emits each package's dist/: the JavaScript that tsc, the editor, node and `npm create` run
npm run typecheck              # build, tsc over the package sources, then tsc --runExternalCode over the example
npm test                       # build, then unit tests and end-to-end tests with real tsc, node and compilers
npm run test:linux             # npm ci, typecheck, test, example and the probe in a Linux container (needs Docker Desktop running)
npm run example                # build, then run the example; addons build on first import (about 3 s cold)
node scripts/lsp-probe.cjs     # hover, definition, references, rename and live-edit results from the language server
node packages/create-ts-polyglot/dist/cli.js my-app --no-install   # the scaffold, before it's on npm; `npm install <tarball>` in the result, as e2e.test.ts does
```

- The LSP probe and the editor run whatever is in `dist/`. After editing `src/`, build (`typecheck`
  and `example` do it first) and restart the editor's TypeScript server.

- `TS_CONTENT_MAPPER_DEBUG=1` makes `tsc` log every mapper JSON-RPC message, virtual text included.
- `TS_POLYGLOT_DEBUG=1` builds debug addons (`/Od` plus `.pdb` on Windows, `-g -O0` elsewhere).
- Addons are cached in `packages/ts-polyglot/node_modules/.cache/ts-polyglot/`. Delete that folder to
  force a rebuild.
- `TS_POLYGLOT_CACHE_DIR` moves that cache. The end-to-end tests point it at a fresh temporary
  directory, so every run compiles from scratch.

VS Code debug configurations are in `.vscode/launch.json`: the example, the mapper under `tsc`, the
mapper inside the editor, and a compound that debugs TypeScript and C, C++ or Rust in one process.
The ones that start a process build `dist/` first. Breakpoints in native files are the native
debugger's alone: no JavaScript runs under a native file's URL, so the JavaScript debugger leaves
them unbound.

## Environment

- Windows 11, with PowerShell as the primary shell (Bash is also available).
- Node 22.21 via nvm4w (`C:\nvm4w\nodejs`).
- Visual Studio 2022 Build Tools. `cl.exe` isn't on PATH: `toolchain.ts` finds it with `vswhere` and
  runs `vcvars64.bat`.
- Rust stable with the MSVC target (`rustc` is on PATH).
- Docker Desktop, for `npm run test:linux`. Start it first; its engine isn't always running. WSL's
  Ubuntu has no compilers or Node, so it isn't used.
- `typescript` is pinned to `7.1.0-beta` on purpose. `^7.1.0-beta` also matches nightlies
  (`7.1.0-dev.*`), and the protocol has changed between builds. Upgrade deliberately, then rerun
  `npm run typecheck`, `npm run example` and the LSP probe.
- The package's `peerDependencies` pins the same version, so change both together. The peer is
  optional, because the runtime hook doesn't need TypeScript. Because the pin is exact, npm refuses
  (`ERESOLVE`) to install ts-polyglot next to any other TypeScript, including `latest` and nightlies.
  Widen it when 7.1.0 ships.
- In VS Code the TypeScript 7 extension must use the workspace version: **TypeScript: Select
  TypeScript Version… → Use Workspace Version**. Its bundled 7.0.2 has no content mappers.

## Conventions

- **`dist/` is what runs.** Node refuses to strip types under `node_modules`, so `exports` and
  `typescript.contentMapper.exec` point at the JavaScript that `tsconfig.build.json` emits, and
  `prepack` builds it before publishing. The repo runs it too, so the example and the probe test
  what ships.
- **Packaging:** `files` is `dist` plus `src`, which the source maps in `dist/` point at. Each
  package's `LICENSE` is a copy of the root one, because npm doesn't pack the root's for a workspace;
  change all three together. `test/pack.test.ts` installs the real tarball outside the repo, so it
  catches anything the package needs but doesn't ship; `create-ts-polyglot`'s `e2e.test.ts` checks
  its own tarball listing the same way.
- **The template's versions are pinned by test.** `create-ts-polyglot/template/package.json` has
  `ts-polyglot` at `^<the workspace version>` and the repo's TypeScript; `project.test.ts` fails when
  either drifts, so bump them with the package.
- **Keep `src/` runnable by Node's type stripping** anyway, so tests and scripts can import it
  without a build: `erasableSyntaxOnly` (no `enum`, `namespace` or parameter properties; use
  `as const` objects), `.ts` extensions on relative imports (the build rewrites them), and
  `import type` for types.
- **Comments say why, not what.** Match the density of the existing files.
- **Bump `GLUE_VERSION` in `build.ts`** whenever the generated C, C++, Rust or JavaScript, or the
  compiler flags, change, so cached addons rebuild.
- **Mapper rules** (details in the docs):
  - Verbatim spans must be identical text on both sides.
  - `transform` diagnostics stop all type checking, so don't use them for "unsupported, skipped".
  - Keep `initialize` fast: there's a 5 s timeout.
  - State that differs per project belongs under `projectHandle`, because one mapper process serves
    every project.

## Open work, roughly in priority order

1. **More tests.** The suite follows the lab's pattern
  Still missing:
   - parser unit tests beyond the type tables: headers, comments, `static`, overloads, Rust `pub fn`;
   - mapper tests: the `transform` text and span mappings, and error locations in the native file.
2. **Compile errors in `tsc` and the editor.** Run a syntax-only compile in `transform` and return
   the errors as mapper diagnostics. Accept that they block type checking, the same as syntax errors.
3. **More types:** strings (`const char*`, `&str`/`String`), buffers and pointers, structs, and
   `bigint` for 64-bit values.
4. **More toolchains:** MinGW gcc and clang-cl on Windows (they need a per-OS `compiler` setting,
   because one committed value would mean different things on different OSes), and Windows on arm64.
5. **Publishing:** `npm login`, then `ts-polyglot` first and `create-ts-polyglot` second: the
   template depends on the published `ts-polyglot`, and `npm create ts-polyglot` resolves
   `create-ts-polyglot` from the registry. Until then, the only way to try the scaffold is the
   command above. Date the `(unreleased)` entries in `CHANGELOG.md` at each release. Later, possibly
   prebuilt binaries.
6. **Parser gaps:**
   - `extern "C" { }` blocks and namespaces aren't scanned;
   - only the first of a set of overloads is kept;
   - included headers aren't part of the cache key.
7. **Trust.** `tsc` gates the mapper behind `--runExternalCode`, and VS Code gates it behind workspace
   trust. The runtime hook compiles and loads any imported native file with no gate beyond `--import`.
