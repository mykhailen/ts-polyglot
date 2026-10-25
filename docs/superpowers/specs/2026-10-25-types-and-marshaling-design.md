# Types and marshaling: design

2026-10-25. Part two of the parser work: what crosses between TypeScript and C, C++ and Rust, and
how. Part one (`2026-10-24-tree-sitter-parser-design.md`) made the parsers real and put one module
per language behind `LanguageModule`; it left the set of types (`int`-sized integers, `double`,
`bool`) and the generated glue exactly as the regex scanner had them.

The owner's direction for this part: the type model must be able to describe what the three
languages actually have (pointers, references, by-value and by-reference, `const` and `mut`,
ownership), so that later rounds fill in cases instead of redesigning; this round marshals
**primitives, strings and plain structs**. Decisions the owner made in the conversation: strings count
as primitives; a plain struct is data only, defined in the same file, with no `#[repr(C)]` asked of
Rust code; 64-bit integers are `bigint` out and `number | bigint` in; conversions become strict; C++
exceptions and Rust panics become JavaScript errors. Items marked **[call]** are mine and reversible;
facts marked **measured** were observed on this machine on 2026-10-25 with Node 22.21.1, MSVC 2022 and
rustc 1.98.1.

## Where things stand

- `signatures.ts` has `Kind`: a TypeScript type name plus the C type, the Rust type and the two
  Node-API calls. Six exist: `I32`, `U32`, `I64`, `F64`, `BOOL`, `VOID`. `C_TYPES` (c-family.ts) and
  `RUST_TYPES` (rust/index.ts) map a normalized spelling to one; any other spelling hides the
  function. `int8_t` is `I32`; `long` is `I64` on every OS; `unsigned long` isn't there at all.
- The glue (`build.ts`) reads each argument with the kind's `fromJs` call. **measured:**
  `napi_get_value_int32` turns `2 ** 40` into 0, `1.5` into 1 and `NaN` into 0 without complaint,
  and a `uint8_t` parameter gets the low bits of whatever `uint32_t` arrived. Only a wrong JavaScript
  type (`"1"`, `5n`, `true`) fails, with `napi_number_expected`. `I64` results go through
  `napi_create_int64`, which makes a double: `fib(92)` already comes back rounded.
- C and C++ glue `#include`s the user's file into the glue translation unit, so it sees the real
  declarations. Rust gets a wrapper crate (`languages/rust/build.ts`) whose `extern "C"` functions
  cast to and from the boundary types; its glue is C with prototypes.
- The C++ glue is compiled with `/EHsc /std:c++17` (MSVC) and `-std=c++17` (gcc, clang): exceptions
  and `std::string_view` are available.
- Nothing catches a C++ exception or a Rust panic. Either one escaping through the Node-API boundary
  takes node down (Rust aborts on unwinding out of an `extern "C"` function since 1.81).
- The mapper emits one `export declare function` per function and nothing at the type level besides
  `number`, `boolean` and `void`.

## Measured

A probe addon built with the package's own `compileAddon`, in the session's scratchpad:

| What | Result |
| --- | --- |
| `napi_get_value_string_utf8` of `"héllo"` | 6 bytes, UTF-8 |
| … of `"a\0b"` | length 3, the NUL byte kept (`strlen` says 1) |
| … of a lone surrogate, `"\uD800x"` | `ef bf bd 78`: U+FFFD; the output is always well-formed UTF-8 |
| `napi_create_string_utf8` of bytes `61 ff 62 00 63` with an explicit length | a 5-character string: `a`, U+FFFD, `b`, U+0000, `c` |
| `napi_get_value_bigint_int64(2n ** 63n)` | status ok, `lossless` false; `napi_get_value_bigint_uint64` of the same: lossless true |
| … of `-1n` | int64 lossless, uint64 not |
| … of `2n ** 64n` | neither lossless |
| … of the number `5` | status 17, `napi_bigint_expected` |
| `napi_get_value_int32` of `2 ** 40`, `1.5`, `NaN` | 0, 1, 0, all status ok |
| … of `"1"`, `5n`, `true` | status 6, `napi_number_expected`; `napi_typeof` tells them apart (number 3, string 4, bigint 9, boolean 2) |
| `napi_create_bigint_int64(12586269025)` | `12586269025n`, with the headers' default `NAPI_VERSION`; the bigint API is `NAPI_VERSION >= 6` |

The tree-sitter node names below were read off parse trees of representative files with the pinned
grammars (tree-sitter-cpp 0.23.4, tree-sitter-rust 0.24.2), the same day.

