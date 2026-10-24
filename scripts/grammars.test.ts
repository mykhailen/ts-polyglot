// The pure parts of the grammar refresh script. The downloads themselves are exercised by hand
// (`npm run grammars -- update <id>`) and their results by packages/ts-polyglot/test/grammars.test.ts.
import assert from "node:assert/strict";
import test from "node:test";

import { assetUrl, licenseUrl, pin } from "./grammars.ts";

const c = { repository: "tree-sitter/tree-sitter-c", tag: "v0.24.2", asset: "tree-sitter-c.wasm", sha256: "old" };

test("release assets and licenses come from the pinned tag", () => {
  assert.equal(assetUrl(c), "https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.2/tree-sitter-c.wasm");
  assert.equal(licenseUrl(c), "https://raw.githubusercontent.com/tree-sitter/tree-sitter-c/v0.24.2/LICENSE");
});

test("pin rewrites one entry's tag and checksum and leaves the rest alone", () => {
  const manifest = { c, cpp: { ...c, repository: "tree-sitter/tree-sitter-cpp", asset: "tree-sitter-cpp.wasm" } };
  const pinned = pin(manifest, "c", "v0.24.3", "new");
  assert.deepEqual(pinned.c, { ...c, tag: "v0.24.3", sha256: "new" });
  assert.deepEqual(pinned.cpp, manifest.cpp);
  assert.deepEqual(manifest.c, c);
});
