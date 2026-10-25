// The bridges: what each language lowers its functions to for the glue. These check the text and the
// callee descriptions; the end-to-end tests compile what they describe.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { cBridge } from "../src/languages/c.ts";
import { cppBridge } from "../src/languages/cpp.ts";
import { languages, loadLanguage, parseModule } from "../src/languages/index.ts";
import type { BridgeInput } from "../src/languages/language.ts";
import { rustPrelude, rustWrapperSource } from "../src/languages/rust/bridge.ts";
import type { NativeModule } from "../src/signatures.ts";

before(() => Promise.all(languages.map((language) => loadLanguage(language.id))));

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
  const module = parseModule('#include <stdexcept>\nint throws(int x) { throw std::runtime_error("boom"); }\nnamespace geometry { void tick(const int& a) {} }\n', "cpp");
  const bridge = cppBridge(input("D:\\p\\add.cpp", module));
  assert.match(bridge.prelude, /^#include "D:\/p\/add\.cpp"/m);
  assert.match(bridge.prelude, /static int ts_polyglot__shim_throws\(int x, ts_polyglot_string\* error\) \{\n  try \{ return throws\(x\); \}\n  catch \(const std::exception& e\) \{ \*error = ts_polyglot__own\(e\.what\(\)\); \}\n  catch \(\.\.\.\) \{ \*error = ts_polyglot__own\("throws\(\) threw an exception"\); \}\n  return int\{\};\n\}/);
  assert.match(bridge.prelude, /static void ts_polyglot__shim_tick\(int a, ts_polyglot_string\* error\) \{\n  try \{ geometry::tick\(a\); \}/);
  assert.deepEqual(bridge.callee(module.functions[0]!), { name: "ts_polyglot__shim_throws", params: [{ kind: "int", c: "int", bits: 32, signed: true, min: "INT_MIN", max: "INT_MAX" }], returns: { kind: "int", c: "int", bits: 32, signed: true, min: "INT_MIN", max: "INT_MAX" }, reportsErrors: true });
});

test("the Rust wrapper keeps the user's spellings, catches panics and reports them through the slot", () => {
  const module = parseModule('pub fn panics(x: i32) -> i32 { panic!("boom") }\npub mod stats { pub fn clamp(x: isize, lo: isize, hi: isize) -> isize { x } }\npub fn next(c: char) -> char { c }\n', "rust");
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