## Goals

1. **A structured type model.** The walkers produce `NativeType` trees, not spellings. The model has
   a shape for everything a signature in the three languages can say about a value that matters for
   marshaling: integers with width and signedness, floats, booleans, code points, strings with
   ownership and nullability, structs, references, pointers, arrays, and "unknown". One predicate
   decides what this round marshals; everything else skips the function as today, but for a reason
   the model can name.
2. **Primitives, all of them.** Every fixed-width and standard integer type of C, C++ and Rust
   (`long`, `unsigned long`, `size_t`, `usize` included), `float`/`f32`, `double`/`f64`, `bool`, C's
   `char`s as integers, Rust's `char` as a one-character string.
3. **64-bit is lossless.** A 64-bit integer is a `bigint` on the way out. As a parameter it's typed
   `number | bigint`.
4. **Strict conversions.** A value that doesn't fit is an error, never truncated or wrapped. Wrong
   JavaScript type: `TypeError`. Right type, impossible value: `RangeError`. Messages name the function
   and the parameter or field path.
5. **Strings.** `const char*`, `std::string`, `const std::string&`, `std::string_view`, `&str`,
   `String`, `&String` as parameters; `const char*`, `std::string`, `const std::string&`,
   `std::string_view`, `String`, `&'static str` as results. UTF-8 both ways.
6. **Plain structs by value**, in and out, nested, with string fields, as TypeScript interfaces that
   rename and navigate the way functions do.
7. **Exceptions and panics become JavaScript `Error`s** carrying the message.
8. **The build half of `LanguageModule`.** A language provides a *bridge* that lowers its functions to
   C-ABI callees; the glue generator knows only that ABI. This is what part one deferred.
9. **Tests per rule:** walker level (one file per language), model and marshaling level, end to end.

## Non-goals (next rounds)

- Arrays, slices, vectors and byte buffers; pointers other than `const char*`; mutable references
  and out-parameters; enums, unions, tuple structs; `Option<T>`, `std::optional<T>`, `Result<T, E>`;
  wide and UTF-16 strings (`wchar_t`, `char16_t`, `char32_t`, `std::wstring`); 128-bit integers;
  classes with methods and `impl` blocks; following `#include`, `mod x;`, `use` or
  `using namespace`.
- Changing which functions are visible beyond what the new types make visible. Overloads, default
  arguments, `pub(crate)`, templates and generics stay as part one left them.
- Surfacing *why* a function was skipped. Open work item 2 (diagnostics) is where that goes; the
  model now carries the reason.

## Anti-goals

- A `number` that has silently lost bits. Not for 64-bit values, not for `int8_t`.
- A TypeScript type that depends on the OS. `long` is `bigint` on Windows too, where it is 32 bits
  wide: the type is the same everywhere; the runtime check uses the real width.
- Freeing memory the native code owns, or leaking memory the glue owns, on any path, errors included.
- The glue generator learning a language's idioms. If it ever writes `std::string` or
  `String::from`, a layer is leaking.
- A mapper diagnostic for anything in this design (they stop type checking).
- Any change to how a function is *found*. The walkers gain struct collection and type construction;
  part one's visitation rules stay.

## Constraints

- Everything in CLAUDE.md's Conventions and the mapper rules, and part one's constraints (`src/`
  runnable by type stripping, `.ts` imports, `Tree.delete()`, JavaScript string indices as offsets).
- `GLUE_VERSION` bumps: the generated code changes for every function.
- The glue stays compilable as C (C and Rust files) and as C++ (C++ files) with today's flags; the
  shared parts are the common subset, as today.
- Node ≥ 22.18 and the headers' default `NAPI_VERSION`: the bigint API is there (**measured**).
- A struct crossing into or out of Rust must not require `#[repr(C)]` or any attribute on the user's
  type.

## The type model

In `signatures.ts`, replacing `Kind`, `Param.type: string` and `NativeFunction.returnType`:

