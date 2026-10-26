// The shared half that knows types: the TypeScript spelling of each kind in each position.
import assert from "node:assert/strict";
import test from "node:test";

import { glueSource } from "../src/glue.ts";
import { abiId, type AbiType } from "../src/languages/language.ts";
import { ABI_HEADER, HELPERS, arrayHelpers, cleanup, jsType, makeResult, readArgument, structHelpers } from "../src/marshal.ts";
import type { NativeFunction, NativeType } from "../src/signatures.ts";

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

test("abiId tells element types apart by C spelling, kind, bound and length", () => {
  const i = (c: string): AbiType => ({ kind: "int", c, bits: 64, signed: true, min: "0", max: "1" });
  assert.deepEqual([i("long"), i("unsigned long"), i("int64_t"), { kind: "float", c: "double", bits: 64 }, { kind: "bool", c: "bool" }, { kind: "char", c: "uint32_t" }, { kind: "cstring", c: "const char*" }, { kind: "string", c: "ts_polyglot_string" }, { kind: "string", c: "ts_polyglot_string", max: 15 }].map((a) => abiId(a as AbiType)), ["int_long", "int_unsigned_long", "int_int64_t", "float_double", "bool", "char", "cstring", "string", "string_15"]);
  const point: AbiType = { kind: "struct", c: "struct Point", name: "Point", fields: [] };
  assert.equal(abiId(point), "struct_struct_Point");
  assert.equal(abiId({ kind: "array", c: "ts_polyglot_array", of: i("int32_t") }), "array_int_int32_t");
  assert.equal(abiId({ kind: "array", c: "ts_polyglot_array", of: { kind: "float", c: "float", bits: 32 }, length: 3 }), "array_3_float_float");
  assert.equal(abiId({ kind: "array", c: "ts_polyglot_array", of: { kind: "array", c: "ts_polyglot_array", of: point } }), "array_array_struct_struct_Point");
});

test("jsType for arrays: readonly in parameters, tuples for fixed lengths, Uint8Array for unsigned bytes, parentheses around unions and nested readonly", () => {
  const arr = (of: NativeType, length?: number): NativeType => ({ kind: "array", of, length, spelling: "x" });
  const f64: NativeType = { kind: "float", bits: 64, spelling: "f64" };
  assert.equal(jsType(arr(int(32, true)), "param"), "readonly number[]");
  assert.equal(jsType(arr(int(32, true)), "result"), "number[]");
  assert.equal(jsType(arr(int(64, true)), "param"), "readonly (number | bigint)[]");
  assert.equal(jsType(arr(int(64, true)), "field"), "bigint[]");
  assert.equal(jsType(arr({ kind: "string", nullable: true, spelling: "c" }), "result"), "(string | null)[]");
  assert.equal(jsType(arr(arr(f64)), "param"), "readonly (readonly number[])[]");
  assert.equal(jsType(arr(arr(f64)), "result"), "number[][]");
  assert.equal(jsType(arr(f64, 3), "param"), "readonly [number, number, number]");
  assert.equal(jsType(arr(f64, 3), "field"), "[number, number, number]");
  assert.equal(jsType(arr(arr(f64, 2)), "result"), "[number, number][]");
  assert.equal(jsType(arr(arr(int(64, false), 2)), "param"), "readonly (readonly [number | bigint, number | bigint])[]");
  assert.equal(jsType(arr(int(8, false)), "param"), "Uint8Array");
  assert.equal(jsType(arr(int(8, false), 16), "result"), "Uint8Array");
  assert.equal(jsType(arr(int(8, true)), "param"), "readonly number[]");
  assert.equal(jsType(arr({ kind: "struct", name: "Point", spelling: "Point" }), "field"), "Point[]");
  assert.equal(jsType({ kind: "string", nullable: false, max: 15, spelling: "char[16]" }, "field"), "string");
  assert.equal(jsType({ kind: "reference", mutable: false, to: arr(int(32, true)), spelling: "&[i32]" }, "param"), "readonly number[]");
});

const i32: AbiType = { kind: "int", c: "int32_t", bits: 32, signed: true, min: "INT32_MIN", max: "INT32_MAX" };
const u8: AbiType = { kind: "int", c: "uint8_t", bits: 8, signed: false, min: "0", max: "UINT8_MAX" };
const str: AbiType = { kind: "string", c: "ts_polyglot_string" };
const list = (of: AbiType, length?: number): AbiType & { kind: "array" } => ({ kind: "array", c: "ts_polyglot_array", of, length });

