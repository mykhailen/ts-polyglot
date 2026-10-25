// The model: what the glue marshals, and the types the C table gives the platform-dependent spellings.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, loadLanguage } from "../src/languages/index.ts";
import { supported, type NativeModule, type NativeType } from "../src/signatures.ts";

before(() => loadLanguage("c"));

test("C long is a 64-bit integer everywhere, unsigned long too, int stays 32-bit", () => {
  const [l, u, i] = findFunctions("long a(long x) { return x; }\nunsigned long b(unsigned long x) { return x; }\nint c(int x) { return x; }\n", "c");
  assert.deepEqual([l?.returns, u?.params[0]?.type, i?.returns], [{ kind: "int", bits: 64, signed: true, spelling: "long" }, { kind: "int", bits: 64, signed: false, spelling: "unsigned long" }, { kind: "int", bits: 32, signed: true, spelling: "int" }]);
});

const int = (bits: 8 | 16 | 32 | 64, signed: boolean, spelling = "int"): NativeType => ({ kind: "int", bits, signed, spelling });
const empty: NativeModule = { functions: [], structs: [] };

test("supported: primitives and immutable references to them", () => {
  for (const t of [int(8, true), int(64, false), { kind: "float", bits: 32, spelling: "float" }, { kind: "bool", spelling: "bool" }, { kind: "char", spelling: "char" }, { kind: "void", spelling: "void" }] as NativeType[]) assert.ok(supported(t, empty), t.spelling);
  assert.ok(supported({ kind: "reference", to: int(32, true), mutable: false, spelling: "const int&" }, empty));
});

test("supported: strings, nullable or not, and references to them", () => {
  assert.ok(supported({ kind: "string", nullable: true, spelling: "const char*" }, empty));
  assert.ok(supported({ kind: "string", nullable: false, spelling: "std::string" }, empty));
  assert.ok(supported({ kind: "reference", mutable: false, to: { kind: "string", nullable: false, spelling: "str" }, spelling: "&str" }, empty));
});

test("supported: mutable references, pointers, arrays and unknowns are not", () => {
  assert.equal(supported({ kind: "reference", to: int(32, true), mutable: true, spelling: "int&" }, empty), false);
  assert.equal(supported({ kind: "pointer", to: int(32, true), const: false, spelling: "int*" }, empty), false);
  assert.equal(supported({ kind: "array", of: int(32, true), spelling: "int[]" }, empty), false);
  assert.equal(supported({ kind: "unknown", spelling: "size_t" }, empty), false);
});
