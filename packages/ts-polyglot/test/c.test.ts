// The C walker over the C grammar, and the registry around it. The rules are the design's "The C and
// C++ walker"; the C++-only constructs are in cpp.test.ts.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { cFamilyModule } from "../src/languages/c-family.ts";
import { cType } from "../src/languages/c-types.ts";
import { findFunctions, languageOf, loadLanguage } from "../src/languages/index.ts";
import { parse } from "../src/parser.ts";

before(() => loadLanguage("c"));
const find = (source: string) => findFunctions(source, "c");
// The raw walker, before the registry filters: these tests want everything it sees.
const module = (source: string) => { const tree = parse("tree-sitter-c.wasm", source); try { return cFamilyModule(tree.rootNode, source, "c"); } finally { tree.delete(); } };
const types = (source: string) => module(source).functions[0]!.params.map((p) => p.type);

test("languageOf ignores case and knows the three languages", () => {
  assert.equal(languageOf("ADD.CPP"), "cpp");
  assert.equal(languageOf("x.cc"), "cpp");
  assert.equal(languageOf("x.c"), "c");
  assert.equal(languageOf("x.h"), undefined);
});

test("a definition with names, offsets, spellings and the header as written", () => {
  const source = "int add(int a, int b) {\n  return a + b;\n}\n";
  const [fn] = find(source);
  assert.equal(fn?.name, "add");
  assert.equal(fn?.callee, "add");
  assert.equal(fn?.nameStart, source.indexOf("add"));
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart, p.type.spelling]), [["a", source.indexOf("a,"), "int"], ["b", source.indexOf("b)"), "int"]]);
  assert.equal(fn?.returns.spelling, "int");
  assert.equal(fn?.returns.kind, "int");
  assert.equal(fn?.signature, "int add(int a, int b)");
});

test("static, static inline and main are skipped", () => {
  assert.deepEqual(find("static int hidden(int a) { return a; }\nstatic inline int also(int a) { return a; }\nint main(void) { return 0; }"), []);
});

test("unnamed parameters are arg<i> without an offset, and (void) is no parameters", () => {
  const [f, g] = find("int f(int, double) { return 0; }\nint g(void) { return 0; }");
  assert.deepEqual(f?.params.map((p) => [p.name, p.nameStart]), [["arg0", undefined], ["arg1", undefined]]);
  assert.deepEqual(g?.params, []);
});

test("const and volatile qualifiers are dropped from a type", () => {
  const [fn] = find("int f(const int a, int const b, volatile int c) { return 0; }");
  assert.deepEqual(fn?.params.map((p) => p.type.spelling), ["int", "int", "int"]);
});

test("pointers, arrays, function pointers and variadics skip the function", () => {
  assert.deepEqual(find("int f(const char *s) { return 0; }\nint g(int a[]) { return 0; }\nint h(int (*cb)(int)) { return 0; }\nint v(int a, ...) { return 0; }\nint *p(int a) { return 0; }"), []);
});

test("size_t crosses as a 64-bit unsigned integer; a name the file doesn't define is unknown and skips the function", () => {
  const found = find("size_t f(int a) { return 0; }\nint g(size_t a) { return 0; }\nint h(mystery_t a) { return 0; }");
  assert.deepEqual(found.map((fn) => fn.name), ["f", "g"]);
  assert.deepEqual(found[0]?.returns, { kind: "int", bits: 64, signed: false, spelling: "size_t" });
});

test("prototypes without a body are not exported", () => {
  assert.deepEqual(find("int declared(int a);\nint defined(int a) { return a; }").map((f) => f.name), ["defined"]);
});

test("every branch of a preprocessor conditional is walked and the first definition wins", () => {
  const source = "#ifdef _WIN32\nint f(int a) { return 1; }\n#else\nint f(int a) { return 2; }\nint g(int a) { return a; }\n#endif\n";
  const found = find(source);
  assert.deepEqual(found.map((f) => f.name), ["f", "g"]);
  assert.equal(found[0]?.nameStart, source.indexOf("f(int"));
});

test("__declspec and a calling convention don't hide a function", () => {
  assert.deepEqual(find("__declspec(dllexport) int __cdecl win(int a) { return a; }").map((f) => f.name), ["win"]);
});

test("sized types keep today's spellings", () => {
  const [fn] = find("unsigned   int f(long long x, unsigned short y) { return 0; }");
  assert.equal(fn?.returns.spelling, "unsigned int");
  assert.deepEqual(fn?.params.map((p) => p.type.spelling), ["long long", "unsigned short"]);
});

test("a half-typed file keeps the functions before the break", () => {
  assert.deepEqual(find("int ok(int a) { return a; }\nint partial(int a,").map((f) => f.name), ["ok"]);
});

test("an error inside a body doesn't hide the function", () => {
  assert.deepEqual(find("int broken(int a) { return a + ; }\nint after(int a) { return a; }").map((f) => f.name), ["broken", "after"]);
});

test("offsets are string indices after non-ASCII text", () => {
  const source = "// ünïcödé 😀\nint add(int a) { return a; }\n";
  const [fn] = find(source);
  assert.equal(fn?.nameStart, source.indexOf("add"));
  assert.equal(fn?.params[0]?.nameStart, source.indexOf("a)"));
});

test("offsets are string indices with CRLF line endings", () => {
  const source = "// first\r\n// second\r\nint add(int a,\r\n        int b) { return a + b; }\r\n";
  const [fn] = find(source);
  assert.equal(fn?.nameStart, source.indexOf("add"));
  assert.equal(fn?.params[1]?.nameStart, source.indexOf("b)"));
  assert.equal(fn?.signature, "int add(int a, int b)");
});

test("comments inside the header are dropped from the signature", () => {
  const [fn] = find("int add(int a /* in */, int b) { return a + b; }");
  assert.deepEqual(fn?.params.map((p) => p.name), ["a", "b"]);
  assert.equal(fn?.signature, "int add(int a, int b)");
});

test("a BOM doesn't hide the first function or shift offsets", () => {
  const source = "﻿int add(int a) { return a; }\n";
  const [fn] = find(source);
  assert.equal(fn?.name, "add");
  assert.equal(fn?.nameStart, source.indexOf("add"));
});

// The structured types and plain structs of the marshaling design, straight off the walker.
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
