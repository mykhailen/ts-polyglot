// The C++ module: the shared walker over its own grammar (C code isn't always valid C++, but
// tree-sitter-cpp's node types are a superset of tree-sitter-c's), and a bridge that wraps every
// function in a static shim inside the glue's translation unit, because an exception escaping
// through the Node-API boundary takes node down. The shim also converts what isn't C: the
// std::string family, std::vector and std::array through a template family, and structs that hold
// any of those, which cross through a mirror struct. C-style arrays use the loops C's bridge uses.
import { structsInDependencyOrder, visibleParams, type NativeFunction, type NativeModule, type NativeType, type Param } from "../signatures.ts";
import { cFamilyModule } from "./c-family.ts";
import { cDeclarator, cStyleArray, converts, copyIn, copyOut, loopDepth, loopIndices, slotName } from "./c-family-bridge.ts";
import { cAbi, cType, mirrored, needsMirror } from "./c-types.ts";
import type { AbiType, Bridge, BridgeInput, LanguageModule } from "./language.ts";

export const cpp: LanguageModule = { id: "cpp", extensions: [".cpp", ".cc", ".cxx"], grammar: "tree-sitter-cpp.wasm", parse: (root, source) => cFamilyModule(root, source, "cpp"), glue: "cpp", bridge: cppBridge };

// What a user type crosses as (its ABI element type) and how it converts each way. The primary
// template is the identity, for scalars, `const char*` and structs the glue writes itself; strings
// and the two containers specialize it, and each mirrored struct adds its own, so nesting needs no
// generated code per depth. A failed allocation gives an empty array rather than a crash.
const TEMPLATES = `template <class T> struct ts_polyglot__abi { using type = T; };
template <> struct ts_polyglot__abi<std::string> { using type = ts_polyglot_string; };
template <> struct ts_polyglot__abi<std::string_view> { using type = ts_polyglot_string; };
template <class T> struct ts_polyglot__conv {
  static T from(const T& v) { return v; }
  static T to(const T& v) { return v; }
};
template <> struct ts_polyglot__conv<std::string> {
  static std::string from(const ts_polyglot_string& s) { return std::string(s.ptr ? s.ptr : "", s.len); }
  static ts_polyglot_string to(const std::string& s) { return ts_polyglot__own(s.data(), s.size()); }
};
template <> struct ts_polyglot__conv<std::string_view> {
  static std::string_view from(const ts_polyglot_string& s) { return std::string_view(s.ptr ? s.ptr : "", s.len); }
  static ts_polyglot_string to(std::string_view s) { return ts_polyglot__own(s.data(), s.size()); }
};`;

// The container half, with its headers, only for a file that has an array somewhere: <vector> and
// <array> cost the compiler time every other file would pay for nothing.
const CONTAINER_TEMPLATES = `template <class T> struct ts_polyglot__abi<std::vector<T>> { using type = ts_polyglot_array; };
template <class T, size_t N> struct ts_polyglot__abi<std::array<T, N>> { using type = ts_polyglot_array; };
template <class T> struct ts_polyglot__conv<std::vector<T>> {
  using E = typename ts_polyglot__abi<T>::type;
  static std::vector<T> from(const ts_polyglot_array& a) {
    std::vector<T> v;
    const E* items = static_cast<const E*>(a.ptr);
    size_t n = items ? a.len : 0;
    v.reserve(n);
    for (size_t i = 0; i < n; i++) v.push_back(ts_polyglot__conv<T>::from(items[i]));
    return v;
  }
  static ts_polyglot_array to(const std::vector<T>& v) {
    ts_polyglot_array a = ts_polyglot__own_array(v.size(), sizeof(E));
    for (size_t i = 0; i < a.len; i++) static_cast<E*>(a.ptr)[i] = ts_polyglot__conv<T>::to(v[i]);
    return a;
  }
};
template <class T, size_t N> struct ts_polyglot__conv<std::array<T, N>> {
  using E = typename ts_polyglot__abi<T>::type;
  static std::array<T, N> from(const ts_polyglot_array& a) {
    std::array<T, N> v{};
    const E* items = static_cast<const E*>(a.ptr);
    for (size_t i = 0; i < N && items; i++) v[i] = ts_polyglot__conv<T>::from(items[i]);
    return v;
  }
  static ts_polyglot_array to(const std::array<T, N>& v) {
    ts_polyglot_array a = ts_polyglot__own_array(N, sizeof(E));
    for (size_t i = 0; i < a.len; i++) static_cast<E*>(a.ptr)[i] = ts_polyglot__conv<T>::to(v[i]);
    return a;
  }
};`;