```ts
type NativeType = { spelling: string } & (   // the type as written, whitespace normalized: "unsigned long", "std::string_view", "isize", "&str"
  | { kind: "void" }
  | { kind: "bool" }
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean }
  | { kind: "float"; bits: 32 | 64 }
  | { kind: "char" }                        // Rust char: one Unicode scalar value
  | { kind: "string"; nullable: boolean }   // nullable: C's `const char*`, which may be NULL
  | { kind: "struct"; name: string }        // the TypeScript name; resolved in NativeModule.structs
  | { kind: "reference"; to: NativeType; mutable: boolean }
  | { kind: "pointer"; to: NativeType; const: boolean }
  | { kind: "array"; of: NativeType; length?: number }
  | { kind: "unknown" }
);

interface Field { name: string; nameStart: number; type: NativeType }
interface NativeStruct {
  name: string;        // the TypeScript name: unqualified
  nameStart: number;
  fields: Field[];
  path: string[];      // enclosing namespaces or modules, for resolution
  spelling: string;    // how the bridge names the type: `struct tag`, the typedef name, `geometry::Point`, `user::geo::Point`
}
interface Param { name: string; nameStart?: number; type: NativeType }
interface NativeFunction { name: string; nameStart: number; callee: string; params: Param[]; returns: NativeType; signature: string }
interface NativeModule { functions: NativeFunction[]; structs: NativeStruct[] }
```

- `bits` on an `int` is its *class*, what the TypeScript side sees. `long` is `bits: 64` on every
  platform; the bridge supplies the real C type and its limits (below).
- A `reference` with `mutable: false` to a marshalable type is marshalable as a parameter or a
  result, never as a field: the value crosses by value and the callee borrows the glue's copy for the
  duration of the call. That covers `const T&`, `&T`, `&str`, `&String`, and `&'static str` as a
  result. Mutable references, pointers (other than the `const char*` the walker already turned into a
  `string`), arrays and unknowns are not.
- `supported(type, module): boolean` is one function in `signatures.ts`; the walkers don't decide. A
  `struct` is supported when it is in `module.structs` (which holds only plain ones) and every field
  is supported, recursively. The registry (`languages/index.ts`) applies it: `parseModule(source,
  language)` returns the module with the functions whose parameters and result are all supported,
  filtered *before* the first-wins deduplication by name (so an unsupported first overload doesn't hide
  a supported second one, as today), and the structs that are supported; `findFunctions` stays as
  `parseModule(...).functions` for the tests and the hook.
- **The spelling stays on every type, and only a bridge reads it** **[call]** (the builder check found
  the gap). The shared code (`supported`, `jsType`, the glue generator) decides everything from
  `kind`, `bits`, `signed` and `nullable`; the bridges need the text: the C bridge looks `long` up for
  its C type and `LONG_MIN`/`LONG_MAX`, which no 64-bit class can recover, and the Rust wrapper must
  write `isize`, not `i64`, and tell `&str` from `String` from `&String`. For a wrapper type
  (`reference`, `pointer`, `array`) it's the whole text; for the `string` made from a pointer to
  `const char` it's `const char*`. The JSDoc keeps using the header verbatim, as before.

## What crosses, and how

| Native | TypeScript | As an argument or an incoming field | As a result or an outgoing field |
| --- | --- | --- | --- |
| Integers up to 32 bits: `char`, `signed char`, `unsigned char`, `short`, `unsigned short`, `int`, `unsigned`, `int8_t` … `uint32_t`, `i8` … `i32`, `u8` … `u32` | `number` | a number or a bigint; integral; within the C type's limits | `number` |
| 64-bit integers: `long`, `unsigned long`, `long long`, `unsigned long long`, `int64_t`, `uint64_t`, `size_t`, `ptrdiff_t`, `intptr_t`, `uintptr_t`, `i64`, `u64`, `isize`, `usize` | `bigint`; as a parameter `number \| bigint` | a safe-integer number or a bigint; within the C type's limits | `bigint` |
| `float`, `double`, `f32`, `f64` | `number` | any number, NaN and ±∞ included; `float`/`f32` round, overflowing to ±∞ | `number` |
| `bool`, `_Bool` | `boolean` | a boolean | `boolean` |
| Rust `char` | `string` | a string of exactly one Unicode scalar value | `string` |
| `const char*` | `string \| null` | a string without embedded NUL, or null | copied; NULL is `null`; never freed |
| `std::string`, `const std::string&`, `std::string_view`, `&str`, `String`, `&String`, `&'static str` | `string` | a string; NUL allowed | copied into a JavaScript string; the native copy the shim or wrapper made is freed |
| a plain struct `S`, `const S&`, `&S` | `S`, an exported `interface` | an object with every field present and converting | a fresh plain object |
| `void`, `()` | `void` | — | `undefined` |

The rules behind the table:

