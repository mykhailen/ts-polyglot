// The command line: `npm create ts-polyglot [dir] -- [options]`. Everything here is optional; the
// prompts ask for what's missing.
import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/args.ts";

test("no arguments means ask for everything", () => {
  assert.deepEqual(parseArgs([]), { dir: undefined, ide: undefined, install: undefined, yes: false, help: false });
});

test("the first positional is the project directory", () => {
  assert.equal(parseArgs(["my-app"]).dir, "my-app");
});

test("--ide picks the editor files to write", () => {
  assert.equal(parseArgs(["--ide", "vscode"]).ide, "vscode");
  assert.equal(parseArgs(["--ide", "none"]).ide, "none");
});

test("--install and --no-install decide the dependency install", () => {
  assert.equal(parseArgs(["--install"]).install, true);
  assert.equal(parseArgs(["--no-install"]).install, false);
});

test("--yes takes every default without asking", () => {
  assert.equal(parseArgs(["-y"]).yes, true);
  assert.equal(parseArgs(["--yes"]).yes, true);
});

test("--help is reported, not acted on", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("an unknown editor or option is an error that names it", () => {
  assert.throws(() => parseArgs(["--ide", "emacs"]), /--ide.*emacs/);
  assert.throws(() => parseArgs(["--bogus"]), /--bogus/);
  assert.throws(() => parseArgs(["a", "b"]), /b/);
});
