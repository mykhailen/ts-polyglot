// The Rust walker. The rules are the design's "The Rust walker".
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, languageOf, loadLanguage } from "../src/languages/index.ts";
import { rustModule } from "../src/languages/rust/index.ts";
import { rustType } from "../src/languages/rust/types.ts";
import { parse } from "../src/parser.ts";
import type { NativeType } from "../src/signatures.ts";

before(() => loadLanguage("rust"));
const find = (source: string) => findFunctions(source, "rust");
// The raw walker, before the registry filters: these tests want everything it sees.
const module = (source: string) => { const tree = parse("tree-sitter-rust.wasm", source); try { return rustModule(tree.rootNode, source); } finally { tree.delete(); } };
const types = (source: string) => module(source).functions[0]!.params.map((p) => p.type);

test(".rs files are Rust", () => {
  assert.equal(languageOf("x.rs"), "rust");
  assert.equal(languageOf("X.RS"), "rust");
});

test("a pub fn with names, offsets, spellings and the header as written", () => {
  const source = "pub fn fib(n: u32) -> i64 {\n    0\n}\n";
  const [fn] = find(source);
  assert.equal(fn?.name, "fib");
  assert.equal(fn?.callee, "fib");
  assert.equal(fn?.nameStart, source.indexOf("fib"));
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart, p.type.spelling]), [["n", source.indexOf("n:"), "u32"]]);
  assert.equal(fn?.returns.spelling, "i64");
  assert.equal(fn?.signature, "pub fn fib(n: u32) -> i64");
});

test("no return type is ()", () => {
  const [fn] = find("pub fn ping(x: i32) {}");
  assert.equal(fn?.returns.spelling, "()");
  assert.equal(fn?.returns.kind, "void");
});

test("private and pub(crate) functions stay private", () => {
  assert.deepEqual(find("fn a(x: i32) -> i32 { x }\npub(crate) fn b(x: i32) -> i32 { x }"), []);
});

test("extern and const are fine; unsafe and async are skipped", () => {
  const found = find('#[no_mangle]\npub extern "C" fn e(n: u32) -> u32 { n }\npub const fn c(n: u32) -> u32 { n }\npub unsafe fn u(n: u32) -> u32 { n }\npub async fn a(n: u32) -> u32 { n }\n');
  assert.deepEqual(found.map((f) => f.name), ["e", "c"]);
  assert.equal(found[0]?.signature, 'pub extern "C" fn e(n: u32) -> u32');
});

test("generics, where clauses, self and non-identifier patterns are skipped", () => {
  assert.deepEqual(find("pub fn g<T>(x: T) -> i32 { 0 }\npub fn w(x: i32) -> i32 where i32: Copy { x }\npub fn t((a, b): (i32, i32)) -> i32 { a }\nstruct S;\nimpl S { pub fn m(&self) -> i32 { 0 } }\n"), []);
});

test("a mut parameter keeps its name and offset", () => {
  const source = "pub fn m(mut x: i32) -> i32 { x }";
  const [fn] = find(source);
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart]), [["x", source.indexOf("x: i32")]]);
});

test("pub mod nesting gives a module path callee; a private mod hides its functions", () => {
  const found = find("pub mod outer { pub mod inner { pub fn deep(x: i32) -> i32 { x } } }\nmod hidden { pub fn h(x: i32) -> i32 { x } }\npub(crate) mod seen { pub fn s(x: i32) -> i32 { x } }\n");
  assert.deepEqual(found.map((f) => [f.name, f.callee]), [["deep", "outer::inner::deep"], ["s", "seen::s"]]);
});

test("strings and Vecs cross; a HashMap doesn't, and skips its function", () => {
  assert.deepEqual(find("pub fn s(x: &str) -> i32 { 0 }\npub fn v(x: Vec<u8>) -> i32 { 0 }\npub fn h(m: std::collections::HashMap<i32, i32>) -> i32 { 0 }\npub fn r(x: i32) -> String { String::new() }").map((f) => f.name), ["s", "v", "r"]);
});

