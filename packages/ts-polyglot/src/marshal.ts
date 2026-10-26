// The shared half of marshaling, which knows types but no language: the TypeScript spelling of a
// type, the C ABI header the glue and every bridge agree on, the static helpers that read a
// JavaScript value strictly and make one back, and the C for one argument or result. Everything here
// is the common subset of C and C++, since the glue is compiled as either.
import { abiId, type AbiType } from "./languages/language.ts";
import type { NativeType } from "./signatures.ts";

/** The TypeScript type of a value in a parameter, result or field position. */
export function jsType(type: NativeType, position: "param" | "result" | "field"): string {
  switch (type.kind) {
    case "void":
      return "void";
    case "bool":
      return "boolean";
    case "int":
      // 64 bits don't fit a number; a parameter still takes one for the common small values.
      if (type.bits === 64) return position === "param" ? "number | bigint" : "bigint";
      return "number";
    case "float":
      return "number";
    case "char":
      return "string";
    case "string":
      return type.nullable ? "string | null" : "string";
    case "struct":
      return type.name;
    case "reference":
      return jsType(type.to, position);
    case "array": {
      // Unsigned bytes are a buffer whatever the length; `char`, `signed char` and `i8` elements are numbers.
      if (type.of.kind === "int" && type.of.bits === 8 && !type.of.signed) return "Uint8Array";
      // The element's own type in this position: `readonly` goes all the way down for a parameter.
      const element = jsType(type.of, position);
      // A union or a nested readonly element needs parentheses before `[]`; a tuple's entries don't.
      const wrapped = element.includes("|") || element.startsWith("readonly") ? `(${element})` : element;
      const inner = type.length === undefined ? `${wrapped}[]` : `[${Array.from({ length: type.length }, () => element).join(", ")}]`;
      return position === "param" ? `readonly ${inner}` : inner;
    }
    default:
      throw new Error(`ts-polyglot: ${type.spelling} isn't marshaled`);
  }
}

/** What every glue starts with: the headers the helpers need, and the one shape strings and error messages cross in. */
export const ABI_HEADER = `#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <node_api.h>

// Text in either direction. release is NULL for a borrowed string (every argument the glue passes)
// and the function that frees an owned one (every result from a shim or a wrapper).
typedef struct { char* ptr; size_t len; void (*release)(char*, size_t); } ts_polyglot_string;
// A sequence in either direction: len elements of the element's C type behind ptr. release is NULL
// for a buffer the glue made (it frees it after the call) or a JavaScript buffer it lent for the
// call; a result from a shim or wrapper carries the function that frees it, called after the elements'.
// A NULL ptr is empty whatever len says.
typedef struct { void* ptr; size_t len; void (*release)(void*, size_t); } ts_polyglot_array;`;

