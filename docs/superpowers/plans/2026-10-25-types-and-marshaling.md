# Types and marshaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six-entry `Kind` table with a structured type model, and marshal every integer
and float type, booleans, Rust `char`, strings and plain structs between TypeScript and C, C++ and
Rust, with 64-bit values as `bigint`, strict conversions, and C++ exceptions and Rust panics as
JavaScript errors.

**Architecture:**
- `signatures.ts` holds the model: `NativeType` (a discriminated union with the spelling kept on
  every node), `NativeStruct`, `NativeFunction`, `NativeModule`, and `supported`, the one predicate
  that says what the glue marshals.
- Each language's walker (`languages/c-family.ts`, `languages/rust/index.ts`) builds `NativeType`s
  from a type table and collects plain structs; the registry (`languages/index.ts`) filters by
  `supported` and deduplicates.
- Each language's *bridge* (`languages/c.ts`, `cpp.ts`, `rust/bridge.ts`) lowers its functions to
  C-ABI callees: C calls the user's function directly; C++ gets a `static` shim per function that
  catches exceptions and converts `std::string`; Rust gets the wrapper crate with `catch_unwind`
  and `#[repr(C)]` mirrors. One ABI struct, `ts_polyglot_string`, carries strings and error messages.
- The glue generator (`glue.ts`, `marshal.ts`) knows only `AbiType` and Node-API: it reads arguments
  strictly with the C type's own limit macros, calls the callee, checks the error slot, makes the
  result, and cleans up on every path.
- `declarations.ts` emits `export interface` per struct and types 64-bit values as `bigint`.
- A **legacy seam** keeps the suite green between tasks: today's `NativeFunction`/`Param` become
  `LegacyFunction`/`LegacyParam`, produced from the new model by `toLegacy`, until Task 7 removes
  them. Tasks 2 to 5 add the new model beside the old pipeline; Task 6 switches the runtime; Task 7
  the mapper; Tasks 8 and 9 add strings and structs end to end.

**Tech Stack:** TypeScript 7.1 beta, Node 22.18+ (`node:test`, type stripping), web-tree-sitter
0.27.1 with the pinned grammars, Node-API (`node-api-headers` 1.9.0, bigint API at
`NAPI_VERSION >= 6`), MSVC / gcc / clang, rustc.

**Spec:** `docs/superpowers/specs/2026-10-25-types-and-marshaling-design.md`. Its "What crosses, and
how", "Plain structs" and "The three layers" sections are the rules; this plan names the code and the
tests that pin them and does not restate the rules. Part one's spec
(`2026-10-24-tree-sitter-parser-design.md`) still governs how functions are found.

## Global Constraints

- Everything in CLAUDE.md's Conventions. `src/` stays runnable by Node's type stripping (erasable
  syntax, `.ts` extensions on relative imports, `import type`). Comments say why, not what.
- The owner edits this checkout concurrently (the `create-ts-polyglot` template is being moved to
  `template/src/`): change existing files with targeted edits, never whole-file rewrites, and commit
  only the paths each task names.
- **Bump `GLUE_VERSION`** in `src/build.ts` in every task that changes the generated C, Rust or
  JavaScript: Task 6 → 7, Task 8 → 8, Task 9 → 9.
- The glue translation unit is C for `.c` and `.rs` files and C++ for `.cpp` files; everything the
  shared generator emits is the common subset, compiled with today's flags (`/EHsc /std:c++17`,
  `-std=c++17`). Every local in a generated wrapper is declared at the top, zero-initialized, so
  `goto fail` is legal in both languages.
- Limits in generated code are C macros (`INT8_MIN`, `LONG_MAX`, `SIZE_MAX`, `CHAR_MIN`…), never
  numbers the generator wrote down. TypeScript types never depend on the OS.
- No attribute is required on a user's Rust struct; the wrapper crate owns every `#[repr(C)]`.
- Error classes and message: wrong `typeof` → `TypeError`; right type, impossible value →
  `RangeError`; text `<function>(): <path> must be <what>`; the error slot → `Error` with the message
  as is. Fewer arguments than parameters stays `TypeError` with today's text `<name>() expects N
  argument(s)`.
- Commit messages: one imperative sentence, a blank line, then
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Unit test commands below run from `packages/ts-polyglot/`; `npm test` runs from the repo root and
  takes about a minute (it builds `dist/`, then runs every suite, with the real compilers).

## Review Focus

Input classes the spec implies and the person using this will hit, each pinned to a test in the
task that owns the code:

1. A string with a lone surrogate (`"\uD800"`) into a Rust `String` or `&str` must arrive as U+FFFD
   (3 bytes), not throw or abort → Task 8.
2. A struct argument that is `null` or an array must be a `TypeError` naming the parameter and the
   fields, not a crash or a message about a missing field → Task 9.
3. A 100 KB string must round-trip in both directions; nothing in the glue may assume a small
   buffer → Task 8.
4. A negative number into an unsigned parameter (`fib(-1)`) must be a `RangeError`, not wrap to
   4294967295 → Task 6.
5. Only exactly one pointer level around `const char` is a string: `char*` and `const char**` stay
   pointers and skip the function, rather than being marshaled as text → Task 2.

---

### Task 1: The type model and the legacy seam

**Files:**
- Modify: `packages/ts-polyglot/src/signatures.ts`
- Modify (type renames only): `src/languages/language.ts`, `src/languages/c-family.ts`,
  `src/languages/rust/index.ts`, `src/languages/index.ts`, `src/languages/rust/build.ts`,
  `src/build.ts`
- Test: `packages/ts-polyglot/test/signatures.test.ts` (new tests; today's three stay)

**Interfaces:**
- Produces, in `signatures.ts`:

```ts
export type NativeType = { spelling: string } & (
  | { kind: "void" } | { kind: "bool" }
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean }
  | { kind: "float"; bits: 32 | 64 }
  | { kind: "char" }
  | { kind: "string"; nullable: boolean }
  | { kind: "struct"; name: string }
  | { kind: "reference"; to: NativeType; mutable: boolean }
  | { kind: "pointer"; to: NativeType; const: boolean }
  | { kind: "array"; of: NativeType; length?: number }
  | { kind: "unknown" });
export interface Field { name: string; nameStart: number; type: NativeType }
export interface NativeStruct { name: string; nameStart: number; fields: Field[]; path: string[]; spelling: string }
export interface Param { name: string; nameStart?: number; type: NativeType }
export interface NativeFunction { name: string; nameStart: number; callee: string; params: Param[]; returns: NativeType; signature: string }
export interface NativeModule { functions: NativeFunction[]; structs: NativeStruct[] }
/** Today's shapes, renamed; removed in Task 7. */
export interface LegacyParam { name: string; nameStart?: number; type: string; kind: Kind }
export interface LegacyFunction { name: string; nameStart: number; callee: string; params: LegacyParam[]; returnType: string; returns: Kind; signature: string }
export function supported(type: NativeType, module: NativeModule): boolean;
export function legacyKind(type: NativeType): Kind | undefined;
export function toLegacy(fn: NativeFunction): LegacyFunction | undefined;
```

  `supported` in this task: `void`, `bool`, `int`, `float`, `char`, and `reference` with
  `mutable: false` to one of those. Strings join in Task 8, structs in Task 9. `legacyKind`: `int`
  signed ≤ 32 → `I32`, unsigned ≤ 32 → `U32`, 64 signed → `I64`, 64 unsigned → undefined, `float` →
  `F64`, `bool` → `BOOL`, `void` → `VOID`, anything else undefined. `toLegacy` copies names, offsets,
  `callee` and `signature`, uses each type's `spelling` as the legacy `type`/`returnType`, and
  returns undefined when any parameter or the result has no legacy kind or a parameter is `void`
  (today's rules).

- [ ] **Step 1: Write the failing tests** (append to `test/signatures.test.ts`; import `supported`,
  `legacyKind`, `toLegacy`, `I32`, `U32`, `I64`, `F64`, `BOOL`, `VOID` from `../src/signatures.ts`)

```ts
const int = (bits: 8 | 16 | 32 | 64, signed: boolean, spelling = "int"): NativeType => ({ kind: "int", bits, signed, spelling });
const empty: NativeModule = { functions: [], structs: [] };

test("supported: primitives and immutable references to them", () => {
  for (const t of [int(8, true), int(64, false), { kind: "float", bits: 32, spelling: "float" }, { kind: "bool", spelling: "bool" }, { kind: "char", spelling: "char" }, { kind: "void", spelling: "void" }] as NativeType[]) assert.ok(supported(t, empty), t.spelling);
  assert.ok(supported({ kind: "reference", to: int(32, true), mutable: false, spelling: "const int&" }, empty));
});

test("supported: mutable references, pointers, arrays and unknowns are not", () => {
  assert.equal(supported({ kind: "reference", to: int(32, true), mutable: true, spelling: "int&" }, empty), false);
  assert.equal(supported({ kind: "pointer", to: int(32, true), const: false, spelling: "int*" }, empty), false);
  assert.equal(supported({ kind: "array", of: int(32, true), spelling: "int[]" }, empty), false);
  assert.equal(supported({ kind: "unknown", spelling: "size_t" }, empty), false);
});

test("legacyKind maps the model onto today's six kinds", () => {
  assert.equal(legacyKind(int(8, true)), I32);
  assert.equal(legacyKind(int(16, false)), U32);
  assert.equal(legacyKind(int(64, true)), I64);
  assert.equal(legacyKind(int(64, false)), undefined);
  assert.equal(legacyKind({ kind: "float", bits: 32, spelling: "float" }), F64);
  assert.equal(legacyKind({ kind: "bool", spelling: "bool" }), BOOL);
  assert.equal(legacyKind({ kind: "void", spelling: "void" }), VOID);
  assert.equal(legacyKind({ kind: "string", nullable: true, spelling: "const char*" }), undefined);
});

