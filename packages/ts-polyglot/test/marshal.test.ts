// The shared half that knows types: the TypeScript spelling of each kind in each position.
import assert from "node:assert/strict";
import test from "node:test";

import { jsType, structHelpers } from "../src/marshal.ts";
import type { NativeType } from "../src/signatures.ts";

const int = (bits: 8 | 16 | 32 | 64, signed: boolean): NativeType => ({ kind: "int", bits, signed, spelling: "x" });

test("jsType by kind and position", () => {
  assert.deepEqual(["param", "result", "field"].map((p) => jsType(int(64, true), p as "param")), ["number | bigint", "bigint", "bigint"]);
  assert.deepEqual([int(32, false), { kind: "float", bits: 32 }, { kind: "bool" }, { kind: "char" }, { kind: "void" }].map((t) => jsType({ spelling: "x", ...t } as NativeType, "result")), ["number", "number", "boolean", "string", "void"]);
  assert.equal(jsType({ kind: "string", nullable: true, spelling: "const char*" }, "field"), "string | null");
  assert.equal(jsType({ kind: "string", nullable: false, spelling: "String" }, "param"), "string");
  assert.equal(jsType({ kind: "struct", name: "Point", spelling: "Point" }, "param"), "Point");
  assert.equal(jsType({ kind: "reference", mutable: false, to: int(64, false), spelling: "&usize" }, "param"), "number | bigint");
  assert.throws(() => jsType({ kind: "pointer", to: int(32, true), const: false, spelling: "int*" }, "param"));
});

// A throwing getter leaves the property slot unwritten; the reader must not look at it.
test("a struct reader initializes the property slot and stops when the getter throws", () => {
  const text = structHelpers({ kind: "struct", c: "struct Point", name: "Point", fields: [{ name: "x", member: "x", type: { kind: "int", c: "int", bits: 32, signed: true, min: "INT_MIN", max: "INT_MAX" } }] });
  assert.match(text, /napi_value field = NULL;/);
  assert.match(text, /if \(napi_get_named_property\(env, value, "x", &field\) != napi_ok\) return false;/);
});