/** The readers and makers, the same text in every glue. A reader throws and returns false when the value isn't what `what` says. */
export const HELPERS = `// Wrong JavaScript type: TypeError. Right type, impossible value: RangeError. The message names the function and the value's path.
static bool ts_polyglot_fail(napi_env env, bool range, const char* fn, const char* path, const char* what) {
  char message[512];
  snprintf(message, sizeof message, "%s(): %s must be %s", fn, path, what);
  if (range) napi_throw_range_error(env, NULL, message);
  else napi_throw_type_error(env, NULL, message);
  return false;
}

// The same, for what a value must have rather than be: "must have 3 elements".
static bool ts_polyglot_fail_must(napi_env env, bool range, const char* fn, const char* path, const char* rest) {
  char message[512];
  snprintf(message, sizeof message, "%s(): %s must %s", fn, path, rest);
  if (range) napi_throw_range_error(env, NULL, message);
  else napi_throw_type_error(env, NULL, message);
  return false;
}

// Zeroed element storage, never NULL for an empty array: a C function gets a pointer it can read
// zero elements from, and cleanup can run over elements that were never read.
static void* ts_polyglot_alloc(size_t count, size_t size) {
  return calloc(count ? count : 1, size);
}

// An integer takes a number or a bigint. A number must be finite, integral and safe (anything past 2^53
// has already lost bits); a bigint must convert without loss. Either must then fit the C type's limits,
// which the caller passes as the type's own macros, so the platform's widths apply.
static bool ts_polyglot_read_int(napi_env env, napi_value value, int64_t min, int64_t max, int64_t* out, const char* fn, const char* path) {
  char what[128];
  napi_valuetype type;
  napi_typeof(env, value, &type);
  snprintf(what, sizeof what, "an integer between %lld and %lld", (long long)min, (long long)max);
  if (type == napi_number) {
    double d;
    napi_get_value_double(env, value, &d);
    if (!isfinite(d) || floor(d) != d || fabs(d) > 9007199254740991.0 || d < (double)min || d > (double)max) return ts_polyglot_fail(env, true, fn, path, what);
    *out = (int64_t)d;
    return true;
  }
  if (type == napi_bigint) {
    bool lossless;
    int64_t v;
    napi_get_value_bigint_int64(env, value, &v, &lossless);
    if (!lossless || v < min || v > max) return ts_polyglot_fail(env, true, fn, path, what);
    *out = v;
    return true;
  }
  return ts_polyglot_fail(env, false, fn, path, what);
}

static bool ts_polyglot_read_uint(napi_env env, napi_value value, uint64_t max, uint64_t* out, const char* fn, const char* path) {
  char what[128];
  napi_valuetype type;
  napi_typeof(env, value, &type);
  snprintf(what, sizeof what, "an integer between 0 and %llu", (unsigned long long)max);
  if (type == napi_number) {
    double d;
    napi_get_value_double(env, value, &d);
    if (!isfinite(d) || floor(d) != d || fabs(d) > 9007199254740991.0 || d < 0 || d > (double)max) return ts_polyglot_fail(env, true, fn, path, what);
    *out = (uint64_t)d;
    return true;
  }
  if (type == napi_bigint) {
    bool lossless;
    uint64_t v;
    napi_get_value_bigint_uint64(env, value, &v, &lossless);
    if (!lossless || v > max) return ts_polyglot_fail(env, true, fn, path, what);
    *out = v;
    return true;
  }
  return ts_polyglot_fail(env, false, fn, path, what);
}

static bool ts_polyglot_read_double(napi_env env, napi_value value, double* out, const char* fn, const char* path) {
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type != napi_number) return ts_polyglot_fail(env, false, fn, path, "a number");
  napi_get_value_double(env, value, out);
  return true;
}

static bool ts_polyglot_read_bool(napi_env env, napi_value value, bool* out, const char* fn, const char* path) {
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type != napi_boolean) return ts_polyglot_fail(env, false, fn, path, "a boolean");
  napi_get_value_bool(env, value, out);
  return true;
}

// One Unicode scalar value: a single code unit that isn't a surrogate, or one surrogate pair.
static bool ts_polyglot_read_char(napi_env env, napi_value value, uint32_t* out, const char* fn, const char* path) {
  napi_valuetype type;
  size_t length;
  char16_t units[3];
  napi_typeof(env, value, &type);
  if (type != napi_string) return ts_polyglot_fail(env, false, fn, path, "one character");
  napi_get_value_string_utf16(env, value, NULL, 0, &length);
  if (length == 0 || length > 2) return ts_polyglot_fail(env, true, fn, path, "one character");
  napi_get_value_string_utf16(env, value, units, 3, &length);
  if (length == 1 && (units[0] < 0xD800 || units[0] > 0xDFFF)) {
    *out = units[0];
    return true;
  }
  if (length == 2 && units[0] >= 0xD800 && units[0] <= 0xDBFF && units[1] >= 0xDC00 && units[1] <= 0xDFFF) {
    *out = 0x10000 + (((uint32_t)units[0] - 0xD800) << 10) + ((uint32_t)units[1] - 0xDC00);
    return true;
  }
  return ts_polyglot_fail(env, true, fn, path, "one character");
}

static napi_value ts_polyglot_make_char(napi_env env, uint32_t c) {
  char16_t units[2];
  size_t length = 1;
  napi_value result;
  if (c >= 0x10000) {
    units[0] = (char16_t)(0xD800 + ((c - 0x10000) >> 10));
    units[1] = (char16_t)(0xDC00 + ((c - 0x10000) & 0x3FF));
    length = 2;
  } else {
    units[0] = (char16_t)c;
  }
  napi_create_string_utf16(env, units, length, &result);
  return result;
}

// A C string: a malloc'd NUL-terminated UTF-8 copy, or NULL for null. The C side would see an embedded
// NUL as the end of the string, so one is a RangeError.
static bool ts_polyglot_read_cstring(napi_env env, napi_value value, char** out, const char* fn, const char* path) {
  napi_valuetype type;
  size_t length;
  char* copy;
  napi_typeof(env, value, &type);
  if (type == napi_null) {
    *out = NULL;
    return true;
  }
  if (type != napi_string) return ts_polyglot_fail(env, false, fn, path, "a string without NUL characters, or null");
  napi_get_value_string_utf8(env, value, NULL, 0, &length);
  copy = (char*)malloc(length + 1);
  if (!copy) return ts_polyglot_fail(env, true, fn, path, "a string that fits in memory");
  napi_get_value_string_utf8(env, value, copy, length + 1, &length);
  if (strlen(copy) != length) {
    free(copy);
    return ts_polyglot_fail(env, true, fn, path, "a string without NUL characters, or null");
  }
  *out = copy;
  return true;
}

// Text with its length, for a shim or wrapper: a malloc'd copy the glue frees after the call, with a
// NUL after it. A NUL inside is just a byte, unless max bounds the string: then it's headed for a C
// char[max + 1], which ends at the first NUL, so one inside is refused like a length past the bound.
static bool ts_polyglot_read_string(napi_env env, napi_value value, ts_polyglot_string* out, size_t max, const char* fn, const char* path) {
  napi_valuetype type;
  size_t length;
  char what[128];
  napi_typeof(env, value, &type);
  if (type != napi_string) return ts_polyglot_fail(env, false, fn, path, "a string");
  napi_get_value_string_utf8(env, value, NULL, 0, &length);
  out->ptr = (char*)malloc(length + 1);
  if (!out->ptr) return ts_polyglot_fail(env, true, fn, path, "a string that fits in memory");
  napi_get_value_string_utf8(env, value, out->ptr, length + 1, &length);
  out->len = length;
  out->release = NULL;
  if (max != SIZE_MAX && (length > max || strlen(out->ptr) != length)) {
    snprintf(what, sizeof what, "at most %llu UTF-8 bytes without NUL characters", (unsigned long long)max);
    return ts_polyglot_fail(env, true, fn, path, what);
  }
  return true;
}

// A byte buffer is lent, not copied: the Uint8Array's own memory, for the length of the call. The
// pointer Node-API gives is already at the view's offset (measured). A view on a detached buffer
// reads as empty, so it's refused by name instead. A Buffer is a Uint8Array; other typed arrays aren't.
static bool ts_polyglot_read_bytes(napi_env env, napi_value value, ts_polyglot_array* out, const char* fn, const char* path) {
  bool typed = false;
  bool detached = false;
  napi_typedarray_type type;
  size_t length = 0;
  void* data = NULL;
  napi_value buffer = NULL;
  napi_is_typedarray(env, value, &typed);
  if (!typed) return ts_polyglot_fail(env, false, fn, path, "a Uint8Array");
  napi_get_typedarray_info(env, value, &type, &length, &data, &buffer, NULL);
  if (type != napi_uint8_array) return ts_polyglot_fail(env, false, fn, path, "a Uint8Array");
  napi_is_detached_arraybuffer(env, buffer, &detached);
  if (detached) return ts_polyglot_fail(env, false, fn, path, "a Uint8Array that isn't detached");
  out->ptr = data;
  out->len = length;
  out->release = NULL;
  return true;
}

// A byte result: copied into a fresh ArrayBuffer behind a plain Uint8Array (not a Buffer: the
// TypeScript type says Uint8Array), then released if it was owned.
static napi_value ts_polyglot_make_bytes(napi_env env, ts_polyglot_array value) {
  napi_value buffer;
  napi_value result;
  void* data = NULL;
  size_t length = value.ptr ? value.len : 0;
  napi_create_arraybuffer(env, length, &data, &buffer);
  if (length) memcpy(data, value.ptr, length);
  napi_create_typedarray(env, napi_uint8_array, length, buffer, 0, &result);
  if (value.release) value.release(value.ptr, value.len);
  return result;
}

// A C string result is borrowed: copied, never freed. NULL is null.
static napi_value ts_polyglot_make_cstring(napi_env env, const char* text) {
  napi_value result;
  if (text) napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &result);
  else napi_get_null(env, &result);
  return result;
}

// A string result from a shim or wrapper: copied, then released if it was owned.
static napi_value ts_polyglot_make_string(napi_env env, ts_polyglot_string text) {
  napi_value result;
  napi_create_string_utf8(env, text.ptr ? text.ptr : "", text.len, &result);
  if (text.release) text.release(text.ptr, text.len);
  return result;
}

// The error slot a shim or wrapper filled: thrown as an Error with the message, then released.
static void ts_polyglot_throw_slot(napi_env env, ts_polyglot_string error) {
  char* message = (char*)malloc(error.len + 1);
  if (message) {
    memcpy(message, error.ptr, error.len);
    message[error.len] = 0;
  }
  napi_throw_error(env, NULL, message ? message : "the native call failed");
  free(message);
  if (error.release) error.release(error.ptr, error.len);
}`;

