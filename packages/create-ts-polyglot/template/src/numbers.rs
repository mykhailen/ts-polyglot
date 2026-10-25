// Plain Rust: each `pub fn` with number or bool types becomes a TypeScript export.

pub fn fib(n: u32) -> i64 {
    let (mut a, mut b) = (0i64, 1i64);
    for _ in 0..n {
        (a, b) = (b, a + b);
    }
    a
}

pub fn is_prime(n: u32) -> bool {
    n >= 2 && (2..).take_while(|d| d * d <= n).all(|d| n % d != 0)
}

// Not `pub`, so not exported.
fn unused_helper() {}
