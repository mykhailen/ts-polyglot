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
  assert.equal(output.fib, "12586269025n");
  assert.equal(output.echo, "-5n");
  // A function in a namespace, and one in a `pub mod`: the glue calls them by their qualified names.
  assert.equal(output.scale, 12);
  assert.equal(output.clamp, 10);
});

test("64-bit integers are bigints out and take numbers or bigints in", () => {
  const { output } = run("project");
  assert.equal(output.u64, "18446744073709551615n");
  assert.equal(output.u64Number, "5n");
  assert.equal(output.count, "7n");
  assert.equal(output.usize, "7n");
  assert.equal(output.bigOver.error, "RangeError: echo_u64(): x must be an integer between 0 and 18446744073709551615");
});

test("conversions are strict: wrong types are TypeErrors, impossible values RangeErrors, with the limits in the message", () => {
  const { output } = run("project");
  assert.equal(output.i8, -128);
  assert.equal(output.i8Over.error, "RangeError: echo_i8(): x must be an integer between -128 and 127");
  assert.equal(output.i8Big, 5); // a bigint is fine for a narrow integer at runtime; TypeScript says number
  assert.equal(output.negate, false);
  assert.equal(output.notBool.error, "TypeError: negate(): b must be a boolean");
  assert.equal(output.fractional.error, "RangeError: add(): a must be an integer between -2147483648 and 2147483647");
  assert.equal(output.wrongType.error, "TypeError: add(): a must be an integer between -2147483648 and 2147483647");
  assert.equal(output.negativeUnsigned.error, "RangeError: fib(): n must be an integer between 0 and 4294967295");
  assert.equal(output.half, 1.5);
  assert.equal(output.char, "b");
  assert.equal(output.charTwo.error, "RangeError: next_char(): c must be one character");
});

test("a C++ exception and a Rust panic are JavaScript errors with the message", () => {
  const { output } = run("project");
  assert.equal(output.throws.error, "Error: boom");
  assert.equal(output.throwsNot, -1);
  assert.equal(output.panics.error, "Error: boom");
});

test("strings cross as UTF-8 in both directions, with C's NUL and NULL rules", () => {
  const { output } = run("project");
  assert.equal(output.describeNull, null);
  assert.equal(output.describe, "non-negative");
  assert.equal(output.bytes, "6n");
  assert.equal(output.bytesNull, "0n");
  assert.equal(output.nulInC.error, "RangeError: byte_count(): s must be a string without NUL characters, or null");
  assert.equal(output.long, "100000n");
  assert.equal(output.shoutCpp, "HéLLO 😀!");
  assert.equal(output.firstWord, "hello");
  assert.equal(output.repeatNul, "ab\0ab\0");
  assert.equal(output.shoutRs, "HÉLLO!");
  assert.equal(output.emoji, "4n");
  // A lone surrogate reaches Rust as U+FFFD, three bytes, not as an error.
  assert.equal(output.loneSurrogate, "3n");
  assert.equal(output.motto, "ship it");
  assert.equal(output.echoLong, 100000);
  assert.equal(output.wrongString.error, "TypeError: shout(): s must be a string");
  assert.equal(output.nullToOwned.error, "TypeError: byte_len(): s must be a string");
});

test("plain structs cross by value, nested, with 64-bit and string fields", () => {
  const { output } = run("project");
  assert.equal(output.area, 12);
  assert.deepEqual(output.grow, { min: { x: -1, y: -1 }, max: { x: 2, y: 2 }, id: "5n" });
  assert.deepEqual(output.retag, { name: "a", id: 2 });
  assert.equal(output.retagNull, null);
  assert.deepEqual(output.louder, { text: "hi!", size: 2 });
  assert.deepEqual(output.mid, { x: 1, y: 2 });
  assert.deepEqual(output.shift, { x: 4, y: "2n" });
  assert.deepEqual(output.shiftNumber, { x: 4, y: "2n" });
  assert.deepEqual(output.rename, { name: "b", at: { x: 1, y: "2n" } });
  assert.equal(output.dist, 5);
  assert.equal(output.extra, 12);
});

