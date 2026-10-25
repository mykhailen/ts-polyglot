// What a language module gives the rest of the package: which files it owns, which grammar parses
// them, how to read the functions and plain structs off a syntax tree, and a bridge that lowers its
// functions to callees the generated glue can call through the C ABI. The glue generator knows only
// the `AbiType`s below and Node-API; everything a language does differently is behind `bridge`.
import type { Node } from "web-tree-sitter";

import type { Compiler } from "../compiler.ts";
import type { NativeFunction, NativeModule } from "../signatures.ts";

export type Language = "c" | "cpp" | "rust";

export interface LanguageModule {
  id: Language;
  /** Lower-case, with the dot. */
  extensions: readonly string[];
  /** A file under grammars/: the manifest's `asset`. */
  grammar: string;
  /** Every plain struct and every function the visitation rules reach, typed, in source order, same-named functions included; the registry filters. */
  parse(root: Node, source: string): NativeModule;
  /** The language of the glue translation unit: C++ only for C++ files, which the glue `#include`s. */
  glue: "c" | "cpp";
  bridge(input: BridgeInput): Bridge;
}

export interface BridgeInput {
  /** The native file, as an absolute path. */
  file: string;
  /** The registry's output for it: only what the glue marshals. */
  module: NativeModule;
  /** The addon's directory, for anything the bridge builds. */
  dir: string;
  compiler: Compiler;
  debug: boolean;
}

export interface Bridge {
  /** Emitted into the glue after the ABI header: an `#include`, shim definitions, mirror typedefs, prototypes. */
  prelude: string;
  callee(fn: NativeFunction): Callee;
  /** Static libraries to link, in order. */
  libs: string[];
}

export interface Callee {
  name: string;
  params: AbiType[];
  returns: AbiType;
  /** Takes a trailing `ts_polyglot_string* error`, set when the call failed. */
  reportsErrors: boolean;
}

/** A value's shape at the C boundary: what the glue declares, reads, makes and frees. `c` is the C type. */
export type AbiType = { c: string } & (
  // min and max are limit macros, or literals, for the C type.
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean; min: string; max: string }
  | { kind: "float"; bits: 32 | 64 }
  | { kind: "bool" }
  | { kind: "void" }
  // A uint32_t code point.
  | { kind: "char" }
  // A raw `const char*`, which may be NULL.
  | { kind: "cstring" }
  // ts_polyglot_string, the glue's own shape for text.
  | { kind: "string" }
  // `name` is the TypeScript name, which the glue's reader and maker are named after; a field's
  // `member` is its C member, which a bridge may spell differently from the JavaScript property.
  | { kind: "struct"; name: string; fields: { name: string; member: string; type: AbiType }[] }
);