/** Whether any function or struct of the module has an array in it, at any depth. */
function usesArrays(module: NativeModule): boolean {
  const has = (type: NativeType): boolean => type.kind === "array" || (type.kind === "reference" && has(type.to));
  return module.functions.some((fn) => has(fn.returns) || fn.params.some((param) => has(param.type))) || module.structs.some((struct) => struct.fields.some((field) => has(field.type)));
}

export function cppBridge(input: BridgeInput): Bridge {
  const { module } = input;
  const arrays = usesArrays(module);
  const prelude = [
    `#include "${input.file.replaceAll("\\", "/")}"`,
    ...(arrays ? ["#include <array>"] : []),
    "#include <cstdlib>",
    "#include <cstring>",
    "#include <exception>",
    "#include <string>",
    "#include <string_view>",
    ...(arrays ? ["#include <vector>"] : []),
    "",
    "// Owned strings and arrays for results and the slot: malloc'd copies the glue releases.",
    "static void ts_polyglot__release(char* ptr, size_t) { free(ptr); }",
    "static void ts_polyglot__release_array(void* ptr, size_t) { free(ptr); }",
    "static ts_polyglot_string ts_polyglot__own(const char* text, size_t length) {",
    "  char* copy = (char*)malloc(length + 1);",
    "  if (copy) { memcpy(copy, text, length); copy[length] = 0; }",
    "  return ts_polyglot_string{ copy, copy ? length : 0, ts_polyglot__release };",
    "}",
    "static ts_polyglot_string ts_polyglot__own(const char* text) { return ts_polyglot__own(text, strlen(text)); }",
    "static ts_polyglot_array ts_polyglot__own_array(size_t count, size_t size) {",
    "  ts_polyglot_array a{};",
    "  a.ptr = calloc(count ? count : 1, size);",
    "  if (a.ptr) { a.len = count; a.release = ts_polyglot__release_array; }",
    "  return a;",
    "}",
    "// The length of a char[n] up to its NUL, or n when it has none.",
    "static size_t ts_polyglot__bounded(const char* s, size_t n) { size_t i = 0; while (i < n && s[i]) i++; return i; }",
    "",
    TEMPLATES,
    ...(arrays ? [CONTAINER_TEMPLATES] : []),
    "",
    ...mirrors(module),
    ...module.functions.map((fn) => cppShim(fn, module)),
  ].join("\n");
  return {
    prelude,
    callee: (fn) => ({ name: `ts_polyglot__shim_${fn.name}`, params: visibleParams(fn).map((param) => shape(param.type, module)), returns: shape(fn.returns, module), reportsErrors: true }),
    libs: [],
  };
}

/** The shape the glue sees: the user's own type, except a struct that holds text or arrays, which crosses as its mirror. */
function shape(type: NativeType, module: NativeModule): AbiType {
  return mirrored(cAbi(type, module));
}

/** A field the loops handle rather than the templates: a C-style array or a bounded `char[N]`. */
const inline = (type: NativeType) => cStyleArray(type) || (type.kind === "string" && type.max !== undefined);

/**
 * For every struct that needs a mirror: the typedef, the two conversions, and the template
 * specializations that let a vector of it convert. Fields first, so a struct that holds another
 * finds its specializations already declared.
 */