/**
 * C that reads the JavaScript value `value` into the C lvalue `into`, or runs `onFail` after throwing.
 * `where` is the C for the message's function and path arguments, literals or variables. A reader
 * never frees what it has read: the glue's cleanup does, over every argument, which zero-initialization
 * makes safe for what was never read.
 */
export function readArgument(abi: AbiType, value: string, into: string, where: string, onFail = "goto fail;"): string[] {
  switch (abi.kind) {
    case "int":
      // Read at full width against the type's own limits, then narrow: the check has already passed.
      return abi.signed
        ? [`{ int64_t wide; if (!ts_polyglot_read_int(env, ${value}, (int64_t)(${abi.min}), (int64_t)(${abi.max}), &wide, ${where})) ${onFail} ${into} = (${abi.c})wide; }`]
        : [`{ uint64_t wide; if (!ts_polyglot_read_uint(env, ${value}, (uint64_t)(${abi.max}), &wide, ${where})) ${onFail} ${into} = (${abi.c})wide; }`];
    case "float":
      return [`{ double wide; if (!ts_polyglot_read_double(env, ${value}, &wide, ${where})) ${onFail} ${into} = (${abi.c})wide; }`];
    case "bool":
      return [`if (!ts_polyglot_read_bool(env, ${value}, &${into}, ${where})) ${onFail}`];
    case "char":
      return [`if (!ts_polyglot_read_char(env, ${value}, &${into}, ${where})) ${onFail}`];
    case "cstring":
      // The local is the `const char*` the callee takes; the reader writes it through a `char**`.
      return [`if (!ts_polyglot_read_cstring(env, ${value}, (char**)&${into}, ${where})) ${onFail}`];
    case "string":
      return [`if (!ts_polyglot_read_string(env, ${value}, &${into}, ${abi.max ?? "SIZE_MAX"}, ${where})) ${onFail}`];
    case "struct":
      return [`if (!ts_polyglot_read_${abi.name}(env, ${value}, &${into}, ${where})) ${onFail}`];
    case "array":
      return [`if (!ts_polyglot_read_${abiId(abi)}(env, ${value}, &${into}, ${where})) ${onFail}`];
    default:
      throw new Error(`ts-polyglot: ${abi.kind} arguments aren't marshaled`);
  }
}

