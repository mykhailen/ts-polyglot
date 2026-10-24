// The C walker over the C grammar, and the registry around it. The rules are the design's "The C and
// C++ walker"; the C++-only constructs are in cpp.test.ts.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, languageOf, loadLanguage } from "../src/languages/index.ts";

before(() => loadLanguage("c"));
const find = (source: string) => findFunctions(source, "c");

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
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart, p.type]), [["a", source.indexOf("a,"), "int"], ["b", source.indexOf("b)"), "int"]]);
  assert.equal(fn?.returnType, "int");
  assert.equal(fn?.returns.ts, "number");
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
  assert.deepEqual(fn?.params.map((p) => p.type), ["int", "int", "int"]);
});

test("pointers, arrays, function pointers and variadics skip the function", () => {
  assert.deepEqual(find("int f(const char *s) { return 0; }\nint g(int a[]) { return 0; }\nint h(int (*cb)(int)) { return 0; }\nint v(int a, ...) { return 0; }\nint *p(int a) { return 0; }"), []);
});

test("an unknown type skips the function", () => {
  assert.deepEqual(find("size_t f(int a) { return 0; }\nint g(size_t a) { return 0; }"), []);
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
  assert.equal(fn?.returnType, "unsigned int");
  assert.deepEqual(fn?.params.map((p) => p.type), ["long long", "unsigned short"]);
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