- **Integers take a bigint anywhere** at runtime **[call]**: it's one helper either way, and the
  TypeScript type (`number` for narrow integers) is what keeps call sites tidy, not the glue. A number
  must be finite and integral; for a 64-bit type it must also be a safe integer
  (`Number.isSafeInteger`), since anything larger has already lost bits. A bigint must convert
  losslessly (the `lossless` flag) and then fit the C type's limits.
- **The limits are the C type's own.** The generated code compares against `INT8_MIN`/`INT8_MAX`,
  `LONG_MIN`/`LONG_MAX`, `SIZE_MAX`, `CHAR_MIN`/`CHAR_MAX` and friends, never against numbers the
  generator wrote down. So `long` on Windows checks 32 bits and `char` is signed or unsigned as the
  platform says, while the TypeScript type is the same everywhere. The message prints the actual
  limits.
- **Two error classes.** Wrong `typeof` (`undefined` for a missing struct field, `null` for a
  non-nullable string, `null` or an array for a struct, a string for a number) → `TypeError`. Right
  type, impossible value (non-integral, out of range, an embedded NUL for `const char*`, a lone
  surrogate or two characters for a `char`) → `RangeError`. The message is
  `<function>(): <path> must be <what>`: `<path>` is the parameter name, or `p.center.x` for a field;
  `<what>` is like `an integer between -128 and 127`, `a number`, `a string`, `a string or null`,
  `a boolean`, `one character`, `an object with x, y`. Fewer arguments than parameters stays a
  `TypeError`; extra arguments are still ignored.
- **Strings are UTF-8.** Reading a JavaScript string gives well-formed UTF-8 with lone surrogates
  replaced by U+FFFD (**measured**), so Rust's `from_utf8` can't fail on glue input; the wrapper
  still checks and reports through the error slot rather than `unwrap`. A returned byte sequence that
  isn't valid UTF-8 comes back with U+FFFD in it (**measured**), not as an error. An embedded NUL
  can't go into a `const char*`, because the C side would see a shorter string: `RangeError`. It can
  go into the length-carrying types.
- **`const char*` is a pointer, so it's nullable**, both ways, and the type says so: `string | null`
  **[call]**. `std::string` and the Rust strings can't be null and are `string`. A returned
  `const char*` is borrowed: copied into a JavaScript string, never freed. A non-const `char*` in
  either direction stays a `pointer`, unsupported: whether it's an out-buffer or an owned string is
  the pointer design's question.
- **64-bit struct fields are `bigint`**, with no `number` convenience **[call]**: one interface, one
  truth, and hover shows the type a value comes back with. The alternative, a generated `In<T>`
  mapped type widening 64-bit fields in parameter position, was considered and dropped as a second
  name for the same shape; it's in "Deferred" if literals with `n` suffixes turn out to annoy. The
  runtime accepts a number in such a field, like everywhere.
- **C's `char` is a number**: it's an integer type in C, with `CHAR_MIN`/`CHAR_MAX`. Rust's `char` is
  a Unicode scalar value, so it's a one-character `string`. `wchar_t`, `char8_t`, `char16_t`,
  `char32_t` and `long double` are `unknown` for now.

## Plain structs

A struct is **plain** when:

- **C and C++:** a `struct_specifier` or `class_specifier` with a name, or the `type` of a
  `type_definition` whose `declarator` is a `type_identifier`, whose body (`field_declaration_list`)
  has only `field_declaration`s whose declarators are `field_identifier`s (`int x, y;` is two fields)
  without a `bitfield_clause`; and that has no `base_class_clause`, no `template_declaration` parent,
  no nested type, no `function_declarator` or `function_definition` or constructor `declaration`, no
  `friend`, `using` or `typedef`, and no `access_specifier` that leaves a field non-public (a `class`
  starts private, a `struct` public). A `default_value` (a C++ default member initializer) and a
  `static` member are allowed **[call]**: the glue assigns every instance field itself, so neither
  matters. A `pointer_declarator`, `array_declarator` or `reference_declarator` on a field yields the
  matching kind, which isn't supported, so the struct isn't either.
- **Rust:** a `struct_item` with a `visibility_modifier` of exactly `pub`, no `type_parameters`
  (lifetimes included) and a `field_declaration_list` (not an `ordered_field_declaration_list`, not a
  unit struct) whose every `field_declaration` has a `visibility_modifier` of exactly `pub`.
  `attribute_item`s before it don't matter. `pub(crate)` on the struct or on a field keeps it private,
  by part one's reasoning for functions. A `reference_type` field would need a lifetime parameter
  anyway; like a `pointer_type` or `array_type` field it yields a kind that isn't supported.

