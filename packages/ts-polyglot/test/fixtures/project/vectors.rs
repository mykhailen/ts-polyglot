pub struct Point { pub x: i32, pub y: i64 }
pub struct Poly { pub pts: Vec<Point>, pub name: String, pub key: [u8; 4] }
pub const N: usize = 2;

pub fn sum(xs: &[i64]) -> i64 { xs.iter().sum() }
pub fn evens(xs: Vec<i32>) -> Vec<i32> { xs.into_iter().filter(|x| x % 2 == 0).collect() }
pub fn shout_all(names: &[String]) -> Vec<String> { names.iter().map(|n| n.to_uppercase()).collect() }
pub fn cross(a: [f32; 3], b: &[f32; 3]) -> [f32; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
pub fn reverse(data: &[u8]) -> Vec<u8> { data.iter().rev().copied().collect() }
pub fn digest(key: [u8; 4]) -> u32 { u32::from_le_bytes(key) }
pub fn pair(v: [f32; N]) -> [f32; N] { [v[1], v[0]] }
pub fn shift_all(mut p: Poly) -> Poly {
    for pt in &mut p.pts { pt.x += 1; pt.y += 1; }
    p.name.push('!');
    p.key[0] += 1;
    p
}
pub fn grid(m: Vec<Vec<i32>>) -> Vec<Vec<i32>> { m.into_iter().map(|row| row.into_iter().map(|x| x * 2).collect()).collect() }
pub fn chars(cs: Vec<char>) -> Vec<char> { cs.into_iter().rev().collect() }
pub fn motto_bytes() -> &'static [u8] { b"ship" }
// Nested bytes: an array of Uint8Arrays each way.
pub fn chunks(xs: Vec<Vec<u8>>) -> Vec<Vec<u8>> { xs.into_iter().map(|c| c.into_iter().rev().collect()).collect() }
// A sequence of fixed arrays: tuples in an array.
pub fn pairs(v: Vec<[f32; 2]>) -> Vec<[f32; 2]> { v.into_iter().map(|[a, b]| [b, a]).collect() }
// Panics after reading its input: the panic is the whole answer.
pub fn panics_midway(xs: &[i32]) -> Vec<i32> { if xs.len() > 2 { panic!("boom") } xs.to_vec() }
// Hidden: &mut, &[&str], Box, an expression size.
pub fn sort(xs: &mut [i32]) { xs.sort() }
pub fn strs(xs: &[&str]) -> usize { xs.len() }
pub fn boxed(xs: Box<[u8]>) -> usize { xs.len() }
pub fn expr(v: [f32; 2 + 1]) -> f32 { v[0] }