function mirrors(module: NativeModule): string[] {
  const lines: string[] = [];
  for (const struct of structsInDependencyOrder(module)) {
    const abi = cAbi({ kind: "struct", name: struct.name, spelling: struct.spelling }, module);
    if (abi.kind !== "struct" || !needsMirror(abi)) continue;
    const mirror = mirrored(abi) as AbiType & { kind: "struct" };
    const fields = struct.fields.map((field, i) => ({ type: field.type, abi: mirror.fields[i]!.type, name: field.name }));
    const indices = loopIndices(Math.max(0, ...fields.filter((field) => inline(field.type)).map((field) => loopDepth(field.abi)))).map((line) => `  ${line}`);
    lines.push(
      `typedef struct { ${mirror.fields.map((field) => `${field.type.c} ${field.member};`).join(" ")} } ${mirror.c};`,
      `static ${struct.spelling} ts_polyglot__from_${struct.name}(const ${mirror.c}& m) {`,
      `  ${struct.spelling} v;`,
      ...indices,
      ...fields.flatMap((field) => (inline(field.type) ? copyIn(field.abi, `v.${field.name}`, `m.${field.name}`, "cpp") : [`v.${field.name} = ${fromMirror(field.type, field.abi, `m.${field.name}`)};`])).map((line) => `  ${line}`),
      "  return v;",
      "}",
      `static ${mirror.c} ts_polyglot__to_${struct.name}(const ${struct.spelling}& v) {`,
      `  ${mirror.c} m;`,
      ...indices,
      ...fields.flatMap((field) => (inline(field.type) ? copyOut(field.abi, `m.${field.name}`, `v.${field.name}`, "cpp") : [`m.${field.name} = ${toMirror(field.type, field.abi, `v.${field.name}`)};`])).map((line) => `  ${line}`),
      "  return m;",
      "}",
      `template <> struct ts_polyglot__abi<${struct.spelling}> { using type = ${mirror.c}; };`,
      `template <> struct ts_polyglot__conv<${struct.spelling}> { static ${struct.spelling} from(const ${mirror.c}& m) { return ts_polyglot__from_${struct.name}(m); } static ${mirror.c} to(const ${struct.spelling}& v) { return ts_polyglot__to_${struct.name}(v); } };`,
      "",
    );
  }
  return lines;
}

/** The user's value for a mirror field's: a container through the templates, text and mirrored structs by their converters. */
function fromMirror(field: NativeType, abi: AbiType, expr: string): string {
  if (field.kind === "array") return `ts_polyglot__conv<${field.spelling}>::from(${expr})`;
  if (abi.kind === "string") return `${field.spelling === "std::string_view" ? "std::string_view" : "std::string"}(${expr}.ptr, ${expr}.len)`;
  if (abi.kind === "struct" && needsMirror(abi)) return `ts_polyglot__from_${abi.name}(${expr})`;
  return expr;
}

/** The mirror field's value for the user's. */
function toMirror(field: NativeType, abi: AbiType, expr: string): string {
  if (field.kind === "array") return `ts_polyglot__conv<${field.spelling}>::to(${expr})`;
  if (abi.kind === "string") return `ts_polyglot__own(${expr}.data(), ${expr}.size())`;
  if (abi.kind === "struct" && needsMirror(abi)) return `ts_polyglot__to_${abi.name}(${expr})`;
  return expr;
}

/**
 * A static function in the glue's own translation unit that calls the user's function inside a try
 * and reports what it threw. Before the call it checks what the glue couldn't (shared lengths agree,
 * a length fits its type) and builds any temporary a C-style array of converted elements needs.
 */
