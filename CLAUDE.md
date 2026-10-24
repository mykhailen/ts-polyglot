# ts-polyglot

Import functions from C, C++ and Rust source files into TypeScript: `import { add } from "./add.cpp"`.
It's an npm workspaces monorepo under the MIT license. It started as a proof of concept in the
`ts-polyglot-trust` lab, `../../../labs/ts-polyglot-trust` from here (`packages/native-mapper`), and
was moved here on 2026-10-22.
It builds with MSVC on Windows and with gcc or clang on Linux, and both are tested. The macOS recipe
is written but has never run: there's no Mac here, so only CI exercises it. `npm test` runs unit
tests and end-to-end tests that use the real compilers. Both packages are on npm (0.1.0 since
2026-10-23); a release is `npm run release`, a tag, and the Release workflow (docs/releasing.md).

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
| `packages/ts-polyglot/src/signatures.ts` | the shared shapes: `NativeFunction`, `Param`, `Kind` and the `Kind` constants |
| `packages/ts-polyglot/src/languages/` | one module per language behind `LanguageModule` (`id`, `extensions`, `grammar`, `functions(root, source)`): `c.ts` and `cpp.ts` share the walker in `c-family.ts`, `rust/` has its walker and the wrapper-crate build; `index.ts` is the registry (`languageOf`, `loadLanguage`, `findFunctions`) and where a language is registered |
| `packages/ts-polyglot/src/parser.ts` | web-tree-sitter: loads a grammar from `grammars/` once per process; parsing is synchronous |
| `packages/ts-polyglot/grammars/` | the vendored tree-sitter `.wasm` grammars, `manifest.json` (repository, tag, SHA-256) and each grammar's LICENSE; `npm run grammars -- check` verifies them, `update <id> [tag]` re-pins one from its GitHub release |
| `packages/ts-polyglot/src/declarations.ts` | the virtual TypeScript and span mappings returned by `transform` |
| `packages/ts-polyglot/src/mapper.ts` | the content mapper process (JSON-RPC over stdio) |
| `packages/ts-polyglot/src/protocol.ts` | the protocol types it uses |
| `packages/ts-polyglot/src/build.ts` | Node-API glue generation and the addon cache; the Rust wrapper crate and static library come from `languages/rust/build.ts` |
| `packages/ts-polyglot/src/compiler.ts` | picks the compiler for a file: `CC`/`CXX`, the `"ts-polyglot"` field in package.json, or the platform default; spawns nothing |
| `packages/ts-polyglot/src/toolchain.ts` | the build commands: MSVC (`vswhere`, `vcvars64.bat`, the Node-API import library) and gcc/clang on Linux and macOS |
| `packages/ts-polyglot/src/register.ts` | loads every grammar (a top-level await, which `--import` waits for), then installs the synchronous Node resolve hook: an import of a native file resolves to the generated module in the cache |
| `packages/ts-polyglot/test/` | `node:test` suites: unit tests import `src/`; `e2e.test.ts` runs the real `tsc` and `node` (so `dist/`) over the projects in `test/fixtures/`; `pack.test.ts` installs the packed tarball outside the repo, as a user would |
| `packages/ts-polyglot/dist/` | what actually runs: JavaScript and source maps from `tsconfig.build.json`, which `exports` and the mapper's `exec` point at (git-ignored) |
| `examples/native-demo/` | a consumer project: `add.cpp`, `geometry.c`, `numbers.rs`, `main.ts` |
| `packages/create-ts-polyglot/` | `npm create ts-polyglot`. `src/cli.ts` asks with `@clack/prompts` (directory, editor, install) and writes `template/`, which is a working project itself: `_gitignore` becomes `.gitignore` (npm leaves that name out of tarballs), `README.md` has `__NAME__` and a `<!-- vscode -->` section, and `.vscode/launch.{windows,linux,osx}.json` are one `launch.json` per OS (the native debugger's type can't vary by OS), with `__NODE__` for the node the native half launches. Only Windows's compound has been run; it's F5 there, second in the dropdown elsewhere. `src/toolchain.ts` mirrors how ts-polyglot finds the compilers and only reports, and finds the node for the debugger. `test/e2e.test.ts` runs the built CLI, installs ts-polyglot from a packed tarball into the result, type-checks and runs it |
| `scripts/lsp-probe.cjs` | drives `tsc --lsp` like VS Code against the example, to check editor behavior without an editor |
| `.github/workflows/ci.yml` | GitHub Actions: `npm ci`, typecheck, test and example on Windows, Linux (x64, arm64) and macOS (arm64, x64). Runs on every branch push and pull request to the GitHub repo, `mykhailen/ts-polyglot`; tags go through `release.yml`, which calls it |
| `.github/workflows/release.yml` | a `v*` tag: runs `ci.yml` (`workflow_call`), then publishes `ts-polyglot` and `create-ts-polyglot` with npm trusted publishing (OIDC, no token) and creates the GitHub release. npm trusts it by filename |
| `scripts/release.ts` | `npm run release`: moves both packages and the template to one version, dates `CHANGELOG.md`, tests, commits and tags. Its `check` and `notes` run in `release.yml`. `release.test.ts` covers the pure parts, and the root `tsconfig.json` type-checks `scripts/*.ts` |
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
node packages/create-ts-polyglot/dist/cli.js my-app --no-install   # the scaffold from this checkout; `npm install <tarball>` in the result, as e2e.test.ts does
npm run grammars -- check      # the vendored tree-sitter grammars match grammars/manifest.json; `update <id> [tag]` re-pins one from its GitHub release
npm run release -- 0.2.0       # or patch|minor|major: the release commit and tag; `git push origin main v0.2.0` then publishes (docs/releasing.md)
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
- `web-tree-sitter` is pinned exactly too (`0.27.1`): the runtime and the grammar binaries in
  `grammars/` are ABI-coupled. Bump them together, deliberately; `test/grammars.test.ts` is the check.
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
  either drifts. `npm run release` bumps `ts-polyglot` there with the packages; TypeScript is bumped
  by hand.
