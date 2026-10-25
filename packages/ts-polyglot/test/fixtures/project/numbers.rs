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

// A panic unwinding out of the wrapper would abort the process; the wrapper turns it into an Error.
pub fn panics(x: i32) -> i32 {
    if x > 0 {
        panic!("boom")
    }
    x
}

pub fn echo_usize(n: usize) -> usize {
    n
}

pub fn next_char(c: char) -> char {
    char::from_u32(c as u32 + 1).unwrap_or(c)
}

pub fn shout(s: &str) -> String {
    format!("{}!", s.to_uppercase())
}

pub fn byte_len(s: String) -> usize {
    s.len()
}

pub fn motto() -> &'static str {
    "ship it"
}

pub fn echo_ref(s: &String) -> String {
    s.clone()
}

// A borrowed primitive result: 'static is the one lifetime that can cross.
pub static MAX: u8 = 7;

pub fn max_level() -> &'static u8 {
    &MAX
}
