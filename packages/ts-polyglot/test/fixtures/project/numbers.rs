pub fn fib(n: u32) -> i64 {
    let (mut a, mut b) = (0i64, 1i64);
    for _ in 0..n {
        (a, b) = (b, a + b);
    }
    a
}

// Inside a `pub mod`: exported as `clamp`, called as `user::stats::clamp` by the wrapper.
pub mod stats {
    pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 {
        x.max(lo).min(hi)
    }
}
