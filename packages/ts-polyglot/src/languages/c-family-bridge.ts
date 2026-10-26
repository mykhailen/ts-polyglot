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

/** How many nested loops copying this type takes, so the caller can declare i0 to i(n-1). */
export function loopDepth(abi: AbiType): number {
  return abi.kind === "array" ? 1 + loopDepth(abi.of) : 0;
}

/** Whether an element has to be converted rather than copied: a mirrored struct, a bounded string, an array. */
export function converts(abi: AbiType): boolean {
  return abi.kind === "array" || (abi.kind === "string" && abi.max !== undefined) || (abi.kind === "struct" && needsMirror(abi));
}

const byRef = (expr: string, dialect: Dialect) => (dialect === "c" ? `&${expr}` : expr);

/**
 * Statements copying ABI storage `src` (an lvalue) into native storage `dst`: a loop per fixed array
 * level, memcpy and a NUL for a bounded string (the glue checked the bound and refused NULs), the
 * mirror conversion for a struct that has one, assignment otherwise. `depth` numbers the loop
 * variables, which the caller declares as `size_t`.
 */
export function copyIn(abi: AbiType, dst: string, src: string, dialect: Dialect, depth = 0): string[] {
  if (abi.kind === "string" && abi.max !== undefined) return [`memcpy(${dst}, ${src}.ptr, ${src}.len); ${dst}[${src}.len] = 0;`];
  if (abi.kind === "array") {
    if (abi.length === undefined) throw new Error("ts-polyglot: only a fixed array has inline storage to copy into");
    const i = `i${depth}`;
    const inner = copyIn(abi.of, `${dst}[${i}]`, `((${abi.of.c} const*)${src}.ptr)[${i}]`, dialect, depth + 1);
    return [`for (${i} = 0; ${i} < ${abi.length}; ${i}++) { ${inner.join(" ")} }`];
  }
  if (abi.kind === "struct" && needsMirror(abi)) return [`${dst} = ts_polyglot__from_${abi.name}(${byRef(src, dialect)});`];
  return [`${dst} = ${src};`];
}

/**
 * The other direction: an owned ABI array per fixed array level (filled over the length the
 * allocation gave, so a failed one is an empty array, not a crash), an owned copy of a bounded
 * string up to its NUL, the mirror conversion for a struct that has one.
 */
export function copyOut(abi: AbiType, dst: string, src: string, dialect: Dialect, depth = 0): string[] {
  if (abi.kind === "string" && abi.max !== undefined) return [`${dst} = ts_polyglot__own(${src}, ts_polyglot__bounded(${src}, ${abi.max + 1}));`];
  if (abi.kind === "array") {
    if (abi.length === undefined) throw new Error("ts-polyglot: only a fixed array has inline storage to copy from");
    const i = `i${depth}`;
    const inner = copyOut(abi.of, `((${abi.of.c}*)${dst}.ptr)[${i}]`, `${src}[${i}]`, dialect, depth + 1);
    return [`${dst} = ts_polyglot__own_array(${abi.length}, sizeof(${abi.of.c}));`, `for (${i} = 0; ${i} < ${dst}.len; ${i}++) { ${inner.join(" ")} }`];
  }
  if (abi.kind === "struct" && needsMirror(abi)) return [`${dst} = ts_polyglot__to_${abi.name}(${byRef(src, dialect)});`];
  return [`${dst} = ${src};`];
}

/** `size_t i0, i1;` for the loops a set of copies needs, or nothing. */
export function loopIndices(depth: number): string[] {
  return depth ? [`size_t ${Array.from({ length: depth }, (_, i) => `i${i}`).join(", ")};`] : [];
}
