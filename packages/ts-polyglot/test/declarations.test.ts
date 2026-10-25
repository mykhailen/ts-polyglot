// The virtual TypeScript the mapper hands tsc, and its span mappings. tsc checks that a verbatim span
// has the same text on both sides, so this does too, over the constructs the parser just learned.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { toDeclarations } from "../src/declarations.ts";
import { languages, loadLanguage } from "../src/languages/index.ts";
import { SpanMapKind } from "../src/protocol.ts";

before(() => Promise.all(languages.map((language) => loadLanguage(language.id))));

function checkVerbatim(fileName: string, source: string) {
  const { text, mappings = [] } = toDeclarations(fileName, source);
  assert.ok(mappings.length > 0, "no mappings");
  for (const [vStart, vLength, oStart, oLength, kind] of mappings) {
    assert.equal(kind, SpanMapKind.Verbatim);
    assert.equal(vLength, oLength);
    assert.equal(text.slice(vStart, vStart + vLength), source.slice(oStart, oStart + oLength));
  }
  return text;
}

test("the declaration text for a C++ function", () => {
  const text = checkVerbatim("add.cpp", "int add(int a, int b) {\n  return a + b;\n}\n");
  assert.equal(text, "/** `int add(int a, int b)` from add.cpp, run through a Node-API addon. */\nexport declare function add(a: number, b: number): number;\n");
});

test("verbatim spans hold for namespaced C++ and nested Rust", () => {
  checkVerbatim("geo.cpp", "// ünïcödé\nnamespace geo {\n  double area(double r, int sides = 4) noexcept { return r * sides; }\n}\n");
  checkVerbatim("m.rs", "pub mod inner {\n    pub fn nested(mut x: i32) -> i32 { x }\n}\n");
});

// A `*/` from the native file would close the JSDoc early and break tsc's parse of the whole virtual
// file, with errors that point nowhere in the user's code.
test("comments inside a header stay out of the JSDoc", () => {
  const c = toDeclarations("c.c", "int add(int a, int b /* the second */) { return a + b; }\n").text;
  assert.equal(c.split("*/").length, 2, c);
  assert.match(c, /`int add\(int a, int b\)` from c\.c/);
  const cpp = toDeclarations("c.cpp", "int add(int a, // first\n        int b) { return a + b; }\n").text;
  assert.match(cpp, /`int add\(int a, int b\)` from c\.cpp/);
  const rs = toDeclarations("r.rs", "pub fn f(a: i32) /* ret */ -> i32 { a }\n").text;
  assert.equal(rs.split("*/").length, 2, rs);
  assert.match(rs, /`pub fn f\(a: i32\) -> i32` from r\.rs/);
});

test("a file without functions exports nothing", () => {
  assert.equal(toDeclarations("empty.c", "").text, "export {};\n");
  assert.equal(toDeclarations("comments.rs", "// nothing here\n/* or here */\n").text, "export {};\n");
  assert.deepEqual(toDeclarations("empty.c", "").mappings, []);
});

test("64-bit integers are bigint results and number | bigint parameters", () => {
  assert.equal(checkVerbatim("values.c", "long echo_long(long x) { return x; }\n"), "/** `long echo_long(long x)` from values.c, run through a Node-API addon. */\nexport declare function echo_long(x: number | bigint): bigint;\n");
  assert.match(checkVerbatim("n.rs", "pub fn fib(n: u32) -> i64 { 0 }\n"), /fib\(n: number\): bigint;/);
});

test("a const reference parameter types as its target; Rust char is a string", () => {
  assert.match(checkVerbatim("r.cpp", "int f(const int& a) { return a; }\n"), /f\(a: number\): number;/);
  assert.match(checkVerbatim("c.rs", "pub fn c(x: char) -> char { x }\n"), /c\(x: string\): string;/);
});