test("a parameter named r, a borrowed primitive result and a throwing getter", () => {
  const { output } = run("project");
  assert.equal(output.same, "x");
  assert.equal(output.sameEmpty, "");
  assert.equal(output.maxLevel, 7);
  // The getter's own error comes back; the reader never looks at the unwritten slot.
  assert.equal(output.throwingGetter.error, "Error: getter");
});

test("struct arguments are checked field by field, with the path in the message", () => {
  const { output } = run("project");
  assert.equal(output.missing.error, "TypeError: shift(): p.y must be an integer between -9223372036854775808 and 9223372036854775807");
  assert.equal(output.nullStruct.error, "TypeError: shift(): p must be an object with x, y");
  assert.equal(output.arrayStruct.error, "TypeError: shift(): p must be an object with x, y");
  assert.equal(output.nestedWrong.error, "TypeError: rename(): n.at.x must be an integer between -2147483648 and 2147483647");
});

// A function named like one that glibc's headers declare (`random`) can't build at all: the glue
// includes those headers before the user's file. So the fixture's name is its own.
test("a C function is called by its own name", () => {
  assert.equal(run("project").output.shuffle, 10);
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
  assert.equal(run("project").output.wide, "1099511627776n");
});

// The TypeScript type is the same everywhere; the glue checks against the platform's LONG_MAX.
test("C long is 32 bits on Windows, and a value past that is a RangeError", { skip: !windows }, () => {
  assert.equal(run("project").output.wide.error, "RangeError: echo_long(): x must be an integer between -2147483648 and 2147483647");
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

test("C arrays: sequences with their length, fixed arrays, bytes from any Uint8Array, counted and bounded strings, structs with array fields", () => {
  const { status, stderr, output } = run("project");
  assert.equal(status, 0, stderr);
  assert.equal(output.mean, 2);
  assert.equal(output.meanEmpty, 0);
  assert.equal(output.dot, 32);
  assert.equal(output.checksum, 1 * 31 * 31 + 2 * 31 + 3);
  assert.equal(output.checksumBuffer, output.checksum);
  assert.equal(output.checksumView, output.checksum);
  assert.equal(output.checksumEmpty, 0);
  assert.equal(output.checksumBig, 0);
  assert.equal(output.longest, "bbb");
  assert.equal(output.countA, "2n");
  assert.equal(output.norm, 25);
  assert.equal(output.polyArea, 2 + 12 + 5 + 7);
  assert.deepEqual(output.relabel, { pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "héllo", key: { "0": 0, "1": 0, "2": 0, "3": 9 }, grid: [[1, 2], [3, 4]] });
  assert.equal(output.relabelLongest, "x");
  assert.equal(output.totalPts, 5);
  assert.equal(output.trace, 5);
  assert.equal(output.meanBig, 499999.5);
});

test("C arrays: every wrong input is a TypeError or RangeError with the path, a length mismatch an Error", () => {
  const { output } = run("project");
  assert.equal(output.badElement.error, "TypeError: mean(): xs[1] must be a number");
  assert.equal(output.hole.error, "TypeError: mean(): xs[1] must be a number");
  assert.equal(output.notArray.error, "TypeError: mean(): xs must be an array");
  assert.equal(output.proxy.error, "TypeError: mean(): xs must be an array");
  assert.equal(output.argumentsObject.error, "TypeError: mean(): xs must be an array");
  assert.equal(output.wrongLength.error, "RangeError: norm(): v must have 3 elements");
  assert.equal(output.lengthsDiffer.error, "Error: dot(): b must have as many elements as a");
  assert.equal(output.nameTooLong.error, "RangeError: relabel(): p.name must be at most 15 UTF-8 bytes without NUL characters");
  assert.equal(output.nameWithNul.error, "RangeError: relabel(): p.name must be at most 15 UTF-8 bytes without NUL characters");
  assert.equal(output.keyLength.error, "RangeError: relabel(): p.key must have 4 bytes");
  assert.equal(output.nestedPath.error, "TypeError: trace(): m[1][1] must be an integer between -2147483648 and 2147483647");
  assert.equal(output.notBytes.error, "TypeError: checksum(): data must be a Uint8Array");
  assert.equal(output.bytesArray.error, "TypeError: checksum(): data must be a Uint8Array");
  assert.equal(output.bytesBuffer.error, "TypeError: checksum(): data must be a Uint8Array");
  assert.equal(output.detached.error, "TypeError: checksum(): data must be a Uint8Array that isn't detached");
});

test("C++ arrays: vectors, std::array tuples, nested vectors, byte vectors, vector<bool>, structs with vector fields, an exception midway", () => {
  const { output } = run("project");
  assert.deepEqual(output.evens, [2, 4]);
  assert.deepEqual(output.evensEmpty, []);
  assert.deepEqual(output.split, ["a", "bc", "d"]);
  assert.deepEqual(output.cross, [0, 0, 1]);
  assert.deepEqual(output.transpose, [[1, 4], [2, 5], [3, 6]]);
  assert.deepEqual(output.reverseBytes, [3, 2, 1]);
  assert.equal(output.reverseBytesIsU8, true);
  assert.equal(output.countTrue, "2n");
  assert.deepEqual(output.close, { pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 2 }], name: "tri!" });
  assert.deepEqual(output.closeEmpty, { pts: [], name: "!" });
  assert.equal(output.throwsMidway.error, "Error: too many");
  assert.deepEqual(output.throwsNotMidway, [1, 2]);
  assert.equal(output.crossLength.error, "RangeError: cross(): a must have 3 elements");
  assert.equal(output.nestedBad.error, "TypeError: transpose(): m[1][1] must be an integer between -2147483648 and 2147483647");
  assert.equal(output.flagsBad.error, "TypeError: count_true(): flags[1] must be a boolean");
  assert.equal(output.closeBad.error, "TypeError: close(): s.pts[1].y must be an integer between -2147483648 and 2147483647");
});

