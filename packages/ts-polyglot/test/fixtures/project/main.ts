import { add, multiply } from "./add.cpp";
import { random } from "./names.c";
import { fib } from "./numbers.rs";
import { echo_long } from "./values.c";

console.log(JSON.stringify({ add: add(2, 3), multiply: multiply(6, 7), fib: fib(50), echo: echo_long(-5), wide: echo_long(2 ** 40), random: random(5) }));
