// The C module: the shared walker over the C grammar, and a bridge that calls the user's function
// directly where the glue can pass the user's own types, and through a static shim where it can't:
// a C array parameter arrives as an ABI array and its length parameter is the array's; a struct
// that holds an array or a char[N] crosses as a mirror the shim converts; a sequence of such
// structs goes through a temporary the shim frees. The shim reports through the error slot, since
// a shared length that disagrees or an allocation that fails has no other way out of C.
import { structsInDependencyOrder, visibleParams, type NativeFunction, type NativeModule, type NativeType, type Param } from "../signatures.ts";
import { cFamilyModule } from "./c-family.ts";
import { cDeclarator, converts, copyIn, copyOut, loopDepth, loopIndices, slotName } from "./c-family-bridge.ts";
import { cAbi, cType, mirrored, needsMirror } from "./c-types.ts";
import type { AbiType, Bridge, BridgeInput, LanguageModule } from "./language.ts";

export const c: LanguageModule = { id: "c", extensions: [".c"], grammar: "tree-sitter-c.wasm", parse: (root, source) => cFamilyModule(root, source, "c"), glue: "c", bridge: cBridge };

export function cBridge(input: BridgeInput): Bridge {
  const { module } = input;
  const prelude = [
    `#include "${input.file.replaceAll("\\", "/")}"`,
    "",
    "// Owned strings and arrays for results and the slot: malloc'd copies the glue releases.",
    "static void ts_polyglot__release(char* ptr, size_t len) { (void)len; free(ptr); }",
    "static void ts_polyglot__release_array(void* ptr, size_t len) { (void)len; free(ptr); }",
    "static ts_polyglot_string ts_polyglot__own(const char* text, size_t length) {",
    "  ts_polyglot_string s = {0};",
    "  char* copy = (char*)malloc(length + 1);",
    "  if (copy) { memcpy(copy, text, length); copy[length] = 0; s.ptr = copy; s.len = length; s.release = ts_polyglot__release; }",
    "  return s;",
    "}",
    "static ts_polyglot_string ts_polyglot__own_text(const char* text) { return ts_polyglot__own(text, strlen(text)); }",
    "static ts_polyglot_array ts_polyglot__own_array(size_t count, size_t size) {",
    "  ts_polyglot_array a = {0};",
    "  a.ptr = calloc(count ? count : 1, size);",
    "  if (a.ptr) { a.len = count; a.release = ts_polyglot__release_array; }",
    "  return a;",
    "}",
    "// The length of a char[n] up to its NUL, or n when it has none.",
    "static size_t ts_polyglot__bounded(const char* s, size_t n) { size_t i = 0; while (i < n && s[i]) i++; return i; }",
    "",
    ...cMirrors(module),
    ...module.functions.filter((fn) => shimmed(fn, module)).map((fn) => cShim(fn, module)),
  ].join("\n");
  return {
    prelude,
    callee: (fn) =>
      shimmed(fn, module)
        ? { name: `ts_polyglot__shim_${fn.name}`, params: visibleParams(fn).map((param) => mirrored(cAbi(param.type, module))), returns: mirrored(cAbi(fn.returns, module)), reportsErrors: true }
        : { name: fn.callee, params: visibleParams(fn).map((param) => cAbi(param.type, module)), returns: cAbi(fn.returns, module), reportsErrors: false },
    libs: [],
  };
}

/** Whether the glue can call the user's function as it is: no array, no text the glue owns, no struct the glue can't write. */
function shimmed(fn: NativeFunction, module: NativeModule): boolean {
  return [fn.returns, ...fn.params.map((param) => param.type)].some((type) => {
    const abi = cAbi(type, module);
    return abi.kind === "array" || abi.kind === "string" || needsMirror(abi);
  });
}

/** For every struct the glue can't write: the mirror typedef and the conversions both ways, fields first so the typedefs compile. One string per struct. */
export function cMirrors(module: NativeModule): string[] {
  const texts: string[] = [];
  for (const struct of structsInDependencyOrder(module)) {
    const abi = cAbi({ kind: "struct", name: struct.name, spelling: struct.spelling }, module);
    if (abi.kind !== "struct" || !needsMirror(abi)) continue;
    const mirror = mirrored(abi) as AbiType & { kind: "struct" };
    const indices = loopIndices(Math.max(0, ...mirror.fields.map((field) => loopDepth(field.type)))).map((line) => `  ${line}`);
    texts.push(
      [
        `typedef struct { ${mirror.fields.map((field) => `${field.type.c} ${field.member};`).join(" ")} } ${mirror.c};`,
        `static ${struct.spelling} ts_polyglot__from_${struct.name}(const ${mirror.c}* m) {`,
        `  ${struct.spelling} v;`,
        ...indices,
        "  memset(&v, 0, sizeof v);",
        ...mirror.fields.flatMap((field, i) => copyIn(field.type, struct.fields[i]!.type, `v.${field.member}`, `m->${field.member}`, "c").map((line) => `  ${line}`)),
        "  return v;",
        "}",
        `static ${mirror.c} ts_polyglot__to_${struct.name}(const ${struct.spelling}* v) {`,
        `  ${mirror.c} m;`,
        ...indices,
        "  memset(&m, 0, sizeof m);",
        ...mirror.fields.flatMap((field, i) => copyOut(field.type, struct.fields[i]!.type, `m.${field.member}`, `v->${field.member}`, "c").map((line) => `  ${line}`)),
        "  return m;",
        "}",
        "",
      ].join("\n"),
    );
  }
  return texts;
}

