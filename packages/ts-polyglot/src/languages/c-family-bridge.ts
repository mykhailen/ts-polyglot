// What the C and C++ bridges' shims and mirrors share: the error slot's name, C declarators for
// temporaries, and the loops that move a C-style array between its inline storage and the ABI
// array, element by element. C++ converts its std containers through templates instead; a C array
// is the same storage in both languages, so the same loops serve both, differing only in how a
// mirrored struct is passed (by pointer in C, by reference in C++).
import type { NativeFunction, NativeType } from "../signatures.ts";
import type { Dialect } from "./c-family.ts";
import { needsMirror } from "./c-types.ts";
import type { AbiType } from "./language.ts";

/** `error`, or `ts_polyglot_error` when a parameter already has that name. */
export function slotName(fn: NativeFunction): string {
  return fn.params.some((param) => param.name === "error") ? "ts_polyglot_error" : "error";
}

/** `int name[2][3]` for array(2, array(3, int)), `char name[16]` for a bounded string: the element's C spelling, the name, the dimensions outer first. */
export function cDeclarator(type: NativeType, name: string): string {
  const dims: number[] = [];
  let element = type;
  while (element.kind === "array" && element.length !== undefined) {
    dims.push(element.length);
    element = element.of;
  }
  if (element.kind === "string" && element.max !== undefined) {
    dims.push(element.max + 1);
    return `char ${name}${dims.map((n) => `[${n}]`).join("")}`;
  }
  return `${element.spelling} ${name}${dims.map((n) => `[${n}]`).join("")}`;
}

/** A C-style array (`T x[N]`, `T xs[]`) rather than a std container, which C++ converts through templates instead of these loops. */
export const cStyleArray = (type: NativeType) => type.kind === "array" && type.spelling.endsWith("]");

/** How many nested loops copying this type takes, so the caller can declare i0 to i(n-1). */
export function loopDepth(abi: AbiType): number {
  return abi.kind === "array" ? 1 + loopDepth(abi.of) : 0;
}

/** Whether an element has to be converted rather than copied: a mirrored struct, any string, any array. */
export function converts(abi: AbiType): boolean {
  return abi.kind === "array" || abi.kind === "string" || (abi.kind === "struct" && needsMirror(abi));
}

const byRef = (expr: string, dialect: Dialect) => (dialect === "c" ? `&${expr}` : expr);

/** The element's model type behind an array's: what a std container or string is spelled as, which the ABI shape doesn't say. */
const elementOf = (type: NativeType): NativeType => (type.kind === "array" ? type.of : type);

/**
 * Statements copying ABI storage `src` (an lvalue) into native storage `dst`: a loop per fixed
 * C-array level, memcpy and a NUL for a bounded string (the glue checked the bound and refused NULs),
 * the mirror conversion for a struct that has one, the C++ constructions for a std string or
 * container element (C has none), assignment otherwise. `type` is the model type `abi` came from,
 * for those spellings. `depth` numbers the loop variables, which the caller declares as `size_t`.
 */
export function copyIn(abi: AbiType, type: NativeType, dst: string, src: string, dialect: Dialect, depth = 0): string[] {
  if (abi.kind === "string" && abi.max !== undefined) return [`memcpy(${dst}, ${src}.ptr, ${src}.len); ${dst}[${src}.len] = 0;`];
  if (abi.kind === "string") return [`${dst} = ${stdString(type, dialect)}(${src}.ptr, ${src}.len);`];
  if (abi.kind === "array" && (abi.length === undefined || !cStyleArray(type))) return [`${dst} = ts_polyglot__conv<${container(type, dialect)}>::from(${src});`];
  if (abi.kind === "array") {
    const i = `i${depth}`;
    const inner = copyIn(abi.of, elementOf(type), `${dst}[${i}]`, `((${abi.of.c} const*)${src}.ptr)[${i}]`, dialect, depth + 1);
    return [`for (${i} = 0; ${i} < ${abi.length}; ${i}++) { ${inner.join(" ")} }`];
  }
  if (abi.kind === "struct" && needsMirror(abi)) return [`${dst} = ts_polyglot__from_${abi.name}(${byRef(src, dialect)});`];
  return [`${dst} = ${src};`];
}

/**
 * The other direction: an owned ABI array per fixed C-array level (filled over the length the
 * allocation gave, so a failed one is an empty array, not a crash), an owned copy of a bounded
 * string up to its NUL or of a std string, the templates for a std container, the mirror
 * conversion for a struct that has one.
 */
export function copyOut(abi: AbiType, type: NativeType, dst: string, src: string, dialect: Dialect, depth = 0): string[] {
  if (abi.kind === "string" && abi.max !== undefined) return [`${dst} = ts_polyglot__own(${src}, ts_polyglot__bounded(${src}, ${abi.max + 1}));`];
  if (abi.kind === "string") {
    stdString(type, dialect);
    return [`${dst} = ts_polyglot__own(${src}.data(), ${src}.size());`];
  }
  if (abi.kind === "array" && (abi.length === undefined || !cStyleArray(type))) return [`${dst} = ts_polyglot__conv<${container(type, dialect)}>::to(${src});`];
  if (abi.kind === "array") {
    const i = `i${depth}`;
    const inner = copyOut(abi.of, elementOf(type), `((${abi.of.c}*)${dst}.ptr)[${i}]`, `${src}[${i}]`, dialect, depth + 1);
    return [`${dst} = ts_polyglot__own_array(${abi.length}, sizeof(${abi.of.c}));`, `for (${i} = 0; ${i} < ${dst}.len; ${i}++) { ${inner.join(" ")} }`];
  }
  if (abi.kind === "struct" && needsMirror(abi)) return [`${dst} = ts_polyglot__to_${abi.name}(${byRef(src, dialect)});`];
  return [`${dst} = ${src};`];
}

/** The C++ string type an ABI string element is built as; C has no such element to copy. */
function stdString(type: NativeType, dialect: Dialect): string {
  if (dialect === "c") throw new Error(`ts-polyglot: a C array can't hold ${type.spelling}`);
  return type.spelling === "std::string_view" ? "std::string_view" : "std::string";
}

/** The C++ container an ABI array element converts through; C has no such element to copy. */
function container(type: NativeType, dialect: Dialect): string {
  if (dialect === "c") throw new Error(`ts-polyglot: a C array can't hold ${type.spelling}`);
  return type.spelling;
}

/** `size_t i0, i1;` for the loops a set of copies needs, or nothing. */
export function loopIndices(depth: number): string[] {
  return depth ? [`size_t ${Array.from({ length: depth }, (_, i) => `i${i}`).join(", ")};`] : [];
}
