# ts-polyglot

Import functions from C, C++ and Rust source files straight into TypeScript:

```ts
import { add } from "./add.cpp"; // extern "C" int add(int a, int b)
add(1, 2); // 3, typed as (a: number, b: number) => number
```

Early stage: numbers, booleans, strings, plain structs and arrays of those cross, as
[Marshaling](#marshaling) lays out. Tested on Windows and Linux; macOS support is written but not
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

| Language | Functions |
| --- | --- |
| C, C++ | definitions that aren't `static`, at the top level, inside `extern "C" { }` blocks or inside named namespaces; attributes, `constexpr`, `noexcept`, trailing return types, default arguments (still required in TypeScript), `__declspec(dllexport)` and `__cdecl` are fine |
| Rust | `pub fn`, `pub extern "C" fn` and `pub const fn`, at the top level or inside `pub mod`s |

A function is exported when its parameters and its result all have a type in
[Marshaling](#marshaling) below. Any other type skips the function, so importing it is a "has no
exported member" error in TypeScript; a half-typed file keeps its intact functions. Skipped:
pointers other than `const char*`; mutable references and arrays (`&mut T`, `T&`, `T&&`,
`std::vector<T>&`, a non-const unsized C array); `wchar_t`, `char16_t`, `char32_t` and
`std::wstring`; `i128` and `u128`; `Option<T>`, `std::optional<T>`, `Box<T>`, tuples, enums, unions,
`std::span`, `std::map` and every other template or generic; function pointers and variadics;
overloads past the first; `unsafe` and `async` functions and ones with type or lifetime parameters;
class methods, `impl` blocks and `self`; and a struct with any of those in it.

## Marshaling

The tables below map native spellings to the TypeScript type that `tsc` and the editor see, and that
the glue enforces when the function is called. A parameter and a result of the same native type can
differ in TypeScript; the tables say where. Every type here may also be taken by `const T&` in C++
and by `&T` in Rust: the callee borrows the glue's copy for the call.

### Scalars

| C and C++ | Rust | TypeScript |
| --- | --- | --- |
| `bool`, `_Bool` | `bool` | `boolean` |
| `char`, `signed char`, `unsigned char`, `short`, `unsigned short`, `int`, `unsigned`, `int8_t`, `int16_t`, `int32_t`, `uint8_t`, `uint16_t`, `uint32_t` | `i8`, `i16`, `i32`, `u8`, `u16`, `u32` | `number` |
| `long`, `unsigned long`, `long long`, `unsigned long long`, `int64_t`, `uint64_t`, `size_t`, `ptrdiff_t`, `intptr_t`, `uintptr_t` | `i64`, `u64`, `isize`, `usize` | `bigint` as a result or a struct field; `number \| bigint` as a parameter |
| `float`, `double` | `f32`, `f64` | `number` |
| | `char` | `string`, one character long |
| `void` | `()`, or no return type | `void` (results only) |

- The integer keywords combine in any order, with `int` or `signed` left out or not
  (`long unsigned int`), and the `<cstdint>` names and `size_t` may carry `std::`.
- `long` is in the 64-bit row although it's 32 bits wide on Windows: the TypeScript type is the same
  on every OS, and the glue checks the platform's real limits (see [Limits](#limits)).
- A C `char` is a number, a Rust `char` a one-character string: `'a'` is `97` from C and `"a"` from
  Rust. One character is one Unicode scalar value, so `"😀"`, whose `length` is 2, is one.

### Strings

| C and C++ | Rust | TypeScript |
| --- | --- | --- |
| `const char*` (one pointer level; `char const*` too) | | `string \| null` |
| `std::string`, `const std::string&`, `std::string_view` | `&str`, `String`, `&String`; `&'static str` as a result | `string` |
| `char name[N]`, as a struct field or a parameter | | `string`, of at most N − 1 UTF-8 bytes |
| `const char s[]` with a length parameter (see [C arrays](#c-arrays-and-their-length-parameter)) | | `string` |

Text is UTF-8 on the native side, both ways. A `const char*` a function returns is copied and never
freed, so the function must keep it alive, as a literal or a static buffer does; NULL comes back as
`null`. Every other string is copied too, so a function may return a `std::string` or a `String` it
built. A Rust result that borrows anything but `'static` (`fn f(s: &str) -> &str`) is hidden: it
would borrow from an argument the wrapper has already dropped. `String` may be spelled
`std::string::String`.

### Structs

| C and C++ | Rust | TypeScript |
| --- | --- | --- |
| a `struct` or `class` with only public data members, defined in the same file; by value, or in C++ by `const T&` | a `pub struct` with only `pub` fields, defined in the same file; by value or by `&T` | an exported `interface` named after the struct, one property per field, every one required |

A field can have any type in these tables, nested structs and arrays included, and is typed by them:
`struct Point { int x; long y; }` is `interface Point { x: number; y: bigint; }` and takes
`{ x: 1, y: 2n }`. A struct with a pointer, a reference, a bit-field, a method or a private member
in it hides every function that uses it. Rust structs need no `#[repr(C)]`. A struct crosses by
value: in, the object is read field by field, so extra properties are ignored and a missing one is a
`TypeError`; out, a plain object with every field is made.

### Sequences and arrays

| C and C++ | Rust | TypeScript |
| --- | --- | --- |
| `std::vector<T>`, `const std::vector<T>&`; `const T xs[]` with a length parameter | `Vec<T>`, `&[T]`, `&Vec<T>`; `&'static [T]` as a result | `readonly T[]` as a parameter; `T[]` as a result or a field |
| `std::array<T, N>`, `const std::array<T, N>&`; `T x[N]` as a field or a parameter | `[T; N]`, `&[T; N]` | a tuple of N: `readonly [T, T, T]` as a parameter, `[T, T, T]` as a result or a field |
| any of those with an unsigned 8-bit element: `uint8_t`, `unsigned char`, `u8` | | `Uint8Array`, whatever the length |

`T` is any type in these tables, so arrays nest to any depth and the TypeScript type follows:
`Vec<Vec<i32>>` is `number[][]` (`readonly (readonly number[])[]` as a parameter),
`std::vector<std::string>` is `string[]`, `std::vector<const char*>` is `(string | null)[]`,
`Vec<[f32; 2]>` is `[number, number][]`, `int grid[2][2]` is `[[number, number], [number, number]]`,
and `Vec<Vec<u8>>` is `Uint8Array[]`. Only unsigned 8-bit elements make a `Uint8Array`:
`std::vector<char>` and `Vec<i8>` are `number[]`, and `char x[N]` is a string, as above. A `Buffer`
is a `Uint8Array` and is accepted; no other typed array is, and a typed array isn't an array either,
so a `Float64Array` for a `readonly number[]` is a `TypeError` (`Array.from` it first).

A size `N` is an integer literal in any base, or a name the same file defines as one (`#define`,
`const`, `constexpr`, a Rust `const`); any other size hides the function. `std::vector` and
`std::array` must be spelled with `std::` (`using std::vector` isn't followed); `Vec<T>` may be
spelled `std::vec::Vec<T>`.

Arrays cross by value, as copies: the native side never sees the JavaScript array or buffer, a
result is a new `Array` or a new `Uint8Array` over its own `ArrayBuffer` (not a `Buffer`), and a
function can't write back into an argument.

### C arrays and their length parameter

C has no sequence type, so the glue pairs an array parameter with the parameter that carries its
length and passes the length itself, which leaves the TypeScript signature:

```c
double mean(const double xs[], size_t n);
double dot(const double a[], const double b[], int n);
size_t count_a(const char s[], size_t n);
float norm(const float v[3]);
```

```ts
mean(xs: readonly number[]): number;
dot(a: readonly number[], b: readonly number[]): number;
count_a(s: string): bigint;
norm(v: readonly [number, number, number]): number;
```

- The array is spelled as one, `const T xs[]`. A pointer, `const T* xs`, stays a pointer and hides
  the function, since nothing says it's an array.
- The length is the next integer parameter after the array, or the one the C99 form names
  (`const double xs[n]`; MSVC doesn't compile that spelling). Unsized arrays in a row share the next
  integer parameter, and their lengths must agree at the call.
- `const char s[]` paired this way is a `string`, and the length parameter gets its byte count.
- A sized array, `const float v[3]` or `const int m[2][2]`, is a tuple and takes no length
  parameter.
- Hidden: an unsized array with no integer parameter after it, one whose elements aren't const (the
  function could write into them), and an unsized array of arrays (`const double m[][3]`).

### Crossing in: the checks

Every argument is checked before the native function runs. A rejected value is named by its path
from the parameter, with the function's name in front: `area(): p.pts[0].y must be a number`.

- An integer takes a `number` that is finite, integral, inside the native type's limits and no
  larger than 2^53 − 1 in magnitude (past that, numbers have lost integer precision), or a `bigint`
  inside the limits. The glue takes a `bigint` for an `int` too, though TypeScript says `number`.
- A `float` or `double` takes any `number`, `NaN` and the infinities included; a `float` is
  narrowed.
- A `bool` takes `true` or `false`, not a truthy value.
- A Rust `char` takes a `string` of exactly one Unicode scalar value.
- A string takes a `string`; `const char*` also takes `null`. A `const char*` or a `char[N]` can't
  hold a NUL character, since C ends the string there, and a `char[N]` holds at most N − 1 bytes.
- A struct takes an object that isn't `null` or an array, read field by field: extra properties are
  ignored; a missing field reads as `undefined` and fails its own check.
- An array takes an array (`Array.isArray`; a typed array or a Proxy isn't one), of exactly N
  elements when the length is fixed, each element checked by its own rule. A hole reads as
  `undefined`.
- A `Uint8Array` takes a `Uint8Array` or a `Buffer`, not detached, of exactly N bytes when the
  length is fixed; a `number[]`, an `ArrayBuffer` or another typed array is rejected. The bytes are
  copied before the call.

| What went wrong | Thrown |
| --- | --- |
| the wrong JavaScript type: `"1"` for an `int`, `1` for a `bool`, `null` for a struct, a `Float64Array` for an array, a `number[]` for a `Uint8Array`, a missing field, a detached `Uint8Array` | `TypeError` |
| the right type, an impossible value: `1.5`, `NaN` or `2 ** 40` for an `int`, `-1` for an unsigned, `"ab"` for a `char`, a NUL inside a `const char*`, 16 bytes for a `char[16]`, 2 elements for a `std::array<int, 3>`, 2 bytes for a `[u8; 4]` | `RangeError`, with the limit in the message |
| the native code failed: a C++ exception (its `what()`, or `f() threw an exception` for one that isn't a `std::exception`), a Rust panic (its message, or `f() panicked` when the payload isn't a string), two C arrays sharing a length parameter with different lengths (`dot(): b must have as many elements as a`), a C array with more elements than its length parameter's type holds (`dot(): a has more elements than int holds`) | `Error` |

When a check fails, nothing native has run; when the native code fails, no result is made.

### Crossing out: results

A result is made once the function returns, always as a fresh JavaScript value: a `number` for an
integer up to 32 bits and for a float, a `bigint` for a 64-bit integer (`fib(50)` is
`12586269025n`), `true` or `false`, a one-character `string` for a Rust `char`, `undefined` for
`void` and `()`, a `string` for every string type (`null` for a NULL `const char*`), a plain object
with every field for a struct, a new `Array` for a sequence or a fixed-length array, and a new
`Uint8Array` over its own `ArrayBuffer`, not a `Buffer`, for bytes. Nothing a result holds aliases
native memory.

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