test("Rust arrays: slices, Vecs, fixed arrays, bytes, structs with list fields, nested paths, a panic midway, a throwing getter", () => {
  const { output } = run("project");
  assert.equal(output.sum, "6n");
  assert.equal(output.sumEmpty, "0n");
  assert.deepEqual(output.evensRs, [2, 4]);
  assert.deepEqual(output.shoutAll, ["HÉLLO", "X"]);
  assert.deepEqual(output.crossRs, [0, 0, 1]);
  assert.deepEqual(output.reverse, [3, 2, 1]);
  assert.equal(output.reverseEmpty, 0);
  assert.equal(output.reverseBig, 1_000_000);
  assert.equal(output.digest, 1);
  assert.deepEqual(output.pair, [2, 1]);
  assert.deepEqual(output.shiftAll, { pts: [{ x: 2, y: "3n" }, { x: 4, y: "5n" }], name: "p!", key: { "0": 2, "1": 2, "2": 3, "3": 4 } });
  assert.deepEqual(output.grid, [[2, 4], [6]]);
  assert.deepEqual(output.chars, ["😀", "a"]);
  assert.deepEqual(output.mottoBytes, [115, 104, 105, 112]);
  assert.equal(output.panicsMidway.error, "Error: boom");
  assert.deepEqual(output.panicsNot, [1]);
  assert.equal(output.digestLength.error, "RangeError: digest(): key must have 4 bytes");
  assert.equal(output.keyLengthRs.error, "RangeError: shift_all(): p.key must have 4 bytes");
  assert.equal(output.gridPath.error, "TypeError: grid(): m[1][1] must be an integer between -2147483648 and 2147483647");
  assert.equal(output.ptsPath.error, "TypeError: shift_all(): p.pts[1].y must be an integer between -9223372036854775808 and 9223372036854775807");
  assert.equal(output.getterInList.error, "Error: getter");
  assert.equal(output.detachedRs.error, "TypeError: reverse(): data must be a Uint8Array that isn't detached");
});