export function cppShim(fn: NativeFunction, module: NativeModule): string {
  const returns = shape(fn.returns, module);
  // The slot's name must not shadow a parameter.
  const slot = slotName(fn);
  const visible = visibleParams(fn);
  const abis = new Map(visible.map((param) => [param.name, shape(param.type, module)]));
  const params = [...visible.map((param) => `${abis.get(param.name)!.c} ${param.name}`), `ts_polyglot_string* ${slot}`].join(", ");
  const zero = returns.kind === "void" ? "return;" : `return ${returns.kind === "cstring" ? "NULL" : `${returns.c}{}`};`;
  const fail = (message: string) => `{ *${slot} = ts_polyglot__own(${JSON.stringify(message)}); ${zero} }`;
  const setup: string[] = [];
  const args: string[] = [];
  let depth = 0;
  // The first array to share a length parameter is the one whose length is passed; the others must agree with it.
  const owners = new Map<string, Param>();
  for (const param of visible) if (param.length && !owners.has(param.length.name)) owners.set(param.length.name, param);
  for (const param of fn.params) {
    const owner = owners.get(param.name);
    if (owner && !visible.includes(param)) {
      for (const other of visible) if (other !== owner && other.length?.name === param.name) setup.push(`if (${other.name}.len != ${owner.name}.len) ${fail(`${fn.name}(): ${other.name} must have as many elements as ${owner.name}`)}`);
      const length = param.type as NativeType & { kind: "int" };
      if (length.signed || length.bits < 64) setup.push(`if (${owner.name}.len > (size_t)${cType(length.spelling)!.max}) ${fail(`${fn.name}(): ${owner.name} has more elements than ${length.spelling} holds`)}`);
      args.push(`(${cType(length.spelling)!.c})${owner.name}.len`);
      continue;
    }
    const abi = abis.get(param.name)!;
    const type = param.type.kind === "reference" ? param.type.to : param.type;
    if (abi.kind === "array" && !cStyleArray(type)) {
      args.push(`ts_polyglot__conv<${type.spelling}>::from(${param.name})`);
    } else if (abi.kind === "array" && !converts(abi.of)) {
      args.push(`(${abi.of.c} const*)${param.name}.ptr`);
    } else if (abi.kind === "array" && abi.length === undefined) {
      // A sequence of elements that need converting: a vector owns the converted copies for the call.
      const tmp = `ts_polyglot_tmp_${param.name}`;
      setup.push(`auto ${tmp} = ts_polyglot__conv<std::vector<${(type as NativeType & { kind: "array" }).of.spelling}>>::from(${param.name});`);
      args.push(`${tmp}.data()`);
    } else if (abi.kind === "array") {
      const tmp = `ts_polyglot_tmp_${param.name}`;
      setup.push(`${cDeclarator(type, tmp)};`, ...copyIn(abi, tmp, param.name, "cpp"));
      depth = Math.max(depth, loopDepth(abi));
      args.push(tmp);
    } else {
      args.push(cppArgument(param, module));
    }
  }
  const call = `${fn.callee}(${args.join(", ")})`;
  const result = fn.returns.kind === "reference" ? fn.returns.to : fn.returns;
  // A std::string-family result is copied into an owned ABI string: a `const std::string&` may refer
  // to the shim's own argument, which dies with the shim. The temporary is prefixed like every other
  // binding the shim introduces: a parameter named `r` would otherwise be shadowed in its own initializer.
  const body =
    returns.kind === "void" ? `${call};`
    : returns.kind === "string" ? `auto ts_polyglot_result = ${call}; return ts_polyglot__own(ts_polyglot_result.data(), ts_polyglot_result.size());`
    : returns.kind === "array" ? `auto ts_polyglot_result = ${call}; return ts_polyglot__conv<${result.spelling}>::to(ts_polyglot_result);`
    : needsMirror(returns) ? `auto ts_polyglot_result = ${call}; return ts_polyglot__to_${returns.kind === "struct" ? returns.name : ""}(ts_polyglot_result);`
    : `return ${call};`;
  return [
    `static ${returns.c} ts_polyglot__shim_${fn.name}(${params}) {`,
    ...(setup.length ? ["  try {", ...[...loopIndices(depth), ...setup, body].map((line) => `    ${line}`), "  }"] : [`  try { ${body} }`]),
    `  catch (const std::exception& e) { *${slot} = ts_polyglot__own(e.what()); }`,
    `  catch (...) { *${slot} = ts_polyglot__own("${fn.name}() threw an exception"); }`,
    ...(returns.kind === "void" ? [] : [`  ${zero}`]),
    "}",
    "",
  ].join("\n");
}

/** The argument the user's function gets from a shim parameter that isn't an array: text and mirrored structs are converted, the rest passes through. */
function cppArgument(param: Param, module: NativeModule): string {
  const type = param.type.kind === "reference" ? param.type.to : param.type;
  if (type.kind === "string" && !type.nullable) {
    // A char[N] or a counted char[] goes as the glue's NUL-terminated copy; its count through its own parameter.
    if (type.max !== undefined || type.spelling.endsWith("]")) return `${param.name}.ptr`;
    return `${type.spelling === "std::string_view" ? "std::string_view" : "std::string"}(${param.name}.ptr, ${param.name}.len)`;
  }
  if (type.kind === "struct" && needsMirror(cAbi(type, module))) return `ts_polyglot__from_${type.name}(${param.name})`;
  return param.name;
}
