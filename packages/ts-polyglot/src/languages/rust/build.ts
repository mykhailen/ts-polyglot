// The Rust half of a build. The user's file becomes a module of a small crate whose `#[no_mangle]
// extern "C"` wrappers take and return the C boundary types; rustc builds that crate into a static
// library, and build.ts links it into the Node-API glue, which is C and calls the wrappers through
// the prototypes below.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Compiler } from "../../compiler.ts";
import type { NativeFunction } from "../../signatures.ts";
import { run } from "../../toolchain.ts";

/** Builds the static library and returns it with the native libraries it needs, ready to link. */
export function rustStaticLib(file: string, functions: NativeFunction[], dir: string, libName: string, debug: boolean): string[] {
  const wrapper = join(dir, "wrapper.rs");
  writeFileSync(
    wrapper,
    [
      "#![allow(warnings)]",
      `#[path = ${JSON.stringify(file.replaceAll("\\", "/"))}]`,
      "mod user;",
      "",
      ...functions.map(rustWrapper),
    ].join("\n"),
  );
  const lib = join(dir, libName);
  const codegen = debug ? ["-C", "opt-level=0", "-C", "debuginfo=2"] : ["-C", "opt-level=2"];
  const args = ["--edition", "2021", "--crate-type", "staticlib", ...rustTargetArgs(process.platform, process.arch), ...codegen, "--print", "native-static-libs", "-o", lib, wrapper];
  const stderr = run("rustc", args, dir, { missing: "ts-polyglot: can't run rustc, which builds .rs files. Install Rust from https://rustup.rs." });
  // The library needs the system libraries Rust's standard library uses; rustc names them.
  const native = /native-static-libs:\s*(.*)/.exec(stderr)?.[1]?.trim().split(/\s+/) ?? [];
  return [lib, ...native];
}

/** `#[no_mangle] extern "C"` wrapper around a Rust function, using the C boundary types. */
export function rustWrapper(fn: NativeFunction): string {
  const params = fn.params.map((p) => `${p.name}: ${p.kind.rust}`).join(", ");
  const args = fn.params.map((p) => (p.type === p.kind.rust ? p.name : `${p.name} as ${p.type}`)).join(", ");
  const call = `user::${fn.callee}(${args})`;
  if (fn.returns.ts === "void") return `#[no_mangle]\npub extern "C" fn ts_polyglot__${fn.name}(${params}) {\n    ${call};\n}\n`;
  const body = fn.returnType === fn.returns.rust ? call : `${call} as ${fn.returns.rust}`;
  return `#[no_mangle]\npub extern "C" fn ts_polyglot__${fn.name}(${params}) -> ${fn.returns.rust} {\n    ${body}\n}\n`;
}

/** The wrapper's C prototype, for the glue. */
export function rustPrototype(fn: NativeFunction): string {
  const params = fn.params.map((p, i) => `${p.kind.c} arg${i}`).join(", ") || "void";
  return `${fn.returns.c} ts_polyglot__${fn.name}(${params});`;
}

/** rustc builds for its own host, so on macOS it's told Node's architecture, as the C side is. */
export function rustTargetArgs(platform: NodeJS.Platform, arch: string): string[] {
  if (platform !== "darwin") return [];
  return ["--target", arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
}

/** MSVC's linker reads .lib archives; gcc and clang read lib*.a ones. */
export function rustStaticLibName(compiler: Compiler): string {
  return compiler.family === "msvc" ? "user.lib" : "libuser.a";
}
