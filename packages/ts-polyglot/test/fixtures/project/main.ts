import { add, multiply, scale } from "./add.cpp";
import { random } from "./names.c";
import { clamp, fib } from "./numbers.rs";
import { echo_long } from "./values.c";

console.log(JSON.stringify({ add: add(2, 3), multiply: multiply(6, 7), fib: fib(50), echo: echo_long(-5), wide: echo_long(2 ** 40), random: random(5), scale: scale(3, 4), clamp: clamp(15, 0, 10) }));
