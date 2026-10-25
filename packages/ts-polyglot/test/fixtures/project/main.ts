import { add, multiply, scale, throws } from "./add.cpp";
import { random } from "./names.c";
import { clamp, echo_usize, fib, next_char, panics } from "./numbers.rs";
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
};

// JSON has no bigint; print them with an `n` so the test can tell them from numbers.
console.log(JSON.stringify(output, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
