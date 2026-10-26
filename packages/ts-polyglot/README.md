# ts-polyglot

Import functions from C, C++ and Rust source files straight into TypeScript:

```ts
import { add } from "./add.cpp"; // extern "C" int add(int a, int b)
add(1, 2); // 3, typed as (a: number, b: number) => number
```

Early stage: numbers, booleans, strings and plain structs. Tested on Windows and Linux; macOS support
is written but not yet verified. Requires TypeScript 7.1 (beta) and Node 22.18+.

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

Both halves read signatures with the same parser: tree-sitter, through one module per language under
[src/languages/](src/languages/), with the grammars vendored in [grammars/](grammars/).

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
| C, C++ | definitions that aren't `static`, at the top level, inside `extern "C" { }` blocks or inside named namespaces; attributes, `constexpr`, `noexcept`, trailing return types, default arguments (still required in TypeScript), `__declspec(dllexport)` and `__cdecl` are fine | every integer type (`char` to `unsigned long long`, the `(u)intN_t`s, `size_t`), `float`, `double`, `bool`, `void`; `const char*` (typed `string \| null`), `std::string`, `const std::string&`, `std::string_view`; plain structs (public data members only, defined in the same file), by value or by `const&`; `std::vector<T>` and `std::array<T, N>`, by value or by `const&`; C arrays as struct fields (`T x[N]`, `char name[N]` as a `string`) and as `const T xs[]` parameters paired with a length parameter |
| Rust | `pub fn`, `pub extern "C" fn` and `pub const fn`, at the top level or inside `pub mod`s | `i8`–`i64`, `isize`, `u8`–`u64`, `usize`, `f32`, `f64`, `bool`, `char`, `()`; `&str`, `String`, `&String`, `&'static str`; plain `pub struct`s with `pub` fields, by value or by `&`; `Vec<T>`, `&[T]`, `&Vec<T>`, `[T; N]`, `&[T; N]` and `&'static [T]` results |

Everything else is skipped, so importing it is a "has no exported member" error in TypeScript. That
includes other pointers, mutable references and arrays (`&mut [T]`, `std::vector<T>&`, a non-const C
array), templates other than `std::vector` and `std::array`, generics, overloads past the first,
`unsafe` and `async` functions, class methods, and a struct with any of those in it. A half-typed
file keeps its intact functions.

**How values cross.** Integers up to 32 bits and floats are `number`s. 64-bit integers (`long`,
`int64_t`, `size_t`, `i64`, `usize`, …) are `bigint` results and `number | bigint` parameters. A wrong
JavaScript type is a `TypeError`; a value that doesn't fit the native type (`1.5` or `2 ** 40` for an
`int`, `-1` for an unsigned, a NUL inside a `const char*`) is a `RangeError`, with the limits in the
message. Strings are UTF-8 both ways. A struct is an object with the struct's fields, every one
required; extra properties are ignored. A C++ exception or a Rust panic becomes an `Error` with its
message.

Sequences (`Vec<T>`, `&[T]`, `std::vector<T>`, a C array with its length parameter) are `T[]`,
`readonly T[]` as parameters; a fixed length (`[T; N]`, `std::array<T, N>`, `T x[N]`) is a tuple, and
a wrong length a `RangeError`. Unsigned bytes (`u8`, `uint8_t`, `unsigned char`) are a `Uint8Array`
instead, lent to the native side without a copy on the way in and copied into a fresh one on the way
out; a `Buffer` is accepted, other typed arrays aren't. A C `char name[N]` is a `string` of at most
N − 1 bytes. Elements are checked one by one and named by their path (`xs[2]`, `p.pts[0].y`).

**The C length rule.** In C and C++, `double mean(const double xs[], size_t n)` is
`mean(xs: readonly number[]): number`: an array spelled `const T xs[]` takes the next integer
parameter as its length, which the glue passes, and arrays in a row share it (`dot(a[], b[], n)`) and
must agree. The C99 spelling `const double xs[n]` names the length parameter explicitly. A plain
pointer, `const double* xs`, stays a pointer and hides the function, since nothing says it's an array.

## Limits

- Needs a C/C++ compiler (see [Compilers](#compilers)) and, for Rust, `rustc` on PATH. On Windows,
  Node must be x64.
- Compile errors in the native file only appear when Node imports it, not in `tsc`.
- Headers a C file includes are not part of the cache key. After editing a header, delete the cache.
- An unknown macro before a function's return type (`MYAPI int f(int)`) hides the function: the
  parser reads the file with tree-sitter and doesn't expand macros.
- Struct definitions come from the same file: `#include`, `mod x;` and `use` aren't followed, so a
  function that uses a struct from a header is skipped.
- A `const char*` a function returns is copied and never freed, so the function has to keep it
  alive; NULL comes back as `null`. A non-const `char*` isn't supported yet.
- Nothing is written back: `&mut [T]`, `std::vector<T>&` and non-const C array parameters hide
  their function. Arrays cross by value in both directions.
- The glue includes your C or C++ file after the C headers it needs (`stdlib.h`, `string.h`,
  `stdio.h`, `math.h`, `limits.h`, `stdint.h`), so a function of yours with the name and a different
  signature of something they declare (`random` on Linux, say) fails to compile.
- `std::vector` and `std::array` must be spelled qualified (`using std::vector` isn't followed), and
  an array size must be an integer literal or a name the same file defines as one (`#define`,
  `const`, `constexpr`, a Rust `const`); any other size hides the function.
- `long` is 32 bits wide on Windows and 64 elsewhere. Its TypeScript type is `bigint` everywhere;
  the glue checks the real width, so a value past 2^31 is a `RangeError` on Windows.
- The runtime hook compiles and loads native code from any imported `.c`, `.cpp` or `.rs` file.
  Only use it with code you trust.
- `TS_POLYGLOT_DEBUG=1` builds unoptimized addons with debug info for a native debugger: `.pdb`
  files on Windows, `-g -O0` elsewhere. Breakpoints in a native file are for that debugger: the
  JavaScript debugger never sees the file as a script and leaves them unbound.