test("a half-typed file keeps the functions before the break", () => {
  assert.deepEqual(find("pub fn ok(x: i32) -> i32 { x }\npub fn half(a: i32,").map((f) => f.name), ["ok"]);
});

// rustfmt's layout for a long parameter list puts a comment after each parameter.
test("comments between parameters don't hide the function", () => {
  const source = "pub fn configure(\n    width: u32,  // pixels\n    height: u32, // pixels\n) -> bool {\n    width > 0 && height > 0\n}\n";
  const [fn] = find(source);
  assert.deepEqual(fn?.params.map((p) => p.name), ["width", "height"]);
  assert.equal(fn?.signature, "pub fn configure(width: u32, height: u32,) -> bool");
});

// The structured types and plain structs of the marshaling design, straight off the walker.
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
  assert.deepEqual(functions.map((f) => [f.name, f.returns.kind, f.returns.spelling]), [["e", "unknown", "&str"]]); // n is skipped by its lifetime parameter, as before
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

test("Vec, slices and arrays are arrays, with sizes from literals in any base and from same-file consts", () => {
  const [a, b, c, d, e, g, h] = types("pub const N: usize = 3;\npub fn f(a: &[i32], b: Vec<String>, c: [f32; 3], d: &[u8; 0x10], e: std::vec::Vec<i64>, g: [f32; N], h: Vec<Vec<char>>) {}\n");
  assert.deepEqual(a, { kind: "reference", mutable: false, spelling: "&[i32]", to: { kind: "array", spelling: "[i32]", of: { kind: "int", bits: 32, signed: true, spelling: "i32" } } });
  assert.deepEqual(b, { kind: "array", spelling: "Vec<String>", of: { kind: "string", nullable: false, spelling: "String" } });
  assert.deepEqual(c, { kind: "array", length: 3, spelling: "[f32; 3]", of: { kind: "float", bits: 32, spelling: "f32" } });
  assert.deepEqual((d as { to: NativeType }).to, { kind: "array", length: 16, spelling: "[u8; 0x10]", of: { kind: "int", bits: 8, signed: false, spelling: "u8" } });
  assert.deepEqual((e as { of: NativeType }).of.spelling, "i64");
  assert.equal((g as { length?: number }).length, 3);
  assert.deepEqual(h, { kind: "array", spelling: "Vec<Vec<char>>", of: { kind: "array", spelling: "Vec<char>", of: { kind: "char", spelling: "char" } } });
});

test("sizes that aren't literals or same-file consts, Box<[T]>, Option<Vec<T>>, &[&str], &mut [T] and a borrowed slice result stay hidden", () => {
  assert.deepEqual(find("pub fn a(v: [f32; 2 + 1]) {}\npub fn b(v: [f32; M]) {}\npub fn c(v: Box<[u8]>) {}\npub fn d(v: Option<Vec<i32>>) {}\npub fn e(v: &[&str]) {}\npub fn f(v: &mut [i32]) {}\npub fn g(v: &[i32]) -> &[i32] { v }\n"), []);
  assert.equal(types("pub fn a(v: [f32; 2 + 1]) {}")[0]!.kind, "unknown");
});

test("struct fields of Vec, array and nested array types; a const in a pub mod resolves there", () => {
  const { structs, functions } = module("pub mod m {\n    pub const K: usize = 2;\n    pub struct S { pub xs: Vec<i32>, pub a: [u8; K], pub n: Vec<[f32; 2]> }\n    pub fn f(s: S) -> &'static [u8] { &[] }\n}\n");
  assert.deepEqual(structs[0]!.fields.map((f) => [f.name, f.type.kind, (f.type as { length?: number }).length]), [["xs", "array", undefined], ["a", "array", 2], ["n", "array", undefined]]);
  assert.deepEqual((structs[0]!.fields[2]!.type as { of: NativeType }).of, { kind: "array", length: 2, spelling: "[f32; 2]", of: { kind: "float", bits: 32, spelling: "f32" } });
  assert.deepEqual(functions[0]!.returns, { kind: "reference", mutable: false, spelling: "&'static [u8]", to: { kind: "array", spelling: "[u8]", of: { kind: "int", bits: 8, signed: false, spelling: "u8" } } });
});