test("the ABI header and the helpers carry the array type, the bytes path and the bounded string", () => {
  assert.match(ABI_HEADER, /typedef struct \{ void\* ptr; size_t len; void \(\*release\)\(void\*, size_t\); \} ts_polyglot_array;/);
  assert.match(HELPERS, /static bool ts_polyglot_read_bytes\(napi_env env, napi_value value, ts_polyglot_array\* out, const char\* fn, const ts_polyglot_path\* path\)/);
  assert.match(HELPERS, /if \(type != napi_uint8_array\) return ts_polyglot_fail\(env, false, fn, path, "a Uint8Array"\);/);
  assert.match(HELPERS, /"a Uint8Array that isn't detached"/);
  // Copied, not lent: a getter run while a later argument is read could detach or resize the buffer.
  assert.match(HELPERS, /out->ptr = ts_polyglot_alloc\(length, 1\);[\s\S]*if \(length\) memcpy\(out->ptr, data, length\);/);
  assert.match(HELPERS, /static bool ts_polyglot_read_string\(napi_env env, napi_value value, ts_polyglot_string\* out, size_t max, const char\* fn, const ts_polyglot_path\* path\)/);
  assert.match(HELPERS, /napi_create_typedarray\(env, napi_uint8_array, /);
});

test("a path is a chain of names and indexes rendered only when a check fails", () => {
  assert.match(HELPERS, /typedef struct ts_polyglot_path \{ const struct ts_polyglot_path\* parent; const char\* name; size_t index; \} ts_polyglot_path;/);
  assert.match(HELPERS, /static void ts_polyglot_render\(const ts_polyglot_path\* path, char\* out, size_t size\)/);
  assert.match(HELPERS, /static bool ts_polyglot_fail\(napi_env env, bool range, const char\* fn, const ts_polyglot_path\* path, const char\* what\)/);
  const struct = structHelpers({ kind: "struct", c: "struct Point", name: "Point", fields: [{ name: "x", member: "x", type: i32 }] });
  assert.match(struct, /ts_polyglot_path child = \{ path, NULL, 0 \};/);
  assert.match(struct, /child\.name = "x";\n\s*if \(napi_get_named_property/);
  assert.match(struct, /ts_polyglot_read_int\(env, field, [^;]*&wide, fn, &child\)/);
});

test("an array reader checks for an array, allocates zeroed storage before reading, indexes the path without formatting it and stops on a throwing getter", () => {
  const text = arrayHelpers(list(i32));
  assert.match(text, /static bool ts_polyglot_read_array_int_int32_t\(napi_env env, napi_value value, ts_polyglot_array\* out, const char\* fn, const ts_polyglot_path\* path\) \{/);
  assert.match(text, /if \(!is_array\) return ts_polyglot_fail\(env, false, fn, path, "an array"\);/);
  assert.match(text, /items = \(int32_t\*\)ts_polyglot_alloc\(length, sizeof\(int32_t\)\);/);
  assert.match(text, /out->ptr = items;\n\s*out->len = length;\n\s*out->release = NULL;\n\s*for \(/);
  assert.match(text, /ts_polyglot_path child = \{ path, NULL, 0 \};/);
  assert.match(text, /child\.index = i;/);
  assert.doesNotMatch(text, /snprintf/);
  assert.match(text, /if \(napi_get_element\(env, value, i, &element\) != napi_ok\) return false;/);
  assert.match(text, /static napi_value ts_polyglot_make_array_int_int32_t\(napi_env env, ts_polyglot_array value\) \{/);
  assert.match(text, /napi_create_array_with_length\(env, length, &result\);/);
  assert.match(text, /if \(value\.release\) value\.release\(value\.ptr, value\.len\);/);
});

test("a fixed length is checked before anything is allocated; bytes go through the typed-array helpers", () => {
  const fixed = arrayHelpers(list({ kind: "float", c: "float", bits: 32 }, 3));
  assert.ok(fixed.indexOf('if (length != 3) return ts_polyglot_fail_must(env, true, fn, path, "have 3 elements");') < fixed.indexOf("ts_polyglot_alloc"));
  const bytes = arrayHelpers(list(u8, 16));
  assert.match(bytes, /if \(!ts_polyglot_read_bytes\(env, value, out, fn, path\)\) return false;\n\s*if \(out->len != 16\) return ts_polyglot_fail_must\(env, true, fn, path, "have 16 bytes"\);/);
  assert.match(bytes, /return ts_polyglot_make_bytes\(env, value\);/);
  assert.doesNotMatch(arrayHelpers(list(u8)), /out->len != /);
});

test("cleanup frees an array's elements then its storage, with a loop index per depth; a byte copy is storage too", () => {
  assert.deepEqual(cleanup(list(str), "arg0"), ["{ size_t i0; for (i0 = 0; i0 < arg0.len; i0++) { free(((ts_polyglot_string*)arg0.ptr)[i0].ptr); } }", "free(arg0.ptr);"]);
  assert.deepEqual(cleanup(list(i32), "arg0"), ["free(arg0.ptr);"]);
  assert.deepEqual(cleanup(list(u8), "arg0"), ["free(arg0.ptr);"]);
  assert.deepEqual(cleanup(list(list(u8)), "arg0"), ["{ size_t i0; for (i0 = 0; i0 < arg0.len; i0++) { free(((ts_polyglot_array*)arg0.ptr)[i0].ptr); } }", "free(arg0.ptr);"]);
  assert.deepEqual(cleanup(list(list(str)), "arg1"), ["{ size_t i0; for (i0 = 0; i0 < arg1.len; i0++) { { size_t i1; for (i1 = 0; i1 < ((ts_polyglot_array*)arg1.ptr)[i0].len; i1++) { free(((ts_polyglot_string*)((ts_polyglot_array*)arg1.ptr)[i0].ptr)[i1].ptr); } } free(((ts_polyglot_array*)arg1.ptr)[i0].ptr); } }", "free(arg1.ptr);"]);
});

test("readArgument and makeResult route arrays to their helpers and pass a string's bound", () => {
  assert.deepEqual(readArgument({ ...str, max: 15 }, "v", "x", "fn, path"), ["if (!ts_polyglot_read_string(env, v, &x, 15, fn, path)) goto fail;"]);
  assert.deepEqual(readArgument(str, "v", "x", "fn, path"), ["if (!ts_polyglot_read_string(env, v, &x, SIZE_MAX, fn, path)) goto fail;"]);
  assert.deepEqual(readArgument(list(i32), "v", "x", "fn, path", "return false;"), ["if (!ts_polyglot_read_array_int_int32_t(env, v, &x, fn, path)) return false;"]);
  assert.deepEqual(makeResult(list(list(str)), "v", "x"), ["x = ts_polyglot_make_array_array_string(env, v);"]);
});

test("the glue declares every struct and array helper before defining them, each once", () => {
  const point: AbiType = { kind: "struct", c: "struct Point", name: "Point", fields: [{ name: "x", member: "x", type: i32 }] };
  const poly: AbiType = { kind: "struct", c: "struct Poly", name: "Poly", fields: [{ name: "pts", member: "pts", type: list(point, 2) }] };
  const callee = { name: "f", params: [list(list(point)), poly], returns: list(point, 2), reportsErrors: false };
  const fn = { name: "f", nameStart: 0, callee: "f", params: [{ name: "a", type: { kind: "unknown", spelling: "" } }, { name: "b", type: { kind: "unknown", spelling: "" } }], returns: { kind: "void", spelling: "void" }, signature: "" } as NativeFunction;
  const glue = glueSource({ functions: [fn], structs: [] }, { prelude: "", libs: [], callee: () => callee });
  for (const name of ["ts_polyglot_read_Point", "ts_polyglot_read_Poly", "ts_polyglot_read_array_struct_struct_Point", "ts_polyglot_read_array_array_struct_struct_Point", "ts_polyglot_read_array_2_struct_struct_Point"]) {
    const occurrences = glue.split(`static bool ${name}(`);
    assert.equal(occurrences.length - 1, 2, `${name}: one prototype and one definition`);
    // The first occurrence is the prototype: its line ends the declaration.
    assert.ok(occurrences[1]!.split("\n")[0]!.endsWith(";"), `${name} is declared before it is defined`);
  }
});