**Naming.** The TypeScript name is the unqualified name: `Point` for `geometry::Point`; the typedef
name for `typedef struct { … } Point;` and for `typedef struct tag { … } Point;` too (the tag resolves
to the same struct). Types and values are different declaration spaces in TypeScript, so a struct and
a function may share a name. Two plain structs with the same unqualified name (two namespaces, two
`mod`s): the first wins, and functions that use the second are skipped, like same-named functions
**[call]**. Concretely, `{ kind: "struct", name }` always means the winner, so a scoped resolution that
lands on the other struct yields `unknown` instead.

**Resolution.** A walker collects structs in a first pass over the same containers it visits for
functions, then functions in a second. In C++ an unqualified type name resolves innermost namespace
out, then global; `a::b::Name` is absolute. In C `struct tag` resolves by tag and a bare name by
typedef. In Rust an unqualified name resolves in the function's own module; `a::b::Name` relative to
that module, then from the crate root; `crate::` is absolute; `super::` is the parent. `use` and
`using` are not followed. The same file only: a type from a header or another module is `unknown`.

**Nesting.** A plain struct may have plain-struct fields, by value. None of the three languages lets a
struct contain itself by value, so no cycle check is needed beyond "resolves".

**Marshaling.** In: `napi_typeof` must be `object` and the value not `null`; each field is read with
`napi_get_named_property` and converted by its own rule, with the path extended (`p.x`); a missing
field reads as `undefined`, a `TypeError`; extra properties are ignored **[call]**. Out:
`napi_create_object` and one `napi_set_named_property` per field. String fields follow the string
rules; an owned string in a result struct is released once it has been copied.

**In the virtual TypeScript.** Every supported struct becomes `export interface Name { field: type; … }`
with its name and each field name mapped verbatim, so rename and go-to-definition work on them,
preceded by a one-line JSDoc naming the native declaration (`` `struct Point` from geometry.c ``).
Interfaces come before the functions, in source order **[call]**. A struct no exported function uses
is still exported: it's part of the module's type surface and costs nothing.

## The three layers

```
source --walker--> NativeModule --bridge--> C-ABI callees, prelude, libs --glue--> .node + .mjs
                        |
                        +--declarations--> the virtual .ts the mapper returns
```

The walker and the bridge belong to the language. The glue generator and the declarations are shared
and know only `NativeType` and the C ABI below.

### Walkers (`languages/*`)

`LanguageModule.functions(root, source)` becomes `parse(root, source): NativeModule`, returning every
plain struct and every function the visitation rules reach, typed; the registry filters. Two things
are added per language: struct collection and `NativeType` construction.

**C family** (`c-family.ts`; split a `c-types.ts` out if it grows past comfort):

- Struct collection walks the containers the function visit already walks (translation unit,
  `namespace_definition`, `linkage_specification`, the `preproc_*` branches) for `struct_specifier` and
  `class_specifier` with a `body`, standing alone or as the `type` of a `type_definition` whose
  `declarator` is a `type_identifier`. `path` is the enclosing namespaces; `spelling` is what the
  glue writes: in C `struct tag` or the typedef name, in C++ the qualified name.
- Type construction, for a `parameter_declaration`, a `field_declaration`, a `function_definition`'s
  `type` or the `type_descriptor` of a `trailing_return_type`: the base is the `type` node
  (`primitive_type`, `sized_type_specifier`, `type_identifier`, `qualified_identifier`,
  `struct_specifier` with a name), looked up by its *keyword set* in the table (so `long int`,
  `int long` and `long` are one entry; `std::` is stripped from the `<cstdint>` names and `size_t`),
  else resolved as a struct, else `unknown`. `type_qualifier` siblings, leading or trailing, give
  `const`. The declarator chain wraps it: `pointer_declarator`/`abstract_pointer_declarator` →
  `pointer`; `reference_declarator`/`abstract_reference_declarator` → `reference`, mutable unless the
  base is `const`; `array_declarator` → `array`. Exactly one `pointer` level around `const char`
  becomes `{ kind: "string", nullable: true }`; any other pointer stays a pointer. `std::string`
  and `std::string_view` are `string`, not nullable; `const std::string&` is a `reference` to one.
