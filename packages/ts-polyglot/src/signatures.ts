// The shapes the language modules produce and the glue and the mapper consume: a native file as a
// module of functions and plain structs, every value's type as a `NativeType`, and `supported`, which
// says what the glue marshals. The spelling stays on every type for the bridges, which need `long`
// against `int64_t` and `&str` against `String`; everything shared decides from `kind`, `bits`,
// `signed` and `nullable`. The legacy shapes at the bottom are today's `Kind`-based output, produced
// from the model by `toLegacy`, until the glue and the mapper read the model themselves.

/** A type as a signature spells it, structured for marshaling. */
export type NativeType = { spelling: string } & (
  | { kind: "void" }
  | { kind: "bool" }
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean }
  | { kind: "float"; bits: 32 | 64 }
  // Rust's char: one Unicode scalar value.
  | { kind: "char" }
  // nullable: C's `const char*`, which may be NULL.
  | { kind: "string"; nullable: boolean }
  // By its TypeScript name; the definition is in NativeModule.structs.
  | { kind: "struct"; name: string }
  | { kind: "reference"; to: NativeType; mutable: boolean }
  | { kind: "pointer"; to: NativeType; const: boolean }
  | { kind: "array"; of: NativeType; length?: number }
  | { kind: "unknown" }
);

export interface Field {
  name: string;
  /** String index of the name in the source. */
  nameStart: number;
  type: NativeType;
}

/** A struct that is data only, with every field visible; "Plain structs" in the design. */
export interface NativeStruct {
  /** The TypeScript name: unqualified. */
  name: string;
  nameStart: number;
  fields: Field[];
  /** The enclosing namespaces or modules, for resolving names used inside them. */
  path: string[];
  /** How the bridge names the type: `struct tag`, the typedef name, `geometry::Point`, `user::geo::Point`. */
  spelling: string;
}

export interface Param {
  name: string;
  /** String index of the name in the source; missing for an unnamed C parameter. */
  nameStart?: number;
  type: NativeType;
}

export interface NativeFunction {
  name: string;
  /** String index of the name in the source. */
  nameStart: number;
  /** What the generated glue calls: `geo::area` for a function in a namespace, `inner::nested` in a Rust mod, else the name. */
  callee: string;
  params: Param[];
  returns: NativeType;
  /** The header as written, on one line, e.g. "int add(int a, int b)". */
  signature: string;
}

export interface NativeModule {
  functions: NativeFunction[];
  structs: NativeStruct[];
}

/**
 * Whether the glue marshals a value of this type. An immutable reference crosses by value, with the
 * callee borrowing the glue's copy for the call. Strings and structs join as the glue learns them.
 */
export function supported(type: NativeType, _module: NativeModule): boolean {
  switch (type.kind) {
    case "void":
    case "bool":
    case "int":
    case "float":
    case "char":
      return true;
    case "reference":
      return !type.mutable && supported(type.to, _module);
    default:
      return false;
  }
}

/** Whitespace collapsed to single spaces and trimmed: a type or a header as one line. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// ---- The legacy shapes: today's glue and mapper still consume these. ----

/** How a value crosses between JavaScript and native code. */
export interface Kind {
  ts: "number" | "boolean" | "void";
  /** The value's C type in the generated Node-API glue. */
  c: string;
  /** The value's Rust type at the C boundary of the generated Rust wrapper. */
  rust: string;
  /** The Node-API call that reads it from a JavaScript value. */
  fromJs: string;
  /** The Node-API call that makes a JavaScript value of it. */
  toJs: string;
}

export const I32: Kind = { ts: "number", c: "int32_t", rust: "i32", fromJs: "napi_get_value_int32", toJs: "napi_create_int32" };
export const U32: Kind = { ts: "number", c: "uint32_t", rust: "u32", fromJs: "napi_get_value_uint32", toJs: "napi_create_uint32" };
export const I64: Kind = { ts: "number", c: "int64_t", rust: "i64", fromJs: "napi_get_value_int64", toJs: "napi_create_int64" };
export const F64: Kind = { ts: "number", c: "double", rust: "f64", fromJs: "napi_get_value_double", toJs: "napi_create_double" };
export const BOOL: Kind = { ts: "boolean", c: "bool", rust: "bool", fromJs: "napi_get_value_bool", toJs: "napi_get_boolean" };
export const VOID: Kind = { ts: "void", c: "void", rust: "()", fromJs: "", toJs: "" };

export interface LegacyParam {
  name: string;
  nameStart?: number;
  /** The type as written, e.g. "unsigned int" or "u8". */
  type: string;
  kind: Kind;
}

export interface LegacyFunction {
  name: string;
  nameStart: number;
  callee: string;
  params: LegacyParam[];
  returnType: string;
  returns: Kind;
  signature: string;
}

/** Today's six kinds, from the model; undefined for what today's glue can't carry. */
export function legacyKind(type: NativeType): Kind | undefined {
  switch (type.kind) {
    case "int":
      if (type.bits === 64) return type.signed ? I64 : undefined;
      return type.signed ? I32 : U32;
    case "float":
      return F64;
    case "bool":
      return BOOL;
    case "void":
      return VOID;
    default:
      return undefined;
  }
}

/** Today's shape of a function, or undefined where today's parser would have skipped it. */
export function toLegacy(fn: NativeFunction): LegacyFunction | undefined {
  const returns = legacyKind(fn.returns);
  if (!returns) return undefined;
  const params: LegacyParam[] = [];
  for (const param of fn.params) {
    const kind = legacyKind(param.type);
    if (!kind || kind === VOID) return undefined;
    params.push(param.nameStart === undefined ? { name: param.name, type: param.type.spelling, kind } : { name: param.name, nameStart: param.nameStart, type: param.type.spelling, kind });
  }
  return { name: fn.name, nameStart: fn.nameStart, callee: fn.callee, params, returnType: fn.returns.spelling, returns, signature: fn.signature };
}
