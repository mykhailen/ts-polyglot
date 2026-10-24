// Finds the functions a C, C++ or Rust file exposes, and how their values cross into JavaScript.
// Proof of concept: top-level functions whose parameters and result are numbers, booleans or void.
// Anything else (pointers, strings, structs, namespaces, generics, overloads) is skipped.

export type Language = "c" | "cpp" | "rust";

export function languageOf(fileName: string): Language | undefined {
  if (/\.c$/i.test(fileName)) return "c";
  if (/\.(cpp|cc|cxx)$/i.test(fileName)) return "cpp";
  if (/\.rs$/i.test(fileName)) return "rust";
  return undefined;
}

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

// `long` is 32-bit on Windows but 64-bit on Linux and macOS, so it crosses as 64-bit everywhere and
// every OS sees the same functions. `unsigned long` would need 64-bit unsigned values, which don't
// cross yet.
export const C_TYPES: Record<string, Kind> = {
  int: I32, "signed int": I32, short: I32, int8_t: I32, int16_t: I32, int32_t: I32,
  unsigned: U32, "unsigned int": U32, "unsigned short": U32, uint8_t: U32, uint16_t: U32, uint32_t: U32,
  long: I64, "long long": I64, int64_t: I64,
  float: F64, double: F64,
  bool: BOOL, _Bool: BOOL,
  void: VOID,
};

export const RUST_TYPES: Record<string, Kind> = {
  i8: I32, i16: I32, i32: I32, u8: U32, u16: U32, u32: U32, i64: I64, f32: F64, f64: F64, bool: BOOL, "()": VOID,
};

export interface Param {
  name: string;
  /** Offset of the name in the source; missing for an unnamed C parameter. */
  nameStart?: number;
  /** The type as written, e.g. "unsigned int" or "u8". */
  type: string;
  kind: Kind;
}

export interface NativeFunction {
  name: string;
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

export function findFunctions(source: string, language: Language): NativeFunction[] {
  const code = blankNonCode(source, language);
  const functions: NativeFunction[] = [];
  // Only the top level: a header is the text between the end of the previous item (`;` or `}`)
  // and a `{` at depth 0. Function bodies, structs, namespaces and impl blocks are never entered.
  let depth = 0;
  let itemStart = 0;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === "{") {
      if (depth === 0) {
        const fn = language === "rust" ? rustHeader(code, itemStart, i) : cHeader(code, itemStart, i);
        // A C++ overload or a duplicate keeps only its first definition.
        if (fn && !functions.some((other) => other.name === fn.name)) functions.push(fn);
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) itemStart = i + 1;
    } else if (char === ";" && depth === 0) {
      itemStart = i + 1;
    }
  }
  return functions;
}

// Comments, literals, preprocessor lines and calling-convention noise become spaces: braces inside
// them no longer count, and every offset still points at the same place in the original text.
const C_NOISE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|^[ \t]*#.*$|extern\s*"C"|__declspec\s*\([^)]*\)|\b__(?:cdecl|stdcall|fastcall|vectorcall)\b|\binline\b|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'/gm;
const RUST_NOISE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])'/g;

function blankNonCode(source: string, language: Language): string {
  return source.replace(language === "rust" ? RUST_NOISE : C_NOISE, (text) => text.replace(/[^\n]/g, " "));
}

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const normalizeC = (type: string) => oneLine(type.replace(/\bconst\b/g, " "));

const C_HEADER = /^\s*(.+?)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*$/d;

function cHeader(code: string, start: number, end: number): NativeFunction | undefined {
  const match = C_HEADER.exec(code.slice(start, end));
  if (!match) return undefined;
  const [, rawType, name, rawParams] = match as unknown as [string, string, string, string];
  // `static` keeps a function private to its file; `main` is the program, not a library function.
  if (/\bstatic\b/.test(rawType) || name === "main") return undefined;
  const returns = C_TYPES[normalizeC(rawType)];
  const params = cParams(rawParams, start + match.indices![3]![0]);
  if (!returns || !params) return undefined;
  return {
    name,
    nameStart: start + match.indices![2]![0],
    callee: name,
    params,
    returnType: normalizeC(rawType),
    returns,
    signature: oneLine(code.slice(start + match.indices![1]![0], start + match.indices![3]![1] + 1)),
  };
}

function cParams(text: string, offset: number): Param[] | undefined {
  if (/^\s*(void)?\s*$/.test(text)) return [];
  const params: Param[] = [];
  let partStart = 0;
  for (const [index, part] of text.split(",").entries()) {
    const typeOnly = C_TYPES[normalizeC(part)];
    if (typeOnly && typeOnly !== VOID) {
      params.push({ name: `arg${index}`, type: normalizeC(part), kind: typeOnly });
    } else {
      // "int a": the last word is the name, the rest the type.
      const named = /^([\s\S]*?\S)\s+([A-Za-z_]\w*)\s*$/d.exec(part);
      const kind = named ? C_TYPES[normalizeC(named[1]!)] : undefined;
      if (!named || !kind || kind === VOID) return undefined;
      params.push({ name: named[2]!, nameStart: offset + partStart + named.indices![2]![0], type: normalizeC(named[1]!), kind });
    }
    partStart += part.length + 1;
  }
  return params;
}

const RUST_HEADER = /\bpub\s+(?:extern\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*(?:->\s*(\(\)|\w+)\s*)?$/d;

function rustHeader(code: string, start: number, end: number): NativeFunction | undefined {
  const match = RUST_HEADER.exec(code.slice(start, end));
  if (!match) return undefined;
  const [, name, rawParams, rawReturn = "()"] = match as unknown as [string, string, string, string | undefined];
  const returns = RUST_TYPES[rawReturn];
  const paramsStart = start + match.indices![2]![0];
  const params: Param[] = [];
  let partStart = 0;
  for (const part of rawParams.split(",")) {
    if (part.trim()) {
      const param = /^\s*(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*(\w+)\s*$/d.exec(part);
      const kind = param ? RUST_TYPES[param[2]!] : undefined;
      if (!param || !kind || kind === VOID) return undefined;
      params.push({ name: param[1]!, nameStart: paramsStart + partStart + param.indices![1]![0], type: param[2]!, kind });
    }
    partStart += part.length + 1;
  }
  if (!returns) return undefined;
  return {
    name,
    nameStart: start + match.indices![1]![0],
    callee: name,
    params,
    returnType: rawReturn,
    returns,
    signature: oneLine(code.slice(start + match.index, end)),
  };
}