- The table serves the bridge too: spelling → `{ type, c, min, max }`, e.g. `long` →
  `{ int 64 signed, "long", "LONG_MIN", "LONG_MAX" }`, `size_t` → `{ int 64 unsigned, "size_t", "0",
  "SIZE_MAX" }`, `char` → `{ int 8 signed, "char", "CHAR_MIN", "CHAR_MAX" }`, `float` →
  `{ float 32, "float" }`.

**Rust** (`languages/rust/index.ts`):

- Struct collection: `struct_item`s in the `source_file` and in the `mod_item` bodies the function
  visit already descends. `path` is the module path; `spelling` is `user::<path>::Name`, for the
  wrapper.
- Type construction, for a `parameter`'s `type`, a `field_declaration`'s `type` or a `return_type`:
  `primitive_type` by table (`i8` … `i64`, `isize`, `u8` … `u64`, `usize`, `f32`, `f64`, `bool`,
  `char`; `str` only under a reference); `unit_type` → void; `type_identifier` and
  `scoped_type_identifier`: `String` and `std::string::String` → `string`, else struct resolution,
  else `unknown`; `reference_type` → `reference`, mutable with a `mutable_specifier`, and `&str` and
  `&String` → a reference to `string`; `generic_type`, `array_type`, `pointer_type`, `tuple_type` →
  their kinds or `unknown`. `i128` and `u128` are `unknown` **[call]**: MSVC has no 128-bit integer
  type for the ABI to use. A `reference_type` as the result is supported only with an explicit
  `'static` lifetime: an elided one (`fn f(s: &str) -> &str`) borrows from an argument the wrapper
  owns, and a named one already skips the function through its lifetime parameter.

### Bridges (`languages/*`), and the C ABI

`LanguageModule` gains the build half:

```ts
glue: "c" | "cpp";                        // the language of the glue translation unit
bridge(input: BridgeInput): Bridge;

interface BridgeInput { file: string; module: NativeModule; dir: string; compiler: Compiler; debug: boolean }
interface Bridge {
  /** Emitted into the glue after the ABI header: an #include, shim definitions, mirror typedefs, prototypes. */
  prelude: string;
  callee(fn: NativeFunction): Callee;
  /** Static libraries to link, in order. */
  libs: string[];
}
interface Callee { name: string; params: AbiType[]; returns: AbiType; reportsErrors: boolean }
type AbiType = { c: string } & (                 // c is the C type to declare a local or a member as
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean; min: string; max: string }   // min and max: limit macros or literals
  | { kind: "float"; bits: 32 | 64 } | { kind: "bool" } | { kind: "void" }
  | { kind: "char" }                             // uint32_t, a code point
  | { kind: "cstring" }                          // a raw `const char*`, nullable
  | { kind: "string" }                           // ts_polyglot_string, below
  | { kind: "struct"; name: string; fields: { name: string; member: string; type: AbiType }[] }
);
```

An `AbiType` carries what the glue needs and nothing it has to look up elsewhere: `bits` and `signed`
pick the reader and the maker; a struct's `name` is the TypeScript name, an identifier the reader and
maker functions are named after, while `c` is `struct tag`, `geometry::Point` or a mirror's typedef;
a field's `name` is the JavaScript property and `member` the C member, which a bridge may spell
differently when the field's name is a C keyword in its mirror (a Rust field called `long`).

The ABI header, which the glue generator emits at the top of every glue, in C that the C++ compiler
also accepts:

```c
typedef struct { char* ptr; size_t len; void (*release)(char*, size_t); } ts_polyglot_string;
```

One shape for strings in both directions. `release` is NULL for a borrowed string, which is every
argument the glue passes, and a function the bridge's code provides for a result, which is always
owned: a shim or wrapper copies even a `const std::string&` or `&'static str` result, because a
reference result may point at the shim's own argument (`const std::string& first(const std::string& s)`),
which dies when the shim returns. The glue copies the bytes into a JavaScript string and calls
`release` when it's set. The only borrowed result is the C bridge's raw `const char*` (`cstring`),
which has no shim to copy it and which the glue copies straight into the JavaScript string.

**The error slot.** A callee with `reportsErrors` takes one extra trailing parameter,
`ts_polyglot_string* error`, which the glue zeroes. If `error->ptr` is set after the call, the glue
throws an `Error` with that message (`napi_throw_error`), releases the message and any owned result,
and returns NULL. C callees have no slot.

**C** (`languages/c.ts`): `glue: "c"`; prelude `#include "<file>"`; the callee is the user's function
itself, with the user's own types (`long`, `struct Point`, `const char*` as `cstring`);
`reportsErrors: false`; no libs. Nothing is generated per function.

