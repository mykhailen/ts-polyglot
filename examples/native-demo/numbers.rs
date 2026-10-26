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

// A 64-bit integer arrives as a number or a bigint and a String leaves as a JavaScript string.
pub fn describe(n: i64) -> String {
    format!("{n} is {}", if n % 2 == 0 { "even" } else { "odd" })
}

// Bytes are a Uint8Array on both sides: a `&[u8]` sees a copy of the caller's bytes, a `Vec<u8>` comes back as a fresh one.
pub fn reverse(data: &[u8]) -> Vec<u8> {
    data.iter().rev().copied().collect()
}

// A `pub fn` inside a `pub mod` exports too, under its own name: `import { clamp }`.
pub mod stats {
    pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 {
        x.max(lo).min(hi)
    }
}