/** Unsigned 8-bit elements cross as a Uint8Array; `char`, `signed char` and `i8` elements are numbers. */
const bytes = (abi: AbiType) => abi.kind === "int" && abi.bits === 8 && !abi.signed;

/** The declarations of a struct's or an array's reader and maker, so the definitions can come in any order. */
export function helperPrototype(abi: AbiType & { kind: "struct" | "array" }): string {
  if (abi.kind === "struct") return `static bool ts_polyglot_read_${abi.name}(napi_env env, napi_value value, ${abi.c}* out, const char* fn, const char* path);\nstatic napi_value ts_polyglot_make_${abi.name}(napi_env env, ${abi.c} value);`;
  const id = abiId(abi);
  return `static bool ts_polyglot_read_${id}(napi_env env, napi_value value, ts_polyglot_array* out, const char* fn, const char* path);\nstatic napi_value ts_polyglot_make_${id}(napi_env env, ts_polyglot_array value);`;
}

/**
 * The reader and the maker for one array type, named by its element. The reader records the storage
 * in the ABI array before reading any element, zeroed, so cleanup is safe at any point; each element
 * goes through its own reader with the path extended by the index. The maker fills a fresh Array
 * element by element, then releases what the native side owned, after the elements' makers released
 * theirs. Bytes take the typed-array helpers instead, with the length check on top.
 */
