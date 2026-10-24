<p align="center">
  <a href="https://ts-polyglot.dev/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
      <img src="assets/logo.svg" alt="ts-polyglot" width="320">
    </picture>
  </a>
</p>

<h1 align="center">Import C, C++ and Rust functions straight into TypeScript</h1>

<p align="center">
  <strong>ts-polyglot</strong> turns <code>import { add } from "./add.cpp"</code> into a typed, working call:
  no bindings to write, no <code>.d.ts</code> to maintain, no separate build step.<br>
  Built on <a href="https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/#content-mappers">content mappers</a>,
  the new TypeScript 7.1 feature, and on Node-API.
</p>

<div align="center">

[![CI](https://github.com/mykhailen/ts-polyglot/actions/workflows/ci.yml/badge.svg)](https://github.com/mykhailen/ts-polyglot/actions/workflows/ci.yml)

</div>

https://github.com/user-attachments/assets/98d0c114-84fd-4474-8083-18186326a729

## What it does

Write a function in C, C++ or Rust. Import the source file from TypeScript. Call it.

```cpp
// add.cpp
extern "C" int add(int a, int b) { return a + b; }
```

```rust
// numbers.rs
pub fn fib(n: u32) -> i64 { /* ... */ }
```

```ts
// main.ts
import { add } from "./add.cpp";
import { fib } from "./numbers.rs";

add(1, 2); // 3, typed as (a: number, b: number) => number
fib(50); // 12586269025, typed as (n: number) => number
add("1", 2); // error in tsc and the editor; at runtime a TypeError: add(): a must be a number
```

- **Real types, no `.d.ts`.** TypeScript reads the signatures from the native source itself, so
  `tsc` checks every call, and hover, go-to-definition, references and rename in VS Code reach into
  the C, C++ or Rust file.
- **No separate build step.** Node compiles each file into a Node-API addon the first time it's
  imported, with the compiler already on the machine, and caches it by source hash.
- **Types and runtime agree.** Both halves read the signatures with the same parser, so the types
  TypeScript checks are the ones the addon enforces.

## How it works

ts-polyglot is built on **content mappers**, a feature new in the TypeScript 7.1 beta. A package
registers for file extensions in `tsconfig.json`, and `tsc` and the editor's language server ask it
what those files export instead of trying to parse them as TypeScript.

- **Types: the content mapper.** For `add.cpp`, [mapper.ts](packages/ts-polyglot/src/mapper.ts)
  answers with `export declare function add(a: number, b: number): number;`, and maps the function
  and parameter names back to the C++ text so hover, rename and go-to-definition land in the native
  file. Nothing is compiled at type-check time.
- **Runtime: a Node hook.** `node --import ts-polyglot/register` installs a resolve hook. When
  `add.cpp` is imported, it generates Node-API glue around the file, builds it into a `.node` addon
  with the platform's compiler (MSVC on Windows; `cc`, gcc or clang on Linux and macOS) and resolves
  the import to a generated module that exports the addon's functions. A Rust file is first built
  into a static library with `rustc`, which the same glue links.

## Status

Early. Functions that take and return numbers and booleans work. Strings, pointers, structs and
64-bit values above 2^53 don't yet. Tested on Windows (MSVC) and Linux (gcc and clang); the macOS
recipe is written but not yet verified. The [package README](packages/ts-polyglot/README.md) has the
exact type tables and limits.

## Get started

### New project

```sh
npm create ts-polyglot
```

It asks for a directory and an editor, writes a project with a C, a C++ and a Rust file imported
from `main.ts`, installs the dependencies, checks for the compilers and prints what's left: for
VS Code, installing the recommended TypeScript 7 extension and picking **Use Workspace Version**.
`npm create ts-polyglot my-app -- --ide none --no-install` skips the questions.

### Existing project

```sh
npm install ts-polyglot
npm install -D typescript@7.1.0-beta   # exactly this build: content mappers are in beta and the protocol still changes
```

Hand the native extensions to ts-polyglot in `tsconfig.json`:

```json
{
  "compilerOptions": { "module": "nodenext", "strict": true, "noEmit": true },
  "contentMappers": [{ "package": "ts-polyglot", "extensions": [".c", ".cpp", ".rs"] }]
}
```

Then type-check with `--runExternalCode`, which `tsc` requires before it runs a mapper, and run with
the hook:

```sh
npx tsc --runExternalCode
node --import ts-polyglot/register main.ts
```

In VS Code, install the **TypeScript (Native Preview)** extension, trust the workspace, and run
**TypeScript: Select TypeScript Version…** to pick **Use Workspace Version**. The extension's bundled
TypeScript is 7.0, which has no content mappers.

### Requirements

- Node 22.18 or newer.
- TypeScript 7.1.0-beta, exactly.
- A C and C++ compiler. Windows (x64): the Visual Studio 2022 Build Tools with "Desktop development
  with C++". Linux: gcc or clang (on Debian or Ubuntu, `sudo apt install build-essential`). macOS:
  the Xcode Command Line Tools (`xcode-select --install`).
- Rust (`rustc` on PATH) for `.rs` files.

## This repository

| Path | What |
| --- | --- |
| [packages/ts-polyglot](packages/ts-polyglot/README.md) | the package: the content mapper and the runtime hook |
| [packages/create-ts-polyglot](packages/create-ts-polyglot/README.md) | `npm create ts-polyglot`: a new project with the demo files, the editor setup and F5 debugging |
| [examples/native-demo](examples/native-demo) | C, C++ and Rust files imported from `main.ts` |
| [docs/content-mappers.md](docs/content-mappers.md) | notes on the content mapper protocol and editor support |
| [docs/releasing.md](docs/releasing.md) | how a release is cut: one command, one tag, and the Release workflow publishing both packages |

To work on it:

```sh
npm install
npm run typecheck   # tsc --runExternalCode over the example
npm test            # unit tests, then end-to-end tests with the real tsc, node and compilers
npm run example     # builds the addons on first import, then runs the example
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the type check, the tests and the
example on Windows, Linux (x64 and arm64) and macOS (arm64 and x64) on every push. A `v*` tag runs
[release.yml](.github/workflows/release.yml), which publishes both packages to npm and creates the
GitHub release.

## License

[MIT](LICENSE)