**C++** (`languages/cpp.ts`): `glue: "cpp"`; prelude: the `#include` and one `static` shim per
function in the same translation unit. The shim takes `ts_polyglot_string` for `std::string`-family
parameters and builds the real argument (`std::string(ptr, len)`, `std::string_view(ptr, len)`),
passes everything else through, calls the user's function inside `try`, copies any
`std::string`-family result into an owned `ts_polyglot_string` (its `release` a static function in
the TU), and turns `catch (const std::exception& e)` into `e.what()` in the slot and `catch (...)`
into `"<name>() threw an exception"`. A struct crosses as the user's own type unless a field,
transitively, is a `std::string`; then the shim converts to and from a `ts_polyglot_<Name>` mirror
declared in the prelude **[call]**. `reportsErrors: true` for every C++ function.

**Rust** (`languages/rust/bridge.ts`, today's `build.ts` renamed **[call]**): `glue: "c"`. It writes
`wrapper.rs`: `#[path] mod user;`; the ABI struct as `#[repr(C)]`; one `#[repr(C)] struct
ts_polyglot_<Name>` mirror per struct an exported function uses, with `From` conversions both ways
(`user::Point { x: m.x, … }`); an `extern "C" fn ts_polyglot_release(ptr, len)` that drops a
`Box<str>`; and per function a `#[no_mangle] pub extern "C" fn ts_polyglot__<name>(…, error: *mut
ts_polyglot_string) -> <abi>` that builds `&str`/`String` from `(ptr, len)` with
`std::str::from_utf8` (a failure goes to the slot), converts mirrors, calls `user::<callee>` inside
`std::panic::catch_unwind(AssertUnwindSafe(…))`, puts a panic payload (`&str` or `String`, else
`"<name>() panicked"`) in the slot, and returns the result lowered: integers, floats and `bool`
declared with the user's own spelling (`isize`, `i8`: every Rust integer type is FFI-safe, so the
`as` casts of today go away) with the C prototype naming the twin from the table (`intptr_t`,
`int8_t`), `char` as `u32`, `String` and `&'static str` as an owned `ts_polyglot_string` from
`into_boxed_str`, structs as mirrors. It runs `rustc` as today; `libs` are the static library and
the native libraries rustc lists. The prelude is the mirror typedefs and the prototypes. Rust's default panic hook still prints the panic to stderr
before the glue throws **[call]**: that's rustc's default and useful; a quiet hook is a later round.

### The glue (`glue.ts` and `marshal.ts`; `build.ts` keeps the cache)

Per module, in this order: the ABI header; the bridge's prelude; the conversion helpers, one block
of static C functions that is the same text in every glue: `ts_polyglot_read_int(env, value, min,
max, out, what)`, `ts_polyglot_read_uint(…)`, `_read_double`, `_read_bool`, `_read_char`,
`_read_cstring`, `_read_string` (two calls of `napi_get_value_string_utf8` into a malloc'd buffer
with its NUL), each throwing and saying so; a reader and a maker per struct (`ts_polyglot_read_<name>`,
`ts_polyglot_make_<name>`, generated from the `AbiType`'s `fields`, reading and writing each
`member`, extending `what` with the field path);
then per function the Node-API wrapper: the `argc` check, each argument into a local of the callee's
C type, the call (with the error slot when `reportsErrors`), the result into a `napi_value`, then the
release of owned strings in the result and the `free` of argument buffers. Every early return goes
through the same cleanup. `GLUE_VERSION` bumps.

The wrapper's shape is the same for every language; which callee it calls, with which C types, is
the bridge's answer. The generated `.mjs` is unchanged: interfaces have no runtime.

### Declarations (`declarations.ts`)

Per module: the JSDoc line and `export interface` per supported struct (name and fields verbatim),
then per function the `export declare function` with `jsType(type, position)` from `marshal.ts`:
`int` with `bits: 64` → `bigint`, or `number | bigint` in parameter position; `string` nullable →
`string | null`; `struct` → its name; `reference` → its target's type; the rest per the table.
`export {}` for a module with nothing.

## Layout

