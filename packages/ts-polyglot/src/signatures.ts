// The shapes the language modules produce and the glue consumes: a function a native file exports,
// its parameters, and how each value crosses between JavaScript and native code. The type tables that
// pick a `Kind` for a spelling live with their languages (languages/c-family.ts, languages/rust/).

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

export interface Param {
  name: string;
  /** String index of the name in the source; missing for an unnamed C parameter. */
  nameStart?: number;
  /** The type as written, e.g. "unsigned int" or "u8". */
  type: string;
  kind: Kind;
}

export interface NativeFunction {
  name: string;
  /** String index of the name in the source. */
  nameStart: number;
  /** What the generated glue calls: `geo::area` for a function in a namespace, `inner::nested` in a Rust mod, else the name. */
  callee: string;
  params: Param[];
  /** The result type as written. */
  returnType: string;
  returns: Kind;
  /** The header as written, on one line, e.g. "int add(int a, int b)". */
  signature: string;
}

/** Whitespace collapsed to single spaces and trimmed: a type or a header as one line. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
