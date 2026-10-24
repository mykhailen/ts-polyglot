# ts-polyglot

Import functions from C, C++ and Rust source files straight into TypeScript:

```ts
import { add } from "./add.cpp"; // extern "C" int add(int a, int b)
add(1, 2); // 3, typed as (a: number, b: number) => number
```

Early stage: numbers and booleans only. Tested on Windows and Linux; macOS support is written but not
yet verified. Requires TypeScript 7.1 (beta) and Node 22.18+.

## Use it in a project

Install ts-polyglot and the TypeScript 7.1 beta. It needs Node 22.18 or newer and a C and C++
compiler (see [Compilers](#compilers)); Rust files also need `rustc`.

```sh
npm install ts-polyglot
npm install -D typescript@7.1.0-beta   # exactly this build; the mapper protocol still changes
```

Tell TypeScript which files ts-polyglot handles (`tsconfig.json`):

```json
{
  "compilerOptions": { "module": "nodenext", "strict": true, "noEmit": true },
  "contentMappers": [{ "package": "ts-polyglot", "extensions": [".c", ".cpp", ".rs"] }]
}
```

Then type-check with `tsc --runExternalCode` and run with the hook:

```sh
node --import ts-polyglot/register main.ts
```

In VS Code, trust the workspace and pick **TypeScript: Select TypeScript Version… → Use Workspace
Version**. The TypeScript 7 extension's bundled server is 7.0 and has no content mappers.

## Compilers

With nothing configured, each platform's usual compiler builds C and C++ (and the glue of Rust
files). Rust files also need `rustc` on PATH.

| OS | Compiler |
| --- | --- |
| Windows x64 | MSVC, from the Visual Studio C++ build tools (found with `vswhere`) |
| Linux | `cc` and `c++`, usually gcc |
| macOS | `cc` and `c++`: Apple clang, from the Xcode Command Line Tools |

On Linux and macOS, a project can pick another compiler in its `package.json`:

```json
"ts-polyglot": { "compiler": "clang" }
```

- `compiler` is `gcc`, `clang`, `cc`, or a path to a gcc- or clang-compatible compiler. A relative
  path is relative to that `package.json`.
- C++ files use the matching C++ driver, keeping any directory or version suffix: `gcc` → `g++`,
  `clang` → `clang++`, `cc` → `c++`, `gcc-13` → `g++-13`.
- The closest `package.json` with a `"ts-polyglot"` field counts, searching upward from the native
  file.
- `CC` (C files and Rust glue) and `CXX` (C++ files) override it, as in make. They may include a
  wrapper, such as `CC="ccache gcc"`.
- Precedence: `CC`/`CXX`, then `package.json`, then the default.

Windows always uses MSVC for now and ignores these settings. A project can choose clang for its Linux
machines without breaking its Windows ones.

## How it works

Both halves read signatures with the same parser, [src/signatures.ts](src/signatures.ts).

- **Types: a content mapper** ([src/mapper.ts](src/mapper.ts), [src/declarations.ts](src/declarations.ts)).
  For `add.cpp`, tsc checks `export declare function add(a: number, b: number): number;`.
  Function and parameter names map back to the native file verbatim. That gives hover,
  go-to-definition, references and rename across the language boundary. Nothing is compiled at
  type-check time.
- **Runtime: a Node hook** ([src/register.ts](src/register.ts), [src/build.ts](src/build.ts)).
  Importing `add.cpp` generates Node-API glue that `#include`s the file and wraps each function. The
  platform's compiler (see [Compilers](#compilers)) builds the glue into a `.node` addon, and the
  import resolves to a generated module that exports the addon's functions. A Rust file
  becomes a module of a small crate with `extern "C"` wrappers. `rustc` builds that crate into a
  static library, which the glue links. Builds are cached by source hash in
  `node_modules/.cache/ts-polyglot`. Set `TS_POLYGLOT_CACHE_DIR` to keep the cache somewhere else.

## What it exports

| Language | Functions | Types |
| --- | --- | --- |
| C, C++ | top-level, non-`static`; `extern "C"` is fine, and so are `__declspec(dllexport)` and `__cdecl` on Windows | `int`, `unsigned`, `short`, `long`, `long long`, `(u)intN_t`, `float`, `double`, `bool`, `void` |
| Rust | top-level `pub fn` and `pub extern "C" fn` | `i8`–`i64`, `u8`–`u32`, `f32`, `f64`, `bool`, `()` |

Everything else is skipped, so importing it is a "has no exported member" error in TypeScript. That
includes pointers, strings, structs, namespaces, `extern "C" { }` blocks, generics and overloads.

## Limits

- Needs a C/C++ compiler (see [Compilers](#compilers)) and, for Rust, `rustc` on PATH. On Windows,
  Node must be x64.
- Compile errors in the native file only appear when Node imports it, not in `tsc`.
- Headers a C file includes are not part of the cache key. After editing a header, delete the cache.
- `long`, `long long`, `int64_t` and `i64` become JavaScript numbers, so values above 2^53 lose
  precision. `unsigned long` is skipped: 64-bit unsigned values aren't supported yet.
- The runtime hook compiles and loads native code from any imported `.c`, `.cpp` or `.rs` file.
  Only use it with code you trust.
- `TS_POLYGLOT_DEBUG=1` builds unoptimized addons with debug info for a native debugger: `.pdb`
  files on Windows, `-g -O0` elsewhere. Breakpoints in a native file are for that debugger: the
  JavaScript debugger never sees the file as a script and leaves them unbound.