| Path | What |
| --- | --- |
| `src/signatures.ts` | `NativeType`, `supported`, `NativeStruct`, `NativeModule`, `NativeFunction`, `Param`, `Field`, `oneLine` |
| `src/marshal.ts` | the shared half that knows types: `jsType`, the ABI header, the conversion helpers' text, the struct reader and maker generators |
| `src/glue.ts` | the Node-API translation unit and the `.mjs`, from a `NativeModule` and a `Bridge` |
| `src/build.ts` | the cache key and directory; calls the language's `bridge` and `compileAddon` |
| `src/languages/language.ts` | `LanguageModule` with `parse`, `glue`, `bridge`; `Bridge`, `Callee`, `AbiType` |
| `src/languages/index.ts` | `parseModule`, `findFunctions`, `languageOf`, `loadLanguage` |
| `src/languages/c-family.ts` (and `c-types.ts` if split) | the walker: structs, types, the C spelling table with limits |
| `src/languages/c.ts`, `cpp.ts` | the two modules: the shared walker, their own bridges |
| `src/languages/rust/index.ts`, `rust/bridge.ts` | the walker and the wrapper crate |

## Example and fixtures

The e2e `project` fixture gains, per language, a function that takes and returns a string, one that
takes and returns a plain struct with a nested struct and a 64-bit field, and one that throws (C++)
or panics (Rust). `echo_long` stays, and its test changes: `2n ** 40n` round-trips on Linux and macOS
and is a `RangeError` on Windows. `main.ts` prints bigints as strings (`JSON.stringify` can't). The
example gains one string and one struct function per language and a `try`/`catch` showing a C++
exception as an `Error`, keeping the existing lines the LSP probe uses.

## Testing, and what counts as done

- **Walker tests** (`c.test.ts`, `cpp.test.ts`, `rust.test.ts`): every struct form above, plain and
  not; every spelling in the tables producing its `NativeType`; `const char*` → string and `char*`
  staying a pointer; `const T&` supported and `T&` not; resolution across namespaces and modules, and
  the first-wins collision; struct and field `nameStart` equal to `source.indexOf(...)`.
- **Model tests** (`signatures.test.ts`): `supported` for each kind, including a struct with an
  unsupported field and a function using a struct that isn't plain.
- **Marshal tests** (`marshal.test.ts`): `jsType` for every kind and position.
- **Declarations tests**: interfaces with verbatim spans identical on both sides; `bigint` fields;
  `string | null`; the JSDoc lines.
- **Bridge tests** (`rust.test.ts` and `cpp.test.ts`, or a `bridges.test.ts`): the wrapper text for
  a function with a string, a struct and the panic path; the prototypes; a C++ shim's text.
- **End to end** (`e2e.test.ts`, `pack.test.ts`): every row of the conversions table at runtime with
  the real compilers: `TypeError` and `RangeError`, with their messages, for a wrong type, a
  non-integer, an out-of-range `int8_t`, an out-of-range bigint, a NUL into `const char*`, a
  two-character `char`; `fib(50)` is `12586269025n`; a number and a bigint both accepted for a 64-bit
  parameter; non-ASCII, emoji, empty and NUL-containing strings round-trip through `std::string` and
  `String`; `null` in and `NULL` out for `const char*`; a struct round-trips with nested and string
  fields; a missing field is a `TypeError` naming `p.x`; a C++ `throw std::runtime_error("boom")` and
  a Rust `panic!("boom")` are `Error: boom`; the `long` platform test.
- `npm run typecheck`, `npm test`, `npm run example`, the LSP probe (hover shows `bigint` and the
  interface) and `npm run test:linux` pass; CI's matrix is unchanged.
- Budget: the example's addons compile in under twice today's time; no change at import time
  (nothing here runs then).
- Docs: CLAUDE.md's layout table and open work item 3 rewritten (what's left is the Non-goals list);
  the "Adding a language" convention gains the bridge; both READMEs get the conversions table and the
  two error classes; the template README's sentence about types; CHANGELOG under
  `### 0.3.0 (unreleased)` in both sections, stating the behavior changes: 64-bit results are
  `bigint`, conversions are strict, exceptions are errors.

## Deferred

- Carried from part one: languages in one package or several (a module is now grammar + walker +
  bridge, which fits either); default arguments as optional parameters; lifetime-only generics;
  `pub(crate)`.
- Everything in Non-goals, in roughly the order demand is expected: arrays, vectors, slices and
  `Uint8Array` buffers; `Option` and `std::optional` as `T | undefined`; enums; out-parameters through
  `&mut T` and `T*`; following `use`, `using` and `#include`; wide strings; 128-bit integers through
  `napi_*_bigint_words`.
- `In<T>` for struct parameters, if `bigint` literals in object literals annoy.
- Surfacing why a function was skipped (open work item 2).
- A quiet Rust panic hook.
