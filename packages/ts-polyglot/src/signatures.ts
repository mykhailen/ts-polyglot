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
  // nullable: C's `const char*`, which may be NULL. max: a bound in UTF-8 bytes, for a C `char[N]`
  // field or parameter, which holds N - 1 of them before its NUL.
  | { kind: "string"; nullable: boolean; max?: number }
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
  /**
   * C and C++ only: the parameter that carries this array's (or counted string's) length. It stays
   * in `params` at its native position, for the bridge's call; `visibleParams` hides it from
   * JavaScript, which passes the array alone.
   */
  length?: { name: string; type: NativeType };
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

/** The parameters JavaScript passes: every one that isn't another's length. The glue and the declarations use this list; a bridge's shim walks the full one. */
export function visibleParams(fn: NativeFunction): Param[] {
  const lengths = new Set(fn.params.flatMap((param) => (param.length ? [param.length.name] : [])));
  return fn.params.filter((param) => !lengths.has(param.name));
}

/**
 * An array size as C or Rust spells it: any base, Rust's `_` separators, either language's suffixes.
 * Undefined for anything else (a name, an expression, a float, zero), which the walkers turn into
 * `unknown` rather than guess at.
 */
export function parseIntegerLiteral(text: string, language: "c" | "rust"): number | undefined {
  // Rust separates digits with `_`, C++14 and C23 with `'`.
  const digits = language === "rust" ? text.trim().replace(/_/g, "").replace(/[ui](8|16|32|64|128|size)$/, "") : text.trim().replace(/'/g, "").replace(/[uUlL]+$/, "");
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(digits)) value = parseInt(digits.slice(2), 16);
  else if (/^0[bB][01]+$/.test(digits)) value = parseInt(digits.slice(2), 2);
  else if (language === "rust" && /^0o[0-7]+$/.test(digits)) value = parseInt(digits.slice(2), 8);
  // A leading zero is octal in C; Rust has no such rule.
  else if (language === "c" && /^0[0-7]+$/.test(digits)) value = parseInt(digits, 8);
  else if (/^[0-9]+$/.test(digits)) value = Number(digits);
  else return undefined;
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Whether the glue marshals a value of this type. An immutable reference crosses by value, with the
 * callee borrowing the glue's copy for the call. A struct crosses when the module defines it and every
 * field crosses; a reference field can't be assigned once the struct exists, so it doesn't.
 */
export function supported(type: NativeType, module: NativeModule, visiting: Set<string> = new Set()): boolean {
  switch (type.kind) {
    case "void":
    case "bool":
    case "int":
    case "float":
    case "char":
    case "string":
      return true;
    case "reference":
      return !type.mutable && supported(type.to, module, visiting);
    // An element can't be a reference (nothing owns what it would borrow) or void.
    case "array":
      return type.of.kind !== "reference" && type.of.kind !== "void" && supported(type.of, module, visiting);
    case "struct": {
      // No language lets a struct hold itself by value; the set guards the walk anyway.
      if (visiting.has(type.name)) return false;
      const struct = module.structs.find((candidate) => candidate.name === type.name);
      if (!struct) return false;
      visiting.add(type.name);
      const ok = struct.fields.every((field) => field.type.kind !== "reference" && supported(field.type, module, visiting));
      visiting.delete(type.name);
      return ok;
    }
    default:
      return false;
  }
}

/** The module's structs with every struct before the ones that hold it, so C typedefs and readers come in a compilable order. */
export function structsInDependencyOrder(module: NativeModule): NativeStruct[] {
  const ordered: NativeStruct[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const struct = module.structs.find((candidate) => candidate.name === name);
    if (!struct) return;
    for (const field of struct.fields) {
      const type = innermost(field.type);
      if (type.kind === "struct") visit(type.name);
    }
    ordered.push(struct);
  };
  for (const struct of module.structs) visit(struct.name);
  return ordered;
}

/** The type behind any depth of references and array elements: what a field ultimately holds. */
const innermost = (type: NativeType): NativeType => (type.kind === "reference" ? innermost(type.to) : type.kind === "array" ? innermost(type.of) : type);

/** Whitespace collapsed to single spaces and trimmed: a type or a header as one line. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
