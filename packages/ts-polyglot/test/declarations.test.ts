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

test("plain structs are exported interfaces with verbatim names and fields, before the functions", () => {
  const text = checkVerbatim("shapes.c", "#include <stdint.h>\nstruct Point { int x; int64_t y; };\ntypedef struct { const char* name; struct Point at; } Tag;\nTag tag(Tag t, struct Point p) { return t; }\n");
  assert.equal(text, "/** `struct Point` from shapes.c */\nexport interface Point {\n  x: number;\n  y: bigint;\n}\n/** `struct Tag` from shapes.c */\nexport interface Tag {\n  name: string | null;\n  at: Point;\n}\n/** `Tag tag(Tag t, struct Point p)` from shapes.c, run through a Node-API addon. */\nexport declare function tag(t: Tag, p: Point): Tag;\n");
  assert.match(checkVerbatim("p.rs", "pub struct P { pub x: i32 }\npub fn f(p: &P) -> P { P { x: 0 } }\n"), /\/\*\* `pub struct P` from p\.rs \*\/\nexport interface P \{\n  x: number;\n\}\n.*\nexport declare function f\(p: P\): P;/);
});

test("strings: const char* is string | null, the owning and view types are string", () => {
  assert.match(checkVerbatim("n.c", "const char* describe(const char* s) { return s; }\n"), /describe\(s: string \| null\): string \| null;/);
  assert.match(checkVerbatim("s.cpp", "std::string shout(const std::string& s, std::string_view v, std::string o) { return o; }\n"), /shout\(s: string, v: string, o: string\): string;/);
  assert.match(checkVerbatim("s.rs", "pub fn shout(s: &str, o: String, r: &String) -> String { o }\npub fn motto() -> &'static str { \"\" }\n"), /shout\(s: string, o: string, r: string\): string;\n.*\nexport declare function motto\(\): string;/);
});

test("array parameters and results, a skipped length parameter, and interface fields with arrays", () => {
  const text = checkVerbatim("v.c", "#include <stddef.h>\n#define LEN 3\nstruct Poly { int xs[4]; char name[16]; unsigned char key[LEN]; };\ndouble mean(const double xs[], size_t n) { return 0; }\nfloat norm(const float v[3]) { return 0; }\nstruct Poly same(struct Poly p) { return p; }\n");
  assert.match(text, /export interface Poly \{\n  xs: \[number, number, number, number\];\n  name: string;\n  key: Uint8Array;\n\}/);
  assert.match(text, /`double mean\(const double xs\[\], size_t n\)` from v\.c[^\n]*\nexport declare function mean\(xs: readonly number\[\]\): number;/);
  assert.match(text, /export declare function norm\(v: readonly \[number, number, number\]\): number;/);
});

test("Rust and C++ sequences in both positions", () => {
  assert.match(checkVerbatim("v.rs", "pub fn evens(xs: Vec<i32>) -> Vec<i32> { xs }\npub fn names(ns: &[String]) -> Vec<Vec<String>> { Vec::new() }\n"), /evens\(xs: readonly number\[\]\): number\[\];\n[^\n]*\n[^\n]*names\(ns: readonly string\[\]\): string\[\]\[\];/);
  assert.match(checkVerbatim("v.cpp", "#include <vector>\n#include <string>\nstd::vector<std::string> split(const std::string& s) { return {}; }\n"), /split\(s: string\): string\[\];/);
});