test("toLegacy keeps today's shape and refuses what today's parser refused", () => {
  const fn: NativeFunction = { name: "f", nameStart: 5, callee: "a::f", signature: "long f(unsigned x)", params: [{ name: "x", nameStart: 12, type: int(32, false, "unsigned") }], returns: int(64, true, "long") };
  assert.deepEqual(toLegacy(fn), { name: "f", nameStart: 5, callee: "a::f", signature: "long f(unsigned x)", params: [{ name: "x", nameStart: 12, type: "unsigned", kind: U32 }], returnType: "long", returns: I64 });
  assert.equal(toLegacy({ ...fn, returns: int(64, false, "unsigned long") }), undefined);
  assert.equal(toLegacy({ ...fn, params: [{ name: "v", type: { kind: "void", spelling: "void" } }] }), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/signatures.test.ts`
Expected: FAIL, `supported` is not exported (SyntaxError on the import or `undefined is not a function`).

- [ ] **Step 3: Add the model to `signatures.ts`**: the types above, `supported`, `legacyKind`,
  `toLegacy`. Rename today's `Param`/`NativeFunction` to `LegacyParam`/`LegacyFunction` and update the
  six importing files (`language.ts`'s `functions(...)` return type, the two walkers, the registry,
  `rust/build.ts`, `build.ts`). The file comment says the legacy shapes go when the glue and the mapper
  read the model (Task 7).

- [ ] **Step 4: Run the tests and the type check**

Run: `node --test test/signatures.test.ts && npx tsc -p .`
Expected: all tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src packages/ts-polyglot/test/signatures.test.ts
git commit -m "Add the structured type model beside today's kinds"
```

---

### Task 2: C-family walker: structured types and plain structs

**Files:**
- Create: `packages/ts-polyglot/src/languages/c-types.ts`
- Modify: `packages/ts-polyglot/src/languages/c-family.ts`
- Test: `packages/ts-polyglot/test/c.test.ts`, `packages/ts-polyglot/test/cpp.test.ts`

**Interfaces:**
- Consumes: Task 1's model and `toLegacy`.
- Produces:

```ts
// c-types.ts
export interface CType { type: NativeType; c: string; min?: string; max?: string }   // min/max for ints
/** Looks a spelling up by its keyword set: "long int", "int long" and "long" are one entry; "std::" is stripped. */
export function cType(spelling: string): CType | undefined;
// c-family.ts
export function cFamilyModule(root: Node, source: string): NativeModule;            // every plain struct and every typed function the visit reaches
export function cFamilyFunctions(root: Node, source: string): LegacyFunction[];    // = cFamilyModule(...).functions.map(toLegacy), undefineds dropped
```

  The table, with `c` and limits (the spec's "The C family" bullet): `char` → int 8 signed,
  `CHAR_MIN`/`CHAR_MAX`; `signed char` → 8 signed, `SCHAR_*`; `unsigned char` → 8 unsigned,
  `UCHAR_MAX`; `short` → 16 signed, `SHRT_*`; `unsigned short` → `USHRT_MAX`; `int` (also `signed`,
  `signed int`) → 32 signed, `INT_*`; `unsigned` / `unsigned int` → `UINT_MAX`; `long` → 64 signed,
  `LONG_*`; `unsigned long` → `ULONG_MAX`; `long long` → `LLONG_*`; `unsigned long long` →
  `ULLONG_MAX`; `int8_t`…`int64_t` → `INTn_MIN`/`INTn_MAX`; `uint8_t`…`uint64_t` → `UINTn_MAX`;
  `size_t` → 64 unsigned, `0`/`SIZE_MAX`; `ptrdiff_t` → `PTRDIFF_*`; `intptr_t`/`uintptr_t` →
  `INTPTR_*`/`UINTPTR_MAX`; `float` → float 32; `double` → float 64; `bool`, `_Bool` → bool with
  `c: "bool"`; `void`; `std::string`, `std::string_view` → string, not nullable, `c:
  "ts_polyglot_string"`. The `spelling` recorded on a type is the text as written, whitespace
  normalized (`long int` stays `long int`); `c` is the table's canonical spelling. The unsigned
  entries have `min: "0"`.

  Type construction and struct collection follow the spec's node names. A type whose base resolves to
  nothing is `{ kind: "unknown", spelling }`. Wrapper spellings are built, not sliced: `const char*`,
  `const std::string&`, `int*`, `int[4]`. A `typedef` without a struct body is ignored (a forward
  `typedef struct P P;` doesn't resolve).

- [ ] **Step 1: Write the failing tests.** In both test files add a raw-walker helper (the registry's
  filtering is Task 4's; these tests want everything the walker sees):

```ts
import { parse } from "../src/parser.ts";
import { cFamilyModule } from "../src/languages/c-family.ts";
import { cType } from "../src/languages/c-types.ts";
const module = (source: string) => { const tree = parse("tree-sitter-c.wasm", source); try { return cFamilyModule(tree.rootNode, source); } finally { tree.delete(); } };   // tree-sitter-cpp.wasm in cpp.test.ts
const types = (source: string) => module(source).functions[0]!.params.map((p) => p.type);
```

  `c.test.ts`:

```ts
test("integer spellings carry width, signedness and the C type's limits", () => {
  const found = types("int f(char a, unsigned char b, short c, unsigned d, long e, unsigned long g, long long h, int8_t i, uint64_t j, size_t k, intptr_t l) { return 0; }");
  assert.deepEqual(found.map((t) => t.kind === "int" && [t.bits, t.signed, t.spelling]), [[8, true, "char"], [8, false, "unsigned char"], [16, true, "short"], [32, false, "unsigned"], [64, true, "long"], [64, false, "unsigned long"], [64, true, "long long"], [8, true, "int8_t"], [64, false, "uint64_t"], [64, false, "size_t"], [64, true, "intptr_t"]]);
  assert.deepEqual(cType("long"), { type: { kind: "int", bits: 64, signed: true, spelling: "long" }, c: "long", min: "LONG_MIN", max: "LONG_MAX" });
  assert.deepEqual(cType("size_t"), { type: { kind: "int", bits: 64, signed: false, spelling: "size_t" }, c: "size_t", min: "0", max: "SIZE_MAX" });
});

test("spellings normalize by keyword set", () => {
  assert.deepEqual(cType("long int"), cType("long"));
  assert.deepEqual(cType("int long"), cType("long"));
  assert.deepEqual(cType("signed int"), cType("int"));
  assert.deepEqual(cType("unsigned"), cType("unsigned int"));
  assert.deepEqual(cType("std::size_t"), cType("size_t"));
  assert.notDeepEqual(cType("signed char"), cType("char"));
  assert.equal(types("int f(long int x) { return 0; }")[0]!.spelling, "long int");
});

test("floats, bool, void and char", () => {
  const { functions } = module("void f(float a, double b, bool c, _Bool d) {}");
  assert.deepEqual(functions[0]!.params.map((p) => p.type.kind), ["float", "float", "bool", "bool"]);
  assert.equal((functions[0]!.params[0]!.type as { bits: number }).bits, 32);
  assert.equal(functions[0]!.returns.kind, "void");
});

test("one pointer level around const char is a nullable string; other pointers stay pointers", () => {
  const found = types("int f(const char* s, char const* t, char* u, const char** v, const int* w) { return 0; }");
  assert.deepEqual(found.map((t) => t.kind), ["string", "string", "pointer", "pointer", "pointer"]);
  assert.deepEqual(found[0], { kind: "string", nullable: true, spelling: "const char*" });
  assert.equal((found[2] as { const: boolean }).const, false);
  assert.equal((found[4] as { const: boolean }).const, true);
});

test("array parameters and pointer results have their own kinds", () => {
  const [fn] = module("int* p(int a[4], int b[]) { return 0; }").functions;
  assert.equal(fn!.returns.kind, "pointer");
  assert.deepEqual(fn!.params.map((p) => p.type.kind === "array" && p.type.length), [4, undefined]);
});

test("plain structs in their three forms, with fields, offsets and the glue's spelling", () => {
  const source = "struct Point { int x; int y; };\ntypedef struct { float a, b; } Pair;\ntypedef struct tag { long v; } Tagged;\n";
  const { structs } = module(source);
  assert.deepEqual(structs.map((s) => [s.name, s.spelling, s.fields.map((f) => [f.name, f.type.kind])]), [["Point", "struct Point", [["x", "int"], ["y", "int"]]], ["Pair", "Pair", [["a", "float"], ["b", "float"]]], ["Tagged", "Tagged", [["v", "int"]]]]);
  assert.equal(structs[0]!.nameStart, source.indexOf("Point"));
  assert.equal(structs[1]!.nameStart, source.indexOf("Pair"));
  assert.equal(structs[1]!.fields[1]!.nameStart, source.indexOf("b;"));
});

test("struct types resolve by tag and by typedef name", () => {
  const { functions, structs } = module("struct Point { int x; };\ntypedef struct { int y; } Pair;\nstruct Point f(struct Point p, Pair q) { return p; }\nint g(struct Missing m) { return 0; }\n");
  assert.deepEqual(functions[0]!.params.map((p) => p.type), [{ kind: "struct", name: "Point", spelling: "struct Point" }, { kind: "struct", name: "Pair", spelling: "Pair" }]);
  assert.deepEqual(functions[0]!.returns, { kind: "struct", name: "Point", spelling: "struct Point" });
  assert.deepEqual(functions[1]!.params[0]!.type, { kind: "unknown", spelling: "struct Missing" });
  assert.equal(structs.length, 2);
});

test("a struct with a bitfield isn't plain; one with a pointer field is plain but typed as such", () => {
  const { structs } = module("struct Bits { int x : 3; };\nstruct Ptr { const char* name; int* p; int a[2]; };\n");
  assert.deepEqual(structs.map((s) => s.name), ["Ptr"]);
  assert.deepEqual(structs[0]!.fields.map((f) => f.type.kind), ["string", "pointer", "array"]);
});

test("the legacy adapter still gives today's shape", () => {
  const [fn] = find("long f(unsigned x) { return x; }");
  assert.deepEqual([fn?.returnType, fn?.returns.c, fn?.params[0]?.type, fn?.params[0]?.kind.ts], ["long", "int64_t", "unsigned", "number"]);
});
```

  `cpp.test.ts`:

```ts
test("const references are immutable references to their target; && and non-const are mutable", () => {
  const found = types("int f(const int& a, int& b, const std::string& s, std::string&& r) { return 0; }");
  assert.deepEqual(found.map((t) => t.kind === "reference" && [t.mutable, t.to.kind, t.spelling]), [[false, "int", "const int&"], [true, "int", "int&"], [false, "string", "const std::string&"], [true, "string", "std::string&&"]]);
});

test("std::string and std::string_view are strings; a bare string is unknown", () => {
  const [fn] = module("std::string f(std::string a, std::string_view b, string c) { return a; }").functions;
  assert.deepEqual(fn!.params.map((p) => p.type), [{ kind: "string", nullable: false, spelling: "std::string" }, { kind: "string", nullable: false, spelling: "std::string_view" }, { kind: "unknown", spelling: "string" }]);
  assert.equal(fn!.returns.kind, "string");
});

test("classes are plain only when every data member is public, with no methods, bases, templates or nested types", () => {
  const { structs } = module("class Open { public: int w; };\nclass Box { public: int w; private: int s; };\nstruct M { int x; void f(); };\nstruct C { int x; C(); };\nstruct D : Open { int z; };\ntemplate <typename T> struct G { T t; };\nstruct N { struct In { int a; } in; };\nstruct WithInit { int x = 0; static int count; };\n");
  assert.deepEqual(structs.map((s) => [s.name, s.fields.map((f) => f.name)]), [["Open", ["w"]], ["WithInit", ["x"]]]);
});

test("struct names resolve innermost namespace out, then qualified; the spelling is qualified", () => {
  const { functions, structs } = module("namespace geometry { struct Vec { float dx; float dy; }; Vec norm(const Vec& v) { return v; } }\ngeometry::Vec scale(geometry::Vec v) { return v; }\nint bare(Vec v) { return 0; }\n");
  assert.deepEqual(structs.map((s) => [s.name, s.spelling, s.path]), [["Vec", "geometry::Vec", ["geometry"]]]);
  assert.deepEqual(functions.map((f) => [f.name, f.params[0]!.type.kind, f.returns.kind]), [["norm", "reference", "struct"], ["scale", "struct", "struct"], ["bare", "unknown", "int"]]);
});

test("two structs with one name: the first wins and the second's scope resolves to unknown", () => {
  const { functions, structs } = module("namespace a { struct P { int x; }; P fa(P p) { return p; } }\nnamespace b { struct P { double y; }; P fb(P p) { return p; } }\n");
  assert.deepEqual(structs.map((s) => s.spelling), ["a::P"]);
  assert.deepEqual(functions.map((f) => [f.name, f.params[0]!.type.kind]), [["fa", "struct"], ["fb", "unknown"]]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/c.test.ts test/cpp.test.ts`
Expected: FAIL on the imports (`c-types.ts` doesn't exist; `cFamilyModule` isn't exported). Today's
tests in both files still pass.

- [ ] **Step 3: Implement `c-types.ts` and rewrite `c-family.ts`** so that `definition` and
  `parameters` build `NativeType`s (the old `kindOf`/`C_TYPES` go away), a first pass collects plain
  structs into a scope-aware table (keys: `[...path, tag]` and `[...path, typedefName]`), and
  `cFamilyModule` returns `{ functions, structs }` with structs unique by `name` (first wins; a
  resolution landing on a loser yields `unknown`). `cFamilyFunctions` becomes the one-line legacy
  adapter.

- [ ] **Step 4: Run the walker suites and the type check**

Run: `node --test test/c.test.ts test/cpp.test.ts test/signatures.test.ts && npx tsc -p .`
Expected: all pass, including every pre-existing test unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/languages/c-types.ts packages/ts-polyglot/src/languages/c-family.ts packages/ts-polyglot/test/c.test.ts packages/ts-polyglot/test/cpp.test.ts
git commit -m "Build structured types and collect plain structs in the C and C++ walker"
```

---

### Task 3: Rust walker: structured types and plain structs

**Files:**
- Create: `packages/ts-polyglot/src/languages/rust/types.ts`
- Modify: `packages/ts-polyglot/src/languages/rust/index.ts`
- Test: `packages/ts-polyglot/test/rust.test.ts`

**Interfaces:**
- Consumes: Task 1's model and `toLegacy`.
- Produces:

```ts
// rust/types.ts
export interface RustType { type: NativeType; c: string; min?: string; max?: string }
export function rustType(spelling: string): RustType | undefined;
// rust/index.ts
export function rustModule(root: Node, source: string): NativeModule;
export function rustFunctions(root: Node, source: string): LegacyFunction[];   // legacy adapter, as in Task 2
```

  Table: `i8`/`i16`/`i32`/`i64` → `int8_t`…`int64_t` with `INTn_MIN`/`INTn_MAX`; `u8`…`u64` →
  `uintN_t`, `0`/`UINTn_MAX`; `isize` → `intptr_t`, `INTPTR_MIN`/`INTPTR_MAX`; `usize` → `size_t`,
  `0`/`SIZE_MAX`; `f32` → `float`; `f64` → `double`; `bool` → `bool`; `char` → `{ kind: "char" }`,
  `uint32_t`; `()` → void; `String`, `std::string::String`, `str` → string, not nullable,
  `ts_polyglot_string`. `i128`, `u128` → undefined (unknown). A `reference_type` result with no
  lifetime or a non-`'static` one is `{ kind: "unknown", spelling }`; with `'static` it's a
  reference. Spelling of a reference is built: `&`, the lifetime and a space if any, `mut ` if
  mutable, the target's spelling. `spelling` of a struct is `user::<path>::Name`.

- [ ] **Step 1: Write the failing tests** (same `module`/`types` helpers as Task 2, with
  `tree-sitter-rust.wasm` and `rustModule`)

```ts
test("integer, float, bool and char spellings carry their class and C twin", () => {
  const found = types("pub fn f(a: i8, b: u16, c: i64, d: usize, e: isize, g: f32, h: bool, i: char) {}");
  assert.deepEqual(found.map((t) => [t.kind, (t as { bits?: number }).bits, (t as { signed?: boolean }).signed, t.spelling]), [["int", 8, true, "i8"], ["int", 16, false, "u16"], ["int", 64, true, "i64"], ["int", 64, false, "usize"], ["int", 64, true, "isize"], ["float", 32, undefined, "f32"], ["bool", undefined, undefined, "bool"], ["char", undefined, undefined, "char"]]);
  assert.deepEqual(rustType("isize"), { type: { kind: "int", bits: 64, signed: true, spelling: "isize" }, c: "intptr_t", min: "INTPTR_MIN", max: "INTPTR_MAX" });
  assert.equal(rustType("i128"), undefined);
});

test("&str, String, &String and &'static str are strings, behind references or not", () => {
  const [fn] = module("pub fn f(a: &str, b: String, c: &String, d: &mut String, e: std::string::String) -> &'static str { \"\" }").functions;
  assert.deepEqual(fn!.params.map((p) => p.type.kind === "reference" ? [p.type.mutable, p.type.to.kind, p.type.spelling] : [p.type.kind, p.type.spelling]), [[false, "string", "&str"], ["string", "String"], [false, "string", "&String"], [true, "string", "&mut String"], ["string", "std::string::String"]]);
  assert.deepEqual(fn!.returns, { kind: "reference", mutable: false, to: { kind: "string", nullable: false, spelling: "str" }, spelling: "&'static str" });
});

test("a reference result without an explicit 'static lifetime is unknown", () => {
  const { functions } = module("pub fn e(s: &str) -> &str { s }\npub fn n<'a>(s: &'a str) -> &'a str { s }\n");
  assert.deepEqual(functions.map((f) => [f.name, f.returns.kind, f.returns.spelling]), [["e", "unknown", "&str"]]);   // n is skipped by its lifetime parameter, as before
});

test("generics, tuples, arrays, slices, raw pointers and &mut have their kinds", () => {
  const found = types("pub fn f(a: Option<i32>, b: (i32, i32), c: [u8; 4], d: &[u8], e: *const u8, g: &mut i32) {}");
  assert.deepEqual(found.map((t) => t.kind), ["unknown", "unknown", "array", "reference", "pointer", "reference"]);
  assert.equal((found[2] as { length?: number }).length, 4);
  assert.equal((found[3] as { to: NativeType }).to.kind, "array");
  assert.deepEqual([(found[4] as { const: boolean }).const, (found[5] as { mutable: boolean }).mutable], [true, true]);
});

test("plain structs: pub fields with offsets, module paths and the wrapper's spelling", () => {
  const source = "#[derive(Debug)]\npub struct Point { pub x: i32, pub y: i64 }\npub mod geo { pub struct V { pub dx: f32 } }\n";
  const { structs } = module(source);
  assert.deepEqual(structs.map((s) => [s.name, s.spelling, s.path, s.fields.map((f) => [f.name, f.type.spelling])]), [["Point", "user::Point", [], [["x", "i32"], ["y", "i64"]]], ["V", "user::geo::V", ["geo"], [["dx", "f32"]]]]);
  assert.equal(structs[0]!.nameStart, source.indexOf("Point"));
  assert.equal(structs[0]!.fields[1]!.nameStart, source.indexOf("y:"));
});

test("structs that aren't plain: a private or pub(crate) field, tuple, unit, generic, lifetime, non-pub", () => {
  assert.deepEqual(module("pub struct A { x: i32 }\npub struct B { pub(crate) x: i32 }\npub struct C(i32);\npub struct D;\npub struct E<T> { pub t: T }\npub struct F<'a> { pub s: &'a str }\nstruct G { pub x: i32 }\npub(crate) struct H { pub x: i32 }\n").structs, []);
});

test("struct names resolve in the function's module, by relative path, crate:: and super::", () => {
  const { functions } = module("pub struct P { pub x: i32 }\npub mod geo { pub struct V { pub x: f32 } pub fn n(v: V) -> V { v } pub mod deep { pub fn d(v: super::V, p: crate::P) -> i32 { 0 } } }\npub fn m(v: geo::V, w: crate::geo::V) -> i32 { 0 }\npub fn bare(v: V) -> i32 { 0 }\n");
  assert.deepEqual(functions.map((f) => [f.name, ...f.params.map((p) => p.type.kind === "struct" ? p.type.name : p.type.kind)]), [["n", "V"], ["d", "V", "P"], ["m", "V", "V"], ["bare", "unknown"]]);
});

test("the legacy adapter still gives today's shape", () => {
  const [fn] = find("pub fn fib(n: u32) -> i64 { 0 }");
  assert.deepEqual([fn?.returnType, fn?.returns.rust, fn?.params[0]?.type], ["i64", "i64", "u32"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/rust.test.ts`
Expected: FAIL on the imports; today's tests still pass.

- [ ] **Step 3: Implement `rust/types.ts` and rewrite `rust/index.ts`**: `item` and `parameters` build
  `NativeType`s (`RUST_TYPES` and `kindOf` go away), a first pass collects `struct_item`s per module
  path, resolution follows the spec's Rust rules, `rustModule` returns the module, `rustFunctions` is
  the legacy adapter.

- [ ] **Step 4: Run the suite and the type check**

Run: `node --test test/rust.test.ts test/signatures.test.ts && npx tsc -p .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/languages/rust packages/ts-polyglot/test/rust.test.ts
git commit -m "Build structured types and collect plain structs in the Rust walker"
```

---

### Task 4: The registry: `parse`, `parseModule`, filtering

**Files:**
- Modify: `src/languages/language.ts`, `src/languages/index.ts`, `src/languages/c.ts`,
  `src/languages/cpp.ts`, `src/languages/rust/index.ts`, `src/languages/c-family.ts`
- Test: create `packages/ts-polyglot/test/registry.test.ts`

**Interfaces:**
- Consumes: `cFamilyModule`, `rustModule`, `supported`, `toLegacy`.
- Produces:

```ts
// language.ts: `functions(root, source)` is replaced by
parse(root: Node, source: string): NativeModule;
// index.ts
export function languageModule(language: Language): LanguageModule;          // today's private moduleFor, exported for build.ts
export function parseModule(source: string, language: Language): NativeModule; // structs whose fields are all supported (recursively); functions whose params and result are supported, then first-wins by name
export function findFunctions(source: string, language: Language): LegacyFunction[];  // transitional: toLegacy over the raw parse, undefineds dropped, then first-wins by name (today's behavior)
```

  `cFamilyFunctions` and `rustFunctions` (the legacy adapters) are deleted; `findFunctions` does
  that job once, in the registry.

- [ ] **Step 1: Write the failing tests** (`test/registry.test.ts`, loading the three languages in
  `before`)

```ts
test("parseModule keeps functions whose types are supported and drops the rest", () => {
  const { functions } = parseModule("int ok(int a) { return a; }\nint ptr(int* p) { return 0; }\nint ref(const int& r) { return r; }\nint mut(int& r) { return r; }\nvoid v(void) {}\n", "cpp");
  assert.deepEqual(functions.map((f) => f.name), ["ok", "ref", "v"]);
});

test("an unsupported first overload doesn't hide a supported second; among supported ones the first wins", () => {
  const { functions } = parseModule("int h(int* p) { return 0; }\nint h(int a) { return a; }\nint over(int a) { return a; }\nint over(int a, int b) { return a + b; }\n", "cpp");
  assert.deepEqual(functions.map((f) => [f.name, f.params.length]), [["h", 1], ["over", 1]]);
});

test("Rust: a mod's functions and a 64-bit unsigned type are kept", () => {
  const { functions } = parseModule("pub mod m { pub fn f(x: usize) -> u64 { 0 } }\npub fn g(s: &str) {}\n", "rust");
  assert.deepEqual(functions.map((f) => f.callee), ["m::f"]);   // g waits for Task 8
});

test("findFunctions keeps today's legacy output", () => {
  const [fn] = findFunctions("long echo_long(long x) { return x; }", "c");
  assert.equal(fn?.returns.c, "int64_t");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/registry.test.ts`
Expected: FAIL, `parseModule` isn't exported.

- [ ] **Step 3: Implement**: `parse` on the three modules; `parseModule`, `languageModule` and the
  transitional `findFunctions` in `index.ts`; delete the two legacy adapters.

- [ ] **Step 4: Run every unit suite and the type check**

Run: `node --test test/registry.test.ts test/c.test.ts test/cpp.test.ts test/rust.test.ts test/signatures.test.ts test/declarations.test.ts test/parser.test.ts && npx tsc -p .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/languages packages/ts-polyglot/test/registry.test.ts
git commit -m "Let the registry filter the structured model and keep the legacy functions beside it"
```

---

### Task 5: Bridges for primitives, and the error slot

**Files:**
- Modify: `src/languages/language.ts`, `src/languages/c.ts`, `src/languages/cpp.ts`,
  `src/languages/c-types.ts`, `src/languages/rust/types.ts`
- Create: `src/languages/rust/bridge.ts` (imports `rustTargetArgs`, `rustStaticLibName` and the
  rustc invocation from `./build.ts` until Task 6 moves them)
- Test: create `packages/ts-polyglot/test/bridges.test.ts`

**Interfaces:**
- Consumes: `cType`, `rustType`, the model.
- Produces (`language.ts`):

```ts
export interface BridgeInput { file: string; module: NativeModule; dir: string; compiler: Compiler; debug: boolean }
export interface Bridge { prelude: string; callee(fn: NativeFunction): Callee; libs: string[] }
export interface Callee { name: string; params: AbiType[]; returns: AbiType; reportsErrors: boolean }
export type AbiType = { c: string } & (
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean; min: string; max: string }
  | { kind: "float"; bits: 32 | 64 } | { kind: "bool" } | { kind: "void" } | { kind: "char" }
  | { kind: "cstring" } | { kind: "string" }
  | { kind: "struct"; name: string; fields: { name: string; member: string; type: AbiType }[] });
// LanguageModule gains:
glue: "c" | "cpp";
bridge(input: BridgeInput): Bridge;
```

  and per language:

```ts
// c-types.ts
export function cAbi(type: NativeType): AbiType;          // from cType(spelling); a reference → its target's; throws on a kind the bridge doesn't lower yet (strings and structs come in Tasks 8 and 9)
// rust/types.ts
export function rustAbi(type: NativeType): AbiType;
// c.ts
export function cBridge(input: BridgeInput): Bridge;      // prelude `#include "<file, backslashes as />"`; callee { name: fn.callee, reportsErrors: false }; libs []
// cpp.ts
export function cppBridge(input: BridgeInput): Bridge;    // prelude: the #include, <exception>, <cstdlib>, <cstring>, ts_polyglot__release, ts_polyglot__own, one cppShim per function; callee { name: `ts_polyglot__shim_${fn.name}`, reportsErrors: true }
export function cppShim(fn: NativeFunction): string;
// rust/bridge.ts
export function rustWrapperSource(file: string, module: NativeModule): string;
export function rustPrelude(module: NativeModule): string;   // the C prototypes of the wrappers (the ABI typedef itself comes from the glue's header)
export function rustBridge(input: BridgeInput): Bridge;      // writes wrapper.rs, runs rustc as rustStaticLib does today; callee { name: `ts_polyglot__${fn.name}`, reportsErrors: true }; libs: the static library and rustc's native-static-libs
```

  Pinned text, so the tests and Task 6's glue agree:
  - C++ shim: `static <ret c> ts_polyglot__shim_<name>(<c> <param name>, …, ts_polyglot_string* error)`;
    body `try { return <callee>(<names>); } catch (const std::exception& e) { *error = ts_polyglot__own(e.what()); } catch (...) { *error = ts_polyglot__own("<name>() threw an exception"); } return <ret c>{};`
    (a `void` function has no `return` values). `ts_polyglot__own(const char*)` and
    `ts_polyglot__own(const char*, size_t)` malloc a copy with `release = ts_polyglot__release`,
    which calls `free`.
  - Rust wrapper: `#![allow(warnings)]`, `#[path = "<file>"] mod user;`, `#[repr(C)] pub struct
    ts_polyglot_string { ptr: *mut u8, len: usize, release: Option<unsafe extern "C" fn(*mut u8, usize)> }`,
    `pub unsafe extern "C" fn ts_polyglot_release(ptr: *mut u8, len: usize)` (drops the `Box<[u8]>`),
    `fn ts_polyglot_own(s: &str) -> ts_polyglot_string` (`into_boxed_str`), `fn ts_polyglot_panic_message(payload: &Box<dyn Any + Send>, name: &str) -> String`
    (`&str` or `String` payload, else `"<name>() panicked"`), and per function
    `#[no_mangle] pub extern "C" fn ts_polyglot__<name>(<param>: <rust spelling>, …, error: *mut ts_polyglot_string) -> <rust spelling or u32 for char>`
    whose body is `match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| user::<callee>(<args>))) { Ok(r) => <lowered r>, Err(p) => { unsafe { *error = ts_polyglot_own(&ts_polyglot_panic_message(&p, "<name>")) }; unsafe { std::mem::zeroed() } } }`.
    A `char` parameter arrives as `u32` and becomes `char::from_u32(c).unwrap_or('\u{FFFD}')`; a `char`
    result leaves `as u32`.
  - Rust prelude: one prototype per function, `<ret c> ts_polyglot__<name>(<c> arg0, …, ts_polyglot_string* error);`.

- [ ] **Step 1: Write the failing tests** (`test/bridges.test.ts`; parse modules with `parseModule`
  after loading the languages; a dummy compiler `{ family: "unix", command: ["cc"], source: "default" }`)

```ts
const input = (file: string, module: NativeModule): BridgeInput => ({ file, module, dir: "D:\\cache\\k", compiler: { family: "unix", command: ["cc"], source: "default" }, debug: false });

test("the C bridge includes the file and calls the function with its own types, no error slot", () => {
  const module = parseModule("long echo_long(long x) { return x; }\nunsigned char u(void) { return 0; }\n", "c");
  const bridge = cBridge(input("D:\\p\\values.c", module));
  assert.equal(bridge.prelude, '#include "D:/p/values.c"');
  assert.deepEqual(bridge.callee(module.functions[0]!), { name: "echo_long", params: [{ kind: "int", c: "long", bits: 64, signed: true, min: "LONG_MIN", max: "LONG_MAX" }], returns: { kind: "int", c: "long", bits: 64, signed: true, min: "LONG_MIN", max: "LONG_MAX" }, reportsErrors: false });
  assert.deepEqual(bridge.callee(module.functions[1]!).returns, { kind: "int", c: "unsigned char", bits: 8, signed: false, min: "0", max: "UCHAR_MAX" });
  assert.deepEqual(bridge.libs, []);
});

test("the C++ bridge wraps each function in a shim that catches exceptions", () => {
  const module = parseModule("#include <stdexcept>\nint throws(int x) { throw std::runtime_error(\"boom\"); }\nnamespace geometry { void tick(const int& a) {} }\n", "cpp");
  const bridge = cppBridge(input("D:\\p\\add.cpp", module));
  assert.match(bridge.prelude, /^#include "D:\/p\/add\.cpp"/m);
  assert.match(bridge.prelude, /static int ts_polyglot__shim_throws\(int x, ts_polyglot_string\* error\) \{\n  try \{ return throws\(x\); \}\n  catch \(const std::exception& e\) \{ \*error = ts_polyglot__own\(e\.what\(\)\); \}\n  catch \(\.\.\.\) \{ \*error = ts_polyglot__own\("throws\(\) threw an exception"\); \}\n  return int\{\};\n\}/);
  assert.match(bridge.prelude, /static void ts_polyglot__shim_tick\(int a, ts_polyglot_string\* error\) \{\n  try \{ geometry::tick\(a\); \}/);
  assert.deepEqual(bridge.callee(module.functions[0]!), { name: "ts_polyglot__shim_throws", params: [{ kind: "int", c: "int", bits: 32, signed: true, min: "INT_MIN", max: "INT_MAX" }], returns: { kind: "int", c: "int", bits: 32, signed: true, min: "INT_MIN", max: "INT_MAX" }, reportsErrors: true });
});

test("the Rust wrapper keeps the user's spellings, catches panics and reports them through the slot", () => {
  const module = parseModule("pub fn panics(x: i32) -> i32 { panic!(\"boom\") }\npub mod stats { pub fn clamp(x: isize, lo: isize, hi: isize) -> isize { x } }\npub fn next(c: char) -> char { c }\n", "rust");
  const wrapper = rustWrapperSource("D:\\p\\numbers.rs", module);
  assert.match(wrapper, /^#\[path = "D:\/p\/numbers\.rs"\]\nmod user;/m);
  assert.match(wrapper, /#\[repr\(C\)\]\npub struct ts_polyglot_string \{ ptr: \*mut u8, len: usize, release: Option<unsafe extern "C" fn\(\*mut u8, usize\)> \}/);
  assert.match(wrapper, /#\[no_mangle\]\npub extern "C" fn ts_polyglot__panics\(x: i32, error: \*mut ts_polyglot_string\) -> i32 \{/);
  assert.match(wrapper, /catch_unwind\(std::panic::AssertUnwindSafe\(\|\| user::panics\(x\)\)\)/);
  assert.match(wrapper, /ts_polyglot_panic_message\(&p, "panics"\)/);
  assert.match(wrapper, /fn ts_polyglot__clamp\(x: isize, lo: isize, hi: isize, error: \*mut ts_polyglot_string\) -> isize/);
  assert.match(wrapper, /user::stats::clamp\(x, lo, hi\)/);
  assert.match(wrapper, /fn ts_polyglot__next\(c: u32, error: \*mut ts_polyglot_string\) -> u32/);
  assert.match(wrapper, /char::from_u32\(c\)\.unwrap_or\('\\u\{FFFD\}'\)/);
  const prelude = rustPrelude(module);
  assert.match(prelude, /^int32_t ts_polyglot__panics\(int32_t arg0, ts_polyglot_string\* error\);$/m);
  assert.match(prelude, /^intptr_t ts_polyglot__clamp\(intptr_t arg0, intptr_t arg1, intptr_t arg2, ts_polyglot_string\* error\);$/m);
  assert.match(prelude, /^uint32_t ts_polyglot__next\(uint32_t arg0, ts_polyglot_string\* error\);$/m);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/bridges.test.ts`
Expected: FAIL on the imports.

- [ ] **Step 3: Implement** the types in `language.ts`, `cAbi`/`rustAbi`, `cBridge`, `cppBridge` +
  `cppShim`, and `rust/bridge.ts`; give the three modules `glue` (`"c"`, `"cpp"`, `"c"`) and
  `bridge`. `rustBridge` reuses today's rustc invocation (`--crate-type staticlib`, target args, the
  `native-static-libs` parsing) by importing from `rust/build.ts`.

- [ ] **Step 4: Run the suite and the type check**

Run: `node --test test/bridges.test.ts test/registry.test.ts && npx tsc -p .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/languages packages/ts-polyglot/test/bridges.test.ts
git commit -m "Give each language a bridge that lowers its functions to C-ABI callees with an error slot"
```

---

### Task 6: The glue generator and the runtime cutover

**Files:**
- Create: `packages/ts-polyglot/src/glue.ts`, `packages/ts-polyglot/src/marshal.ts`
- Modify: `src/build.ts` (uses `parseModule`, `languageModule(...).bridge`, `glueSource`,
  `moduleSource`; `GLUE_VERSION = 7`; the old `glueSource`/`moduleSource` and the Rust branch go),
  `src/languages/rust/bridge.ts` (absorbs `rustTargetArgs`, `rustStaticLibName` and the rustc call),
  `test/toolchain.test.ts` (import from `../src/languages/rust/bridge.ts`)
- Delete: `src/languages/rust/build.ts`
- Fixtures: `test/fixtures/project/values.c`, `add.cpp`, `numbers.rs`, `main.ts`
- Test: `test/e2e.test.ts`, `test/pack.test.ts`

**Interfaces:**
- Consumes: `Bridge`, `Callee`, `AbiType`, `parseModule`, `languageModule`.
- Produces:

```ts
// marshal.ts
export const ABI_HEADER: string;   // <stdbool.h> <stdint.h> <stddef.h> <limits.h> <stdlib.h> <string.h> <stdio.h> <node_api.h>, then the ts_polyglot_string typedef
export const HELPERS: string;      // static helpers, same text in every glue (below)
export function readArgument(abi: AbiType, value: string, into: string, fn: string, what: string): string[];  // C lines reading napi_value `value` into C lvalue `into`; `goto fail;` on failure. Strings and structs: Tasks 8 and 9 (throw until then)
export function makeResult(abi: AbiType, value: string, into: string): string[];                           // C lines making napi_value `into` from C expression `value`
export function cleanup(abi: AbiType, value: string): string[];                                             // frees what `readArgument`/the callee left owned; nothing for primitives
// glue.ts
export function glueSource(module: NativeModule, bridge: Bridge): string;
export function moduleSource(file: string, addon: string, module: NativeModule): string;   // today's text, moved
```

  `HELPERS` (names pinned): `static bool ts_polyglot_read_int(napi_env, napi_value, int64_t min, int64_t max, int64_t* out, const char* fn, const char* what)`,
  `ts_polyglot_read_uint(…, uint64_t max, uint64_t* out, …)`, `ts_polyglot_read_double(…, double*, …)`,
  `ts_polyglot_read_bool(…, bool*, …)`, `ts_polyglot_read_char(…, uint32_t*, …)`, and
  `static napi_value ts_polyglot_make_char(napi_env, uint32_t)`. Each reader returns `false` after
  throwing. Readers accept a `number` or a `bigint` for integers (`napi_typeof`, then
  `napi_get_value_double` with `isfinite`/`floor` checks, or `napi_get_value_bigint_int64`/`uint64`
  with the `lossless` flag), and print the limits into the message:
  `%s(): %s must be an integer between %lld and %lld` / `between 0 and %llu`; `a number`;
  `a boolean`; `one character` (a string of exactly one scalar value; a lone surrogate is a
  `RangeError`). An integer is read into an `int64_t`/`uint64_t` temporary against the `AbiType`'s
  `min`/`max`, then cast to `c`. 64-bit results use `napi_create_bigint_int64`/`uint64` (cast from
  `c`); narrower ones `napi_create_int32`/`uint32`; floats `napi_create_double`.

  The wrapper per function: locals at the top (`size_t argc`, `napi_value argv[]`, `napi_value
  result = NULL`, one `<c> arg<i>` per parameter, temporaries, `ts_polyglot_string error = {0}` when
  `reportsErrors`, `<c> value` for a non-void result); the `argc` check; `readArgument` per parameter
  with `what` = the parameter's name; the call; if `reportsErrors` and `error.ptr`, `napi_throw_error`
  with the message (NUL-terminated copy), release it, `goto fail`; `makeResult`; then `done:` cleanup
  of arguments and `return result;` with `fail:` setting `result = NULL` first. `NAPI_MODULE_INIT`
  registers the functions as today.

- [ ] **Step 1: Extend the fixtures and the e2e expectations (the failing tests).** `values.c`:

```c
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
// `long` is 64-bit on Linux and macOS, so values past 2^31 must survive the round trip there.
long echo_long(long x) { return x; }
int8_t echo_i8(int8_t x) { return x; }
uint64_t echo_u64(uint64_t x) { return x; }
size_t count(size_t n) { return n; }
float half(float x) { return x / 2; }
bool negate(bool b) { return !b; }
```

  `add.cpp` gains `#include <stdexcept>` and `int throws(int x) { if (x > 0) throw std::runtime_error("boom"); return x; }`.
  `numbers.rs` gains `pub fn panics(x: i32) -> i32 { if x > 0 { panic!("boom") } x }`,
  `pub fn echo_usize(n: usize) -> usize { n }` and
  `pub fn next_char(c: char) -> char { char::from_u32(c as u32 + 1).unwrap_or(c) }`.
  `main.ts` gets `const attempt = (f: () => unknown) => { try { return f(); } catch (e) { return { error: `${(e as Error).name}: ${(e as Error).message}` }; } };`
  and prints with `JSON.stringify(output, (_, v) => typeof v === "bigint" ? \`${v}n\` : v)` an object
  with today's keys plus: `wide: attempt(() => echo_long(2n ** 40n))`, `i8: echo_i8(-128)`,
  `i8Over: attempt(() => echo_i8(128))`, `i8Big: echo_i8(5n as never)`, `negate: negate(true)`,
  `notBool: attempt(() => negate(1 as never))`, `fractional: attempt(() => add(1.5, 2))`,
  `wrongType: attempt(() => add("1" as never, 2))`, `negativeUnsigned: attempt(() => fib(-1))`,
  `u64: echo_u64(2n ** 64n - 1n)`, `u64Number: echo_u64(5)`, `bigOver: attempt(() => echo_u64(2n ** 64n))`,
  `count: count(7)`, `half: half(3)`, `usize: echo_usize(7)`, `char: next_char("a")`,
  `charTwo: attempt(() => next_char("ab"))`, `throws: attempt(() => throws(1))`,
  `throwsNot: throws(-1)`, `panics: attempt(() => panics(1))`.

  `e2e.test.ts`: in "C, C++ and Rust functions run", `output.fib` becomes `"12586269025n"`, and new
  tests:

```ts
test("64-bit integers are bigints out and take numbers or bigints in", () => {
  const { output } = run("project");
  assert.equal(output.u64, "18446744073709551615n");
  assert.equal(output.u64Number, "5n");
  assert.equal(output.count, "7n");
  assert.equal(output.usize, "7n");
  assert.equal(output.bigOver.error, "RangeError: echo_u64(): x must be an integer between 0 and 18446744073709551615");
});

test("conversions are strict: wrong types are TypeErrors, impossible values RangeErrors, with the limits in the message", () => {
  const { output } = run("project");
  assert.equal(output.i8, -128);
  assert.equal(output.i8Over.error, "RangeError: echo_i8(): x must be an integer between -128 and 127");
  assert.equal(output.i8Big, 5);   // a bigint is fine for a narrow integer at runtime; TypeScript says number
  assert.equal(output.negate, false);
  assert.equal(output.notBool.error, "TypeError: negate(): b must be a boolean");
  assert.equal(output.fractional.error, "RangeError: add(): a must be an integer between -2147483648 and 2147483647");
  assert.equal(output.wrongType.error, "TypeError: add(): a must be an integer between -2147483648 and 2147483647");
  assert.equal(output.negativeUnsigned.error, "RangeError: fib(): n must be an integer between 0 and 4294967295");
  assert.equal(output.half, 1.5);
  assert.equal(output.char, "b");
  assert.equal(output.charTwo.error, "RangeError: next_char(): c must be one character");
});

test("a C++ exception and a Rust panic are JavaScript errors with the message", () => {
  const { output } = run("project");
  assert.equal(output.throws.error, "Error: boom");
  assert.equal(output.throwsNot, -1);
  assert.equal(output.panics.error, "Error: boom");
});
```

  "C long keeps 64 bits on Linux and macOS" becomes two tests: `{ skip: windows }` asserting
  `output.wide === "1099511627776n"`, and `{ skip: !windows }` asserting
  `output.wide.error === "RangeError: echo_long(): x must be an integer between -2147483648 and 2147483647"`.
  `pack.test.ts`: `output.fib` is `"12586269025n"`.

- [ ] **Step 2: Run the e2e suite to verify it fails**

Run: `npm test -w ts-polyglot` (from the repo root)
Expected: the fixture's `main.ts` no longer type-checks or runs (`echo_i8` and the others aren't
exported by today's glue, `throws` kills node) and the new assertions fail.

- [ ] **Step 3: Implement `marshal.ts` and `glue.ts`; switch `build.ts`** to `parseModule` →
  `languageModule(language).bridge({...})` → `glueSource` → `compileAddon` with the bridge's `libs`;
  delete the old generator and `rust/build.ts` (moving `rustTargetArgs`, `rustStaticLibName` and the
  rustc call into `rust/bridge.ts`); set `GLUE_VERSION = 7`. `readArgument`/`makeResult` throw
  `Error("ts-polyglot: strings aren't marshaled yet")` / `… structs …` for those kinds.

- [ ] **Step 4: Run the full suite**

Run: `npm test` (repo root)
Expected: every suite passes on this OS (Windows: 4 skips as today plus the Linux-only `wide` test
skipped; the Windows `wide` RangeError test runs). Also run `npm run example`: the example still
prints `fib(50) = 12586269025n`.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src packages/ts-polyglot/test
git commit -m "Generate the glue from the structured model: strict conversions, bigint, and errors from exceptions and panics"
```

---

### Task 7: Declarations from the model, and the end of the legacy seam

**Files:**
- Modify: `src/marshal.ts` (`jsType`), `src/declarations.ts`, `src/signatures.ts` (delete `Kind`,
  the six constants, `LegacyParam`, `LegacyFunction`, `legacyKind`, `toLegacy`), `src/languages/index.ts`
  (`findFunctions` = `parseModule(...).functions`)
- Test: create `test/marshal.test.ts`; modify `test/declarations.test.ts`, `test/signatures.test.ts`,
  `test/c.test.ts`, `test/cpp.test.ts`, `test/rust.test.ts`, `test/registry.test.ts` (assertions on
  the legacy shape move to the model)

**Interfaces:**
- Produces:

```ts
// marshal.ts
export function jsType(type: NativeType, position: "param" | "result" | "field"): string;
// int 64 → "bigint", or "number | bigint" as a param; other int, float → "number"; bool → "boolean"; char → "string";
// string → "string" or "string | null"; struct → its name; reference → jsType(to, position); void → "void"; else throws
```

- [ ] **Step 1: Write the failing tests.** `marshal.test.ts`, pure:

```ts
const int = (bits: 8 | 16 | 32 | 64, signed: boolean): NativeType => ({ kind: "int", bits, signed, spelling: "x" });
test("jsType by kind and position", () => {
  assert.deepEqual(["param", "result", "field"].map((p) => jsType(int(64, true), p as "param")), ["number | bigint", "bigint", "bigint"]);
  assert.deepEqual([int(32, false), { kind: "float", bits: 32 }, { kind: "bool" }, { kind: "char" }, { kind: "void" }].map((t) => jsType({ spelling: "x", ...t } as NativeType, "result")), ["number", "number", "boolean", "string", "void"]);
  assert.equal(jsType({ kind: "string", nullable: true, spelling: "const char*" }, "field"), "string | null");
  assert.equal(jsType({ kind: "string", nullable: false, spelling: "String" }, "param"), "string");
  assert.equal(jsType({ kind: "struct", name: "Point", spelling: "Point" }, "param"), "Point");
  assert.equal(jsType({ kind: "reference", mutable: false, to: int(64, false), spelling: "&usize" }, "param"), "number | bigint");
  assert.throws(() => jsType({ kind: "pointer", to: int(32, true), const: false, spelling: "int*" }, "param"));
});
```

  `declarations.test.ts`:

```ts
test("64-bit integers are bigint results and number | bigint parameters", () => {
  assert.equal(checkVerbatim("values.c", "long echo_long(long x) { return x; }\n"), "/** `long echo_long(long x)` from values.c, run through a Node-API addon. */\nexport declare function echo_long(x: number | bigint): bigint;\n");
  assert.match(checkVerbatim("n.rs", "pub fn fib(n: u32) -> i64 { 0 }\n"), /fib\(n: number\): bigint;/);
});

test("a const reference parameter types as its target; Rust char is a string", () => {
  assert.match(checkVerbatim("r.cpp", "int f(const int& a) { return a; }\n"), /f\(a: number\): number;/);
  assert.match(checkVerbatim("c.rs", "pub fn c(x: char) -> char { x }\n"), /c\(x: string\): string;/);
});
```

  `signatures.test.ts` replaces its three legacy tests and the `legacyKind`/`toLegacy` tests with:

```ts
test("C long is a 64-bit integer everywhere, unsigned long too, int stays 32-bit", () => {
  const [l, u, i] = findFunctions("long a(long x) { return x; }\nunsigned long b(unsigned long x) { return x; }\nint c(int x) { return x; }\n", "c");
  assert.deepEqual([l?.returns, u?.params[0]?.type, i?.returns], [{ kind: "int", bits: 64, signed: true, spelling: "long" }, { kind: "int", bits: 64, signed: false, spelling: "unsigned long" }, { kind: "int", bits: 32, signed: true, spelling: "int" }]);
});
```

  In `c.test.ts`, `cpp.test.ts`, `rust.test.ts`: `p.type` → `p.type.spelling`, `fn.returnType` →
  `fn.returns.spelling`, `fn.returns.ts === "number"` → `fn.returns.kind === "int"`, and delete the
  two "legacy adapter" tests; `registry.test.ts`'s `findFunctions` test asserts `returns.spelling === "long"`.
  Pre-existing "skip" tests whose subject is now supported (`unsigned long`, `size_t`, `const int&`
  in cpp) flip to asserting the type.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/declarations.test.ts test/signatures.test.ts`
Expected: FAIL (`bigint` isn't emitted; `findFunctions` still returns the legacy shape).

- [ ] **Step 3: Implement** `jsType`; make `declarations.ts` use `parseModule` and `jsType`; delete
  the legacy types and functions; redefine `findFunctions`; fix the compile errors that fall out.

- [ ] **Step 4: Run the unit suites, the type check and the e2e type check**

Run: `node --test test/marshal.test.ts test/declarations.test.ts test/signatures.test.ts test/c.test.ts test/cpp.test.ts test/rust.test.ts test/registry.test.ts test/bridges.test.ts test/parser.test.ts test/grammars.test.ts && npx tsc -p .`,
then `npm test -w ts-polyglot`.
Expected: all pass; the fixture's `main.ts` type-checks with `fib` as `bigint`.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src packages/ts-polyglot/test
git commit -m "Type the virtual TypeScript from the model, with bigint for 64-bit values, and drop the legacy kinds"
```

---

### Task 8: Strings

**Files:**
- Modify: `src/signatures.ts` (`supported`: `string`, and references to it), `src/marshal.ts`
  (string readers/makers, `jsType`), `src/languages/c-types.ts` (`cAbi`: `string` nullable →
  `{ kind: "cstring", c: "const char*" }`, else `{ kind: "string", c: "ts_polyglot_string" }`),
  `src/languages/rust/types.ts` (`rustAbi`: `string` → `ts_polyglot_string`), `src/languages/cpp.ts`
  (`cppShim`: string parameters and results; `<string>`, `<string_view>` includes),
  `src/languages/rust/bridge.ts` (string parameters and results), `src/build.ts` (`GLUE_VERSION = 8`)
- Fixtures: `test/fixtures/project/names.c`, `add.cpp`, `numbers.rs`, `main.ts`
- Test: `test/signatures.test.ts`, `test/declarations.test.ts`, `test/bridges.test.ts`,
  `test/registry.test.ts`, `test/e2e.test.ts`

**Interfaces:**
- `HELPERS` gains `static bool ts_polyglot_read_cstring(napi_env, napi_value, char** out, const char* fn, const char* what)`
  (`null` → `*out = NULL`; a string → a malloc'd NUL-terminated UTF-8 copy from two
  `napi_get_value_string_utf8` calls; `strlen(*out) != len` → `RangeError`),
  `ts_polyglot_read_string(…, ts_polyglot_string* out, …)` (malloc'd bytes, `release = NULL`),
  `static napi_value ts_polyglot_make_cstring(napi_env, const char*)` (NULL → `null`), and
  `static napi_value ts_polyglot_make_string(napi_env, ts_polyglot_string)` (copies with the length,
  then calls `release` if set). `cleanup` frees a `cstring` argument and a `string` argument's bytes.
  Messages: `cstring` → `a string without NUL characters, or null`; `string` → `a string`.
- C++ shim: a `string` parameter arrives as `ts_polyglot_string s` and is passed as
  `std::string(s.ptr, s.len)`, `std::string_view(s.ptr, s.len)` or, for `const std::string&`,
  `std::string(...)` bound to the reference; a `cstring` passes through as `const char*`. A
  `std::string`-family result (`std::string`, `const std::string&`, `std::string_view`) is copied:
  `{ auto r = <call>; return ts_polyglot__own(r.data(), r.size()); }`; a `const char*` result passes
  through.
- Rust wrapper: a `string` parameter `s: ts_polyglot_string` becomes
  `match std::str::from_utf8(unsafe { std::slice::from_raw_parts(s.ptr, s.len) }) { Ok(v) => v, Err(_) => { *error = ts_polyglot_own("<name>(): <param> isn't valid UTF-8"); return zeroed } }`
  (an empty string has a null or dangling `ptr` with `len` 0: use an empty slice then), passed as
  `&str`, `.to_owned()` for `String`, `&String::from(v)` for `&String`; a `String` or `&'static str`
  result is `ts_polyglot_own(&r)` / `ts_polyglot_own(r)`.

- [ ] **Step 1: Write the failing tests.** `signatures.test.ts`: strings supported (`string` nullable
  and not; `reference` to `string`); `declarations.test.ts`:

```ts
test("strings: const char* is string | null, the owning and view types are string", () => {
  assert.match(checkVerbatim("n.c", "const char* describe(const char* s) { return s; }\n"), /describe\(s: string \| null\): string \| null;/);
  assert.match(checkVerbatim("s.cpp", "std::string shout(const std::string& s, std::string_view v, std::string o) { return o; }\n"), /shout\(s: string, v: string, o: string\): string;/);
  assert.match(checkVerbatim("s.rs", "pub fn shout(s: &str, o: String, r: &String) -> String { o }\npub fn motto() -> &'static str { \"\" }\n"), /shout\(s: string, o: string, r: string\): string;\n.*\nexport declare function motto\(\): string;/);
});
```

  `registry.test.ts`: the Rust `g(s: &str)` from Task 4 is now kept (edit that assertion to
  `["m::f", "g"]`). `bridges.test.ts`:

```ts
test("the C++ shim builds std::string and std::string_view from the ABI string and copies string results", () => {
  const module = parseModule("#include <string>\nstd::string shout(const std::string& s, std::string_view v, const char* c) { return s; }\n", "cpp");
  const shim = cppShim(module.functions[0]!);
  assert.match(shim, /static ts_polyglot_string ts_polyglot__shim_shout\(ts_polyglot_string s, ts_polyglot_string v, const char\* c, ts_polyglot_string\* error\)/);
  assert.match(shim, /shout\(std::string\(s\.ptr, s\.len\), std::string_view\(v\.ptr, v\.len\), c\)/);
  assert.match(shim, /return ts_polyglot__own\(r\.data\(\), r\.size\(\)\)/);
});

test("the Rust wrapper validates UTF-8 and owns string results", () => {
  const module = parseModule("pub fn shout(s: &str, o: String, r: &String) -> String { o }\npub fn motto() -> &'static str { \"\" }\n", "rust");
  const wrapper = rustWrapperSource("D:\\p\\s.rs", module);
  assert.match(wrapper, /fn ts_polyglot__shout\(s: ts_polyglot_string, o: ts_polyglot_string, r: ts_polyglot_string, error: \*mut ts_polyglot_string\) -> ts_polyglot_string/);
  assert.match(wrapper, /std::str::from_utf8/);
  assert.match(wrapper, /user::shout\(s, o\.to_owned\(\), &String::from\(r\)\)/);
  assert.match(wrapper, /Ok\(r\) => ts_polyglot_own\(&r\)/);
  assert.match(wrapper, /fn ts_polyglot__motto\(error: \*mut ts_polyglot_string\) -> ts_polyglot_string/);
});
```

  Fixtures. `names.c` gains `#include <stddef.h>`, `#include <string.h>`,
  `const char* describe(int n) { return n < 0 ? NULL : "non-negative"; }` and
  `size_t byte_count(const char* s) { return s ? strlen(s) : 0; }`. `add.cpp` gains `#include <string>`,
  `#include <string_view>`, `std::string shout(const std::string& s) { std::string r = s; for (auto& c : r) if (c >= 'a' && c <= 'z') c -= 32; return r + "!"; }`,
  `std::string first_word(std::string_view s) { return std::string(s.substr(0, s.find(' '))); }` and
  `std::string repeat(std::string s, int n) { std::string r; while (n-- > 0) r += s; return r; }`.
  `numbers.rs` gains `pub fn shout(s: &str) -> String { format!("{}!", s.to_uppercase()) }`,
  `pub fn byte_len(s: String) -> usize { s.len() }`, `pub fn motto() -> &'static str { "ship it" }` and
  `pub fn echo_ref(s: &String) -> String { s.clone() }`. `main.ts` adds: `describeNull: describe(-1)`,
  `describe: describe(3)`, `bytes: byte_count("héllo")`, `bytesNull: byte_count(null)`,
  `nulInC: attempt(() => byte_count("a\0b"))`, `long: byte_count("x".repeat(100000))`,
  `shoutCpp: shout("héllo 😀")`, `firstWord: first_word("hello world")`, `repeatNul: repeat("ab\0", 2)`,
  `shoutRs: shout_rs("héllo")` (imported `as shout_rs`), `emoji: byte_len("😀")`,
  `loneSurrogate: byte_len("\uD800")`, `motto: motto()`, `echoLong: echo_ref("y".repeat(100000)).length`,
  `wrongString: attempt(() => shout(5 as never))`, `nullToOwned: attempt(() => byte_len(null as never))`.
  `e2e.test.ts`:

```ts
test("strings cross as UTF-8 in both directions, with C's NUL and NULL rules", () => {
  const { output } = run("project");
  assert.equal(output.describeNull, null);
  assert.equal(output.describe, "non-negative");
  assert.equal(output.bytes, "6n");
  assert.equal(output.bytesNull, "0n");
  assert.equal(output.nulInC.error, "RangeError: byte_count(): s must be a string without NUL characters, or null");
  assert.equal(output.long, "100000n");
  assert.equal(output.shoutCpp, "HéLLO 😀!");
  assert.equal(output.firstWord, "hello");
  assert.equal(output.repeatNul, "ab\0ab\0");
  assert.equal(output.shoutRs, "HÉLLO!");
  assert.equal(output.emoji, "4n");
  assert.equal(output.loneSurrogate, "3n");
  assert.equal(output.motto, "ship it");
  assert.equal(output.echoLong, 100000);
  assert.equal(output.wrongString.error, "TypeError: shout(): s must be a string");
  assert.equal(output.nullToOwned.error, "TypeError: byte_len(): s must be a string");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/signatures.test.ts test/declarations.test.ts test/bridges.test.ts test/registry.test.ts`
Expected: FAIL (strings unsupported, shims and wrappers don't emit string code).

- [ ] **Step 3: Implement** across `supported`, `cAbi`/`rustAbi`, `marshal.ts`, `cppShim`, the Rust
  wrapper, and `GLUE_VERSION = 8`.

- [ ] **Step 4: Run the full suite and the example**

Run: `npm test` then `npm run example`
Expected: all pass; the new e2e test passes on this OS.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src packages/ts-polyglot/test
git commit -m "Marshal C, C++ and Rust strings as UTF-8 JavaScript strings"
```

---

### Task 9: Plain structs

**Files:**
- Modify: `src/signatures.ts` (`supported`: `struct` when in `module.structs` with every field
  supported, recursively, visited-set guarded), `src/languages/index.ts` (`parseModule` keeps a struct
  only when `supported` says so; functions then filter against the kept structs), `src/marshal.ts`
  (struct readers/makers, `jsType`), `src/declarations.ts` (interfaces), `src/languages/c-types.ts`
  (`cAbi` for a struct: `c` = the struct's `spelling`, `name`, fields with `member = name`; the C++
  bridge overrides `c` with `ts_polyglot_<name>` when a field, transitively, is a `string` that isn't a
  `cstring`), `src/languages/cpp.ts` (mirror typedefs and field-wise conversion in shims),
  `src/languages/rust/types.ts` (`rustAbi` struct: `c: "ts_polyglot_<name>"`, members = field names
  unless a C keyword, then `m_<name>`), `src/languages/rust/bridge.ts` (`#[repr(C)]` mirrors with
  `From` both ways; mirror typedefs in the prelude), `src/build.ts` (`GLUE_VERSION = 9`)
- Fixtures: create `test/fixtures/project/shapes.c`, `labels.cpp`, `points.rs`; modify `main.ts`
- Test: `test/signatures.test.ts`, `test/registry.test.ts`, `test/declarations.test.ts`,
  `test/bridges.test.ts`, `test/e2e.test.ts`

**Interfaces:**
- `marshal.ts` gains `export function structHelpers(abi: AbiType & { kind: "struct" }): string`: the
  definitions of `static bool ts_polyglot_read_<name>(napi_env, napi_value, <c>* out, const char* fn, const char* what)`
  (a `TypeError` `an object with <field names, comma-separated>` for a non-object, `null` or an array
  via `napi_is_array`; then each field through its reader with `what` = `"<what>.<field>"`) and
  `static napi_value ts_polyglot_make_<name>(napi_env, <c>)` (`napi_create_object`, one
  `napi_set_named_property` per field, releasing owned strings). `glueSource` emits them after
  `HELPERS`, each once, dependencies first. `cleanup` of a struct argument frees its string fields.
- Declarations: before the functions, per struct in source order:
  `` /** `struct <name>` from <file> */ `` (`` `pub struct <name>` `` for Rust) then
  `export interface <name> {\n  <field>: <jsType(field)>;\n…}\n`, with the struct name and each field
  name as verbatim spans.
- C++ mirror: `typedef struct { <c> <member>; … } ts_polyglot_<name>;` in the prelude, and in each
  shim that uses it `static <user type> ts_polyglot__from_<name>(ts_polyglot_<name>)` /
  `static ts_polyglot_<name> ts_polyglot__to_<name>(const <user type>&)` converting field-wise (strings
  through the Task 8 rules).
- Rust mirror: `#[repr(C)] pub struct ts_polyglot_<name> { pub <member>: <abi rust type>, … }` with
  `impl From<ts_polyglot_<name>> for user::<path>::<name>` and the reverse (`String` fields through
  `ts_polyglot_own` / UTF-8 validation).

- [ ] **Step 1: Write the failing tests.** `signatures.test.ts`: a struct in `module.structs` with
  supported fields is supported; one with a pointer field isn't; one nesting an unsupported one isn't.
  `registry.test.ts`:

```ts
test("parseModule keeps structs whose fields are all supported and the functions that use them", () => {
  const { structs, functions } = parseModule("struct Point { int x; int y; };\nstruct Bad { int* p; };\nstruct Nest { struct Bad b; };\nint area(struct Point p) { return 0; }\nint bad(struct Bad b) { return 0; }\nint nest(struct Nest n) { return 0; }\n", "c");
  assert.deepEqual(structs.map((s) => s.name), ["Point"]);
  assert.deepEqual(functions.map((f) => f.name), ["area"]);
});
```

  `declarations.test.ts`:

```ts
test("plain structs are exported interfaces with verbatim names and fields, before the functions", () => {
  const text = checkVerbatim("shapes.c", "#include <stdint.h>\nstruct Point { int x; int64_t y; };\ntypedef struct { const char* name; struct Point at; } Tag;\nTag tag(Tag t, struct Point p) { return t; }\n");
  assert.equal(text, "/** `struct Point` from shapes.c */\nexport interface Point {\n  x: number;\n  y: bigint;\n}\n/** `struct Tag` from shapes.c */\nexport interface Tag {\n  name: string | null;\n  at: Point;\n}\n/** `Tag tag(Tag t, struct Point p)` from shapes.c, run through a Node-API addon. */\nexport declare function tag(t: Tag, p: Point): Tag;\n");
  assert.match(checkVerbatim("p.rs", "pub struct P { pub x: i32 }\npub fn f(p: &P) -> P { P { x: 0 } }\n"), /\/\*\* `pub struct P` from p\.rs \*\/\nexport interface P \{\n  x: number;\n\}\n.*\nexport declare function f\(p: P\): P;/);
});
```

  `bridges.test.ts`:

```ts
test("C++ uses the user's struct unless it holds a std::string, then a mirror; Rust always mirrors", () => {
  const cpp = parseModule("#include <string>\nstruct Pt { double x; double y; };\nstruct Label { std::string text; int size; };\nPt mid(Pt a) { return a; }\nLabel louder(const Label& l) { return l; }\n", "cpp");
  const bridge = cppBridge(input("D:\\p\\l.cpp", cpp));
  assert.equal(bridge.callee(cpp.functions[0]!).params[0]!.c, "Pt");
  assert.equal(bridge.callee(cpp.functions[1]!).params[0]!.c, "ts_polyglot_Label");
  assert.match(bridge.prelude, /typedef struct \{ ts_polyglot_string text; int size; \} ts_polyglot_Label;/);
  const rs = parseModule("pub struct Point { pub x: i32, pub long: i64 }\npub fn shift(p: Point) -> Point { p }\n", "rust");
  const wrapper = rustWrapperSource("D:\\p\\p.rs", rs);
  assert.match(wrapper, /#\[repr\(C\)\]\npub struct ts_polyglot_Point \{ pub x: i32, pub m_long: i64 \}/);
  assert.match(wrapper, /impl From<ts_polyglot_Point> for user::Point/);
  assert.match(rustPrelude(rs), /typedef struct \{ int32_t x; int64_t m_long; \} ts_polyglot_Point;/);
  const abi = rustAbi(rs.functions[0]!.params[0]!.type);   // from rust/types.ts
  assert.deepEqual(abi.kind === "struct" && abi.fields.map((f) => [f.name, f.member]), [["x", "x"], ["long", "m_long"]]);
});
```

  Fixtures. `shapes.c`:

```c
#include <stdint.h>
struct Point { int x; int y; };
typedef struct { struct Point min; struct Point max; int64_t id; } Box;
typedef struct { const char* name; int id; } Tag;
int area(struct Point p) { return p.x * p.y; }
Box grow(Box b, int by) { b.min.x -= by; b.min.y -= by; b.max.x += by; b.max.y += by; return b; }
// Returns the caller's own string: the glue must make the result before it frees the arguments.
Tag retag(Tag t, int id) { t.id = id; return t; }
```

  `labels.cpp`: `#include <string>`, `struct Label { std::string text; int size; };`,
  `Label louder(const Label& l) { return { l.text + "!", l.size + 1 }; }`,
  `namespace ui { struct Pt { double x; double y; }; Pt mid(Pt a, Pt b) { return { (a.x + b.x) / 2, (a.y + b.y) / 2 }; } }`.
  `points.rs`: `pub struct Point { pub x: i32, pub y: i64 }`, `pub struct Named { pub name: String, pub at: Point }`,
  `pub fn shift(p: Point, dx: i32) -> Point { Point { x: p.x + dx, y: p.y } }`,
  `pub fn rename(n: Named, name: &str) -> Named { Named { name: name.to_owned(), at: n.at } }`,
  `pub fn dist(a: &Point, b: &Point) -> f64 { (((a.x - b.x) as f64).powi(2) + ((a.y - b.y) as f64).powi(2)).sqrt() }`.
  `main.ts` adds: `area: area({ x: 3, y: 4 })`, `grow: grow({ min: { x: 0, y: 0 }, max: { x: 1, y: 1 }, id: 5n }, 1)`,
  `retag: retag({ name: "a", id: 1 }, 2)`, `retagNull: retag({ name: null, id: 1 }, 2).name`,
  `louder: louder({ text: "hi", size: 1 })`, `mid: mid({ x: 0, y: 0 }, { x: 2, y: 4 })`,
  `shift: shift({ x: 1, y: 2n }, 3)`, `shiftNumber: shift({ x: 1, y: 2 } as never, 3)`,
  `rename: rename({ name: "a", at: { x: 1, y: 2n } }, "b")`, `dist: dist({ x: 0, y: 0n }, { x: 3, y: 4n })`,
  `extra: area({ x: 3, y: 4, z: 9 } as never)`, `missing: attempt(() => shift({ x: 1 } as never, 1))`,
  `nullStruct: attempt(() => shift(null as never, 1))`, `arrayStruct: attempt(() => shift([1, 2] as never, 1))`,
  `nestedWrong: attempt(() => rename({ name: "a", at: { x: "1", y: 2n } } as never, "b"))`.
  `e2e.test.ts`:

```ts
test("plain structs cross by value, nested, with 64-bit and string fields", () => {
  const { output } = run("project");
  assert.equal(output.area, 12);
  assert.deepEqual(output.grow, { min: { x: -1, y: -1 }, max: { x: 2, y: 2 }, id: "5n" });
  assert.deepEqual(output.retag, { name: "a", id: 2 });
  assert.equal(output.retagNull, null);
  assert.deepEqual(output.louder, { text: "hi!", size: 2 });
  assert.deepEqual(output.mid, { x: 1, y: 2 });
  assert.deepEqual(output.shift, { x: 4, y: "2n" });
  assert.deepEqual(output.shiftNumber, { x: 4, y: "2n" });
  assert.deepEqual(output.rename, { name: "b", at: { x: 1, y: "2n" } });
  assert.equal(output.dist, 5);
  assert.equal(output.extra, 12);
});

test("struct arguments are checked field by field, with the path in the message", () => {
  const { output } = run("project");
  assert.equal(output.missing.error, "TypeError: shift(): p.y must be an integer between -9223372036854775808 and 9223372036854775807");
  assert.equal(output.nullStruct.error, "TypeError: shift(): p must be an object with x, y");
  assert.equal(output.arrayStruct.error, "TypeError: shift(): p must be an object with x, y");
  assert.equal(output.nestedWrong.error, "TypeError: rename(): n.at.x must be an integer between -2147483648 and 2147483647");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/signatures.test.ts test/registry.test.ts test/declarations.test.ts test/bridges.test.ts`
Expected: FAIL (structs unsupported; no interfaces; no mirrors).

- [ ] **Step 3: Implement** across `supported`, `parseModule`, `marshal.ts` (`structHelpers`, struct
  cases in `readArgument`/`makeResult`/`cleanup`, `jsType`), `declarations.ts`, the three bridges,
  and `GLUE_VERSION = 9`.

- [ ] **Step 4: Run the full suite and the example**

Run: `npm test` then `npm run example`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src packages/ts-polyglot/test
git commit -m "Marshal plain structs by value as TypeScript interfaces"
```

---

### Task 10: Example, docs and changelog

**Files:**
- Modify: `examples/native-demo/add.cpp`, `geometry.c`, `numbers.rs`, `main.ts` (append; the
  existing lines stay for the LSP probe), `CLAUDE.md`, `README.md`, `packages/ts-polyglot/README.md`,
  `packages/create-ts-polyglot/template/README.md` (the one sentence about numbers and booleans),
  `CHANGELOG.md`

- [ ] **Step 1: Extend the example**: `add.cpp` gains `#include <string>` and
  `std::string greet(const std::string& name) { return "hello, " + name; }`; `geometry.c` gains
  `struct Point { double x; double y; };` and `double distance(struct Point a, struct Point b)`;
  `numbers.rs` gains `pub fn describe(n: i64) -> String { format!("{n} is {}", if n % 2 == 0 { "even" } else { "odd" }) }`;
  `main.ts` appends `console.log` lines for `greet("world")`, `distance({ x: 0, y: 0 }, { x: 3, y: 4 })`
  and `describe(2n ** 40n)`, and a `try`/`catch` around `add(2 ** 40, 1)` printing the `RangeError`.

- [ ] **Step 2: Run the example, the type check and the probe**

Run: `npm run typecheck && npm run example && node scripts/lsp-probe.cjs`
Expected: the example prints the new lines (`describe(...)` shows `1099511627776 is even`); the probe's
hover for `fib` shows `: bigint`. Budget: delete `packages/ts-polyglot/node_modules/.cache/ts-polyglot/`
and time `npm start -w native-demo` cold; it stays under twice the time of the same run on `main`
(the spec's compile-time budget). Record both numbers in the final report.

- [ ] **Step 3: Documentation.** `CLAUDE.md`: layout rows for `signatures.ts` (the model and
  `supported`), `marshal.ts`, `glue.ts`, `build.ts` (cache and orchestration), `languages/` (walker +
  bridge per language; `c-types.ts`, `rust/types.ts`, `rust/bridge.ts`); the "Adding a language"
  convention gains the bridge; open work item 3 becomes the spec's Non-goals list (arrays and
  buffers, out-parameters, enums, optionals, wide strings, 128-bit, classes, includes). Both READMEs:
  the status sentence (strings and plain structs now), the "What it exports" table's Types column
  (the spec's conversions table in short, with the two error classes and `bigint`), and the Limits
  list (drop the 64-bit-as-number bullet; add: `const char*` returns are never freed; struct
  definitions come from the same file; `use`/`using`/`#include` aren't followed). Template README:
  "Functions that take and return numbers, booleans, strings and plain structs". `CHANGELOG.md`, under
  `### 0.3.0 (unreleased)` in both package sections: strings, plain structs as interfaces, every C
  and Rust integer type, `bigint` for 64-bit values (behavior change: `fib(50)` is `12586269025n`),
  strict conversions with `TypeError`/`RangeError` (behavior change: fractional and out-of-range
  numbers no longer truncate), C++ exceptions and Rust panics as `Error`s.

- [ ] **Step 4: Full verification**

Run: `npm test && npm run test:linux`
Expected: `npm test` green. `test:linux` needs Docker Desktop running; if its engine is off, start it
and rerun, or record in the final report that CI covers Linux on push.

- [ ] **Step 5: Commit**

```bash
git add examples CLAUDE.md README.md packages/ts-polyglot/README.md packages/create-ts-polyglot/template/README.md CHANGELOG.md
git commit -m "Show strings, structs and bigints in the example and document the type mapping"
```
