<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="ts-polyglot" width="320">
  </picture>
</h1>

[![CI](https://github.com/mykhailen/ts-polyglot/actions/workflows/ci.yml/badge.svg)](https://github.com/mykhailen/ts-polyglot/actions/workflows/ci.yml)

Import functions from C, C++ and Rust source files straight into TypeScript, with real types:

```ts
import { add } from "./add.cpp";
import { fib } from "./numbers.rs";

add(1, 2); // 3, typed from `int add(int a, int b)`
fib(50); // 12586269025, typed from `pub fn fib(n: u32) -> i64`
```

TypeScript gets the types from a [content mapper](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/#content-mappers),
a TypeScript 7.1 beta feature. Node gets the functions from a Node-API addon that ts-polyglot compiles
the first time the file is imported.

Status: early, for functions that take and return numbers and booleans. Tested on Windows and Linux;
macOS support is written but not yet verified.

| Path | What |
| --- | --- |
| [packages/ts-polyglot](packages/ts-polyglot/README.md) | the package: content mapper and runtime hook |
| [packages/create-ts-polyglot](packages/create-ts-polyglot/README.md) | `npm create ts-polyglot`: a new project with the demo files, the editor setup and F5 debugging |
| [examples/native-demo](examples/native-demo) | C, C++ and Rust files imported from `main.ts` |
| [docs/content-mappers.md](docs/content-mappers.md) | notes on the content mapper protocol and editor support |

## Start a project

```sh
npm create ts-polyglot
```

It asks for a directory and an editor, writes a project with a C, a C++ and a Rust file imported
from `main.ts`, installs the dependencies, checks for the compilers and prints what's left: for
VS Code, installing the recommended TypeScript 7 extension and picking **Use Workspace Version**.
`npm create ts-polyglot my-app -- --ide none --no-install` skips the questions.

## Try it

Needs Node 22.18+, Rust (for `.rs` files), and a C and C++ compiler:

- Windows (x64): the Visual Studio 2022 C++ build tools ("Desktop development with C++").
- Linux: gcc or clang (on Debian or Ubuntu: `sudo apt install build-essential`).
- macOS: the Xcode Command Line Tools (`xcode-select --install`).

```sh
npm install
npm run typecheck   # tsc --runExternalCode over the example
npm run example     # builds the addons on first import, then runs the example
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the type check, the tests and the
example on Windows, Linux and macOS on every push.

## License

[MIT](LICENSE)
