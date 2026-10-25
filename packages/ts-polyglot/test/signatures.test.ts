// The parser's type tables, which the mapper and the runtime share.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, loadLanguage } from "../src/languages/index.ts";
import { BOOL, F64, I32, I64, U32, VOID, legacyKind, supported, toLegacy, type NativeFunction, type NativeModule, type NativeType } from "../src/signatures.ts";

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

// The model: what the glue marshals, and the seam that still feeds today's glue and mapper from it.
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
