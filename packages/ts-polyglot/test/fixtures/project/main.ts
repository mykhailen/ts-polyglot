import { add, first_word, multiply, repeat, same, scale, shout, throws } from "./add.cpp";
import { louder, mid } from "./labels.cpp";
import { byte_count, describe, shuffle } from "./names.c";
import { byte_len, clamp, echo_ref, echo_usize, fib, max_level, motto, next_char, panics, shout as shout_rs } from "./numbers.rs";
import { dist, rename, shift } from "./points.rs";
import { area, grow, retag } from "./shapes.c";
import { count, echo_i8, echo_long, echo_u64, half, negate } from "./values.c";
import { area as poly_area, checksum, count_a, dot, longest, mean, norm, relabel, total_pts, trace } from "./vectors.c";
import { close, count_true, cross, evens, reverse_bytes, split, throws_midway, transpose } from "./vectors.cpp";
import { chars, cross as cross_rs, digest, evens as evens_rs, grid, motto_bytes, pair, panics_midway, reverse, shift_all, shout_all, sum } from "./vectors.rs";

// The fixture has no @types/node; a Buffer is a Uint8Array, which is all the glue needs to know.
declare const Buffer: { from(bytes: number[]): Uint8Array };

// What a call threw, as "Name: message", so the test can check the class and the text.
const attempt = (f: () => unknown) => {
  try {
    return f();
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}` };
  }
};

const output = {
  add: add(2, 3),
  multiply: multiply(6, 7),
  fib: fib(50),
  echo: echo_long(-5),
  shuffle: shuffle(5),
  scale: scale(3, 4),
  clamp: clamp(15, 0, 10),
  wide: attempt(() => echo_long(2n ** 40n)),
  i8: echo_i8(-128),
  i8Over: attempt(() => echo_i8(128)),
  i8Big: echo_i8(5n as never),
  negate: negate(true),
  notBool: attempt(() => negate(1 as never)),
  fractional: attempt(() => add(1.5, 2)),
  wrongType: attempt(() => add("1" as never, 2)),
  negativeUnsigned: attempt(() => fib(-1)),
  u64: echo_u64(2n ** 64n - 1n),
  u64Number: echo_u64(5),
  bigOver: attempt(() => echo_u64(2n ** 64n)),
  count: count(7),
  half: half(3),
  usize: echo_usize(7),
  char: next_char("a"),
  charTwo: attempt(() => next_char("ab")),
  throws: attempt(() => throws(1)),
  throwsNot: throws(-1),
  panics: attempt(() => panics(1)),
  // Strings.
  describeNull: describe(-1),
  describe: describe(3),
  bytes: byte_count("héllo"),
  bytesNull: byte_count(null),
  nulInC: attempt(() => byte_count("a\0b")),
  long: byte_count("x".repeat(100000)),
  shoutCpp: shout("héllo 😀"),
  firstWord: first_word("hello world"),
  repeatNul: repeat("ab\0", 2),
  shoutRs: shout_rs("héllo"),
  emoji: byte_len("😀"),
  loneSurrogate: byte_len("\uD800"),
  motto: motto(),
  echoLong: echo_ref("y".repeat(100000)).length,
  wrongString: attempt(() => shout(5 as never)),
  nullToOwned: attempt(() => byte_len(null as never)),
  // Plain structs.
  area: area({ x: 3, y: 4 }),
  grow: grow({ min: { x: 0, y: 0 }, max: { x: 1, y: 1 }, id: 5n }, 1),
  retag: retag({ name: "a", id: 1 }, 2),
  retagNull: retag({ name: null, id: 1 }, 2).name,
  louder: louder({ text: "hi", size: 1 }),
  mid: mid({ x: 0, y: 0 }, { x: 2, y: 4 }),
  shift: shift({ x: 1, y: 2n }, 3),
  shiftNumber: shift({ x: 1, y: 2 } as never, 3),
  rename: rename({ name: "a", at: { x: 1, y: 2n } }, "b"),
  dist: dist({ x: 0, y: 0n }, { x: 3, y: 4n }),
  extra: area({ x: 3, y: 4, z: 9 } as never),
  missing: attempt(() => shift({ x: 1 } as never, 1)),
  nullStruct: attempt(() => shift(null as never, 1)),
  arrayStruct: attempt(() => shift([1, 2] as never, 1)),
  nestedWrong: attempt(() => rename({ name: "a", at: { x: "1", y: 2n } } as never, "b")),
  // The review's regressions.
  same: same("x"),
  sameEmpty: same(""),
  maxLevel: max_level(),
  throwingGetter: attempt(() => area({ get x() { throw new Error("getter"); }, y: 1 } as never)),
  // C arrays.
  mean: mean([1, 2, 3]),
  meanEmpty: mean([]),
  dot: dot([1, 2, 3], [4, 5, 6]),
  checksum: checksum(new Uint8Array([1, 2, 3])),
  checksumBuffer: checksum(Buffer.from([1, 2, 3])),
  checksumView: checksum(new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)),
  checksumEmpty: checksum(new Uint8Array(0)),
  checksumBig: checksum(new Uint8Array(1_000_000)),
  longest: longest(["a", "bbb", null, "cc"]),
  countA: count_a("a\0a"),
  norm: norm([3, 4, 0]),
  polyArea: poly_area({ pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "p", key: new Uint8Array([7, 0, 0, 0]), grid: [[0, 0], [0, 5]] }),
  relabel: relabel({ pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "p", key: new Uint8Array(4), grid: [[1, 2], [3, 4]] }, "héllo"),
  relabelLongest: relabel({ pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "123456789012345", key: new Uint8Array(4), grid: [[0, 0], [0, 0]] }, "x").name,
  totalPts: total_pts([{ pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "ab", key: new Uint8Array(4), grid: [[0, 0], [0, 0]] }, { pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "cde", key: new Uint8Array(4), grid: [[0, 0], [0, 0]] }]),
  trace: trace([[1, 2], [3, 4]]),
  meanBig: mean(Array.from({ length: 1_000_000 }, (_, i) => i)),
  badElement: attempt(() => mean([1, "2"] as never)),
  hole: attempt(() => mean([1, , 3] as never)),
  notArray: attempt(() => mean(new Set([1]) as never)),
  proxy: attempt(() => mean(new Proxy([1, 2], {}))),
  argumentsObject: attempt(function () { return mean(arguments as never); }),
  wrongLength: attempt(() => norm([1, 2] as never)),
  lengthsDiffer: attempt(() => dot([1, 2], [1])),
  nameTooLong: attempt(() => relabel({ pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "1234567890123456", key: new Uint8Array(4), grid: [[0, 0], [0, 0]] }, "x")),
  nameWithNul: attempt(() => relabel({ pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "a\0b", key: new Uint8Array(4), grid: [[0, 0], [0, 0]] }, "x")),
  keyLength: attempt(() => relabel({ pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], name: "a", key: new Uint8Array(3), grid: [[0, 0], [0, 0]] }, "x")),
  nestedPath: attempt(() => trace([[1, 2], [3, "4"]] as never)),
  notBytes: attempt(() => checksum(new Int8Array(2) as never)),
  bytesArray: attempt(() => checksum([1, 2] as never)),
  bytesBuffer: attempt(() => checksum(new ArrayBuffer(2) as never)),
  detached: attempt(() => { const b = new ArrayBuffer(4); const v = new Uint8Array(b); structuredClone(b, { transfer: [b] }); return checksum(v); }),
  // C++ arrays.
  evens: evens([1, 2, 3, 4]),
  evensEmpty: evens([]),
  split: split("a bc d"),
  cross: cross([1, 0, 0], [0, 1, 0]),
  transpose: transpose([[1, 2, 3], [4, 5, 6]]),
  reverseBytes: Array.from(reverse_bytes(new Uint8Array([1, 2, 3]))),
  reverseBytesIsU8: reverse_bytes(new Uint8Array([1])) instanceof Uint8Array && reverse_bytes(new Uint8Array([1])).constructor === Uint8Array,
  countTrue: count_true([true, false, true]),
  close: close({ pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }], name: "tri" }),
  closeEmpty: close({ pts: [], name: "" }),
  throwsMidway: attempt(() => throws_midway([1, 2, 3])),
  throwsNotMidway: throws_midway([1, 2]),
  crossLength: attempt(() => cross([1, 0] as never, [0, 1, 0])),
  nestedBad: attempt(() => transpose([[1, 2], [3, "x"]] as never)),
  flagsBad: attempt(() => count_true([true, 1] as never)),
  closeBad: attempt(() => close({ pts: [{ x: 1, y: 2 }, { x: 3 }], name: "t" } as never)),
  // Rust arrays.
  sum: sum([1, 2, 3n]),
  sumEmpty: sum([]),
  evensRs: evens_rs([1, 2, 3, 4]),
  shoutAll: shout_all(["héllo", "x"]),
  crossRs: cross_rs([1, 0, 0], [0, 1, 0]),
  reverse: Array.from(reverse(new Uint8Array([1, 2, 3]))),
  reverseEmpty: reverse(new Uint8Array(0)).length,
  reverseBig: reverse(new Uint8Array(1_000_000)).length,
  digest: digest(new Uint8Array([1, 0, 0, 0])),
  pair: pair([1, 2]),
  shiftAll: shift_all({ pts: [{ x: 1, y: 2n }, { x: 3, y: 4n }], name: "p", key: new Uint8Array([1, 2, 3, 4]) }),
  grid: grid([[1, 2], [3]]),
  chars: chars(["a", "😀"]),
  mottoBytes: Array.from(motto_bytes()),
  panicsMidway: attempt(() => panics_midway([1, 2, 3])),
  panicsNot: panics_midway([1]),
  digestLength: attempt(() => digest(new Uint8Array(3))),
  keyLengthRs: attempt(() => shift_all({ pts: [], name: "", key: new Uint8Array(3) })),
  gridPath: attempt(() => grid([[1], [2, "3"]] as never)),
  ptsPath: attempt(() => shift_all({ pts: [{ x: 1, y: 2n }, { x: 3 }], name: "", key: new Uint8Array(4) } as never)),
  getterInList: attempt(() => shout_all(Object.defineProperty(["a", "b"], 1, { get() { throw new Error("getter"); } }) as never)),
  detachedRs: attempt(() => { const b = new ArrayBuffer(4); const v = new Uint8Array(b); structuredClone(b, { transfer: [b] }); return reverse(v); }),
};

// JSON has no bigint; print them with an `n` so the test can tell them from numbers.
console.log(JSON.stringify(output, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
