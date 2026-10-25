// The C++ module: the shared walker over its own grammar (C code isn't always valid C++, but
// tree-sitter-cpp's node types are a superset of tree-sitter-c's), and a bridge that wraps every
// function in a static shim inside the glue's translation unit, because an exception escaping
// through the Node-API boundary takes node down. The shim also converts what isn't C: the
// std::string family, and structs that hold it, which cross through a mirror struct.
import { cFamilyModule } from "./c-family.ts";
import { cAbi } from "./c-types.ts";
import type { AbiType, Bridge, BridgeInput, LanguageModule } from "./language.ts";
import { structsInDependencyOrder, type NativeFunction, type NativeModule, type NativeType, type Param } from "../signatures.ts";

export const cpp: LanguageModule = { id: "cpp", extensions: [".cpp", ".cc", ".cxx"], grammar: "tree-sitter-cpp.wasm", parse: (root, source) => cFamilyModule(root, source, "cpp"), glue: "cpp", bridge: cppBridge };

export function cppBridge(input: BridgeInput): Bridge {
  const { module } = input;
  const prelude = [
    `#include "${input.file.replaceAll("\\", "/")}"`,
    "#include <cstdlib>",
    "#include <cstring>",
    "#include <exception>",
    "#include <string>",
    "#include <string_view>",
    "",
    "// Owned strings for results and the slot: a malloc'd copy the glue releases.",
    "static void ts_polyglot__release(char* ptr, size_t) { free(ptr); }",
    "static ts_polyglot_string ts_polyglot__own(const char* text, size_t length) {",
    "  char* copy = (char*)malloc(length + 1);",
    "  if (copy) { memcpy(copy, text, length); copy[length] = 0; }",
    "  return ts_polyglot_string{ copy, copy ? length : 0, ts_polyglot__release };",
    "}",
    "static ts_polyglot_string ts_polyglot__own(const char* text) { return ts_polyglot__own(text, strlen(text)); }",
    "",
    ...mirrors(module),
    ...module.functions.map((fn) => cppShim(fn, module)),
  ].join("\n");
  return {
    prelude,
    callee: (fn) => ({ name: `ts_polyglot__shim_${fn.name}`, params: fn.params.map((param) => shape(param.type, module)), returns: shape(fn.returns, module), reportsErrors: true }),
    libs: [],
  };
}

/** Whether a struct holds text the shim has to convert: a std::string-family field, directly or in a struct it holds. */
function holdsText(abi: AbiType): boolean {
  return abi.kind === "struct" && abi.fields.some((field) => field.type.kind === "string" || holdsText(field.type));
}

/** The shape the glue sees: the user's own type, except a struct that holds text, which crosses as its mirror. */
function shape(type: NativeType, module: NativeModule): AbiType {
  return mirrored(cAbi(type, module));
}

function mirrored(abi: AbiType): AbiType {
  if (abi.kind !== "struct" || !holdsText(abi)) return abi;
  return { ...abi, c: `ts_polyglot_${abi.name}`, fields: abi.fields.map((field) => ({ ...field, type: mirrored(field.type) })) };
}

/** For every struct that holds text: the mirror typedef and the two conversions, fields first so the typedefs compile. */
function mirrors(module: NativeModule): string[] {
  const lines: string[] = [];
  for (const struct of structsInDependencyOrder(module)) {
    const abi = cAbi({ kind: "struct", name: struct.name, spelling: struct.spelling }, module);
    if (abi.kind !== "struct" || !holdsText(abi)) continue;
    const mirror = mirrored(abi) as AbiType & { kind: "struct" };
    lines.push(
      `typedef struct { ${mirror.fields.map((field) => `${field.type.c} ${field.member};`).join(" ")} } ${mirror.c};`,
      `static ${struct.spelling} ts_polyglot__from_${struct.name}(const ${mirror.c}& m) {`,
      `  ${struct.spelling} v;`,
      ...struct.fields.map((field, i) => `  v.${field.name} = ${fromMirror(field.type, mirror.fields[i]!.type, `m.${field.name}`)};`),
      "  return v;",
      "}",
      `static ${mirror.c} ts_polyglot__to_${struct.name}(const ${struct.spelling}& v) {`,
      `  ${mirror.c} m;`,
      ...struct.fields.map((field, i) => `  m.${field.name} = ${toMirror(mirror.fields[i]!.type, `v.${field.name}`)};`),
      "  return m;",
      "}",
      "",
    );
  }
  return lines;
}

/** The user's value for a mirror field's. */
function fromMirror(field: NativeType, abi: AbiType, expr: string): string {
  if (abi.kind === "string") return `${field.spelling === "std::string_view" ? "std::string_view" : "std::string"}(${expr}.ptr, ${expr}.len)`;
  if (abi.kind === "struct" && holdsText(abi)) return `ts_polyglot__from_${abi.name}(${expr})`;
  return expr;
}

/** The mirror field's value for the user's. */
function toMirror(abi: AbiType, expr: string): string {
  if (abi.kind === "string") return `ts_polyglot__own(${expr}.data(), ${expr}.size())`;
  if (abi.kind === "struct" && holdsText(abi)) return `ts_polyglot__to_${abi.name}(${expr})`;
  return expr;
}

/** A static function in the glue's own translation unit that calls the user's function inside a try and reports what it threw. */
export function cppShim(fn: NativeFunction, module: NativeModule): string {
  const returns = shape(fn.returns, module);
  // The slot's name must not shadow a parameter.
  const slot = fn.params.some((param) => param.name === "error") ? "ts_polyglot_error" : "error";
  const params = [...fn.params.map((param) => `${shape(param.type, module).c} ${param.name}`), `ts_polyglot_string* ${slot}`].join(", ");
  const call = `${fn.callee}(${fn.params.map((param) => cppArgument(param, module)).join(", ")})`;
  // A std::string-family result is copied into an owned ABI string: a `const std::string&` may refer
  // to the shim's own argument, which dies with the shim. The temporary is prefixed like every other
  // binding the shim introduces: a parameter named `r` would otherwise be shadowed in its own initializer.
  const body =
    returns.kind === "void" ? `${call};`
    : returns.kind === "string" ? `auto ts_polyglot_result = ${call}; return ts_polyglot__own(ts_polyglot_result.data(), ts_polyglot_result.size());`
    : holdsText(returns) ? `auto ts_polyglot_result = ${call}; return ts_polyglot__to_${returns.kind === "struct" ? returns.name : ""}(ts_polyglot_result);`
    : `return ${call};`;
  return [
    `static ${returns.c} ts_polyglot__shim_${fn.name}(${params}) {`,
    `  try { ${body} }`,
    `  catch (const std::exception& e) { *${slot} = ts_polyglot__own(e.what()); }`,
    `  catch (...) { *${slot} = ts_polyglot__own("${fn.name}() threw an exception"); }`,
    ...(returns.kind === "void" ? [] : [`  return ${returns.kind === "cstring" ? "NULL" : `${returns.c}{}`};`]),
    "}",
    "",
  ].join("\n");
}

/** The argument the user's function gets from a shim parameter: text and mirrored structs are converted, the rest passes through. */
function cppArgument(param: Param, module: NativeModule): string {
  const type = param.type.kind === "reference" ? param.type.to : param.type;
  if (type.kind === "string" && !type.nullable) return `${type.spelling === "std::string_view" ? "std::string_view" : "std::string"}(${param.name}.ptr, ${param.name}.len)`;
  if (type.kind === "struct" && holdsText(cAbi(type, module))) return `ts_polyglot__from_${type.name}(${param.name})`;
  return param.name;
}