/**
 * A static function in the glue's own translation unit that takes the ABI shapes, checks what the
 * glue couldn't (shared lengths agree, a length fits its type, a temporary could be allocated),
 * converts, calls the user's function in its own order, and converts the result back.
 */
export function cShim(fn: NativeFunction, module: NativeModule): string {
  const slot = slotName(fn);
  const visible = visibleParams(fn);
  const abis = new Map(visible.map((param) => [param.name, mirrored(cAbi(param.type, module))]));
  const returns = mirrored(cAbi(fn.returns, module));
  const mirroredResult = returns.kind === "struct" && needsMirror(returns);
  const locals: string[] = [];
  const checks: string[] = [];
  const fills: string[] = [];
  const frees: string[] = [];
  const args: string[] = [];
  let depth = 0;
  let exits = false;
  const fail = (message: string) => {
    exits = true;
    return `{ *${slot} = ts_polyglot__own_text(${JSON.stringify(message)}); goto done; }`;
  };
  if (returns.kind !== "void") locals.push(`${returns.c} ts_polyglot_out = {0};`);
  if (mirroredResult) locals.push(`${fn.returns.spelling} ts_polyglot_result;`);
  // The first array to share a length parameter is the one whose length is passed; the others must agree with it.
  const owners = new Map<string, Param>();
  for (const param of visible) if (param.length && !owners.has(param.length.name)) owners.set(param.length.name, param);
  for (const param of fn.params) {
    const owner = owners.get(param.name);
    if (owner && !visible.includes(param)) {
      for (const other of visible) if (other !== owner && other.length?.name === param.name) checks.push(`if (${other.name}.len != ${owner.name}.len) ${fail(`${fn.name}(): ${other.name} must have as many elements as ${owner.name}`)}`);
      const length = param.type as NativeType & { kind: "int" };
      // size_t and its 64-bit kin hold any JavaScript length; a narrower or signed type may not.
      if (length.signed || length.bits < 64) checks.push(`if (${owner.name}.len > (size_t)${cType(length.spelling)!.max}) ${fail(`${fn.name}(): ${owner.name} has more elements than ${length.spelling} holds`)}`);
      args.push(`(${cType(length.spelling)!.c})${owner.name}.len`);
      continue;
    }
    const abi = abis.get(param.name)!;
    if (abi.kind === "array" && !converts(abi.of)) {
      args.push(`(${abi.of.c} const*)${param.name}.ptr`);
    } else if (abi.kind === "array" && abi.length === undefined) {
      // A sequence of structs that need converting: a temporary of the user's type, filled and freed here.
      const element = (param.type as NativeType & { kind: "array" }).of.spelling;
      const tmp = `ts_polyglot_tmp_${param.name}`;
      locals.push(`${element}* ${tmp} = NULL;`);
      fills.push(`${tmp} = (${element}*)malloc((${param.name}.len ? ${param.name}.len : 1) * sizeof(${element}));`, `if (!${tmp}) ${fail(`${fn.name}(): can't allocate ${param.name}`)}`);
      fills.push(`for (i0 = 0; i0 < ${param.name}.len; i0++) { ${copyIn(abi.of, (param.type as NativeType & { kind: "array" }).of, `${tmp}[i0]`, `((${abi.of.c} const*)${param.name}.ptr)[i0]`, "c", 1).join(" ")} }`);
      depth = Math.max(depth, 1 + loopDepth(abi.of));
      frees.push(`free(${tmp});`);
      args.push(tmp);
    } else if (abi.kind === "array") {
      const tmp = `ts_polyglot_tmp_${param.name}`;
      locals.push(`${cDeclarator(param.type, tmp)};`);
      fills.push(...copyIn(abi, param.type, tmp, param.name, "c"));
      depth = Math.max(depth, loopDepth(abi));
      args.push(tmp);
    } else if (abi.kind === "string") {
      // Bounded or counted: the glue NUL-terminated it and checked the bound; a count goes through its own parameter.
      args.push(`${param.name}.ptr`);
    } else if (abi.kind === "struct" && needsMirror(abi)) {
      args.push(`ts_polyglot__from_${abi.name}(&${param.name})`);
    } else {
      args.push(param.name);
    }
  }
  const call = `${fn.callee}(${args.join(", ")})`;
  const params = [...visible.map((param) => `${abis.get(param.name)!.c} ${param.name}`), `ts_polyglot_string* ${slot}`].join(", ");
  return [
    `static ${returns.c} ts_polyglot__shim_${fn.name}(${params}) {`,
    ...[...locals, ...loopIndices(depth), ...checks, ...fills].map((line) => `  ${line}`),
    returns.kind === "void" ? `  ${call};` : mirroredResult ? `  ts_polyglot_result = ${call};` : `  ts_polyglot_out = ${call};`,
    ...(mirroredResult ? [`  ts_polyglot_out = ts_polyglot__to_${returns.name}(&ts_polyglot_result);`] : []),
    ...(exits ? ["done:"] : []),
    ...frees.map((line) => `  ${line}`),
    returns.kind === "void" ? "  return;" : "  return ts_polyglot_out;",
    "}",
    "",
  ].join("\n");
}
