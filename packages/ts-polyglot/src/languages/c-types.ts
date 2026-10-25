// The C and C++ type table: a spelling's structured type, the C type the glue declares it as, and the
// macros that bound it. The limits are macros, not numbers, so the compiler applies the platform's
// widths: `long` checks 32 bits on Windows and 64 elsewhere while its TypeScript type stays `bigint`.
import { oneLine, type NativeType } from "../signatures.ts";
import type { AbiType } from "./language.ts";

export interface CType {
  type: NativeType;
  /** The canonical spelling: what the glue declares a local or a shim parameter as. */
  c: string;
  /** For integers: the limit macros, or `0` for an unsigned minimum. */
  min?: string;
  max?: string;
}

const int = (bits: 8 | 16 | 32 | 64, signed: boolean, c: string, min: string, max: string): CType => ({ type: { kind: "int", bits, signed, spelling: c }, c, min, max });
const float = (bits: 32 | 64, c: string): CType => ({ type: { kind: "float", bits, spelling: c }, c });
const string = (c: string): CType => ({ type: { kind: "string", nullable: false, spelling: c }, c: "ts_polyglot_string" });

// `char` is signed or unsigned as the platform says; its limits are, too. The 64-bit class holds
// `long` and the pointer-sized types everywhere, so the TypeScript side never depends on the OS.
const TABLE = new Map<string, CType>([
  ["char", int(8, true, "char", "CHAR_MIN", "CHAR_MAX")],
  ["signed char", int(8, true, "signed char", "SCHAR_MIN", "SCHAR_MAX")],
  ["unsigned char", int(8, false, "unsigned char", "0", "UCHAR_MAX")],
  ["short", int(16, true, "short", "SHRT_MIN", "SHRT_MAX")],
  ["unsigned short", int(16, false, "unsigned short", "0", "USHRT_MAX")],
  ["int", int(32, true, "int", "INT_MIN", "INT_MAX")],
  ["unsigned int", int(32, false, "unsigned int", "0", "UINT_MAX")],
  ["long", int(64, true, "long", "LONG_MIN", "LONG_MAX")],
  ["unsigned long", int(64, false, "unsigned long", "0", "ULONG_MAX")],
  ["long long", int(64, true, "long long", "LLONG_MIN", "LLONG_MAX")],
  ["unsigned long long", int(64, false, "unsigned long long", "0", "ULLONG_MAX")],
  ["int8_t", int(8, true, "int8_t", "INT8_MIN", "INT8_MAX")],
  ["int16_t", int(16, true, "int16_t", "INT16_MIN", "INT16_MAX")],
  ["int32_t", int(32, true, "int32_t", "INT32_MIN", "INT32_MAX")],
  ["int64_t", int(64, true, "int64_t", "INT64_MIN", "INT64_MAX")],
  ["uint8_t", int(8, false, "uint8_t", "0", "UINT8_MAX")],
  ["uint16_t", int(16, false, "uint16_t", "0", "UINT16_MAX")],
  ["uint32_t", int(32, false, "uint32_t", "0", "UINT32_MAX")],
  ["uint64_t", int(64, false, "uint64_t", "0", "UINT64_MAX")],
  ["size_t", int(64, false, "size_t", "0", "SIZE_MAX")],
  ["ptrdiff_t", int(64, true, "ptrdiff_t", "PTRDIFF_MIN", "PTRDIFF_MAX")],
  ["intptr_t", int(64, true, "intptr_t", "INTPTR_MIN", "INTPTR_MAX")],
  ["uintptr_t", int(64, false, "uintptr_t", "0", "UINTPTR_MAX")],
  ["float", float(32, "float")],
  ["double", float(64, "double")],
  ["bool", { type: { kind: "bool", spelling: "bool" }, c: "bool" }],
  ["_Bool", { type: { kind: "bool", spelling: "_Bool" }, c: "bool" }],
  ["void", { type: { kind: "void", spelling: "void" }, c: "void" }],
  ["std::string", string("std::string")],
  ["std::string_view", string("std::string_view")],
]);

// The integer keywords combine in any order and with `int` or `signed` left out, so a spelling is
// looked up by what it says. `std::` is stripped from the <cstdint> names and `size_t`, but not from
// `std::string`, which is only a string with it.
const INTEGER_WORDS = new Set(["signed", "unsigned", "short", "long", "int", "char"]);

function canonical(spelling: string): string {
  const words = spelling.split(" ");
  if (words.every((word) => INTEGER_WORDS.has(word))) {
    const longs = words.filter((word) => word === "long").length;
    const base = words.includes("char") ? (words.includes("signed") ? "signed char" : "char") : words.includes("short") ? "short" : longs > 1 ? "long long" : longs === 1 ? "long" : "int";
    return words.includes("unsigned") ? `unsigned ${base}` : base;
  }
  return spelling.startsWith("std::") && !TABLE.has(spelling) ? spelling.slice("std::".length) : spelling;
}

/** The table entry for a spelling, however it orders its keywords; undefined for anything not a known primitive or string. */
export function cType(spelling: string): CType | undefined {
  return TABLE.get(canonical(oneLine(spelling)));
}

/** How a supported C or C++ type crosses the boundary: the user's own type, with the table's limits. A reference crosses as its target. */
export function cAbi(type: NativeType): AbiType {
  if (type.kind === "reference") return cAbi(type.to);
  // The walker typed it from this table, so the entry is there.
  const entry = cType(type.spelling);
  if (type.kind === "int" && entry) return { kind: "int", c: entry.c, bits: type.bits, signed: type.signed, min: entry.min!, max: entry.max! };
  if (type.kind === "float" && entry) return { kind: "float", c: entry.c, bits: type.bits };
  if ((type.kind === "bool" || type.kind === "void") && entry) return { kind: type.kind, c: entry.c };
  // A `const char*` crosses as itself; the std::string family crosses as the ABI string the shim converts.
  if (type.kind === "string") return type.nullable ? { kind: "cstring", c: "const char*" } : { kind: "string", c: "ts_polyglot_string" };
  throw new Error(`ts-polyglot: ${type.spelling} isn't marshaled yet`);
}
