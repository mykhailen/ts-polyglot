// The bridges: what each language lowers its functions to for the glue. These check the text and the
// callee descriptions; the end-to-end tests compile what they describe.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { cBridge, cMirrors, cShim } from "../src/languages/c.ts";
import { cppBridge, cppShim } from "../src/languages/cpp.ts";
import { languages, loadLanguage, parseModule } from "../src/languages/index.ts";
import type { BridgeInput } from "../src/languages/language.ts";
import { rustPrelude, rustWrapperSource } from "../src/languages/rust/bridge.ts";
import { rustAbi } from "../src/languages/rust/types.ts";
import type { NativeModule } from "../src/signatures.ts";

before(() => Promise.all(languages.map((language) => loadLanguage(language.id))));

const input = (file: string, module: NativeModule): BridgeInput => ({ file, module, dir: "D:\\cache\\k", compiler: { family: "unix", command: ["cc"], source: "default" }, debug: false });

test("the C bridge includes the file and calls the function with its own types, no error slot", () => {
  const module = parseModule("long echo_long(long x) { return x; }\nunsigned char u(void) { return 0; }\n", "c");
  const bridge = cBridge(input("D:\\p\\values.c", module));
  assert.match(bridge.prelude, /^#include "D:\/p\/values\.c"\n/);
  assert.deepEqual(bridge.callee(module.functions[0]!), { name: "echo_long", params: [{ kind: "int", c: "long", bits: 64, signed: true, min: "LONG_MIN", max: "LONG_MAX" }], returns: { kind: "int", c: "long", bits: 64, signed: true, min: "LONG_MIN", max: "LONG_MAX" }, reportsErrors: false });
  assert.deepEqual(bridge.callee(module.functions[1]!).returns, { kind: "int", c: "unsigned char", bits: 8, signed: false, min: "0", max: "UCHAR_MAX" });
  assert.deepEqual(bridge.libs, []);
});

test("the C++ bridge wraps each function in a shim that catches exceptions", () => {
  const module = parseModule('#include <stdexcept>\nint throws(int x) { throw std::runtime_error("boom"); }\nnamespace geometry { void tick(const int& a) {} }\n', "cpp");
  const bridge = cppBridge(input("D:\\p\\add.cpp", module));
  assert.match(bridge.prelude, /^#include "D:\/p\/add\.cpp"/m);
  assert.match(bridge.prelude, /static int ts_polyglot__shim_throws\(int x, ts_polyglot_string\* error\) \{\n  try \{ return throws\(x\); \}\n  catch \(const std::exception& e\) \{ \*error = ts_polyglot__own\(e\.what\(\)\); \}\n  catch \(\.\.\.\) \{ \*error = ts_polyglot__own\("throws\(\) threw an exception"\); \}\n  return \{\};\n\}/);
  assert.match(bridge.prelude, /static void ts_polyglot__shim_tick\(int a, ts_polyglot_string\* error\) \{\n  try \{ geometry::tick\(a\); \}/);
  assert.deepEqual(bridge.callee(module.functions[0]!), { name: "ts_polyglot__shim_throws", params: [{ kind: "int", c: "int", bits: 32, signed: true, min: "INT_MIN", max: "INT_MAX" }], returns: { kind: "int", c: "int", bits: 32, signed: true, min: "INT_MIN", max: "INT_MAX" }, reportsErrors: true });
});

test("the Rust wrapper keeps the user's spellings, catches panics and reports them through the slot", () => {
  const module = parseModule('pub fn panics(x: i32) -> i32 { panic!("boom") }\npub mod stats { pub fn clamp(x: isize, lo: isize, hi: isize) -> isize { x } }\npub fn next(c: char) -> char { c }\n', "rust");
  const wrapper = rustWrapperSource("D:\\p\\numbers.rs", module);
  assert.match(wrapper, /^#\[path = "D:\/p\/numbers\.rs"\]\nmod user;/m);
  assert.match(wrapper, /#\[repr\(C\)\]\n#\[derive\(Clone, Copy\)\]\npub struct ts_polyglot_string \{ ptr: \*mut u8, len: usize, release: Option<unsafe extern "C" fn\(\*mut u8, usize\)> \}/);
  assert.match(wrapper, /#\[no_mangle\]\npub extern "C" fn ts_polyglot__panics\(x: i32, error: \*mut ts_polyglot_string\) -> i32 \{/);
  assert.match(wrapper, /catch_unwind\(std::panic::AssertUnwindSafe\(\|\| user::panics\(x\)\)\)/);
  assert.match(wrapper, /ts_polyglot_panic_message\(&p, "panics"\)/);
  assert.match(wrapper, /fn ts_polyglot__clamp\(x: isize, lo: isize, hi: isize, error: \*mut ts_polyglot_string\) -> isize/);
  assert.match(wrapper, /user::stats::clamp\(x, lo, hi\)/);
  assert.match(wrapper, /fn ts_polyglot__next\(c: u32, error: \*mut ts_polyglot_string\) -> u32/);
  assert.match(wrapper, /char::from_u32\(c\)\.unwrap_or\('\\u\{FFFD\}'\)/);
  const prelude = rustPrelude(module);
  assert.match(prelude, /^int32_t ts_polyglot__panics\(int32_t arg0, ts_polyglot_string\* error\);$/m);
  assert.match(prelude, /^intptr_t ts_polyglot__clamp\(intptr_t arg0, intptr_t arg1, intptr_t arg2, ts_polyglot_string\* error\);$/m);
  assert.match(prelude, /^uint32_t ts_polyglot__next\(uint32_t arg0, ts_polyglot_string\* error\);$/m);
});

test("the C++ shim builds std::string and std::string_view from the ABI string and copies string results", () => {
  const module = parseModule("#include <string>\nstd::string shout(const std::string& s, std::string_view v, const char* c) { return s; }\n", "cpp");
  const shim = cppShim(module.functions[0]!, module);
  assert.match(shim, /static ts_polyglot_string ts_polyglot__shim_shout\(ts_polyglot_string s, ts_polyglot_string v, const char\* c, ts_polyglot_string\* error\)/);
  assert.match(shim, /shout\(std::string\(s\.ptr, s\.len\), std::string_view\(v\.ptr, v\.len\), c\)/);
  assert.match(shim, /return ts_polyglot__own\(ts_polyglot_result\.data\(\), ts_polyglot_result\.size\(\)\)/);
});

// The review's regressions: a binding the shim or wrapper introduces must never shadow a parameter.
test("the C++ shim's result temporary doesn't shadow a parameter named r", () => {
  const module = parseModule("#include <string>\nstd::string same(const std::string& r) { return r; }\n", "cpp");
  const shim = cppShim(module.functions[0]!, module);
  assert.match(shim, /auto ts_polyglot_result = same\(std::string\(r\.ptr, r\.len\)\); return ts_polyglot__own\(ts_polyglot_result\.data\(\), ts_polyglot_result\.size\(\)\);/);
});

test("a Rust &'static primitive result is dereferenced", () => {
  const module = parseModule("pub static MAX: u8 = 7;\npub fn max_level() -> &'static u8 { &MAX }\npub static C: char = 'x';\npub fn letter() -> &'static char { &C }\n", "rust");
  const wrapper = rustWrapperSource("D:\\p\\s.rs", module);
  assert.match(wrapper, /fn ts_polyglot__max_level\(error: \*mut ts_polyglot_string\) -> u8 \{[\s\S]*?Ok\(r\) => \(\*r\),/);
  assert.match(wrapper, /fn ts_polyglot__letter\(error: \*mut ts_polyglot_string\) -> u32 \{[\s\S]*?Ok\(r\) => \(\*r\) as u32,/);
});

test("the Rust wrapper validates UTF-8 and owns string results", () => {
  const module = parseModule('pub fn shout(s: &str, o: String, r: &String) -> String { o }\npub fn motto() -> &\'static str { "" }\n', "rust");
  const wrapper = rustWrapperSource("D:\\p\\s.rs", module);
  assert.match(wrapper, /fn ts_polyglot__shout\(s: ts_polyglot_string, o: ts_polyglot_string, r: ts_polyglot_string, error: \*mut ts_polyglot_string\) -> ts_polyglot_string/);
  assert.match(wrapper, /std::str::from_utf8/);
  assert.match(wrapper, /user::shout\(s, o\.to_owned\(\), &String::from\(r\)\)/);
  assert.match(wrapper, /Ok\(r\) => ts_polyglot_own\(&r\)/);
  assert.match(wrapper, /fn ts_polyglot__motto\(error: \*mut ts_polyglot_string\) -> ts_polyglot_string/);
});

test("C++ uses the user's struct unless it holds a std::string, then a mirror; Rust always mirrors", () => {
  const cpp = parseModule("#include <string>\nstruct Pt { double x; double y; };\nstruct Label { std::string text; int size; };\nPt mid(Pt a) { return a; }\nLabel louder(const Label& l) { return l; }\n", "cpp");
  const bridge = cppBridge(input("D:\\p\\l.cpp", cpp));
  assert.equal(bridge.callee(cpp.functions[0]!).params[0]!.c, "Pt");
  assert.equal(bridge.callee(cpp.functions[1]!).params[0]!.c, "ts_polyglot_Label");
  assert.match(bridge.prelude, /typedef struct \{ ts_polyglot_string text; int size; \} ts_polyglot_Label;/);
  const rs = parseModule("pub struct Point { pub x: i32, pub long: i64 }\npub fn shift(p: Point) -> Point { p }\n", "rust");
  const wrapper = rustWrapperSource("D:\\p\\p.rs", rs);
  assert.match(wrapper, /#\[repr\(C\)\]\n#\[derive\(Clone, Copy\)\]\npub struct ts_polyglot_Point \{ pub x: i32, pub m_long: i64 \}/);
  assert.match(wrapper, /impl From<ts_polyglot_Point> for user::Point/);
  assert.match(rustPrelude(rs), /typedef struct \{ int32_t x; int64_t m_long; \} ts_polyglot_Point;/);
  const abi = rustAbi(rs.functions[0]!.params[0]!.type, rs);
  assert.deepEqual(abi.kind === "struct" && abi.fields.map((f) => [f.name, f.member]), [["x", "x"], ["long", "m_long"]]);
});

test("the C bridge shims a function with array parameters: the length is the array's, arrays in a row must agree, a narrow length type is checked", () => {
  const module = parseModule("double mean(const double xs[], int n) { return 0; }\ndouble dot(const double a[], const double b[], size_t n) { return 0; }\n", "c");
  const bridge = cBridge(input("D:\\p\\v.c", module));
  assert.deepEqual(bridge.callee(module.functions[0]!), { name: "ts_polyglot__shim_mean", params: [{ kind: "array", c: "ts_polyglot_array", of: { kind: "float", c: "double", bits: 64 } }], returns: { kind: "float", c: "double", bits: 64 }, reportsErrors: true });
  assert.equal(cShim(module.functions[0]!, module), [
    "static double ts_polyglot__shim_mean(ts_polyglot_array xs, ts_polyglot_string* error) {",
    "  double ts_polyglot_out = {0};",
    '  if (xs.len > (size_t)INT_MAX) { *error = ts_polyglot__own_text("mean(): xs has more elements than int holds"); goto done; }',
    "  ts_polyglot_out = mean((double const*)xs.ptr, (int)xs.len);",
    "done:",
    "  return ts_polyglot_out;",
    "}",
    "",
  ].join("\n"));
  const dot = cShim(module.functions[1]!, module);
  assert.match(dot, /if \(b\.len != a\.len\) \{ \*error = ts_polyglot__own_text\("dot\(\): b must have as many elements as a"\); goto done; \}/);
  assert.match(dot, /dot\(\(double const\*\)a\.ptr, \(double const\*\)b\.ptr, \(size_t\)a\.len\)/);
  assert.doesNotMatch(dot, /SIZE_MAX/);
  assert.match(bridge.prelude, /^#include "D:\/p\/v\.c"\n/);
  assert.match(bridge.prelude, /static ts_polyglot_array ts_polyglot__own_array\(size_t count, size_t size\)/);
});

test("the C bridge mirrors a struct with array or char[N] fields and converts it both ways, nested arrays included", () => {
  const module = parseModule("struct Point { int x; int y; };\nstruct Poly { struct Point pts[2]; char name[8]; int grid[2][2]; };\ndouble area(struct Poly p) { return 0; }\nstruct Poly relabel(struct Poly p, const char* name) { return p; }\n", "c");
  const [mirror] = cMirrors(module);
  assert.match(mirror!, /^typedef struct \{ ts_polyglot_array pts; ts_polyglot_string name; ts_polyglot_array grid; \} ts_polyglot_Poly;\n/);
  assert.match(mirror!, /static struct Poly ts_polyglot__from_Poly\(const ts_polyglot_Poly\* m\) \{/);
  assert.match(mirror!, /v\.pts\[i0\] = \(\(struct Point const\*\)m->pts\.ptr\)\[i0\];/);
  assert.match(mirror!, /memcpy\(v\.name, m->name\.ptr, m->name\.len\); v\.name\[m->name\.len\] = 0;/);
  assert.match(mirror!, /v\.grid\[i0\]\[i1\] = \(\(int const\*\)\(\(ts_polyglot_array const\*\)m->grid\.ptr\)\[i0\]\.ptr\)\[i1\];/);
  assert.match(mirror!, /static ts_polyglot_Poly ts_polyglot__to_Poly\(const struct Poly\* v\) \{/);
  assert.match(mirror!, /m\.pts = ts_polyglot__own_array\(2, sizeof\(struct Point\)\);/);
  assert.match(mirror!, /m\.name = ts_polyglot__own\(v->name, ts_polyglot__bounded\(v->name, 8\)\);/);
  assert.match(mirror!, /\(\(int\*\)\(\(ts_polyglot_array\*\)m\.grid\.ptr\)\[i0\]\.ptr\)\[i1\] = v->grid\[i0\]\[i1\];/);
  const bridge = cBridge(input("D:\\p\\v.c", module));
  assert.equal(bridge.callee(module.functions[0]!).params[0]!.c, "ts_polyglot_Poly");
  assert.equal(bridge.callee(module.functions[1]!).returns.c, "ts_polyglot_Poly");
  assert.match(cShim(module.functions[1]!, module), /  struct Poly ts_polyglot_result;\n[\s\S]*  ts_polyglot_result = relabel\(ts_polyglot__from_Poly\(&p\), name\);\n  ts_polyglot_out = ts_polyglot__to_Poly\(&ts_polyglot_result\);\n  return ts_polyglot_out;/);
  const plain = parseModule("struct Point { int x; int y; };\nint area(struct Point p) { return 0; }\n", "c");
  assert.equal(cBridge(input("D:\\p\\s.c", plain)).callee(plain.functions[0]!).name, "area");
});

test("a C sequence or fixed array whose elements need converting goes through a temporary the shim frees", () => {
  const module = parseModule("struct Poly { char name[8]; };\nint total(const struct Poly polys[], size_t n) { return 0; }\nint trace(const int m[2][2]) { return 0; }\n", "c");
  const total = cShim(module.functions[0]!, module);
  assert.match(total, /  struct Poly\* ts_polyglot_tmp_polys = NULL;\n  size_t i0;\n/);
  assert.match(total, /ts_polyglot_tmp_polys = \(struct Poly\*\)malloc\(\(polys\.len \? polys\.len : 1\) \* sizeof\(struct Poly\)\);\n  if \(!ts_polyglot_tmp_polys\) \{ \*error = ts_polyglot__own_text\("total\(\): can't allocate polys"\); goto done; \}/);
  assert.match(total, /for \(i0 = 0; i0 < polys\.len; i0\+\+\) \{ ts_polyglot_tmp_polys\[i0\] = ts_polyglot__from_Poly\(&\(\(ts_polyglot_Poly const\*\)polys\.ptr\)\[i0\]\); \}/);
  assert.match(total, /ts_polyglot_out = total\(ts_polyglot_tmp_polys, \(size_t\)polys\.len\);\ndone:\n  free\(ts_polyglot_tmp_polys\);\n  return ts_polyglot_out;/);
  const trace = cShim(module.functions[1]!, module);
  assert.match(trace, /  int ts_polyglot_tmp_m\[2\]\[2\];\n  size_t i0, i1;\n/);
  assert.match(trace, /ts_polyglot_tmp_m\[i0\]\[i1\] = \(\(int const\*\)\(\(ts_polyglot_array const\*\)m\.ptr\)\[i0\]\.ptr\)\[i1\];/);
  assert.match(trace, /ts_polyglot_out = trace\(ts_polyglot_tmp_m\);/);
});

test("the C++ shim converts std::vector and std::array through the template family, in and out", () => {
  const module = parseModule("#include <vector>\n#include <array>\nstd::vector<int> evens(const std::vector<int>& xs) { return xs; }\nstd::array<float, 3> cross(std::array<float, 3> a, const std::array<float, 3>& b) { return a; }\nstd::vector<std::vector<std::string>> grid(std::vector<std::vector<std::string>> m) { return m; }\n", "cpp");
  const bridge = cppBridge(input("D:\\p\\v.cpp", module));
  assert.match(bridge.prelude, /template <class T> struct ts_polyglot__conv<std::vector<T>> \{/);
  assert.match(bridge.prelude, /template <class T, size_t N> struct ts_polyglot__abi<std::array<T, N>> \{ using type = ts_polyglot_array; \};/);
  assert.match(cppShim(module.functions[0]!, module), /static ts_polyglot_array ts_polyglot__shim_evens\(ts_polyglot_array xs, ts_polyglot_string\* error\) \{\n  try \{ auto ts_polyglot_result = evens\(ts_polyglot__conv<std::vector<int>>::from\(xs\)\); return ts_polyglot__conv<std::vector<int>>::to\(ts_polyglot_result\); \}/);
  assert.match(cppShim(module.functions[1]!, module), /cross\(ts_polyglot__conv<std::array<float, 3>>::from\(a\), ts_polyglot__conv<std::array<float, 3>>::from\(b\)\)/);
  assert.match(cppShim(module.functions[2]!, module), /ts_polyglot__conv<std::vector<std::vector<std::string>>>::to\(ts_polyglot_result\)/);
  assert.deepEqual(bridge.callee(module.functions[1]!).params.map((p) => p.kind === "array" && p.length), [3, 3]);
  assert.match(cppShim(module.functions[0]!, module), /  return \{\};\n\}/);
});

test("the C++ shim's fallback return is valid for a multi-word type and a pointer", () => {
  const module = parseModule("unsigned long u(unsigned long x) { return x; }\nconst char* s(void) { return 0; }\n", "cpp");
  assert.match(cppShim(module.functions[0]!, module), /static unsigned long ts_polyglot__shim_u\(unsigned long x, ts_polyglot_string\* error\) \{[\s\S]*  return \{\};\n\}/);
  assert.match(cppShim(module.functions[1]!, module), /  return \{\};\n\}/);
});

test("C++ C-style arrays of std types convert element by element in mirrors and shims", () => {
  const module = parseModule("#include <string>\n#include <vector>\nstruct Tagged { std::string tags[2]; std::vector<int> rows[2]; };\nTagged tag_up(Tagged t) { return t; }\nint total(const std::string ns[], size_t n) { return 0; }\n", "cpp");
  const bridge = cppBridge(input("D:\\p\\v.cpp", module));
  assert.match(bridge.prelude, /v\.tags\[i0\] = std::string\(\(\(ts_polyglot_string const\*\)m\.tags\.ptr\)\[i0\]\.ptr, \(\(ts_polyglot_string const\*\)m\.tags\.ptr\)\[i0\]\.len\);/);
  assert.match(bridge.prelude, /\(\(ts_polyglot_string\*\)m\.tags\.ptr\)\[i0\] = ts_polyglot__own\(v\.tags\[i0\]\.data\(\), v\.tags\[i0\]\.size\(\)\);/);
  assert.match(bridge.prelude, /v\.rows\[i0\] = ts_polyglot__conv<std::vector<int>>::from\(\(\(ts_polyglot_array const\*\)m\.rows\.ptr\)\[i0\]\);/);
  assert.match(bridge.prelude, /\(\(ts_polyglot_array\*\)m\.rows\.ptr\)\[i0\] = ts_polyglot__conv<std::vector<int>>::to\(v\.rows\[i0\]\);/);
  assert.match(cppShim(module.functions[1]!, module), /auto ts_polyglot_tmp_ns = ts_polyglot__conv<std::vector<std::string>>::from\(ns\);[\s\S]*total\(ts_polyglot_tmp_ns\.data\(\), \(size_t\)ns\.len\)/);
});

test("the C99 spelling passes the length where the parameter sits", () => {
  const module = parseModule("double mean99(size_t n, const double xs[n]) { return 0; }\n", "c");
  assert.match(cShim(module.functions[0]!, module), /mean99\(\(size_t\)xs\.len, \(double const\*\)xs\.ptr\)/);
});

test("the C++ bridge mirrors a struct with a vector field and specializes the templates for it; C-style arrays and char[N] use the loops", () => {
  const module = parseModule("#include <vector>\n#include <string>\nstruct Point { int x; int y; };\nstruct Shape { std::vector<Point> pts; std::string name; int c[2]; char tag[4]; };\nShape close(Shape s) { return s; }\n", "cpp");
  const bridge = cppBridge(input("D:\\p\\v.cpp", module));
  assert.match(bridge.prelude, /typedef struct \{ ts_polyglot_array pts; ts_polyglot_string name; ts_polyglot_array c; ts_polyglot_string tag; \} ts_polyglot_Shape;/);
  assert.match(bridge.prelude, /v\.pts = ts_polyglot__conv<std::vector<Point>>::from\(m\.pts\);/);
  assert.match(bridge.prelude, /m\.pts = ts_polyglot__conv<std::vector<Point>>::to\(v\.pts\);/);
  assert.match(bridge.prelude, /v\.c\[i0\] = \(\(int const\*\)m\.c\.ptr\)\[i0\];/);
  assert.match(bridge.prelude, /memcpy\(v\.tag, m\.tag\.ptr, m\.tag\.len\); v\.tag\[m\.tag\.len\] = 0;/);
  assert.match(bridge.prelude, /m\.tag = ts_polyglot__own\(v\.tag, ts_polyglot__bounded\(v\.tag, 4\)\);/);
  assert.match(bridge.prelude, /template <> struct ts_polyglot__abi<Shape> \{ using type = ts_polyglot_Shape; \};\ntemplate <> struct ts_polyglot__conv<Shape> \{ static Shape from\(const ts_polyglot_Shape& m\) \{ return ts_polyglot__from_Shape\(m\); \} static ts_polyglot_Shape to\(const Shape& v\) \{ return ts_polyglot__to_Shape\(v\); \} \};/);
  assert.match(cppShim(module.functions[0]!, module), /auto ts_polyglot_result = close\(ts_polyglot__from_Shape\(s\)\); return ts_polyglot__to_Shape\(ts_polyglot_result\);/);
});

test("a C-style array parameter in C++ is cast when plain and converted through a vector when not", () => {
  const module = parseModule("#include <string>\nstruct Named { char name[8]; int id; };\ndouble mean(const double xs[], size_t n) { return 0; }\nint ids(const Named items[], size_t n) { return 0; }\n", "cpp");
  assert.match(cppShim(module.functions[0]!, module), /mean\(\(double const\*\)xs\.ptr, \(size_t\)xs\.len\)/);
  assert.doesNotMatch(cppShim(module.functions[0]!, module), /SIZE_MAX/);
  assert.match(cppShim(module.functions[1]!, module), /auto ts_polyglot_tmp_items = ts_polyglot__conv<std::vector<Named>>::from\(items\);[\s\S]*ids\(ts_polyglot_tmp_items\.data\(\), \(size_t\)items\.len\)/);
});

test("the Rust wrapper borrows slices of plain elements, copies vectors, converts element strings and structs, and owns or borrows list results", () => {
  const module = parseModule("pub struct P { pub x: i32 }\npub fn sum(xs: &[i64]) -> i64 { 0 }\npub fn evens(xs: Vec<i32>) -> Vec<i32> { xs }\npub fn shout_all(names: &[String]) -> Vec<String> { Vec::new() }\npub fn cross(a: [f32; 3], b: &[f32; 3]) -> [f32; 3] { a }\npub fn motto_bytes() -> &'static [u8] { b\"x\" }\npub fn ps(ps: Vec<P>) -> Vec<Vec<P>> { Vec::new() }\n", "rust");
  const wrapper = rustWrapperSource("D:\\p\\v.rs", module);
  assert.match(wrapper, /#\[repr\(C\)\]\n#\[derive\(Clone, Copy\)\]\npub struct ts_polyglot_array \{ ptr: \*mut std::ffi::c_void, len: usize, release: Option<unsafe extern "C" fn\(\*mut std::ffi::c_void, usize\)> \}/);
  assert.match(wrapper, /pub extern "C" fn ts_polyglot__sum\(xs: ts_polyglot_array, error: \*mut ts_polyglot_string\) -> i64 \{\n    match std::panic::catch_unwind\(std::panic::AssertUnwindSafe\(\|\| user::sum\(unsafe \{ ts_polyglot_slice::<i64>\(&xs\) \}\)\)\) \{/);
  assert.match(wrapper, /user::evens\(unsafe \{ ts_polyglot_slice::<i32>\(&xs\) \}\.to_vec\(\)\)\)\) \{\n        Ok\(r\) => ts_polyglot_own_list\(r\),/);
  assert.match(wrapper, /user::shout_all\(&unsafe \{ ts_polyglot_slice::<ts_polyglot_string>\(&names\) \}\.iter\(\)\.map\(\|e\| String::from_utf8_lossy\(unsafe \{ ts_polyglot_bytes\(e\) \}\)\.into_owned\(\)\)\.collect::<Vec<_>>\(\)\[\.\.\]\)/);
  assert.match(wrapper, /Ok\(r\) => ts_polyglot_own_list\(r\.into_iter\(\)\.map\(\|e\| ts_polyglot_own\(&e\)\)\.collect::<Vec<_>>\(\)\),/);
  assert.match(wrapper, /user::cross\(<\[f32; 3\]>::try_from\(unsafe \{ ts_polyglot_slice::<f32>\(&a\) \}\)\.unwrap\(\), <&\[f32; 3\]>::try_from\(unsafe \{ ts_polyglot_slice::<f32>\(&b\) \}\)\.unwrap\(\)\)/);
  assert.match(wrapper, /Ok\(r\) => ts_polyglot_own_list\(r\.to_vec\(\)\),/);
  assert.match(wrapper, /Ok\(r\) => ts_polyglot_borrow_list\(r\),/);
  assert.match(wrapper, /user::ps\(unsafe \{ ts_polyglot_slice::<ts_polyglot_P>\(&ps\) \}\.iter\(\)\.map\(\|e\| user::P::from\(\*e\)\)\.collect::<Vec<_>>\(\)\)/);
  assert.match(wrapper, /ts_polyglot_own_list\(r\.into_iter\(\)\.map\(\|e\| ts_polyglot_own_list\(e\.into_iter\(\)\.map\(\|e\| ts_polyglot_P::from\(&e\)\)\.collect::<Vec<_>>\(\)\)\)\.collect::<Vec<_>>\(\)\)/);
  assert.match(rustPrelude(module), /ts_polyglot_array ts_polyglot__evens\(ts_polyglot_array arg0, ts_polyglot_string\* error\);/);
});

test("a Rust mirror holds lists for Vec and array fields and converts them both ways", () => {
  const module = parseModule("pub struct Point { pub x: i32, pub y: i64 }\npub struct Poly { pub pts: Vec<Point>, pub name: String, pub key: [u8; 4] }\npub fn f(p: Poly) -> Poly { p }\n", "rust");
  const wrapper = rustWrapperSource("D:\\p\\v.rs", module);
  assert.match(wrapper, /#\[repr\(C\)\]\n#\[derive\(Clone, Copy\)\]\npub struct ts_polyglot_Poly \{ pub pts: ts_polyglot_array, pub name: ts_polyglot_string, pub key: ts_polyglot_array \}/);
  assert.match(wrapper, /pts: unsafe \{ ts_polyglot_slice::<ts_polyglot_Point>\(&m\.pts\) \}\.iter\(\)\.map\(\|e\| user::Point::from\(\*e\)\)\.collect::<Vec<_>>\(\)/);
  assert.match(wrapper, /key: <\[u8; 4\]>::try_from\(unsafe \{ ts_polyglot_slice::<u8>\(&m\.key\) \}\)\.unwrap\(\)/);
  assert.match(wrapper, /pts: ts_polyglot_own_list\(v\.pts\.iter\(\)\.map\(\|e\| ts_polyglot_Point::from\(e\)\)\.collect::<Vec<_>>\(\)\)/);
  assert.match(wrapper, /key: ts_polyglot_own_list\(v\.key\.to_vec\(\)\)/);
  assert.match(rustPrelude(module), /typedef struct \{ ts_polyglot_array pts; ts_polyglot_string name; ts_polyglot_array key; \} ts_polyglot_Poly;/);
});
