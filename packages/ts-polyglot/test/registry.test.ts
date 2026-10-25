// The registry around the walkers: which functions and structs make it through `supported`, and how
// same-named functions are settled.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, languages, loadLanguage, parseModule } from "../src/languages/index.ts";

before(() => Promise.all(languages.map((language) => loadLanguage(language.id))));

test("parseModule keeps functions whose types are supported and drops the rest", () => {
  const { functions } = parseModule("int ok(int a) { return a; }\nint ptr(int* p) { return 0; }\nint ref(const int& r) { return r; }\nint mut(int& r) { return r; }\nvoid v(void) {}\n", "cpp");
  assert.deepEqual(functions.map((f) => f.name), ["ok", "ref", "v"]);
});

test("an unsupported first overload doesn't hide a supported second; among supported ones the first wins", () => {
  const { functions } = parseModule("int h(int* p) { return 0; }\nint h(int a) { return a; }\nint over(int a) { return a; }\nint over(int a, int b) { return a + b; }\n", "cpp");
  assert.deepEqual(functions.map((f) => [f.name, f.params.length]), [["h", 1], ["over", 1]]);
});

test("Rust: a mod's functions, a 64-bit unsigned type and a &str are kept", () => {
  const { functions } = parseModule("pub mod m { pub fn f(x: usize) -> u64 { 0 } }\npub fn g(s: &str) {}\n", "rust");
  assert.deepEqual(functions.map((f) => f.callee), ["m::f", "g"]);
});

test("findFunctions is parseModule's functions", () => {
  const [fn] = findFunctions("long echo_long(long x) { return x; }", "c");
  assert.equal(fn?.returns.spelling, "long");
  assert.equal(fn?.returns.kind, "int");
});
