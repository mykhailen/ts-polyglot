// The Rust bridge: the user's file becomes a module of a small crate whose `#[no_mangle] extern "C"`
// wrappers take and return the boundary types; rustc builds that crate into a static library, which
// the glue links and calls through the prototypes in the prelude. Every wrapper runs the user's
// function under `catch_unwind`, because unwinding out of an `extern "C"` function aborts the process.
// Structs cross through `#[repr(C)]` mirrors this crate declares, so the user's types need no attribute.
// Sequences cross as the ABI array: a slice of plain elements is lent as it is, anything else is
// converted element by element through the same expressions, nested to any depth.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Compiler } from "../../compiler.ts";
import { structsInDependencyOrder, visibleParams, type NativeFunction, type NativeModule, type NativeStruct, type NativeType } from "../../signatures.ts";
import { run } from "../../toolchain.ts";
import type { AbiType, Bridge, BridgeInput, Callee } from "../language.ts";
import { cMember, rustAbi } from "./types.ts";

/** rustc builds for its own host, so on macOS it's told Node's architecture, as the C side is. */
export function rustTargetArgs(platform: NodeJS.Platform, arch: string): string[] {
  if (platform !== "darwin") return [];
  return ["--target", arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
}

/** MSVC's linker reads .lib archives; gcc and clang read lib*.a ones. */
export function rustStaticLibName(compiler: Compiler): string {
  return compiler.family === "msvc" ? "user.lib" : "libuser.a";
}

export function rustBridge(input: BridgeInput): Bridge {
  const wrapper = join(input.dir, "wrapper.rs");
  writeFileSync(wrapper, rustWrapperSource(input.file, input.module));
  const lib = join(input.dir, rustStaticLibName(input.compiler));
  const codegen = input.debug ? ["-C", "opt-level=0", "-C", "debuginfo=2"] : ["-C", "opt-level=2"];
  const args = ["--edition", "2021", "--crate-type", "staticlib", ...rustTargetArgs(process.platform, process.arch), ...codegen, "--print", "native-static-libs", "-o", lib, wrapper];
  const stderr = run("rustc", args, input.dir, { missing: "ts-polyglot: can't run rustc, which builds .rs files. Install Rust from https://rustup.rs." });
  // The library needs the system libraries Rust's standard library uses; rustc names them.
  const native = /native-static-libs:\s*(.*)/.exec(stderr)?.[1]?.trim().split(/\s+/) ?? [];
  return { prelude: rustPrelude(input.module), callee: (fn) => rustCallee(fn, input.module), libs: [lib, ...native] };
}

export function rustCallee(fn: NativeFunction, module: NativeModule): Callee {
  return { name: `ts_polyglot__${fn.name}`, params: visibleParams(fn).map((param) => rustAbi(param.type, module)), returns: rustAbi(fn.returns, module), reportsErrors: true };
}

/** The mirrors' C typedefs and the wrappers' prototypes, for the glue. The ABI string and array themselves come from the glue's header. */
export function rustPrelude(module: NativeModule): string {
  const typedefs = structsInDependencyOrder(module).map((struct) => {
    const abi = rustAbi({ kind: "struct", name: struct.name, spelling: struct.spelling }, module) as AbiType & { kind: "struct" };
    return `typedef struct { ${abi.fields.map((field) => `${field.type.c} ${field.member};`).join(" ")} } ${abi.c};`;
  });
  const prototypes = module.functions.map((fn) => {
    const callee = rustCallee(fn, module);
    return `${callee.returns.c} ${callee.name}(${[...callee.params.map((param, i) => `${param.c} arg${i}`), "ts_polyglot_string* error"].join(", ")});`;
  });
  return [...typedefs, ...prototypes].join("\n");
}

export function rustWrapperSource(file: string, module: NativeModule): string {
  return [
    "#![allow(warnings)]",
    `#[path = ${JSON.stringify(file.replaceAll("\\", "/"))}]`,
    "mod user;",
    "",
    // Copy, so an element of an ABI list can be read out of its slice by value.
    "#[repr(C)]",
    "#[derive(Clone, Copy)]",
    'pub struct ts_polyglot_string { ptr: *mut u8, len: usize, release: Option<unsafe extern "C" fn(*mut u8, usize)> }',
    "",
    "#[repr(C)]",
    "#[derive(Clone, Copy)]",
    'pub struct ts_polyglot_array { ptr: *mut std::ffi::c_void, len: usize, release: Option<unsafe extern "C" fn(*mut std::ffi::c_void, usize)> }',
    "",
    "// Frees a string this crate handed out: the Box<str> behind `ptr`, which has the layout of a Box<[u8]>.",
    'pub unsafe extern "C" fn ts_polyglot_release(ptr: *mut u8, len: usize) {',
    "    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));",
    "}",
    "",
    "fn ts_polyglot_own(s: &str) -> ts_polyglot_string {",
    "    let len = s.len();",
    "    let boxed: Box<str> = s.into();",
    "    ts_polyglot_string { ptr: Box::into_raw(boxed) as *mut u8, len, release: Some(ts_polyglot_release) }",
    "}",
    "",
    "// The bytes of a string the glue passed; an empty one may come without a buffer.",
    "unsafe fn ts_polyglot_bytes(s: &ts_polyglot_string) -> &[u8] {",
    "    if s.ptr.is_null() { &[] } else { std::slice::from_raw_parts(s.ptr, s.len) }",
    "}",
    "",
    "// Frees a list this crate handed out: the Box<[T]> behind `ptr`. Generic, so each element type gets its own.",
    'unsafe extern "C" fn ts_polyglot_release_list<T>(ptr: *mut std::ffi::c_void, len: usize) {',
    "    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr as *mut T, len)));",
    "}",
    "",
    "fn ts_polyglot_own_list<T>(v: Vec<T>) -> ts_polyglot_array {",
    "    let len = v.len();",
    "    ts_polyglot_array { ptr: Box::into_raw(v.into_boxed_slice()) as *mut T as *mut std::ffi::c_void, len, release: Some(ts_polyglot_release_list::<T>) }",
    "}",
    "",
    "// A 'static slice of plain elements needs no copy: the glue reads it and releases nothing.",
    "fn ts_polyglot_borrow_list<T>(s: &'static [T]) -> ts_polyglot_array {",
    "    ts_polyglot_array { ptr: s.as_ptr() as *mut T as *mut std::ffi::c_void, len: s.len(), release: None }",
    "}",
    "",
    "// The elements of a list the glue passed; an empty one may come without a buffer.",
    "unsafe fn ts_polyglot_slice<T>(a: &ts_polyglot_array) -> &[T] {",
    "    if a.ptr.is_null() { &[] } else { std::slice::from_raw_parts(a.ptr as *const T, a.len) }",
    "}",
    "",
    "fn ts_polyglot_panic_message(payload: &Box<dyn std::any::Any + Send>, name: &str) -> String {",
    "    if let Some(s) = payload.downcast_ref::<&str>() { s.to_string() }",
    "    else if let Some(s) = payload.downcast_ref::<String>() { s.clone() }",
    "    else { format!(\"{}() panicked\", name) }",
    "}",
    "",
    ...structsInDependencyOrder(module).map((struct) => mirror(struct, module)),
    ...module.functions.map((fn) => rustWrapper(fn, module)),
  ].join("\n");
}

/** The repr(C) twin of a user struct and the conversions both ways, field by field. */
function mirror(struct: NativeStruct, module: NativeModule): string {
  const name = `ts_polyglot_${struct.name}`;
  return [
    "#[repr(C)]",
    "#[derive(Clone, Copy)]",
    `pub struct ${name} { ${struct.fields.map((field) => `pub ${cMember(field.name)}: ${boundary(field.type)}`).join(", ")} }`,
    `impl From<${name}> for ${struct.spelling} {`,
    `    fn from(m: ${name}) -> Self { ${struct.spelling} { ${struct.fields.map((field) => `${field.name}: ${fromMirror(field.type, `m.${cMember(field.name)}`, module)}`).join(", ")} } }`,
    "}",
    `impl From<&${struct.spelling}> for ${name} {`,
    `    fn from(v: &${struct.spelling}) -> Self { ${name} { ${struct.fields.map((field) => `${cMember(field.name)}: ${toMirror(field.type, `v.${field.name}`, module)}`).join(", ")} } }`,
    "}",
    "",
  ].join("\n");
}

/** Elements that are the same bytes on both sides, which a slice can lend and a Vec can copy whole. */
const plain = (type: NativeType) => type.kind === "int" || type.kind === "float" || type.kind === "bool";

/** The user's spelling of a struct, `user::geo::Point`, for a conversion that names it. */
const structSpelling = (name: string, module: NativeModule) => module.structs.find((struct) => struct.name === name)!.spelling;

/**
 * A type as the wrapper can name it: a struct by its path from the crate root, a fixed array by its
 * resolved length (the user's `[f32; N]` names a const the wrapper can't see), the rest as written.
 */
function spelled(type: NativeType, module: NativeModule): string {
  if (type.kind === "struct") return structSpelling(type.name, module);
  if (type.kind === "reference") return `&${spelled(type.to, module)}`;
  if (type.kind !== "array") return type.spelling;
  const of = spelled(type.of, module);
  if (type.length !== undefined) return `[${of}; ${type.length}]`;
  return type.spelling.startsWith("[") ? `[${of}]` : `Vec<${of}>`;
}

/** The user's value for a mirror field's. The glue's UTF-8 is well-formed (measured), so lossy decoding never has anything to replace. */
function fromMirror(type: NativeType, expr: string, module: NativeModule): string {
  if (type.kind === "string") return `String::from_utf8_lossy(unsafe { ts_polyglot_bytes(&${expr}) }).into_owned()`;
  if (type.kind === "char") return `char::from_u32(${expr}).unwrap_or('\\u{FFFD}')`;
  if (type.kind === "struct") return `${expr}.into()`;
  if (type.kind === "array") return type.length === undefined ? fromList(type, `&${expr}`, module) : `<${spelled(type, module)}>::try_from(${plain(type.of) ? slice(type.of, `&${expr}`) : fromList(type, `&${expr}`, module)}).unwrap()`;
  return expr;
}

/** The mirror field's value for the user's (`v` is a reference to the user's struct). */
function toMirror(type: NativeType, expr: string, module: NativeModule): string {
  if (type.kind === "string") return `ts_polyglot_own(&${expr})`;
  if (type.kind === "char") return `${expr} as u32`;
  if (type.kind === "struct") return `ts_polyglot_${type.name}::from(&${expr})`;
  if (type.kind === "array") return toList(type, expr, true, module);
  return expr;
}

/** The wrapper's own type for a value: the user's spelling, except a `char` (its code point), text (the ABI string), a struct (its mirror) and a sequence (the ABI array). */
function boundary(type: NativeType): string {
  if (type.kind === "reference") return boundary(type.to);
  if (type.kind === "char") return "u32";
  if (type.kind === "string") return "ts_polyglot_string";
  if (type.kind === "struct") return `ts_polyglot_${type.name}`;
  if (type.kind === "array") return "ts_polyglot_array";
  return type.spelling;
}

/** The elements of the ABI array `ref` (a `&ts_polyglot_array`) as a slice of their boundary type. */
const slice = (of: NativeType, ref: string) => `unsafe { ts_polyglot_slice::<${boundary(of)}>(${ref}) }`;

/** The user's element for one boundary element `e`, a reference into the slice. */
function fromElement(type: NativeType, e: string, module: NativeModule): string {
  if (type.kind === "char") return `char::from_u32(*${e}).unwrap_or('\\u{FFFD}')`;
  if (type.kind === "string") return `String::from_utf8_lossy(unsafe { ts_polyglot_bytes(${e}) }).into_owned()`;
  if (type.kind === "struct") return `${structSpelling(type.name, module)}::from(*${e})`;
  if (type.kind === "array") return type.length === undefined ? fromList(type, e, module) : `<${spelled(type, module)}>::try_from(${plain(type.of) ? slice(type.of, e) : fromList(type, e, module)}).unwrap()`;
  return `*${e}`;
}

/** A Vec of the user's elements from the ABI array `ref` (a `&ts_polyglot_array`): one copy for plain elements, a conversion each otherwise. */
function fromList(type: NativeType & { kind: "array" }, ref: string, module: NativeModule): string {
  return plain(type.of) ? `${slice(type.of, ref)}.to_vec()` : `${slice(type.of, ref)}.iter().map(|e| ${fromElement(type.of, "e", module)}).collect::<Vec<_>>()`;
}

/** The boundary element for one of the user's, owned (`into_iter`) or borrowed (`iter`). */
function toElement(type: NativeType, e: string, borrowed: boolean, module: NativeModule): string {
  if (type.kind === "char") return `${borrowed ? "*" : ""}${e} as u32`;
  if (type.kind === "string") return `ts_polyglot_own(${borrowed ? "" : "&"}${e})`;
  if (type.kind === "struct") return `ts_polyglot_${type.name}::from(${borrowed ? "" : "&"}${e})`;
  if (type.kind === "array") return toList(type, e, borrowed, module);
  return borrowed ? `*${e}` : e;
}

/** An owned ABI list from the user's sequence `expr`: a Vec moved whole or a fixed array copied for plain elements, a conversion each otherwise. */
function toList(type: NativeType & { kind: "array" }, expr: string, borrowed: boolean, module: NativeModule): string {
  if (plain(type.of)) return !borrowed && type.length === undefined ? `ts_polyglot_own_list(${expr})` : `ts_polyglot_own_list(${expr}.to_vec())`;
  return `ts_polyglot_own_list(${expr}.${borrowed ? "iter" : "into_iter"}().map(|e| ${toElement(type.of, "e", borrowed, module)}).collect::<Vec<_>>())`;
}

/** Whether a parameter arrives as text the wrapper has to validate first. */
const isText = (type: NativeType) => type.kind === "string" || (type.kind === "reference" && type.to.kind === "string");

/** The expression that turns a wrapper parameter into the user function's argument. A text parameter has been rebound to a `&str` by then. */
function argument(name: string, type: NativeType, module: NativeModule): string {
  if (type.kind === "reference" && type.to.kind === "string") return type.to.spelling === "str" ? name : `&String::from(${name})`;
  if (type.kind === "reference" && type.to.kind === "array") {
    const to = type.to;
    // `&[T]` of plain elements is the glue's buffer itself; `&[T; N]` a view of it; anything else a Vec built here and borrowed.
    if (to.length === undefined && to.spelling.startsWith("[")) return plain(to.of) ? slice(to.of, `&${name}`) : `&${fromList(to, `&${name}`, module)}[..]`;
    if (to.length !== undefined) return plain(to.of) ? `<&${spelled(to, module)}>::try_from(${slice(to.of, `&${name}`)}).unwrap()` : `&<${spelled(to, module)}>::try_from(${fromList(to, `&${name}`, module)}).unwrap()`;
    return `&${fromList(to, `&${name}`, module)}`;
  }
  if (type.kind === "array") {
    if (type.length === undefined) return fromList(type, `&${name}`, module);
    return `<${spelled(type, module)}>::try_from(${plain(type.of) ? slice(type.of, `&${name}`) : fromList(type, `&${name}`, module)}).unwrap()`;
  }
  if (type.kind === "string") return `${name}.to_owned()`;
  if (type.kind === "struct") return `${name}.into()`;
  if (type.kind === "reference") return `&${argument(name, type.to, module)}`;
  return type.kind === "char" ? `char::from_u32(${name}).unwrap_or('\\u{FFFD}')` : name;
}

/** How a user function's result becomes the wrapper's: text is copied into an owned ABI string, a struct into its mirror, a sequence into an owned list (or lent, when 'static and plain), a `&'static` primitive is read through. */
function lower(type: NativeType, module: NativeModule, expr = "r"): string {
  if (type.kind === "reference") {
    if (type.to.kind === "string") return `ts_polyglot_own(${expr})`;
    if (type.to.kind === "struct") return `ts_polyglot_${type.to.name}::from(${expr})`;
    if (type.to.kind === "array") {
      if (!plain(type.to.of)) return toList(type.to, expr, true, module);
      return type.to.length === undefined && type.to.spelling.startsWith("[") ? `ts_polyglot_borrow_list(${expr})` : `ts_polyglot_borrow_list(&${expr}[..])`;
    }
    return lower(type.to, module, `(*${expr})`);
  }
  if (type.kind === "char") return `${expr} as u32`;
  if (type.kind === "string") return `ts_polyglot_own(&${expr})`;
  if (type.kind === "struct") return `ts_polyglot_${type.name}::from(&${expr})`;
  if (type.kind === "array") return toList(type, expr, false, module);
  return expr;
}

/** `#[no_mangle] extern "C"` wrapper around a user function: boundary types in and out, the error slot set on a panic. */
export function rustWrapper(fn: NativeFunction, module: NativeModule): string {
  const slot = fn.params.some((param) => param.name === "error") ? "ts_polyglot_error" : "error";
  const params = [...fn.params.map((param) => `${param.name}: ${boundary(param.type)}`), `${slot}: *mut ts_polyglot_string`].join(", ");
  const call = `user::${fn.callee}(${fn.params.map((param) => argument(param.name, param.type, module)).join(", ")})`;
  const returns = fn.returns.kind === "void" ? "" : ` -> ${boundary(fn.returns)}`;
  const lowered = lower(fn.returns, module);
  // The glue's UTF-8 is well-formed (measured), so this never fails; it still reports instead of trusting.
  const texts = fn.params
    .filter((param) => isText(param.type))
    .map((param) => `    let ${param.name} = match std::str::from_utf8(unsafe { ts_polyglot_bytes(&${param.name}) }) { Ok(v) => v, Err(_) => { unsafe { *${slot} = ts_polyglot_own(${JSON.stringify(`${fn.name}(): ${param.name} isn't valid UTF-8`)}) }; return unsafe { std::mem::zeroed() }; } };`);
  return [
    "#[no_mangle]",
    `pub extern "C" fn ts_polyglot__${fn.name}(${params})${returns} {`,
    ...texts,
    `    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${call})) {`,
    `        Ok(r) => ${lowered},`,
    `        Err(p) => { unsafe { *${slot} = ts_polyglot_own(&ts_polyglot_panic_message(&p, ${JSON.stringify(fn.name)})) }; unsafe { std::mem::zeroed() } }`,
    "    }",
    "}",
    "",
  ].join("\n");
}