export function arrayHelpers(abi: AbiType & { kind: "array" }): string {
  const id = abiId(abi);
  const reader = `static bool ts_polyglot_read_${id}(napi_env env, napi_value value, ts_polyglot_array* out, const char* fn, const char* path) {`;
  const maker = `static napi_value ts_polyglot_make_${id}(napi_env env, ts_polyglot_array value) {`;
  if (bytes(abi.of)) {
    return [
      reader,
      "  if (!ts_polyglot_read_bytes(env, value, out, fn, path)) return false;",
      ...(abi.length === undefined ? [] : [`  if (out->len != ${abi.length}) return ts_polyglot_fail_must(env, true, fn, path, "have ${abi.length} bytes");`]),
      "  return true;",
      "}",
      "",
      maker,
      "  return ts_polyglot_make_bytes(env, value);",
      "}",
      "",
    ].join("\n");
  }
  const element = abi.of.c;
  return [
    reader,
    "  bool is_array = false;",
    "  uint32_t length = 0;",
    "  uint32_t i;",
    "  napi_value element = NULL;",
    `  ${element}* items;`,
    "  char child[512];",
    "  napi_is_array(env, value, &is_array);",
    '  if (!is_array) return ts_polyglot_fail(env, false, fn, path, "an array");',
    "  napi_get_array_length(env, value, &length);",
    ...(abi.length === undefined ? [] : [`  if (length != ${abi.length}) return ts_polyglot_fail_must(env, true, fn, path, "have ${abi.length} elements");`]),
    `  items = (${element}*)ts_polyglot_alloc(length, sizeof(${element}));`,
    '  if (!items) return ts_polyglot_fail(env, true, fn, path, "an array that fits in memory");',
    "  out->ptr = items;",
    "  out->len = length;",
    "  out->release = NULL;",
    "  for (i = 0; i < length; i++) {",
    '    snprintf(child, sizeof child, "%s[%u]", path, (unsigned)i);',
    // A hole reads as undefined and fails the element's type check; a throwing getter propagates its own error.
    "    if (napi_get_element(env, value, i, &element) != napi_ok) return false;",
    ...readArgument(abi.of, "element", "items[i]", "fn, child", "return false;").map((line) => `    ${line}`),
    "  }",
    "  return true;",
    "}",
    "",
    maker,
    "  napi_value result;",
    "  napi_value element;",
    "  size_t i;",
    `  ${element}* items = (${element}*)value.ptr;`,
    "  size_t length = items ? value.len : 0;",
    "  napi_create_array_with_length(env, length, &result);",
    "  for (i = 0; i < length; i++) {",
    ...makeResult(abi.of, "items[i]", "element").map((line) => `    ${line}`),
    "    napi_set_element(env, result, (uint32_t)i, element);",
    "  }",
    "  if (value.release) value.release(value.ptr, value.len);",
    "  return result;",
    "}",
    "",
  ].join("\n");
}

