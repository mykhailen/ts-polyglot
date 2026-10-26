import { add, cross, greet, multiply, square } from "./add.cpp";
import { distance, hypotenuse, is_right_triangle, mean } from "./geometry.c";
import { clamp, describe, fib, is_prime, reverse } from "./numbers.rs";

console.log("C++   add(1, 2)                  =", add(1, 2));
console.log("C++   multiply(6, 7)             =", multiply(6, 7));
console.log("C     hypotenuse(3, 4)           =", hypotenuse(3, 4));
console.log("C     is_right_triangle(3, 4, 5) =", is_right_triangle(3, 4, 5));
console.log("Rust  fib(50)                    =", fib(50));
console.log("Rust  is_prime(97)               =", is_prime(97));
console.log("C++   math::square(12)           =", square(12));
console.log("Rust  stats::clamp(15, 0, 10)    =", clamp(15, 0, 10));

console.log('C++   greet("world")             =', greet("world"));
console.log("C     distance({0,0}, {3,4})     =", distance({ x: 0, y: 0 }, { x: 3, y: 4 }));
console.log("Rust  describe(2n ** 40n)        =", describe(2n ** 40n));

console.log("C     mean([1, 2, 3, 4])         =", mean([1, 2, 3, 4]));
console.log("C++   cross([1,0,0], [0,1,0])    =", cross([1, 0, 0], [0, 1, 0]));
console.log("Rust  reverse(Uint8Array 1,2,3)  =", reverse(new Uint8Array([1, 2, 3])));

try {
  // @ts-expect-error add() takes `int`s, so TypeScript wants numbers. The generated glue checks too.
  add("1", 2);
} catch (error) {
  console.log('      add("1", 2) threw          :', (error as Error).message);
}

try {
  // TypeScript is fine with any number, so the glue's range check is what catches this one.
  add(2 ** 40, 1);
} catch (error) {
  console.log("      add(2 ** 40, 1) threw      :", (error as Error).message);
}
