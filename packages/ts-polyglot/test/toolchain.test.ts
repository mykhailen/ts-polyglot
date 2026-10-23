// The gcc/clang command lines, checked without running a compiler, so macOS is covered from any OS.
import assert from "node:assert/strict";
import test from "node:test";

import { rustStaticLibName, rustTargetArgs, unixArgs, type AddonBuild } from "../src/toolchain.ts";

const build: AddonBuild = { language: "c", glue: "glue.c", libs: ["libuser.a", "-lm"], out: "a.node", debug: false, cacheRoot: "cache" };

test("Linux builds a position-independent shared library", () => {
  const args = unixArgs(build, "linux", "x64");
  for (const flag of ["-shared", "-fPIC", "-O2"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.some((arg) => arg.startsWith("-I") && /node-api-headers[\\/]include$/.test(arg)), args.join(" "));
  assert.ok(!args.includes("-std=c++17"));
  // GNU ld resolves left to right: libraries come after the glue that uses them.
  assert.ok(args.indexOf("glue.c") < args.indexOf("libuser.a"));
  assert.deepEqual(args.slice(-2), ["-o", "a.node"]);
});

test("user functions stay inside the addon, so same-named libc or node functions can't replace them", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assert.ok(unixArgs(build, platform, "x64").includes("-fvisibility=hidden"), platform);
  }
});

test("C++ gets C++17", () => {
  assert.ok(unixArgs({ ...build, language: "cpp", glue: "glue.cpp" }, "linux", "x64").includes("-std=c++17"));
});

test("debug builds are unoptimized, with debug info", () => {
  const args = unixArgs({ ...build, debug: true }, "linux", "x64");
  assert.ok(args.includes("-g") && args.includes("-O0") && !args.includes("-O2"), args.join(" "));
});

test("macOS builds a bundle for Node's architecture that finds Node-API at load time", () => {
  const arm = unixArgs(build, "darwin", "arm64");
  const at = arm.indexOf("-bundle");
  assert.deepEqual(arm.slice(at, at + 5), ["-bundle", "-undefined", "dynamic_lookup", "-arch", "arm64"]);
  assert.ok(!arm.includes("-shared"));
  assert.ok(unixArgs(build, "darwin", "x64").includes("x86_64"));
});

test("rustc targets Node's architecture on macOS only", () => {
  assert.deepEqual(rustTargetArgs("darwin", "arm64"), ["--target", "aarch64-apple-darwin"]);
  assert.deepEqual(rustTargetArgs("darwin", "x64"), ["--target", "x86_64-apple-darwin"]);
  assert.deepEqual(rustTargetArgs("linux", "x64"), []);
  assert.deepEqual(rustTargetArgs("win32", "x64"), []);
});

test("the Rust static library is named for the linker that reads it", () => {
  assert.equal(rustStaticLibName({ family: "msvc" }), "user.lib");
  assert.equal(rustStaticLibName({ family: "unix", command: ["cc"], source: "default" }), "libuser.a");
});
