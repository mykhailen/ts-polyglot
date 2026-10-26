// The model: what the glue marshals, and the types the C table gives the platform-dependent spellings.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { findFunctions, loadLanguage } from "../src/languages/index.ts";
import { parseIntegerLiteral, structsInDependencyOrder, supported, visibleParams, type NativeFunction, type NativeModule, type NativeStruct, type NativeType, type Param } from "../src/signatures.ts";

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

test("supported: a struct in the module whose fields all cross, recursively", () => {
  const struct = (name: string, fields: [string, NativeType][]): NativeStruct => ({ name, nameStart: 0, path: [], spelling: `struct ${name}`, fields: fields.map(([n, type]) => ({ name: n, nameStart: 0, type })) });
  const module: NativeModule = {
    functions: [],
    structs: [
      struct("Point", [["x", int(32, true)], ["y", int(64, false)]]),
      struct("Bad", [["p", { kind: "pointer", to: int(32, true), const: false, spelling: "int*" }]]),
      struct("Nest", [["b", { kind: "struct", name: "Bad", spelling: "struct Bad" }]]),
      struct("Ref", [["r", { kind: "reference", mutable: false, to: int(32, true), spelling: "const int&" }]]),
    ],
  };
  assert.ok(supported({ kind: "struct", name: "Point", spelling: "struct Point" }, module));
  assert.ok(supported({ kind: "reference", mutable: false, to: { kind: "struct", name: "Point", spelling: "Point" }, spelling: "const Point&" }, module));
  assert.equal(supported({ kind: "struct", name: "Bad", spelling: "struct Bad" }, module), false);
  assert.equal(supported({ kind: "struct", name: "Nest", spelling: "struct Nest" }, module), false);
  assert.equal(supported({ kind: "struct", name: "Ref", spelling: "struct Ref" }, module), false); // a reference field can't be assigned after the fact
  assert.equal(supported({ kind: "struct", name: "Missing", spelling: "Missing" }, module), false);
});

test("supported: mutable references, pointers, arrays of unknowns and unknowns are not", () => {
  assert.equal(supported({ kind: "reference", to: int(32, true), mutable: true, spelling: "int&" }, empty), false);
  assert.equal(supported({ kind: "pointer", to: int(32, true), const: false, spelling: "int*" }, empty), false);
  assert.equal(supported({ kind: "array", of: { kind: "unknown", spelling: "T" }, spelling: "T[]" }, empty), false);
  assert.equal(supported({ kind: "unknown", spelling: "size_t" }, empty), false);
});

test("supported: arrays of supported, non-reference elements, nested; not of references, pointers, unknowns or void", () => {
  const arr = (of: NativeType, length?: number): NativeType => ({ kind: "array", of, length, spelling: "x" });
  assert.ok(supported(arr(int(32, true)), empty));
  assert.ok(supported(arr(arr({ kind: "string", nullable: true, spelling: "const char*" }), 3), empty));
  assert.ok(supported({ kind: "reference", mutable: false, to: arr(int(8, false)), spelling: "&[u8]" }, empty));
  assert.equal(supported(arr({ kind: "reference", mutable: false, to: { kind: "string", nullable: false, spelling: "str" }, spelling: "&str" }), empty), false);
  assert.equal(supported(arr({ kind: "pointer", to: int(32, true), const: false, spelling: "int*" }), empty), false);
  assert.equal(supported(arr({ kind: "unknown", spelling: "T" }), empty), false);
  assert.equal(supported(arr({ kind: "void", spelling: "void" }), empty), false);
});

test("visibleParams hides a parameter that is another's length, wherever it sits", () => {
  const n: Param = { name: "n", nameStart: 0, type: int(64, false, "size_t") };
  const xs: Param = { name: "xs", nameStart: 0, type: { kind: "array", of: { kind: "float", bits: 64, spelling: "double" }, spelling: "double[]" }, length: { name: "n", type: n.type } };
  const fn = (params: Param[]): NativeFunction => ({ name: "f", nameStart: 0, callee: "f", params, returns: { kind: "void", spelling: "void" }, signature: "" });
  assert.deepEqual(visibleParams(fn([xs, n])).map((p) => p.name), ["xs"]);
  assert.deepEqual(visibleParams(fn([n, xs, { ...xs, name: "ys" }])).map((p) => p.name), ["xs", "ys"]);
  assert.deepEqual(visibleParams(fn([n])).map((p) => p.name), ["n"]);
});

test("parseIntegerLiteral reads every base, separators and suffixes, and rejects zero, names, expressions and floats", () => {
  assert.deepEqual(["4", "0x10", "0X1f", "010", "0b101", "0B11", "1'000", "0x1'F", "16u", "32UL", "7ll"].map((t) => parseIntegerLiteral(t, "c")), [4, 16, 31, 8, 5, 3, 1000, 31, 16, 32, 7]);
  assert.deepEqual(["4", "0x10", "0o17", "0b101", "1_000", "4usize", "8u8", "010"].map((t) => parseIntegerLiteral(t, "rust")), [4, 16, 15, 5, 1000, 4, 8, 10]);
  for (const t of ["0", "N", "2 + 1", "", "1e3", "1.5", "(32)", "-1", "99999999999999999999"]) assert.equal(parseIntegerLiteral(t, "c"), undefined, t);
});

test("structsInDependencyOrder follows array and reference fields", () => {
  const struct = (name: string, fields: [string, NativeType][]): NativeStruct => ({ name, nameStart: 0, path: [], spelling: name, fields: fields.map(([n, type]) => ({ name: n, nameStart: 0, type })) });
  const point: NativeType = { kind: "struct", name: "Point", spelling: "Point" };
  const module: NativeModule = { functions: [], structs: [struct("Poly", [["pts", { kind: "array", of: point, length: 4, spelling: "Point[4]" }]]), struct("Point", [["x", int(32, true)]])] };
  assert.deepEqual(structsInDependencyOrder(module).map((s) => s.name), ["Point", "Poly"]);
});
