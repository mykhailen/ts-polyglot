// The Rust bridge: the user's file becomes a module of a small crate whose `#[no_mangle] extern "C"`
// wrappers take and return the boundary types; rustc builds that crate into a static library, which
// the glue links and calls through the prototypes in the prelude. Every wrapper runs the user's
// function under `catch_unwind`, because unwinding out of an `extern "C"` function aborts the process.
// Structs cross through `#[repr(C)]` mirrors this crate declares, so the user's types need no attribute.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Compiler } from "../../compiler.ts";
import { structsInDependencyOrder, type NativeFunction, type NativeModule, type NativeStruct, type NativeType } from "../../signatures.ts";
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
  return { name: `ts_polyglot__${fn.name}`, params: fn.params.map((param) => rustAbi(param.type, module)), returns: rustAbi(fn.returns, module), reportsErrors: true };
}

/** The mirrors' C typedefs and the wrappers' prototypes, for the glue. The ABI string itself comes from the glue's header. */
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
    "#[repr(C)]",
    'pub struct ts_polyglot_string { ptr: *mut u8, len: usize, release: Option<unsafe extern "C" fn(*mut u8, usize)> }',
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
    "fn ts_polyglot_panic_message(payload: &Box<dyn std::any::Any + Send>, name: &str) -> String {",
    "    if let Some(s) = payload.downcast_ref::<&str>() { s.to_string() }",
    "    else if let Some(s) = payload.downcast_ref::<String>() { s.clone() }",
    "    else { format!(\"{}() panicked\", name) }",
    "}",
    "",
    ...structsInDependencyOrder(module).map(mirror),
    ...module.functions.map(rustWrapper),
  ].join("\n");
}

/** The repr(C) twin of a user struct and the conversions both ways, field by field. */
function mirror(struct: NativeStruct): string {
  const name = `ts_polyglot_${struct.name}`;
  return [
    "#[repr(C)]",
    `pub struct ${name} { ${struct.fields.map((field) => `pub ${cMember(field.name)}: ${boundary(field.type)}`).join(", ")} }`,
    `impl From<${name}> for ${struct.spelling} {`,
    `    fn from(m: ${name}) -> Self { ${struct.spelling} { ${struct.fields.map((field) => `${field.name}: ${fromMirror(field.type, `m.${cMember(field.name)}`)}`).join(", ")} } }`,
    "}",
    `impl From<&${struct.spelling}> for ${name} {`,
    `    fn from(v: &${struct.spelling}) -> Self { ${name} { ${struct.fields.map((field) => `${cMember(field.name)}: ${toMirror(field.type, `v.${field.name}`)}`).join(", ")} } }`,
    "}",
    "",
  ].join("\n");
}

/** The user's value for a mirror field's. The glue's UTF-8 is well-formed (measured), so lossy decoding never has anything to replace. */
function fromMirror(type: NativeType, expr: string): string {
  if (type.kind === "string") return `String::from_utf8_lossy(unsafe { ts_polyglot_bytes(&${expr}) }).into_owned()`;
  if (type.kind === "char") return `char::from_u32(${expr}).unwrap_or('\\u{FFFD}')`;
  if (type.kind === "struct") return `${expr}.into()`;
  return expr;
}

/** The mirror field's value for the user's. */
function toMirror(type: NativeType, expr: string): string {
  if (type.kind === "string") return `ts_polyglot_own(&${expr})`;
  if (type.kind === "char") return `${expr} as u32`;
  if (type.kind === "struct") return `ts_polyglot_${type.name}::from(&${expr})`;
  return expr;
}

/** The wrapper's own type for a value: the user's spelling, except a `char` (its code point), text (the ABI string) and a struct (its mirror). */
function boundary(type: NativeType): string {
  if (type.kind === "reference") return boundary(type.to);
  if (type.kind === "char") return "u32";
  if (type.kind === "string") return "ts_polyglot_string";
  if (type.kind === "struct") return `ts_polyglot_${type.name}`;
  return type.spelling;
}

/** Whether a parameter arrives as text the wrapper has to validate first. */
const isText = (type: NativeType) => type.kind === "string" || (type.kind === "reference" && type.to.kind === "string");

/** The expression that turns a wrapper parameter into the user function's argument. A text parameter has been rebound to a `&str` by then. */
function argument(name: string, type: NativeType): string {
  if (type.kind === "reference" && type.to.kind === "string") return type.to.spelling === "str" ? name : `&String::from(${name})`;
  if (type.kind === "string") return `${name}.to_owned()`;
  if (type.kind === "struct") return `${name}.into()`;
  if (type.kind === "reference") return `&${argument(name, type.to)}`;
  return type.kind === "char" ? `char::from_u32(${name}).unwrap_or('\\u{FFFD}')` : name;
}

/** How a user function's result becomes the wrapper's: text is copied into an owned ABI string, a struct into its mirror. */
function lower(type: NativeType): string {
  if (type.kind === "char") return "r as u32";
  if (type.kind === "string") return "ts_polyglot_own(&r)";
  if (type.kind === "struct") return `ts_polyglot_${type.name}::from(&r)`;
  if (type.kind === "reference" && type.to.kind === "string") return "ts_polyglot_own(r)";
  if (type.kind === "reference" && type.to.kind === "struct") return `ts_polyglot_${type.to.name}::from(r)`;
  return "r";
}

/** `#[no_mangle] extern "C"` wrapper around a user function: boundary types in and out, the error slot set on a panic. */
export function rustWrapper(fn: NativeFunction): string {
  const slot = fn.params.some((param) => param.name === "error") ? "ts_polyglot_error" : "error";
  const params = [...fn.params.map((param) => `${param.name}: ${boundary(param.type)}`), `${slot}: *mut ts_polyglot_string`].join(", ");
  const call = `user::${fn.callee}(${fn.params.map((param) => argument(param.name, param.type)).join(", ")})`;
  const returns = fn.returns.kind === "void" ? "" : ` -> ${boundary(fn.returns)}`;
  const lowered = lower(fn.returns);
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
