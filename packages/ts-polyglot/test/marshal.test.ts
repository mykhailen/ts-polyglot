// The shared half that knows types: the TypeScript spelling of each kind in each position.
import assert from "node:assert/strict";
import test from "node:test";

import { jsType } from "../src/marshal.ts";
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
