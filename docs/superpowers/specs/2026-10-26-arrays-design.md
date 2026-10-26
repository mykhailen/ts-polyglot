# Arrays: design

2026-10-26. Part three of the parser work: sequences cross between TypeScript and C, C++ and Rust.
Part two (`2026-10-25-types-and-marshaling-design.md`) built the type model, the bridges and the
strict glue for primitives, strings and plain structs, and listed arrays first among what was left.
This round adds counted sequences of anything the glue already marshals, nested to any depth, in both
directions; byte buffers as `Uint8Array`; fixed-length arrays; and C's pointer-and-length idiom, in
its array spelling.

The owner's direction: arrays next; in C, recognize the array spelling only, with no guessing from
parameter names; the calls below stand unless flipped. Items marked **[call]** are mine and
reversible; facts marked **measured** were observed on this machine on 2026-10-26 with Node 22.21.1
and MSVC 2022.

## Where things stand

- `NativeType` has `{ kind: "array"; of; length? }` and the walkers already produce it: a C `T x[N]`
  or `T x[]` declarator and a Rust `[T; N]` or `[T]` become `array`, with `length` when the size is a
  decimal literal. Any other size (`0x10`, `N`, `2 + 1`) is recorded as an *unsized* array, which is
  wrong. `supported()` rejects every array, so no function with one is visible. `std::vector` is
  `unknown`, like every template.
- `AbiType` has no sequence kind. The glue reads and makes scalars, strings and structs, and
  `cleanup` frees the copies it made for an argument; makers release what the native side owned.
- The C bridge calls the user's function directly, with no error slot. The C++ bridge wraps every
  function in a shim that has one, and mirrors structs that hold text. The Rust bridge mirrors every
  struct and wraps every function.
- `jsType` has no array case, and `declarations.ts` prints one TypeScript parameter per native one.

## Measured

A probe addon built with `compileAddon`, and parse trees from the pinned grammars, both in the
session's scratchpad (`arrays-spike/`):

| What | Result |
| --- | --- |
| `napi_is_array` | true for an `Array`, an `Array` subclass instance and an array from another realm; **false for a `Proxy` of an array** (`Array.isArray` says true), and for typed arrays, `arguments`, array-likes and `Set` |
| `napi_get_array_length` of a Proxy, a typed array or an array-like | status 8, `napi_array_expected` |
| `napi_get_element` of a hole (`[1,,3]`) or past the end | ok, `undefined` |
| `napi_get_element` where index 1 has a throwing getter | fails with the exception pending; every later call fails too, as `napi_get_named_property` did in part two |
| `napi_get_typedarray_info`'s `data` | already offset: a `subarray(2, 5)` points at byte 2; `Buffer.from([1, 2, 3])` lives at offset 1192 of an 8192-byte pool and `data` points at the 1 |
| … of an empty typed array | length 0, `data` NULL |
| … of a view on a detached buffer | ok, length 0, `data` NULL; `napi_is_detached_arraybuffer` of its buffer is true |
| … of a length-tracking view on a resizable buffer; of a `SharedArrayBuffer` view | the current length; works |
| `napi_is_buffer` | true for every typed array and for `DataView`, so it says nothing; `napi_is_typedarray` plus the type does: `Buffer` is `napi_uint8_array` (1), `Int8Array` 0, `Uint8ClampedArray` 2, `Float64Array` 8, `BigInt64Array` 9 |
| `napi_create_arraybuffer` + `napi_create_typedarray(napi_uint8_array)` | a plain `Uint8Array`, `Buffer.isBuffer` false; `napi_create_buffer_copy` makes a `Buffer` |
| 1,000,000 numbers in, `napi_get_element` + `napi_get_value_double` each | 37 ms; the same numbers out, `napi_create_array_with_length` + `napi_set_element`: 61 ms |
| 1,000,000 doubles summed through a `Float64Array`'s data pointer; 1,000,000 bytes made as a `Uint8Array` | 0.6 ms; 0.4 ms |

Parse trees (tree-sitter-cpp 0.23.4, tree-sitter-rust 0.24.2; tree-sitter-c the same shapes):

