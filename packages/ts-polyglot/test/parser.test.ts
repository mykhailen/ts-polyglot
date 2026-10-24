// The web-tree-sitter wrapper: grammars load once, parsing needs a loaded grammar, and node offsets
// are JavaScript string indices, which is what the mapper's UTF-16 position encoding and the verbatim
// spans assume.
import assert from "node:assert/strict";
import test from "node:test";

import { loadGrammar, parse } from "../src/parser.ts";

// Runs first: node:test runs a file's tests in order, and this one must see the C grammar unloaded.
test("parse throws until the grammar is loaded, naming it", () => {
  assert.throws(() => parse("tree-sitter-c.wasm", "int x;"), /tree-sitter-c\.wasm/);
});

test("loadGrammar rejects for a file that isn't there, naming it", async () => {
  await assert.rejects(loadGrammar("tree-sitter-missing.wasm"), /tree-sitter-missing\.wasm/);
});

test("parses with string offsets, not byte offsets", async () => {
  await loadGrammar("tree-sitter-c.wasm");
  await loadGrammar("tree-sitter-c.wasm"); // a second load is a no-op
  const source = "// ünïcödé 😀\nint add(int a) { return a; }\n";
  const tree = parse("tree-sitter-c.wasm", source);
  try {
    assert.equal(tree.rootNode.type, "translation_unit");
    const fn = tree.rootNode.namedChildren.find((n) => n.type === "function_definition")!;
    const name = fn.childForFieldName("declarator")!.childForFieldName("declarator")!;
    assert.equal(name.text, "add");
    assert.equal(name.startIndex, source.indexOf("add"));
  } finally {
    tree.delete();
  }
});
