// The C++-only parts of the shared walker: linkage blocks, namespaces and the declarator forms the
// C grammar doesn't have. The common rules are in c.test.ts.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { cFamilyModule } from "../src/languages/c-family.ts";
import { findFunctions, loadLanguage } from "../src/languages/index.ts";
import { parse } from "../src/parser.ts";
import type { NativeType } from "../src/signatures.ts";

before(() => loadLanguage("cpp"));
const find = (source: string) => findFunctions(source, "cpp");
const module = (source: string) => { const tree = parse("tree-sitter-cpp.wasm", source); try { return cFamilyModule(tree.rootNode, source, "cpp"); } finally { tree.delete(); } };
const types = (source: string) => module(source).functions[0]!.params.map((p) => p.type);

test('extern "C" in both forms', () => {
  const found = find('extern "C" int one(int a) { return a; }\nextern "C" {\n  int two(int a) { return a; }\n}\n');
  assert.deepEqual(found.map((f) => [f.name, f.callee, f.signature]), [["one", "one", "int one(int a)"], ["two", "two", "int two(int a)"]]);
});

test("functions in namespaces export their unqualified name with a qualified callee", () => {
  const found = find("namespace geo { namespace shapes { double area(double r) { return r; } } }\nnamespace a::b { int f(int x) { return x; } }\n");
  assert.deepEqual(found.map((f) => [f.name, f.callee, f.signature]), [["area", "geo::shapes::area", "double area(double r)"], ["f", "a::b::f", "int f(int x)"]]);
});

test("anonymous namespaces and out-of-line qualified definitions are skipped", () => {
  assert.deepEqual(find("namespace { int hidden(int a) { return a; } }\nnamespace geo { int f(int); }\nint geo::f(int a) { return a; }\n"), []);
});

test("templates are skipped and only the first overload is kept", () => {
  const found = find("template <typename T> T twice(T x) { return x + x; }\nint over(int a) { return a; }\nint over(int a, int b) { return a + b; }\n");
  assert.deepEqual(found.map((f) => [f.name, f.params.length]), [["over", 1]]);
});

test("attributes, constexpr, noexcept and a trailing return type don't hide a function", () => {
  const [f, g] = find("[[nodiscard]] constexpr int f(int a) noexcept { return a; }\nauto g(int a) -> int { return a; }\n");
  assert.equal(f?.returns.spelling, "int");
  assert.equal(f?.signature, "int f(int a) noexcept");
  assert.equal(g?.returns.spelling, "int");
  assert.equal(g?.signature, "auto g(int a) -> int");
});

test("auto without a trailing return type is skipped", () => {
  assert.deepEqual(find("auto f(int a) { return a; }"), []);
});

test("a default argument is a required parameter for now", () => {
  const [fn] = find("int f(int a, int b = 2) { return a + b; }");
  assert.deepEqual(fn?.params.map((p) => [p.name, p.type.spelling]), [["a", "int"], ["b", "int"]]);
});

test("a const reference crosses as its target; a mutable reference skips the function", () => {
  const found = find("#include <string>\nint f(const std::string& s) { return 0; }\nint g(int& r) { return r; }");
  assert.deepEqual(found.map((fn) => [fn.name, fn.params[0]?.type.kind]), [["f", "reference"]]);
});

test("a class method is not a function, its neighbor is", () => {
  assert.deepEqual(find("struct S { int m(int a) { return a; } };\nint free_fn(int a) { return a; }\n").map((f) => f.name), ["free_fn"]);
});

test("a half-typed C++ file keeps the functions before the break", () => {
  assert.deepEqual(find("namespace n { int ok(int a) { return a; } }\nint partial(int a,").map((f) => f.callee), ["n::ok"]);
});

// The C++-only parts of the structured types and plain structs.
test("const references are immutable references to their target; && and non-const are mutable", () => {
  const found = types("int f(const int& a, int& b, const std::string& s, std::string&& r) { return 0; }");
  assert.deepEqual(found.map((t) => t.kind === "reference" && [t.mutable, t.to.kind, t.spelling]), [[false, "int", "const int&"], [true, "int", "int&"], [false, "string", "const std::string&"], [true, "string", "std::string&&"]]);
});

test("std::string and std::string_view are strings; a bare string is unknown", () => {
  const [fn] = module("std::string f(std::string a, std::string_view b, string c) { return a; }").functions;
  assert.deepEqual(fn!.params.map((p) => p.type), [{ kind: "string", nullable: false, spelling: "std::string" }, { kind: "string", nullable: false, spelling: "std::string_view" }, { kind: "unknown", spelling: "string" }]);
  assert.equal(fn!.returns.kind, "string");
});

