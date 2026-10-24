// Runs the real tsc and the real node over the projects in test/fixtures, against the dist/ that
// `npm test` builds. The addon cache is a fresh directory with a space in its name: every run
// compiles from scratch, and paths with spaces get exercised.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const tsc = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin", "tsc");
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
const cache = mkdtempSync(join(tmpdir(), "ts-polyglot test "));
after(() => rmSync(cache, { recursive: true, force: true }));

const windows = process.platform === "win32";
const linux = process.platform === "linux";

function typecheck(name: string) {
  const result = spawnSync(process.execPath, [tsc, "-p", ".", "--runExternalCode", "--pretty", "false"], { cwd: fixture(name), encoding: "utf8" });
  const errors = result.stdout.split(/\r?\n/).filter((line) => /: error TS\d+/.test(line));
  return { status: result.status, errors, output: result.stdout + result.stderr };
}

/** Runs a fixture's main.ts, which prints one JSON object. CC and CXX come only from `env`. */
function run(name: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.CC;
  delete inherited.CXX;
  const result = spawnSync(process.execPath, ["--import", "ts-polyglot/register", "main.ts"], {
    cwd: fixture(name),
    encoding: "utf8",
    env: { ...inherited, TS_POLYGLOT_CACHE_DIR: cache, ...env },
  });
  return { status: result.status, stderr: result.stderr, output: result.status === 0 ? JSON.parse(result.stdout) : undefined };
}

test("tsc type-checks the fixtures without errors", () => {
  for (const name of ["project", "clang", "inspector"]) {
    const { status, errors, output } = typecheck(name);
    assert.deepEqual(errors, [], output);
    // Errors that aren't about a file, such as an unknown option, only show in the exit status.
    assert.equal(status, 0, output);
  }
});

test("C, C++ and Rust functions run", () => {
  const { status, stderr, output } = run("project");
  assert.equal(status, 0, stderr);
  assert.equal(output.add, 5);
  assert.equal(output.multiply, 42);
  assert.equal(output.fib, 12586269025);
  assert.equal(output.echo, -5);
  // A function in a namespace, and one in a `pub mod`: the glue calls them by their qualified names.
  assert.equal(output.scale, 12);
  assert.equal(output.clamp, 10);
});

test("a C function named like a libc function runs, not libc's", () => {
  assert.equal(run("project").output.random, 10);
});

test("a function the native file declares but never defines fails the import, catchably", () => {
  const { status, stderr, output } = run("unresolved");
  assert.equal(status, 0, stderr);
  assert.match(output.error, /helper/);
});

// Otherwise a breakpoint set in add.cpp binds to the generated JavaScript and stops there on import,
// instead of being left to the native debugger.
test("a JavaScript debugger sees no script under a native file's URL", () => {
  const { status, stderr, output } = run("inspector");
  assert.equal(status, 0, stderr);
  assert.equal(output.add, 5);
  assert.ok(output.scripts.some((url: string) => url.endsWith("/main.ts")), `no scripts reported: ${JSON.stringify(output.scripts)}`);
  assert.deepEqual(output.scripts.filter((url: string) => /\.(c|cpp|rs)$/.test(url)), []);
});

test("addons are built in TS_POLYGLOT_CACHE_DIR", () => {
  run("project");
  assert.ok(readdirSync(cache).length > 0, `nothing was built in ${cache}`);
});

test("C long keeps 64 bits on Linux and macOS", { skip: windows }, () => {
  assert.equal(run("project").output.wide, 2 ** 40);
});

test("package.json picks clang on Linux and macOS", { skip: windows }, () => {
  const { status, stderr, output } = run("clang");
  assert.equal(status, 0, stderr);
  assert.deepEqual(output, { c: 1, cpp: 1 });
});

// Same cache as the test above, so this also checks that a different compiler rebuilds. On macOS,
// gcc is Apple clang, hence Linux only.
test("CC overrides package.json for C only", { skip: !linux }, () => {
  const { status, stderr, output } = run("clang", { CC: "gcc" });
  assert.equal(status, 0, stderr);
  assert.deepEqual(output, { c: 0, cpp: 1 });
});

test("a missing compiler is an error that says where the choice came from", { skip: windows }, () => {
  const { status, stderr } = run("clang", { CC: "/nonexistent/cc" });
  assert.notEqual(status, 0);
  assert.match(stderr, /can't run the C compiler "\/nonexistent\/cc" \(from CC\)/);
});

test("Windows ignores compiler, CC and CXX", { skip: !windows }, () => {
  const { status, stderr, output } = run("clang", { CC: "/nonexistent/cc", CXX: "/nonexistent/c++" });
  assert.equal(status, 0, stderr);
  assert.deepEqual(output, { c: 0, cpp: 0 });
});
