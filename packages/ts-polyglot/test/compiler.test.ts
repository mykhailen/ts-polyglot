// Which compiler builds a file. Platform and env are passed in, so every OS is covered from any OS.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { after } from "node:test";

import { cppCompilerFor, resolveCompiler } from "../src/compiler.ts";

const root = mkdtempSync(join(tmpdir(), "ts-polyglot-compiler-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A directory under the temp root, with a package.json made from an object or written as raw text. */
function project(name: string, packageJson?: unknown): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (packageJson !== undefined) {
    writeFileSync(join(dir, "package.json"), typeof packageJson === "string" ? packageJson : JSON.stringify(packageJson));
  }
  return dir;
}
const linux = { platform: "linux", env: {} } as const;
const unix = (command: string[], source: string) => ({ family: "unix", command, source });

test("Windows always uses MSVC", () => {
  const dir = project("win", { "ts-polyglot": { compiler: "gcc" } });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform: "win32", env: { CC: "gcc" } }), { family: "msvc" });
});

test("Linux and macOS default to cc and c++", () => {
  const dir = project("plain", { name: "plain" });
  for (const platform of ["linux", "darwin"] as const) {
    assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform, env: {} }), unix(["cc"], "default"));
    assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", { platform, env: {} }), unix(["c++"], "default"));
  }
});

test("package.json picks the compiler, and C++ gets the matching driver", () => {
  const dir = project("clang", { "ts-polyglot": { compiler: "clang" } });
  const pkg = join(dir, "package.json");
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix(["clang"], pkg));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", linux), unix(["clang++"], pkg));
});

test("the search goes upward past package.json files without the field", () => {
  const top = project("up", { "ts-polyglot": { compiler: "gcc" } });
  const inner = project(join("up", "inner"), { name: "inner" });
  assert.deepEqual(resolveCompiler(join(inner, "src", "a.c"), "c", linux), unix(["gcc"], join(top, "package.json")));
});

test("the nearest ts-polyglot field wins, even without a compiler", () => {
  project("near", { "ts-polyglot": { compiler: "gcc" } });
  const inner = project(join("near", "inner"), { "ts-polyglot": {} });
  assert.deepEqual(resolveCompiler(join(inner, "a.c"), "c", linux), unix(["cc"], "default"));
});

test("a relative compiler path is relative to its package.json", () => {
  const dir = project("relative", { "ts-polyglot": { compiler: "./tools/gcc-13" } });
  const pkg = join(dir, "package.json");
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix([join(dir, "tools", "gcc-13")], pkg));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", linux), unix([join(dir, "tools", "g++-13")], pkg));
});

test("CC and CXX override package.json, each for its own language", () => {
  const dir = project("env", { "ts-polyglot": { compiler: "clang" } });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform: "linux", env: { CC: "ccache gcc" } }), unix(["ccache", "gcc"], "CC"));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", { platform: "linux", env: { CC: "gcc" } }), unix(["clang++"], join(dir, "package.json")));
  assert.deepEqual(resolveCompiler(join(dir, "a.cpp"), "cpp", { platform: "linux", env: { CXX: "g++-13" } }), unix(["g++-13"], "CXX"));
});

test("an empty CC counts as unset", () => {
  const dir = project("empty-env", { name: "x" });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", { platform: "linux", env: { CC: "  " } }), unix(["cc"], "default"));
});

test("msvc on Linux or macOS is an error naming the package.json", () => {
  const dir = project("msvc", { "ts-polyglot": { compiler: "msvc" } });
  assert.throws(
    () => resolveCompiler(join(dir, "a.c"), "c", { platform: "darwin", env: {} }),
    (error: Error) => error.message.includes("only works on Windows") && error.message.includes(join(dir, "package.json")),
  );
});

test("bad settings are errors", () => {
  const notString = project("not-string", { "ts-polyglot": { compiler: 42 } });
  assert.throws(() => resolveCompiler(join(notString, "a.c"), "c", linux), /"compiler" in .* must be a string/);
  const notObject = project("not-object", { "ts-polyglot": "clang" });
  assert.throws(() => resolveCompiler(join(notObject, "a.c"), "c", linux), /must be an object/);
  const broken = project("broken", "{ not json");
  assert.throws(() => resolveCompiler(join(broken, "a.c"), "c", linux), /can't parse/);
});

test("a C++ file needs CXX when the C compiler has no C++ counterpart", () => {
  const dir = project("tcc", { "ts-polyglot": { compiler: "tcc" } });
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix(["tcc"], join(dir, "package.json")));
  assert.throws(() => resolveCompiler(join(dir, "a.cpp"), "cpp", linux), /Set CXX/);
});

test("reads a package.json that starts with a BOM", () => {
  const dir = project("bom", "﻿" + JSON.stringify({ "ts-polyglot": { compiler: "clang" } }));
  assert.deepEqual(resolveCompiler(join(dir, "a.c"), "c", linux), unix(["clang"], join(dir, "package.json")));
});

test("falls back to the default when no package.json is found", () => {
  // Directories that don't exist, right under the filesystem root: the search has to end there.
  const file = join(parse(root).root, "ts-polyglot-no-such-dir", "deeper", "a.c");
  assert.deepEqual(resolveCompiler(file, "c", linux), unix(["cc"], "default"));
});

test("C++ drivers match their C compilers", () => {
  const pairs = {
    gcc: "g++", clang: "clang++", cc: "c++", "gcc-13": "g++-13", "clang-18": "clang++-18",
    "x86_64-linux-gnu-gcc": "x86_64-linux-gnu-g++", "x86_64-linux-gnu-cc": "x86_64-linux-gnu-c++",
  };
  for (const [c, cpp] of Object.entries(pairs)) assert.equal(cppCompilerFor(c), cpp, c);
  assert.equal(cppCompilerFor(join("opt", "llvm", "bin", "clang")), join("opt", "llvm", "bin", "clang++"));
  assert.equal(cppCompilerFor("tcc"), undefined);
  assert.equal(cppCompilerFor("clang++"), undefined);
});
