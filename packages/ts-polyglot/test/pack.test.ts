// Packs ts-polyglot as `npm publish` would and installs the tarball into a copy of the project
// fixture outside the repo, the way a user gets it. The other end-to-end tests reach the package
// through the workspace link, so they can't see what the tarball leaves out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const tsc = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin", "tsc");
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "ts-polyglot pack "));
const project = join(root, "project");
after(() => rmSync(root, { recursive: true, force: true }));

// npm sets npm_execpath for the scripts it runs, so these tests need `npm test`.
const npmCli = process.env.npm_execpath;
const skip = npmCli ? false : "run it with npm test, which sets npm_execpath";

function npm(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, [npmCli!, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `npm ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

before(() => {
  if (skip) return;
  // --ignore-scripts skips prepack: `npm test` has just built dist/, and rebuilding it here would
  // race the other test files, which run at the same time.
  const [{ filename }] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], packageDir));
  cpSync(fileURLToPath(new URL("./fixtures/project/", import.meta.url)), project, { recursive: true });
  // Inside the repo the fixture inherits "type": "module" from the package's package.json. Out here
  // it needs its own, which also keeps npm from installing into a project that encloses the
  // temporary directory.
  writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // node-api-headers is already in npm's cache from installing the repo.
  npm(["install", join(root, filename), "--prefer-offline", "--no-audit", "--no-fund"], project);
});

test("tsc type-checks a project that installed the tarball", { skip }, () => {
  const result = spawnSync(process.execPath, [tsc, "-p", ".", "--runExternalCode", "--pretty", "false"], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("C, C++ and Rust functions run from the installed tarball", { skip }, () => {
  // What a user gets: no CC or CXX, and the default cache, inside the installed package.
  const env = { ...process.env };
  delete env.CC;
  delete env.CXX;
  delete env.TS_POLYGLOT_CACHE_DIR;
  const result = spawnSync(process.execPath, ["--import", "ts-polyglot/register", "main.ts"], { cwd: project, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.add, 5);
  assert.equal(output.multiply, 42);
  assert.equal(output.fib, 12586269025);
  assert.equal(output.echo, -5);
  assert.equal(output.scale, 12);
  assert.equal(output.clamp, 10);
});

test("the tarball carries the license", { skip }, () => {
  assert.ok(existsSync(join(project, "node_modules", "ts-polyglot", "LICENSE")));
});