| Spelling | Shape |
| --- | --- |
| `int xs[4]` field, `const float v[3]` parameter | `array_declarator declarator: (field_identifier or identifier) size: (number_literal)` |
| `const double xs[]` parameter | `array_declarator` with no `size`; `const double* xs` is a `pointer_declarator`, so the two are told apart |
| `const char* tags[3]` | `pointer_declarator (array_declarator …)`: an array of pointers, which `declared()` already orders right |
| `int grid[2][3]` | `array_declarator (array_declarator … size: 2) size: 3` |
| `const char* const names[]` | `pointer_declarator (type_qualifier) (array_declarator …)` |
| `const double m[][3]` | `array_declarator (array_declarator …) size: 3` |
| `char name[MAX]`; `int xs[2 + 1]` | `size: (identifier)`; `size: (binary_expression)` |
| C++ `std::vector<int>` | `qualified_identifier scope: (namespace_identifier) name: (template_type name: (type_identifier) arguments: (template_argument_list (type_descriptor …)))` |
| `std::array<float, 3>` | the same, the arguments `(type_descriptor …) (number_literal)` |
| `vector<int>` after `using std::vector` | a bare `template_type` |
| `std::span<const int>` | a `template_type` whose `type_descriptor` carries a `type_qualifier` |
| Rust `&[i32]` | `reference_type type: (array_type element: (primitive_type))`, no `length`; `&mut [i32]` adds `(mutable_specifier)`, `&'static [u8]` adds `(lifetime)` |
| `Vec<i32>`, `Vec<Vec<String>>` | `generic_type type: (type_identifier) type_arguments: (type_arguments …)`, nested; `std::vec::Vec<i32>` has a `scoped_type_identifier` as `type` |
| `[f32; 3]` | `array_type element: … length: (integer_literal)`; `[f32; N]` has `length: (identifier)`, `[f32; 2 + 1]` a `binary_expression` |
| `&[&str]` | `array_type element: (reference_type …)` |
| `const N: usize = 4;` | `const_item name: (identifier) type: … value: (integer_literal)` |

## Goals

- Sequences cross by value, as parameters, results and struct fields: Rust `Vec<T>`, `&[T]`,
  `&Vec<T>`, `[T; N]`, `&[T; N]` and `&'static [T]` results; C++ `std::vector<T>` and
  `std::array<T, N>`, by value or by const reference, and C-style arrays; C arrays as struct fields and
  as `const T xs[]` parameters with a length parameter. `T` is anything the glue marshals, arrays
  included, so `Vec<Vec<String>>` and `std::vector<Point>` come along.
- TypeScript sees `T[]`, a tuple for a fixed length and `Uint8Array` for bytes, and a C length
  parameter disappears from the signature.
- The checks stay strict and the messages keep the path: `xs[2] must be an integer between …`,
  `pts[0].x`, `p.pos[1]`.
- Ownership stays where part two put it: the glue frees what it allocated after the call, the native
  side's results are released through the ABI, nothing leaks on any path, errors included.
- A million numbers cost tens of milliseconds a direction and a million bytes well under one
  (**measured**), and the generated code for a file without arrays is unchanged apart from the
  glue version.

## Non-goals (next rounds)

- Writing back: `&mut [T]`, `std::vector<T>&`, non-const C arrays, `T* out, size_t* len`; zero-copy
  results through external array buffers.
- Typed arrays other than `Uint8Array`; a `number[]` parameter taking a `Float64Array`.
- `std::span`, `std::deque`, `std::list`, `std::map`, `std::set`, `std::pair`, `Box<[T]>`, `Rc<[T]>`,
  `Cow`, `HashMap`, iterators, `Option<Vec<T>>`, tuples, `&[&str]`.
- `vector<int>` after `using std::vector` or `using namespace std`; `std::vector<char>` as text (it
  is `number[]`).
- Sizes from expressions (`[N * 2]`, `[1 << 4]`), from enum constants, or from names defined in
  another file; multi-dimensional unsized C parameters (`double m[][3]`); a C array with no length
  parameter, or whose length comes earlier without the C99 spelling; variable-length arrays.
- Wide strings; strings as arrays of code points; `In<T>` for struct parameters.

## Anti-goals

- A silent mis-mapping: a pointer taken for an array, a flag taken for a length, an unsized array
  for a size the walker couldn't read. In doubt, the function is hidden, as part one and two do.
- Native code holding a JavaScript buffer past the call, or writing to one.
- The glue learning an idiom. It never sees a `char[32]`, a decayed pointer or a NUL terminator;
  those are the bridges' to convert, as `std::string` is.
- A byte buffer copied twice, or a `number[]` of a million elements refused for being slow.
- Part two's anti-goals: lost bits, OS-dependent TypeScript types, leaks, mapper diagnostics.

## Constraints

- Everything in CLAUDE.md's conventions, and part one's and part two's constraints.
- `GLUE_VERSION` bumps: the ABI header grows.
- The ABI stays C: the shared parts compile as C for C and Rust files and as C++ for C++ files.
- The C++ flags stay C++17 (`std::span` would need 20).
- A Rust user type still needs no attribute.

## The type model

`signatures.ts`:

```ts
| { kind: "string"; nullable: boolean; max?: number }   // max: a bound in UTF-8 bytes, for a C char[N]
| { kind: "array"; of: NativeType; length?: number }    // unchanged: length is a fixed size; absent, any length

export interface Param {
  name: string; nameStart?: number; type: NativeType;
  /** C and C++ only: the parameter that carries this array's length. The bridge fills it; TypeScript never sees it. */
  length?: { name: string; type: NativeType };
}

/** The parameters JavaScript passes: every one that isn't another's length. The glue and the declarations use this list; a bridge's shim walks the full one. */
export function visibleParams(fn: NativeFunction): Param[];
```

