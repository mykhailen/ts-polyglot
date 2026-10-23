// What the compiler check reports, without running a compiler: `run` and `exists` are injected.
import assert from "node:assert/strict";
import test from "node:test";

import { checkToolchain, type ToolcheckOptions } from "../src/toolchain.ts";

const none: ToolcheckOptions = { platform: "linux", env: {}, nodeVersion: "v22.21.0", exists: () => false, run: () => undefined };
const byName = (checks: ReturnType<typeof checkToolchain>) => Object.fromEntries(checks.map((c) => [c.tool, c]));

test("Linux needs cc, c++ and rustc, and says how to get them", () => {
  const checks = byName(checkToolchain(none));
  assert.equal(checks["C compiler"].found, false);
  assert.match(checks["C compiler"].hint, /build-essential/);
  assert.equal(checks["C++ compiler"].found, false);
  assert.equal(checks["Rust"].found, false);
  assert.match(checks["Rust"].hint, /rustup/);
});

test("a compiler that answers --version is found", () => {
  const ran: string[] = [];
  const checks = byName(checkToolchain({ ...none, run: (command) => (ran.push(command), "version 1") }));
  assert.ok(checks["C compiler"].found && checks["C++ compiler"].found && checks["Rust"].found);
  assert.deepEqual(ran.sort(), ["c++", "cc", "rustc"]);
});

test("CC and CXX name the compilers to look for, as ts-polyglot honors them", () => {
  const ran: string[] = [];
  checkToolchain({ ...none, env: { CC: "ccache gcc", CXX: "g++-13" }, run: (command) => (ran.push(command), undefined) });
  assert.ok(ran.includes("ccache") && ran.includes("g++-13"), ran.join(" "));
});

test("macOS points at the Xcode Command Line Tools", () => {
  const checks = byName(checkToolchain({ ...none, platform: "darwin" }));
  assert.match(checks["C compiler"].hint, /xcode-select --install/);
});

test("Windows looks for the Visual Studio C++ build tools with vswhere", () => {
  const missing = byName(checkToolchain({ ...none, platform: "win32" }));
  assert.equal(missing["C/C++ compiler (MSVC)"].found, false);
  assert.match(missing["C/C++ compiler (MSVC)"].hint, /Desktop development with C\+\+/);
  assert.equal(missing["C compiler"], undefined);

  const asked: string[][] = [];
  const found = byName(checkToolchain({
    ...none,
    platform: "win32",
    env: { "ProgramFiles(x86)": "C:\\PF86" },
    exists: (path) => path === "C:\\PF86\\Microsoft Visual Studio\\Installer\\vswhere.exe",
    run: (command, args) => (asked.push([command, ...args]), command.endsWith("vswhere.exe") ? "C:\\VS\\2022\\BuildTools\n" : undefined),
  }));
  assert.equal(found["C/C++ compiler (MSVC)"].found, true);
  assert.ok(asked.some((a) => a.includes("Microsoft.VisualStudio.Component.VC.Tools.x86.x64")), JSON.stringify(asked));
});

test("without ProgramFiles(x86) in the environment, vswhere is looked for under C:\\Program Files (x86)", () => {
  const looked: string[] = [];
  checkToolchain({ ...none, platform: "win32", exists: (path) => (looked.push(path), false) });
  assert.deepEqual(looked, ["C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe"]);
});

test("Node must be 22.18 or newer, for type stripping", () => {
  assert.equal(byName(checkToolchain({ ...none, nodeVersion: "v22.17.1" }))["Node 22.18+"].found, false);
  assert.equal(byName(checkToolchain({ ...none, nodeVersion: "v22.18.0" }))["Node 22.18+"].found, true);
  assert.equal(byName(checkToolchain({ ...none, nodeVersion: "v24.1.0" }))["Node 22.18+"].found, true);
});