- **One version for both packages.** A tag `vX.Y.Z` publishes both. `scripts/release.ts` keeps the
  two package.json files, the template and the lockfile's workspace entries in step, and its `check`
  refuses a tag that doesn't match them.
- **`CHANGELOG.md` has a `## <package>` section each.** The next version's entries go under
  `### x.y.z (unreleased)` in both; the release dates them, and they become the GitHub release notes.
- **`release.yml` is configuration on npmjs.com.** The trusted publishers of both packages name the
  workflow file and the repository. Renaming either, or changing `repository.url`, stops publishing.
- **Keep `src/` runnable by Node's type stripping** anyway, so tests and scripts can import it
  without a build: `erasableSyntaxOnly` (no `enum`, `namespace` or parameter properties; use
  `as const` objects), `.ts` extensions on relative imports (the build rewrites them), and
  `import type` for types.
- **Comments say why, not what.** Match the density of the existing files.
- **Bump `GLUE_VERSION` in `build.ts`** whenever the generated C, C++, Rust or JavaScript, or the
  compiler flags, change, so cached addons rebuild.
- **Adding a language:** `npm run grammars -- update <id> <tag> <owner/name>` pins its grammar; a
  module under `src/languages/` implements `LanguageModule` and joins `languages` in `index.ts`; a
  `test/<id>.test.ts` pins its walker. The build half (toolchain, glue) is still shared code in
  `build.ts` and `toolchain.ts`, with Rust's wrapper crate in `languages/rust/build.ts`, until the
  marshaling design says what a language provides there.
- **Mapper rules** (details in the docs):
  - Verbatim spans must be identical text on both sides.
  - `transform` diagnostics stop all type checking, so don't use them for "unsupported, skipped".
  - Keep `initialize` fast: there's a 5 s timeout.
  - State that differs per project belongs under `projectHandle`, because one mapper process serves
    every project.

## Open work, roughly in priority order

1. **More tests.** The suite follows the lab's pattern. Still missing: error locations in the native
   file, once item 2 produces diagnostics.
2. **Compile errors in `tsc` and the editor.** Run a syntax-only compile in `transform` and return
   the errors as mapper diagnostics. Accept that they block type checking, the same as syntax errors.
3. **More types:** strings (`const char*`, `&str`/`String`), buffers and pointers, structs, and
   `bigint` for 64-bit values.
4. **More toolchains:** MinGW gcc and clang-cl on Windows (they need a per-OS `compiler` setting,
   because one committed value would mean different things on different OSes), and Windows on arm64.
5. **Releasing.** Both packages have been on npm since 2026-10-23 (0.1.0, published by hand).
   Releases go through `npm run release`, `git push origin main vX.Y.Z` and the Release workflow
   (docs/releasing.md). Before the next one, the owner configures the trusted publishers on
   npmjs.com for both packages (workflow `release.yml`, allow `npm publish`); a new configuration
   expires after 2 days without a publish, so do it right before releasing. After the first CI
   publish: require 2FA and disallow tokens. Later, possibly prebuilt binaries.
6. **Parser limits:**
   - an unknown macro before the return type (`MYAPI int f(int)`) hides the function;
   - every branch of a preprocessor conditional is scanned, and a name defined in two of them is
     exported once, from the first;
   - only the first of a set of overloads is kept;
   - included headers aren't part of the cache key.
7. **Trust.** `tsc` gates the mapper behind `--runExternalCode`, and VS Code gates it behind workspace
   trust. The runtime hook compiles and loads any imported native file with no gate beyond `--import`.
