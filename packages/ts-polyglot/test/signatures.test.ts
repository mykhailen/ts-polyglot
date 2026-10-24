// The parser's type tables, which the mapper and the runtime share.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, loadLanguage } from "../src/languages/index.ts";

before(() => loadLanguage("c"));

test("C long crosses as 64-bit on every OS", () => {
  const [fn] = findFunctions("long echo_long(long x) { return x; }", "c");
  assert.equal(fn?.returns.c, "int64_t");
  assert.equal(fn?.params[0]?.kind.fromJs, "napi_get_value_int64");
});

test("unsigned long is skipped on every OS", () => {
  assert.deepEqual(findFunctions("unsigned long f(unsigned long x) { return x; }", "c"), []);
});

test("int stays 32-bit", () => {
  const [fn] = findFunctions("int add(int a, int b) { return a + b; }", "c");
  assert.equal(fn?.returns.c, "int32_t");
});