test("classes are plain only when every data member is public, with no methods, bases, templates or nested types", () => {
  const { structs } = module("class Open { public: int w; };\nclass Box { public: int w; private: int s; };\nstruct M { int x; void f(); };\nstruct C { int x; C(); };\nstruct D : Open { int z; };\ntemplate <typename T> struct G { T t; };\nstruct N { struct In { int a; } in; };\nstruct WithInit { int x = 0; static int count; };\n");
  assert.deepEqual(structs.map((s) => [s.name, s.fields.map((f) => f.name)]), [["Open", ["w"]], ["WithInit", ["x"]]]);
});

test("struct names resolve innermost namespace out, then qualified; the spelling is qualified", () => {
  const { functions, structs } = module("namespace geometry { struct Vec { float dx; float dy; }; Vec norm(const Vec& v) { return v; } }\ngeometry::Vec scale(geometry::Vec v) { return v; }\nint bare(Vec v) { return 0; }\n");
  assert.deepEqual(structs.map((s) => [s.name, s.spelling, s.path]), [["Vec", "geometry::Vec", ["geometry"]]]);
  assert.deepEqual(functions.map((f) => [f.name, f.params[0]!.type.kind, f.returns.kind]), [["norm", "reference", "struct"], ["scale", "struct", "struct"], ["bare", "unknown", "int"]]);
});

test("two structs with one name: the first wins and the second's scope resolves to unknown", () => {
  const { functions, structs } = module("namespace a { struct P { int x; }; P fa(P p) { return p; } }\nnamespace b { struct P { double y; }; P fb(P p) { return p; } }\n");
  assert.deepEqual(structs.map((s) => s.spelling), ["a::P"]);
  assert.deepEqual(functions.map((f) => [f.name, f.params[0]!.type.kind]), [["fa", "struct"], ["fb", "unknown"]]);
});

test("std::vector and std::array are arrays when qualified; span, a using'd vector, an array element and an expression size are unknown", () => {
  const source = "#include <vector>\nstd::vector<int> f(const std::vector<int>& xs, std::vector<std::string> names, std::array<float, 3> v, std::vector<std::vector<unsigned char>> m, std::vector<const char*> tags) { return xs; }\nvoid g(std::span<const int> s) {}\nusing std::vector;\nvoid h(vector<int> v) {}\nconstexpr size_t N = 2;\nvoid k(std::array<int, N> a, std::array<int, N + 1> b, std::array<int[2], 2> c) {}\n";
  const [f, g, h, k] = module(source).functions;
  assert.deepEqual(f!.returns, { kind: "array", spelling: "std::vector<int>", of: { kind: "int", bits: 32, signed: true, spelling: "int" } });
  assert.deepEqual(f!.params.map((p) => p.type.kind), ["reference", "array", "array", "array", "array"]);
  assert.deepEqual((f!.params[0]!.type as { to: NativeType }).to.spelling, "std::vector<int>");
  assert.deepEqual((f!.params[1]!.type as { of: NativeType }).of, { kind: "string", nullable: false, spelling: "std::string" });
  assert.equal((f!.params[2]!.type as { length?: number }).length, 3);
  assert.deepEqual((f!.params[3]!.type as { of: NativeType }).of, { kind: "array", spelling: "std::vector<unsigned char>", of: { kind: "int", bits: 8, signed: false, spelling: "unsigned char" } });
  assert.deepEqual((f!.params[4]!.type as { of: NativeType }).of, { kind: "string", nullable: true, spelling: "const char*" });
  assert.deepEqual([g!.params[0]!.type.kind, h!.params[0]!.type.kind], ["unknown", "unknown"]);
  assert.deepEqual(k!.params.map((p) => (p.type.kind === "array" ? p.type.length : p.type.kind)), [2, "unknown", "unknown"]);
});

test("a vector of a struct resolves the element in scope; a mutable vector reference is mutable", () => {
  const [f] = module("namespace geo { struct P { int x; }; int f(const std::vector<P>& ps, std::vector<P>& out) { return 0; } }\n").functions;
  assert.deepEqual(f!.params[0]!.type, { kind: "reference", mutable: false, spelling: "const std::vector<P>&", to: { kind: "array", spelling: "std::vector<P>", of: { kind: "struct", name: "P", spelling: "P" } } });
  assert.equal((f!.params[1]!.type as { mutable: boolean }).mutable, true);
});
