import { add, first_word, multiply, repeat, same, scale, shout, throws } from "./add.cpp";
import { louder, mid } from "./labels.cpp";
import { byte_count, describe, random } from "./names.c";
import { byte_len, clamp, echo_ref, echo_usize, fib, max_level, motto, next_char, panics, shout as shout_rs } from "./numbers.rs";
import { dist, rename, shift } from "./points.rs";
import { area, grow, retag } from "./shapes.c";
import { count, echo_i8, echo_long, echo_u64, half, negate } from "./values.c";

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
  random: random(5),
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
};

// JSON has no bigint; print them with an `n` so the test can tell them from numbers.
console.log(JSON.stringify(output, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
