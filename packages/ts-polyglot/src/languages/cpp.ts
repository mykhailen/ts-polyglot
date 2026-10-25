// The C++ module: the shared walker over its own grammar (C code isn't always valid C++, but
// tree-sitter-cpp's node types are a superset of tree-sitter-c's), and a bridge that wraps every
// function in a static shim inside the glue's translation unit, because an exception escaping
// through the Node-API boundary takes node down.
import { cFamilyModule } from "./c-family.ts";
import { cAbi } from "./c-types.ts";
import type { Bridge, BridgeInput, LanguageModule } from "./language.ts";
import type { NativeFunction } from "../signatures.ts";

export const cpp: LanguageModule = { id: "cpp", extensions: [".cpp", ".cc", ".cxx"], grammar: "tree-sitter-cpp.wasm", parse: (root, source) => cFamilyModule(root, source, "cpp"), glue: "cpp", bridge: cppBridge };

export function cppBridge(input: BridgeInput): Bridge {
  const prelude = [
    `#include "${input.file.replaceAll("\\", "/")}"`,
    "#include <cstdlib>",
    "#include <cstring>",
    "#include <exception>",
    "",
    "// Owned strings for the slot: a malloc'd copy the glue releases.",
    "static void ts_polyglot__release(char* ptr, size_t) { free(ptr); }",
    "static ts_polyglot_string ts_polyglot__own(const char* text, size_t length) {",
    "  char* copy = (char*)malloc(length + 1);",
    "  if (copy) { memcpy(copy, text, length); copy[length] = 0; }",
    "  return ts_polyglot_string{ copy, copy ? length : 0, ts_polyglot__release };",
    "}",
    "static ts_polyglot_string ts_polyglot__own(const char* text) { return ts_polyglot__own(text, strlen(text)); }",
    "",
    ...input.module.functions.map(cppShim),
  ].join("\n");
  return {
    prelude,
    callee: (fn) => ({ name: `ts_polyglot__shim_${fn.name}`, params: fn.params.map((param) => cAbi(param.type)), returns: cAbi(fn.returns), reportsErrors: true }),
    libs: [],
  };
}

/** A static function in the glue's own translation unit that calls the user's function inside a try and reports what it threw. */
export function cppShim(fn: NativeFunction): string {
  const returns = cAbi(fn.returns);
  // The slot's name must not shadow a parameter.
  const slot = fn.params.some((param) => param.name === "error") ? "ts_polyglot_error" : "error";
  const params = [...fn.params.map((param) => `${cAbi(param.type).c} ${param.name}`), `ts_polyglot_string* ${slot}`].join(", ");
  const call = `${fn.callee}(${fn.params.map((param) => param.name).join(", ")})`;
  return [
    `static ${returns.c} ts_polyglot__shim_${fn.name}(${params}) {`,
    `  try { ${returns.kind === "void" ? `${call};` : `return ${call};`} }`,
    `  catch (const std::exception& e) { *${slot} = ts_polyglot__own(e.what()); }`,
    `  catch (...) { *${slot} = ts_polyglot__own("${fn.name}() threw an exception"); }`,
    ...(returns.kind === "void" ? [] : [`  return ${returns.c}{};`]),
    "}",
    "",
  ].join("\n");
}
