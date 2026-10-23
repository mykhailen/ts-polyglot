import { add, multiply } from "./add.cpp";
import { hypotenuse, is_right_triangle } from "./geometry.c";
import { fib, is_prime } from "./numbers.rs";

console.log("C++   add(1, 2)                  =", add(1, 2));
console.log("C++   multiply(6, 7)             =", multiply(6, 7));
console.log("C     hypotenuse(3, 4)           =", hypotenuse(3, 4));
console.log("C     is_right_triangle(3, 4, 5) =", is_right_triangle(3, 4, 5));
console.log("Rust  fib(50)                    =", fib(50));
console.log("Rust  is_prime(97)               =", is_prime(97));

try {
  // @ts-expect-error add() takes `int`s, so TypeScript wants numbers. The generated glue checks too.
  add("1", 2);
} catch (error) {
  console.log('      add("1", 2) threw          :', (error as Error).message);
}