/** The reader and the maker for one struct: field by field through the other helpers, with the path extended for the message. */
export function structHelpers(abi: AbiType & { kind: "struct" }): string {
  const what = JSON.stringify(abi.fields.length ? `an object with ${abi.fields.map((field) => field.name).join(", ")}` : "an object");
  const lines = [
    `static bool ts_polyglot_read_${abi.name}(napi_env env, napi_value value, ${abi.c}* out, const char* fn, const char* path) {`,
    "  napi_valuetype type;",
    "  bool is_array = false;",
    "  napi_value field = NULL;",
    "  char child[512];",
    "  napi_typeof(env, value, &type);",
    "  if (type == napi_object) napi_is_array(env, value, &is_array);",
    `  if (type != napi_object || is_array) return ts_polyglot_fail(env, false, fn, path, ${what});`,
  ];
  for (const field of abi.fields) {
    // A missing property reads as undefined, which the field's own reader rejects with the full path. A
    // getter that throws leaves the slot unwritten and an exception pending: stop, and let it propagate.
    lines.push(`  snprintf(child, sizeof child, "%s.${field.name}", path);`, `  if (napi_get_named_property(env, value, ${JSON.stringify(field.name)}, &field) != napi_ok) return false;`);
    lines.push(...readArgument(field.type, "field", `out->${field.member}`, "fn, child", "return false;").map((line) => `  ${line}`));
  }
  lines.push("  return true;", "}", "", `static napi_value ts_polyglot_make_${abi.name}(napi_env env, ${abi.c} value) {`, "  napi_value result;", "  napi_value field;", "  napi_create_object(env, &result);");
  for (const field of abi.fields) {
    lines.push(...makeResult(field.type, `value.${field.member}`, "field").map((line) => `  ${line}`), `  napi_set_named_property(env, result, ${JSON.stringify(field.name)}, field);`);
  }
  lines.push("  return result;", "}", "");
  return lines.join("\n");
}

/** C that makes the JavaScript value `into` from the C expression `value`. */
export function makeResult(abi: AbiType, value: string, into: string): string[] {
  switch (abi.kind) {
    case "void":
      return [`napi_get_undefined(env, &${into});`];
    case "int":
      if (abi.bits === 64) return [`${abi.signed ? "napi_create_bigint_int64" : "napi_create_bigint_uint64"}(env, (${abi.signed ? "int64_t" : "uint64_t"})(${value}), &${into});`];
      return [`${abi.signed ? "napi_create_int32" : "napi_create_uint32"}(env, (${abi.signed ? "int32_t" : "uint32_t"})(${value}), &${into});`];
    case "float":
      return [`napi_create_double(env, (double)(${value}), &${into});`];
    case "bool":
      return [`napi_get_boolean(env, ${value}, &${into});`];
    case "char":
      return [`${into} = ts_polyglot_make_char(env, ${value});`];
    case "cstring":
      return [`${into} = ts_polyglot_make_cstring(env, ${value});`];
    case "string":
      return [`${into} = ts_polyglot_make_string(env, ${value});`];
    case "struct":
      return [`${into} = ts_polyglot_make_${abi.name}(env, ${value});`];
    case "array":
      return [`${into} = ts_polyglot_make_${abiId(abi)}(env, ${value});`];
    default:
      // Every kind is handled above; this keeps the function total if one is added.
      throw new Error(`ts-polyglot: ${(abi as AbiType).kind} results aren't marshaled`);
  }
}

/**
 * C that frees what reading `value` as an argument left owned: the copies of strings and the element
 * storage of arrays, inside structs and arrays too. Safe on a value that was never read. A byte array
 * is JavaScript's own buffer, lent for the call, so nothing is freed. `depth` numbers nested loops.
 */
export function cleanup(abi: AbiType, value: string, depth = 0): string[] {
  switch (abi.kind) {
    case "cstring":
      return [`free((char*)${value});`];
    case "string":
      return [`free(${value}.ptr);`];
    case "struct":
      return abi.fields.flatMap((field) => cleanup(field.type, `${value}.${field.member}`, depth));
    case "array": {
      if (bytes(abi.of)) return [];
      const index = `i${depth}`;
      const elements = cleanup(abi.of, `((${abi.of.c}*)${value}.ptr)[${index}]`, depth + 1);
      return [...(elements.length ? [`{ size_t ${index}; for (${index} = 0; ${index} < ${value}.len; ${index}++) { ${elements.join(" ")} } }`] : []), `free(${value}.ptr);`];
    }
    default:
      return [];
  }
}