The length parameter stays in `NativeFunction.params` at its native position, so `signature` and
the shim's call keep the native order (`mean99(size_t n, const double xs[n])` is called as
`mean99((size_t)xs.len, (const double*)xs.ptr)`); `visibleParams` is the one place that hides it,
and `Callee.params` aligns with it. That is the round's one cross-cutting interface change: the three
bridges, `glue.ts` and `declarations.ts` all move to the visible list **[call]**.

`supported()` gains one case: an `array` is supported when `of` is, and `of` is not a `reference`.
Everything a language can't do with an array (a C flexible member, a result array in C, a size that
isn't readable) is the walker's to turn into `unknown`: the predicate stays language-blind, as it is.

**Sizes.** A size is an integer literal in any base, with Rust's `_` separators and either
language's suffixes (`16u`, `32UL`, `4usize`), or a name the same file defines as one: C and C++
`#define N 32`, `const int N = 32;`, `constexpr size_t N = 32;` at file scope or in the enclosing
namespace; Rust `const N: usize = 32;` at file scope or in the enclosing module **[call]**. Anything
else, an expression, a name from another file, an `enum` member, makes the type `unknown`, never an
unsized array. `[0]` is `unknown` too.

## What crosses, and how

| Native | TypeScript parameter | TypeScript result or field |
| --- | --- | --- |
| Rust `Vec<T>`, `&[T]`, `&Vec<T>`; C++ `std::vector<T>`, `const std::vector<T>&`; C `const T xs[]` + length | `readonly T[]` | `T[]` (a Rust `Vec<T>` or `&'static [T]`, a C++ `std::vector<T>`; a C function can't return one) |
| Rust `[T; N]`, `&[T; N]`; C++ `std::array<T, N>` (by value or const reference), `T x[N]` field; C `const T v[N]` parameter, `T x[N]` field | `readonly [T, T, …]`, N entries | `[T, T, …]` |
| …where `T` is `u8`, `uint8_t` or `unsigned char` | `Uint8Array` | `Uint8Array` |
| C and C++ `char name[N]` field or parameter | `string`, at most N − 1 bytes, no NUL | `string`, up to the first NUL |
| C and C++ `const char s[]` + length | `string`, NUL allowed | — |

`T` is the element's own type in that position: `bigint[]` out and `readonly (number | bigint)[]`
in for 64-bit integers, `(string | null)[]` for `const char*` elements, `Point[]` for structs,
`number[][]` for `Vec<Vec<f64>>`, `[number, number][]` for `Vec<[f32; 2]>`.

- **Only `Uint8Array` is bytes** **[call]**: unsigned 8-bit elements, in every language. `char`,
  `signed char`, `int8_t` and `i8` elements are numbers. A `Uint8Array` parameter takes any
  `Uint8Array`, a `Buffer` included, since it is one (**measured**: type 1); it rejects
  `Int8Array`, `Uint8ClampedArray`, `ArrayBuffer`, `DataView` and `number[]` with a TypeError, and a
  view on a detached buffer with its own TypeError. On the way in, the bytes are copied: the pointer
  Node-API gives is already at the view's offset (**measured**), but a getter run while a later
  argument is read could detach or resize the buffer before the call, so lending it is not safe
  (the review found this; the first draft lent it). On the way out, the bytes are copied into a
  fresh `ArrayBuffer` and come back as a plain `Uint8Array`, not a `Buffer` **[call]**: the type
  says `Uint8Array`, and `Buffer.from(u8.buffer, u8.byteOffset, u8.length)` views it without a copy.
- **A fixed length is a tuple** **[call]**: `[number, number, number]` for `[f32; 3]`, so the length
  is checked at compile time, and `readonly` in parameter position. At runtime a wrong length is a
  RangeError: `v must have 3 elements` (`key must have 16 bytes` for bytes). No cap on N: TypeScript
  prints a 16-tuple for `double m[16]`, and a `uint8_t hash[32]` is a `Uint8Array` anyway.
- **Parameters are `readonly`** **[call]**: `readonly number[]` accepts a `number[]`, a tuple and a
  `readonly` array, and says what the native side can't do. It goes all the way down, since the
  element type is the element's own type in parameter position: `readonly (readonly number[])[]`
  for `Vec<Vec<f64>>`, which accepts every mix of mutable and readonly rows. Results and interface
  fields are plain `T[]`: a result is a fresh array the caller owns, and a field type has to serve
  both directions.
- **`char name[N]` is a string** **[call]**, since that is what it is in every C struct that has one:
  at most N − 1 UTF-8 bytes and no NUL on the way in (a RangeError otherwise: `name must be at most
  31 UTF-8 bytes without NUL characters`; a non-string is the usual TypeError), and the bytes up to
  the first NUL, or all N, on the way out. `const char s[]` with a length parameter is a counted
  string: NUL is allowed, and the C function gets the pointer and the byte count.
- **Arrays of arrays** cross as arrays of ABI arrays, each element its own allocation, so
  `Vec<[f32; 2]>` is `[number, number][]` and `std::vector<std::vector<int>>` is `number[][]`. The
  one exception is inside a C or C++ struct, where `int grid[2][3]` is inline storage: the bridge's
  mirror conversion copies the nested ABI arrays into it and out of it.
- **Elements can't be references**, so `&[&str]` hides the function; `&[String]` and `Vec<&'static
  str>` don't exist as idioms worth the wrapper code. Elements can't be `unknown` or pointers either,
  except `const char*`, which is already a nullable string.
- **Mutable forms stay out.** `&mut [T]` is a mutable reference (already unsupported); a C++
  `std::vector<T>&` likewise; a C array parameter whose elements the function could write hides it:
  the element type must be `const`, or a pointer to `const` (`const double xs[]`, `const char*
  names[]`, `const char* const names[]` all pass; `double xs[]` doesn't).

### Conversions

In, for an array parameter or field (not bytes): `napi_is_array` must say yes, else TypeError
`xs must be an array`. A `Proxy` of an array isn't one (**measured**); nor is a typed array, an
`arguments` object or a `Set`. The length comes from `napi_get_array_length`; a fixed length is
checked before any element is read. The glue allocates `len` elements (zeroed, so cleanup is safe at
any point), records them in the ABI array *before* reading, then reads element `i` with the element's
own reader and the path `xs[i]`: a hole is `undefined` and fails that reader's type check; a throwing
getter propagates its own error, as it does for a struct field. In, for bytes: `napi_is_typedarray`,
the type must be `napi_uint8_array`, the buffer must not be detached; the ABI array points at the
view's data with `release` NULL.

Out: a fresh `Array` of the right length filled element by element through the element's maker, or a
fresh `Uint8Array` with the bytes copied in. Then the ABI array is released (its `release`, if set),
after its elements were, innermost first; a string element's maker already releases it, as today.

Strings into a `char[N]`: the glue's string reader with `max` set rejects more than `max` bytes and
any NUL, with the RangeError above, and the glue's own copies are always NUL-terminated after `len`
(they are today: `napi_get_value_string_utf8` writes one; the C++ `ts_polyglot__own` writes one; this
makes it a rule), so a bridge can hand a checked string to C as a C string.

### The C length rule

In C and C++, a parameter spelled as an unsized array, `const T xs[]`, is a sequence whose length is
another parameter:

- **The next integer parameter after it.** Unsized array parameters in a row share the one that
  follows them: `double dot(const double a[], const double b[], size_t n)`. With a shared length the
  arrays must agree, else `dot(): b must have as many elements as a`. The length parameter's type is
  any integer type; an array longer than it holds is `mean(): xs has more elements than int holds`.
- **Or the parameter the size names**, C99 style: `double mean(size_t n, const double xs[n])`, and
  `const double xs[n], size_t n` just the same. A size naming anything but an integer parameter
  follows the size rules above.
- Both come back through the error slot, so they are plain `Error`s, like an exception **[call]**;
  a RangeError would need the glue to know which parameters pair, and it doesn't.
- A sized array parameter, `const float v[3]`, is a fixed array and consumes no length parameter.
- An unsized array parameter with no length, `void f(const int xs[])`, is `unknown`. So is
  `const double* xs, size_t n`: a pointer stays a pointer, and the function is hidden, per the
  owner's decision. So is `double m[][3]`. A C function can't return an array, and a flexible
  array member (`int xs[]` as the last field) is `unknown` too.

The length parameter leaves the TypeScript signature: `mean(xs: readonly number[]): number`. It is
still in the JSDoc line, which quotes the native signature, and it has no verbatim span, so it can't
be renamed from TypeScript.

## The ABI

```c
typedef struct { void* ptr; size_t len; void (*release)(void*, size_t); } ts_polyglot_array;
```

- `ptr` points at `len` contiguous elements of the element's C type: `int32_t`, `ts_polyglot_string`,
  `ts_polyglot_array` for nested arrays, the struct's own C type or its mirror. The element type is
  static: the `AbiType` says it, so the glue casts.
- Ownership follows `ts_polyglot_string`. A buffer the glue made has `release` NULL; the glue frees it
  and what it holds after the call. A result the native side made carries a `release` the glue calls
  once the JavaScript value exists, after releasing the elements. Bytes are copies too, both ways.
- Empty: the glue's own buffers are never NULL (one element is allocated for an empty array, so a C
  function never sees a NULL it didn't ask for), but a result can be NULL with `len` 0. Every reader
  of a `ts_polyglot_array`, on either side, treats a NULL `ptr` as empty whatever `len` says.
- `release` is called whenever it is set, `len` 0 included: a Rust `Box<[T]>` of nothing still has
  to be dropped.

`AbiType` gains:

```ts
| { kind: "string"; max?: number }                   // max: reject more UTF-8 bytes than that, and any NUL
| { kind: "array"; of: AbiType; length?: number }    // c is "ts_polyglot_array"; of says what ptr points at
```

Bytes are an `array` whose `of` is `{ kind: "int", bits: 8, signed: false }`, and the glue picks the
typed-array path from that. `char` is signed in the C table and Rust's `i8` is signed, so a
`std::vector<char>` or a `Vec<i8>` is a `number[]`, never bytes.

## The three layers

### Walkers (`languages/*`)

**C-family (`c-family.ts`).** `declared()`'s array case parses the size by the rules above (a
`sizes` helper shared with Rust, `parseIntegerLiteral`, lives in `signatures.ts`), looking names up
in a `Constants` collection the walker fills from `preproc_def`, `const` and `constexpr` declarations
as it collects structs. Then, by context:

- A field: `T x[N]` is `array`; `char x[N]` (plain `char` only) is `string` with `max: N - 1`, so
  `char names[4][16]` is an array of four bounded strings; `T x[]` is `unknown`. The `const char*`
  rule applies to elements too: `const char* tags[3]` is an array of nullable strings.
- A parameter: `const T xs[]` pairs with a length parameter by the C length rule and becomes `array`
  with `Param.length` set, or `unknown` when nothing pairs; `const char s[]` paired is `string`;
  `const T v[N]` is `array` with `length`; `const char v[N]` is `string` with `max`; a non-const
  element type is `unknown`. Pairing happens in `parameters()` after every parameter's type is known.
- A result: never an array (C syntax can't), so nothing changes.
- C++ templates in `namedType()`: `std::vector<T>` is `array` of `T`, `std::array<T, N>` is `array`
  with `length`, where `T` goes through the same resolution as a field type, and anything else that
  is a template stays `unknown`. Qualified only: `vector<int>` is `unknown`.

**Rust (`rust/index.ts`).** `typeOf()`: `Vec<T>` and `std::vec::Vec<T>` are `array` of `T`; an
`array_type` with a `length` is `array` with it (the size rules, with a `Constants` collection of
`const_item`s), without one it is `array` unsized (a slice, only ever behind a reference); the
rest as today: `&[T]` is `reference` to it, `&mut` is mutable, a reference result without
`'static` is `unknown`. `Box<[T]>` and `Option<Vec<T>>` stay `unknown`.

### Bridges (`languages/*`), and the C ABI

The rule from part two generalizes: a bridge mirrors a struct the glue can't write directly, and
shims a function whose signature the glue can't call directly. For C++ that was text; now it is
text, arrays, and `char[N]`.

**C (`c.ts`).** Grows what C++ has, in C: a prelude with `ts_polyglot__release`, `ts_polyglot__own`
(an owned copy of bytes) and `ts_polyglot__own_array` (an owned copy of `n` elements of `size`
bytes); a mirror typedef with `ts_polyglot__from_<Name>` and `ts_polyglot__to_<Name>` for every
struct that holds an array or a `char[N]`, directly or in a struct it holds; and a shim,
`static <ret> ts_polyglot__shim_<name>(<params>, ts_polyglot_string* error)` with `reportsErrors:
true`, for every function with an array parameter, a `char[N]` parameter, or a mirrored struct in
its signature. Everything else calls the user's function directly, as today. In the shim:

- a sequence `const T xs[]` with its length `n`: `xs.ptr` cast to `const T*`, and `(n_type)xs.len`,
  after the shared-length and overflow checks, which set the slot (`ts_polyglot__own` of the message)
  and return zero (`{0}` for a struct, `NULL` for a `const char*`);
- a fixed `const T v[N]`: `v.ptr` cast; the glue has checked the length;
- either of those when the elements need converting, a mirrored struct or a fixed array of arrays
  (`const struct Poly polys[]`, `const int m[2][2]`): a temporary in the shim, on the stack for a
  fixed array and `malloc`ed for a sequence (a failed allocation sets the slot), filled element by
  element with the same conversion the mirrors use, passed to the user, and freed after the call,
  which in C has no other way out **[call]**. C stays as wide as C++ here; the C++ shim does the
  same through its templates;
- a `char[N]` or `const char s[]`: `s.ptr`, NUL-terminated and checked by the glue, with `s.len` for
  the counted form;
- a mirrored struct: `ts_polyglot__from_<Name>(m)` in, `ts_polyglot__to_<Name>(r)` out. The `from`
  copies ABI arrays into inline storage (`memcpy` for a fixed array of plain elements, a loop for
  nested ones, `memcpy` plus a NUL for `char[N]`); the `to` makes owned copies the other way
  (`ts_polyglot__own_array`, `ts_polyglot__own` up to `strnlen(v.name, N)`). A `const char*` element
  is copied as a pointer, borrowed as it is today.

The C and C++ bridges now have the same shape, so the builder may extract the shared generator
(mirrors, shims, slot naming) into `c-family-bridge.ts` with a dialect for the syntax that differs
(`T{}` against `{0}`, casts, references); CLAUDE.md's "Adding a language" stays true either way.

**C++ (`cpp.ts`).** `holdsText` becomes `needsMirror`: text, arrays or `char[N]`. The shim converts
`std::vector<T>` and `std::array<T, N>` with a small template family in the prelude,
`ts_polyglot__from<T>(const ts_polyglot_array&)` and `ts_polyglot__to(const T&)`, specialized for
the ABI scalars, strings, mirrored structs and recursively for vectors and arrays, so nested
containers need no generated name per depth; `std::vector<bool>` goes through the element loop like
everything else (no `data()`). C-style array parameters and `char[N]` are handled as in C. A
`std::vector<T>` result is copied into an owned ABI array; `std::string_view` elements of a parameter
vector view the glue's strings, which outlive the call.

**Rust (`rust/bridge.ts`).** The preamble gains the `#[repr(C)]` twin of `ts_polyglot_array` and three
generic helpers: `ts_polyglot_slice<T>(&ts_polyglot_array) -> &[T]` (NULL is empty),
`ts_polyglot_own_list<T>(Vec<T>) -> ts_polyglot_array` (a `Box<[T]>` with a `release` monomorphized
for `T`: `ts_polyglot_release_list::<T>`, a generic `unsafe extern "C" fn`, which Rust allows without
`#[no_mangle]`), and `ts_polyglot_borrow_list<T>(&'static [T])` (release `None`). `argument`,
`lower`, `fromMirror` and `toMirror` recurse through arrays with the element's conversion: a `&[T]`
of plain elements is the slice itself, no copy; `&[String]` builds the `Vec` and borrows it; `Vec<T>`
builds one; `[T; N]` is `.try_into().unwrap()` on the built slice, which the glue has sized; a `Vec<T>`
result is `ts_polyglot_own_list` of the elements converted; a `&'static [T]` result of plain elements
is borrowed, of converted ones owned. Mirror fields of array type are `ts_polyglot_array`, converted
in `From` both ways. Element strings in a `From` decode lossily, as part two ruled for fields.

### The glue (`glue.ts` and `marshal.ts`)

- The ABI header gains the typedef. `HELPERS` gains the bytes reader and maker
  (`ts_polyglot_read_bytes`, `ts_polyglot_make_bytes`), an `ts_polyglot_alloc(n, size)` that never
  returns NULL for `n` 0 and reports `can't allocate n elements` when it fails, and a `max` argument
  on `ts_polyglot_read_string`.
- For every distinct array type reachable from the callees (parameters, results, struct fields,
  nested), one reader and one maker: `ts_polyglot_read_array_<id>` and `ts_polyglot_make_array_<id>`.
  The `<id>` tells element types apart by what the helper depends on, which is the element's
  `AbiType`, not its class: the C spelling, sanitized (`int64_t`, `long`, `unsigned_long`, `double`),
  since `long` and `int64_t` share a class but not a size on Windows and `char` and `int8_t` not
  their limits on arm64; the kind where the spelling is shared (a code point and a `uint32_t` are
  both `uint32_t`); `max` for a bounded string; the length in front for a fixed array; and the inner
  id for a nested one. The exact strings are the builder's; two parameters of the same type share a
  helper, and `const long xs[]` and `const int64_t ys[]` never do. They call the element's reader and
  maker through `readArgument` and `makeResult`, which gain the `array` case, with the path
  `"%s[%u]"`. Fixed-length bytes get a reader that checks the length and then
  `ts_polyglot_read_bytes`.
- The wrapper counts and reads `visibleParams(fn)`, one per `Callee.params` entry, as it counted
  `fn.params` before.
- Prototypes for every struct and array helper come first, then the definitions, so order doesn't
  matter and an array of structs of arrays compiles.
- `cleanup` gains `array`: each element's cleanup, then `free(ptr)`; bytes: nothing, the buffer is
  JavaScript's. Makers release what they made the value from, as today.
- A struct named `array_i32` collides with a helper, like the `string` and `uint` collisions
  already deferred; the glue should refuse those names one day, not this round.

### Declarations (`declarations.ts`)

`jsType` prints `readonly T[]` or `readonly [T, …]` in parameter position, `T[]` or `[T, …]`
otherwise, `Uint8Array` for bytes, parenthesizing a union or a nested readonly element (`readonly
(number | bigint)[]`, `readonly (readonly number[])[]`), and `string` for a bounded or counted string.
The functions print `visibleParams(fn)`: a length parameter is skipped and gets no span. Interfaces
print fields the same way.

## Layout

| Path | Change |
| --- | --- |
| `src/signatures.ts` | `max` on strings, `Param.length`, `visibleParams`, `parseIntegerLiteral`, `supported` for arrays, `structsInDependencyOrder` through `array.of` |
| `src/languages/language.ts` | `AbiType`: `array`, `max` on `string` |
| `src/languages/c-family.ts` | sizes and constants, fields, the C length rule in `parameters()`, templates in `namedType()` |
| `src/languages/c-types.ts` | `cAbi` for arrays and bounded strings |
| `src/languages/c.ts`, `cpp.ts` (or a shared `c-family-bridge.ts`) | mirrors and shims for arrays and `char[N]`; C grows a prelude and an error slot |
| `src/languages/rust/index.ts`, `types.ts`, `bridge.ts` | `Vec`, slices, arrays, constants; `rustAbi`; the generic helpers and recursive conversions |
| `src/marshal.ts` | the typedef, bytes helpers, `max`, array readers and makers, `jsType`, `cleanup` |
| `src/glue.ts` | helper collection and prototypes-first emission; the wrapper over `visibleParams` |
| `src/declarations.ts` | `visibleParams` for the parameter list |
| `src/build.ts` | `GLUE_VERSION` |
| `test/fixtures/project/vectors.{c,cpp,rs}`, `main.ts` | the fixtures below |
| `examples/native-demo/` | one array call per language |
| README, package README, CLAUDE.md, CHANGELOG | the table of what crosses, the C length rule, limits, open work |

## Example and fixtures

Fixtures (`test/fixtures/project/`), each with a negative or two that must stay hidden:

- `vectors.c`: `double mean(const double xs[], size_t n)`, `double dot(const double a[], const
  double b[], int n)`, `double mean99(size_t n, const double xs[n])`, `uint32_t checksum(const
  unsigned char data[], size_t len)`, `const char* longest(const char* const names[], int n)`,
  `size_t count_a(const char s[], size_t n)` (NUL inside allowed), `float norm(const float v[3])`,
  `#define POLY_NAME_MAX 16` (not `NAME_MAX`, which glibc's `<limits.h>` defines first) with `struct
  Poly { struct Point pts[4]; char name[POLY_NAME_MAX]; unsigned char key[4]; int grid[2][2]; }`,
  `double area(struct Poly p)`, `struct Poly relabel(struct Poly p, const char* name)`, `int
  total_pts(const struct Poly polys[], size_t n)` and `int trace(const int m[2][2])` (the temporary
  path); hidden: `void scale(double xs[], size_t n)`, `void f(const int xs[])`, `void g(const double*
  xs, size_t n)`, `void h(const double m[][3], int rows)`.
- `vectors.cpp`: `std::vector<int> evens(const std::vector<int>& xs)`, `std::vector<std::string>
  split(const std::string& s)`, `std::array<float, 3> cross(const std::array<float, 3>& a, const
  std::array<float, 3>& b)`, `std::vector<std::vector<int>> transpose(std::vector<std::vector<int>>
  m)`, `std::vector<uint8_t> reverse_bytes(const std::vector<uint8_t>& data)`, `size_t count_true(const
  std::vector<bool>& flags)`, `struct Shape { std::vector<Point> pts; std::string name; }` with
  `Shape close(Shape s)`, `std::vector<int> throws_midway(const std::vector<int>& xs)`; hidden: `void
  sort_in_place(std::vector<int>& xs)`, `void span(std::span<const int> s)`, `void bare(vector<int> v)`
  after `using std::vector`.
- `vectors.rs`: `pub fn sum(xs: &[i64]) -> i64`, `pub fn evens(xs: Vec<i32>) -> Vec<i32>`, `pub fn
  shout_all(names: &[String]) -> Vec<String>`, `pub fn cross(a: [f32; 3], b: &[f32; 3]) -> [f32; 3]`,
  `pub fn reverse(data: &[u8]) -> Vec<u8>`, `pub fn digest(key: [u8; 4]) -> u32`, `pub const N: usize
  = 2; pub fn pair(v: [f32; N]) -> [f32; N]`, `pub struct Poly { pub pts: Vec<Point>, pub name: String,
  pub key: [u8; 4] }` with `pub fn shift_all(p: Poly) -> Poly`, `pub fn grid(m: Vec<Vec<i32>>) ->
  Vec<Vec<i32>>`, `pub fn chars(cs: Vec<char>) -> Vec<char>`, `pub fn motto_bytes() -> &'static [u8]`,
  `pub fn panics_midway(xs: &[i32]) -> Vec<i32>`; hidden: `pub fn sort(xs: &mut [i32])`, `pub fn strs(xs:
  &[&str])`, `pub fn boxed(xs: Box<[u8]>)`, `pub fn expr(v: [f32; 2 + 1])`.
- `main.ts` calls each with a value and with the inputs under "Testing" below, printing JSON as today.

The example gains one line per language: `mean` in C, `cross` over `std::array<float, 3>` in C++,
and `reverse` over bytes in Rust, so the probe can hover a sequence, a tuple and a `Uint8Array`.

## Testing, and what counts as done

Unit tests pin each walker's model (`c.test.ts`, `cpp.test.ts`, `rust.test.ts`: every fixture
signature above, sizes in every base, every hidden form, the pairing rules), `supported`
(`signatures.test.ts`), the bridges' text (`bridges.test.ts`: a C shim with a shared length, a C
mirror with a `char[N]` and a nested fixed array, the C++ templates, the Rust helpers and a `Vec<[f32;
2]>` conversion), the glue's helpers (`marshal.test.ts`: `jsType` in every position; that `const long xs[]` and
`const int64_t ys[]` get different helpers while two `Vec<i32>` share one; `cleanup` for bytes
against numbers), and the declarations (`declarations.test.ts`: `readonly`,
tuples, a skipped length parameter, an interface with an array field).

End-to-end (`e2e.test.ts`), through the fixtures, at least:

- every function above with a normal value, nested and empty arrays included, and `evens([])` is `[]`;
- `Uint8Array`, `Buffer.from` (a pooled one, offset not 0) and a `subarray` give the same checksum;
  a detached view, an `Int8Array`, an `ArrayBuffer` and `[1, 2]` are TypeErrors with their messages;
- `mean([1, "2"])` is `TypeError: mean(): xs[1] must be an integer…` (or the double message), a hole
  is the same at its index, `shift_all({ pts: [{ x: 1 }], … })` names `p.pts[0].y`;
- `norm([1, 2])` is `RangeError: norm(): v must have 3 elements`; `digest(new Uint8Array(3))` is
  `… key must have 4 bytes`;
- `dot([1, 2], [1])` is `Error: dot(): b must have as many elements as a`;
- `relabel(p, …)` with a 15-byte name round-trips and a 16-byte one, and `"a\0b"`, are RangeErrors;
- a `Proxy` of an array, `new Set()` and `arguments` are `TypeError: … must be an array`;
- a getter that throws at `xs[1]` surfaces its own error and leaks nothing (the test can't see the
  leak; the reader's structure is what the bridges test pins);
- `throws_midway` and `panics_midway` are errors, and the process survives;
- a million numbers through `mean` and a million bytes through `checksum` finish, with no time
  assertion beyond the test's own timeout;
- `total_pts` over two `Poly` values and `trace` over a nested literal go through the C temporary;
- `count_a("a\0a", …)` counts both: NUL crosses the counted form;
- the `long`-style skip: none needed, sizes are in the TypeScript type.

Done means: `npm test` green on Windows and in the Linux container, the example runs, the probe's
hover on the example shows `mean(xs: readonly number[]): number` and `cross(a: readonly [number,
number, number], …)`,
the cold example build stays near its 3.5 s, and the docs describe the table above and the C length
rule.

## Deferred

- Everything in Non-goals, in the order demand is expected: out-parameters and mutable arrays;
  typed arrays as `number[]` inputs (the measured 60× says a `Float64Array` path is worth having);
  `Option` and `std::optional`; `std::span`; `Box<[T]>`; unqualified `vector`; sizes from
  expressions and enums.
- A RangeError, not an Error, for the shim-detected length problems, once the slot can say which.
- Refusing struct names that collide with glue helpers (`array_…`, `string`, `uint`).
- Zero-copy byte results through `napi_create_external_arraybuffer`, if a profile ever asks.
- Carried from part two: `In<T>`, surfacing why a function was skipped, a quiet panic hook.

## Calls, for the owner to flip

1. Bytes are `Uint8Array` only for unsigned 8-bit elements; copied in (the review showed lending
   them is unsafe), copied out as a plain `Uint8Array`; `Buffer` accepted, other typed arrays and
   detached views rejected.
2. Fixed lengths are tuples, uncapped; a wrong length is a RangeError.
3. Array parameters are `readonly`; results and fields are not.
4. `char name[N]` is a bounded string; `const char s[]` with a length is a counted string.
5. The C length rule: the next integer parameter, shared by arrays in a row and checked for
   agreement; or the C99 `xs[n]` spelling; element types must be const or pointer-to-const; length
   problems a shim finds are `Error`s.
6. Sizes may be names the same file defines as integer literals; everything else hides the function.
7. Arrays of fixed arrays are arrays of allocations, except inline inside a C or C++ struct.
8. `std::vector` and `std::array` only when qualified; `std::vector<char>` is `number[]`.
9. The C bridge gains a prelude, mirrors and shims (internal, but it is the biggest structural change).
10. From the builder check: array helpers are keyed by the element's C type, not its class.
11. From the builder check: the length parameter stays in the model's list; `visibleParams` hides it
    from the glue and the declarations, and every bridge's `Callee.params` follows that list.
12. From the builder check: a C sequence or fixed array whose elements need conversion crosses
    through a temporary in the shim rather than hiding the function.
