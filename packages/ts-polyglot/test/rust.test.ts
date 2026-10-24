// The Rust walker. The rules are the design's "The Rust walker".
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, languageOf, loadLanguage } from "../src/languages/index.ts";

before(() => loadLanguage("rust"));
const find = (source: string) => findFunctions(source, "rust");

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
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart, p.type]), [["n", source.indexOf("n:"), "u32"]]);
  assert.equal(fn?.returnType, "i64");
  assert.equal(fn?.signature, "pub fn fib(n: u32) -> i64");
});

test("no return type is ()", () => {
  const [fn] = find("pub fn ping(x: i32) {}");
  assert.equal(fn?.returnType, "()");
  assert.equal(fn?.returns.ts, "void");
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

test("unknown types skip the function", () => {
  assert.deepEqual(find("pub fn s(x: &str) -> i32 { 0 }\npub fn v(x: Vec<u8>) -> i32 { 0 }\npub fn r(x: i32) -> String { String::new() }"), []);
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
