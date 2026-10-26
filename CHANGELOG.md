# Changelog

A section per package. The next version's entries go under `### x.y.z (unreleased)` in both
sections; `npm run release` dates the headings, and the Release workflow makes them the GitHub
release notes ([docs/releasing.md](docs/releasing.md)).

## ts-polyglot

### 0.3.0 (2026-10-26)

- Native files are parsed with tree-sitter (`web-tree-sitter`, with the C, C++ and Rust grammars
  vendored under `grammars/`, about 5 MB unpacked), one walker per language. Found now: functions
  inside `extern "C" { }` blocks, named namespaces and Rust `pub mod`s, exported under their own
  name; functions with attributes, `constexpr`, `noexcept`, a trailing return type or default
  arguments; `pub const fn`. A half-typed file keeps its intact functions, so the editor's types
  don't vanish while you type. Still skipped: pointers other than `const char*`, mutable references,
  arrays, templates and generics, overloads past the first, `unsafe` and `async` functions, and a
  function behind an unknown macro.
- The runtime hook preloads the grammars at `--import` time, about 25 ms; the type side loads one
  the first time it sees a file of that language.
- Strings cross, as UTF-8 both ways: `const char*` (typed `string | null`; a NUL inside is a
  `RangeError`), `std::string`, `const std::string&`, `std::string_view`, `&str`, `String` and
  `&'static str`. A returned `const char*` is copied and never freed.
- Plain structs cross by value, nested, as exported `interface`s with the struct's field names: C and
  C++ `struct`s and `class`es with only public data members, Rust `pub struct`s with `pub` fields,
  defined in the same file. Rust needs no `#[repr(C)]`. A missing field is a `TypeError` naming it.
- Every C and Rust integer type: `char`, `short`, `long`, `unsigned long`, `size_t`, the `(u)intN_t`s,
  `i8` to `i64`, `u8` to `u64`, `isize` and `usize`; `float` and `f32`; Rust `char` as a one-character
  string.
- **Behavior change:** 64-bit integers are `bigint` results and `number | bigint` parameters:
  `fib(50)` is `12586269025n`. The TypeScript type is the same on every OS; the glue checks the real
  width, so on Windows a `long` past 32 bits is a `RangeError`.
- **Behavior change:** conversions are strict. A wrong JavaScript type is a `TypeError`; a value that
  doesn't fit (`1.5` or `2 ** 40` for an `int`, `-1` for an unsigned) is a `RangeError`, with the
  limits in the message. Before, they were truncated or wrapped silently.
- A C++ exception and a Rust panic become a JavaScript `Error` carrying the message, instead of
  ending the process.
- Arrays cross, by value and nested to any depth: Rust `Vec<T>`, `&[T]`, `&Vec<T>`, `[T; N]` and
  `&'static [T]` results; C++ `std::vector<T>` and `std::array<T, N>`, by value or by `const&`; C
  arrays as struct fields and as `const T xs[]` parameters paired with the next integer parameter
  (or the one `xs[n]` names), which leaves the TypeScript signature. They are `T[]`, `readonly` as
  parameters, and a fixed length is a tuple; unsigned bytes (`u8`, `uint8_t`, `unsigned char`) are a
  `Uint8Array`, copied both ways; a C `char name[N]` is a
  `string` of at most N − 1 bytes. A bad element is named by its path (`xs[2]`, `p.pts[0].y`), a
  wrong fixed length is a `RangeError`, and a mutable array (`&mut [T]`, `std::vector<T>&`, a
  non-const C array) still hides its function.

### 0.2.0 (2026-10-23)

- An import of a native file now resolves to a generated module in the addon cache, instead of the
  generated JavaScript being loaded under the native file's URL. The JavaScript debugger no longer
  takes `add.cpp` for a script: a breakpoint set there is left to the native debugger, where before
  it bound to the generated text, stopped there on import, and opened that text as a second,
  read-only `add.cpp`.
- Published by the Release workflow from a `v*` tag, with npm provenance.

### 0.1.0 (2026-10-23)

First release.

- Imports top-level C, C++ and Rust functions that take and return numbers and booleans from
  `.c`, `.cpp` and `.rs` files.
- Types come from a TypeScript 7.1 beta content mapper, for `tsc --runExternalCode` and the
  TypeScript 7 editor extension. Hover, go-to-definition, references and rename reach into the
  native file.
- Functions come from a Node hook, `node --import ts-polyglot/register`. Each file is compiled into
  a Node-API addon on first import and cached by source hash.
- Compilers: MSVC on Windows x64; `cc`, gcc or clang on Linux and macOS, chosen with `CC`/`CXX` or
  the `"ts-polyglot"` field in package.json. Rust files need `rustc`. macOS support is written but
  not yet verified.

## create-ts-polyglot

### 0.3.0 (2026-10-26)

- The template keeps its sources in `src/`: `main.ts` and the native files it imports. The `start`
  script and the launch configurations point there.
- The template asks for ts-polyglot 0.3.0, and its README says what crosses now: numbers, booleans,
  strings, plain structs and arrays.

### 0.2.0 (2026-10-23)

- F5 debugs `main.ts` and the native code in one session. `launch.json` is written for the OS the
  project is created on: the Visual Studio debugger on Windows, gdb or lldb through the C/C++
  extension on Linux and macOS. On those two it hasn't been tried yet, so F5 stays TypeScript-only
  there and "Debug TypeScript + native" waits in the dropdown. The native debugger launches the node
  that ran `npm create`, by full path; when that was bun or deno, the first node on PATH.
- `extensions.json` also recommends the C/C++ extension, and the closing steps say so.
- The template asks for ts-polyglot 0.2.0.
- Published by the Release workflow from a `v*` tag, with npm provenance.

### 0.1.0 (2026-10-23)

First release.

- `npm create ts-polyglot` writes a project with a C, a C++ and a Rust file imported from
  `main.ts`, the `contentMappers` entry in tsconfig.json, `typecheck` and `start` scripts, and
  optionally the VS Code settings, the TypeScript 7 extension recommendation and an F5
  configuration for `main.ts`.
- Installs with the package manager that ran it, checks for the compilers and reports what's
  missing.
