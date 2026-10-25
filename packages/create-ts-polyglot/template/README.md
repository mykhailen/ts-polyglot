# __NAME__

TypeScript that imports C, C++ and Rust functions straight from their source files, with
[ts-polyglot](https://www.npmjs.com/package/ts-polyglot):

```ts
import { add } from "./add.cpp"; // extern "C" int add(int a, int b)
import { fib } from "./numbers.rs"; // pub fn fib(n: u32) -> i64
```

## Run it

```sh
npm install
npm run typecheck   # tsc --runExternalCode: TypeScript types the native files through ts-polyglot
npm start           # node --import ts-polyglot/register src/main.ts
```

The first `npm start` compiles each native file into a Node-API addon, which takes a few seconds.
Later runs use the cache in `node_modules/.cache/ts-polyglot`.

## What you need

- Node 22.18 or newer.
- A C and C++ compiler. Windows: the Visual Studio 2022 Build Tools with "Desktop development with
  C++". Linux: gcc or clang (`sudo apt install build-essential`). macOS: the Xcode Command Line
  Tools (`xcode-select --install`).
- Rust, for `.rs` files: `rustc` on PATH, from <https://rustup.rs>. Don't want it? Delete `numbers.rs`
  and its import in `main.ts`.

<!-- vscode -->
## VS Code

Open the folder and trust it. VS Code offers to install the recommended extensions: **TypeScript
(Native Preview)**, which is TypeScript 7, and **C/C++**, which debugs the native code. Then run
**TypeScript: Select TypeScript Version…** from the command palette and pick
**Use Workspace Version**: the extension's own TypeScript is 7.0 and can't type native files; the
7.1 beta in `node_modules` can. That's a one-time choice per folder. After it, hover,
go-to-definition, references and rename work across the language boundary.

**F5** runs `main.ts` under both debuggers ("Debug TypeScript + native"): set a breakpoint in
`add.cpp`, step over `add(1, 2)` in `main.ts` (F10), and you're in the C++. F5 there brings you back
to the next line of `main.ts`. On Linux and macOS this configuration hasn't been tried yet, so F5
runs "Debug main.ts" (TypeScript only) and the other waits in the dropdown. The native debugger
launches the node that ran `npm create`; `.vscode/launch.json` says where to change that.
<!-- /vscode -->

## Next

Add a `.c`, `.cpp` or `.rs` file and import it. Functions that take and return numbers and booleans
are exported, at the top level or inside `extern "C" { }` blocks, namespaces and `pub mod`s;
`static` C functions and non-`pub` Rust functions stay private. The extensions ts-polyglot handles
are listed under `contentMappers` in `tsconfig.json`.
