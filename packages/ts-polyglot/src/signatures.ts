// The shapes the language modules produce and the glue and the mapper consume: a native file as a
// module of functions and plain structs, every value's type as a `NativeType`, and `supported`, which
// says what the glue marshals. The spelling stays on every type for the bridges, which need `long`
// against `int64_t` and `&str` against `String`; everything shared decides from `kind`, `bits`,
// `signed` and `nullable`.

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
 * callee borrowing the glue's copy for the call. Structs join as the glue learns them.
 */
export function supported(type: NativeType, _module: NativeModule): boolean {
  switch (type.kind) {
    case "void":
    case "bool":
    case "int":
    case "float":
    case "char":
    case "string":
      return true;
    case "reference":
      return !type.mutable && supported(type.to, _module);
    default:
      return false;
  }
}

/** Whitespace collapsed to single spaces and trimmed: a type or a header as one line. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
