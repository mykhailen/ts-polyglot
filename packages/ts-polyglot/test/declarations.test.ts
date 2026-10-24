// The virtual TypeScript the mapper hands tsc, and its span mappings. tsc checks that a verbatim span
// has the same text on both sides, so this does too, over the constructs the parser just learned.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { toDeclarations } from "../src/declarations.ts";
import { languages, loadLanguage } from "../src/languages/index.ts";
import { SpanMapKind } from "../src/protocol.ts";

before(() => Promise.all(languages.map((language) => loadLanguage(language.id))));

function checkVerbatim(fileName: string, source: string) {
  const { text, mappings = [] } = toDeclarations(fileName, source);
  assert.ok(mappings.length > 0, "no mappings");
  for (const [vStart, vLength, oStart, oLength, kind] of mappings) {
    assert.equal(kind, SpanMapKind.Verbatim);
    assert.equal(vLength, oLength);
    assert.equal(text.slice(vStart, vStart + vLength), source.slice(oStart, oStart + oLength));
  }
  return text;
}

test("the declaration text for a C++ function", () => {
  const text = checkVerbatim("add.cpp", "int add(int a, int b) {\n  return a + b;\n}\n");
  assert.equal(text, "/** `int add(int a, int b)` from add.cpp, run through a Node-API addon. */\nexport declare function add(a: number, b: number): number;\n");
});

test("verbatim spans hold for namespaced C++ and nested Rust", () => {
  checkVerbatim("geo.cpp", "// ünïcödé\nnamespace geo {\n  double area(double r, int sides = 4) noexcept { return r * sides; }\n}\n");
  checkVerbatim("m.rs", "pub mod inner {\n    pub fn nested(mut x: i32) -> i32 { x }\n}\n");
});

test("a file without functions exports nothing", () => {
  assert.equal(toDeclarations("empty.c", "").text, "export {};\n");
  assert.equal(toDeclarations("comments.rs", "// nothing here\n/* or here */\n").text, "export {};\n");
  assert.deepEqual(toDeclarations("empty.c", "").mappings, []);
});
