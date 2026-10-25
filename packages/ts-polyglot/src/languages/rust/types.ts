// The Rust type table: a spelling's structured type, the C type the glue sees it as at the wrapper's
// boundary, and the macros that bound it. Every Rust integer type is FFI-safe, so the wrapper keeps the
// user's spelling and only the C prototype names the twin (`isize` is `intptr_t` there).
import { oneLine, type NativeModule, type NativeType } from "../../signatures.ts";
import type { AbiType } from "../language.ts";

export interface RustType {
  type: NativeType;
  /** The C type of the wrapper's parameter or result. */
  c: string;
  /** For integers: the limit macros, or `0` for an unsigned minimum. */
  min?: string;
  max?: string;
}

const int = (bits: 8 | 16 | 32 | 64, signed: boolean, spelling: string, c: string, min: string, max: string): RustType => ({ type: { kind: "int", bits, signed, spelling }, c, min, max });
const string = (spelling: string): RustType => ({ type: { kind: "string", nullable: false, spelling }, c: "ts_polyglot_string" });

// i128 and u128 are left out: MSVC has no 128-bit integer for the ABI to use.
const TABLE = new Map<string, RustType>([
  ["i8", int(8, true, "i8", "int8_t", "INT8_MIN", "INT8_MAX")],
  ["i16", int(16, true, "i16", "int16_t", "INT16_MIN", "INT16_MAX")],
  ["i32", int(32, true, "i32", "int32_t", "INT32_MIN", "INT32_MAX")],
  ["i64", int(64, true, "i64", "int64_t", "INT64_MIN", "INT64_MAX")],
  ["isize", int(64, true, "isize", "intptr_t", "INTPTR_MIN", "INTPTR_MAX")],
  ["u8", int(8, false, "u8", "uint8_t", "0", "UINT8_MAX")],
  ["u16", int(16, false, "u16", "uint16_t", "0", "UINT16_MAX")],
  ["u32", int(32, false, "u32", "uint32_t", "0", "UINT32_MAX")],
  ["u64", int(64, false, "u64", "uint64_t", "0", "UINT64_MAX")],
  ["usize", int(64, false, "usize", "size_t", "0", "SIZE_MAX")],
  ["f32", { type: { kind: "float", bits: 32, spelling: "f32" }, c: "float" }],
  ["f64", { type: { kind: "float", bits: 64, spelling: "f64" }, c: "double" }],
  ["bool", { type: { kind: "bool", spelling: "bool" }, c: "bool" }],
  // One Unicode scalar value, which crosses as its code point.
  ["char", { type: { kind: "char", spelling: "char" }, c: "uint32_t" }],
  ["()", { type: { kind: "void", spelling: "()" }, c: "void" }],
  ["String", string("String")],
  ["std::string::String", string("std::string::String")],
  // Only ever behind a reference.
  ["str", string("str")],
]);

/** The table entry for a spelling; undefined for anything not a known primitive or string. */
export function rustType(spelling: string): RustType | undefined {
  return TABLE.get(oneLine(spelling));
}

// A Rust field named like a C keyword can't be a member of the mirror typedef as it is.
const C_KEYWORDS = new Set(["auto", "bool", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "false", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch", "true", "typedef", "union", "unsigned", "void", "volatile", "while"]);

/** The C member name for a Rust field: its own, unless C would read it as a keyword. */
export const cMember = (name: string) => (C_KEYWORDS.has(name) ? `m_${name}` : name);

/** How a supported Rust type crosses the wrapper's boundary. A reference crosses as its target; a struct as its repr(C) mirror. */
export function rustAbi(type: NativeType, module: NativeModule): AbiType {
  if (type.kind === "reference") return rustAbi(type.to, module);
  if (type.kind === "struct") {
    const struct = module.structs.find((candidate) => candidate.name === type.name);
    if (!struct) throw new Error(`ts-polyglot: ${type.spelling} isn't a struct this file defines`);
    return { kind: "struct", c: `ts_polyglot_${struct.name}`, name: struct.name, fields: struct.fields.map((field) => ({ name: field.name, member: cMember(field.name), type: rustAbi(field.type, module) })) };
  }
  const entry = rustType(type.spelling);
  if (type.kind === "int" && entry) return { kind: "int", c: entry.c, bits: type.bits, signed: type.signed, min: entry.min!, max: entry.max! };
  if (type.kind === "float" && entry) return { kind: "float", c: entry.c, bits: type.bits };
  if ((type.kind === "bool" || type.kind === "void" || type.kind === "char") && entry) return { kind: type.kind, c: entry.c };
  if (type.kind === "string") return { kind: "string", c: "ts_polyglot_string" };
  throw new Error(`ts-polyglot: ${type.spelling} isn't marshaled yet`);
}
