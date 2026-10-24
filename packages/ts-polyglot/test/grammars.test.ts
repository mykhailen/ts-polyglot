// The vendored grammars: each one pinned in grammars/manifest.json is on disk, unchanged, licensed,
// and loads in the web-tree-sitter this package pins. This is the check that makes bumping either
// side safe: the runtime refuses a grammar whose ABI it doesn't support.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { Language, Parser } from "web-tree-sitter";

const grammars = new URL("../grammars/", import.meta.url);
const manifest: Record<string, { asset: string; sha256: string }> = JSON.parse(readFileSync(new URL("manifest.json", grammars), "utf8"));

test("every pinned grammar is on disk with its checksum and license", () => {
  assert.deepEqual(Object.keys(manifest).sort(), ["c", "cpp", "rust"]);
  for (const [id, entry] of Object.entries(manifest)) {
    const bytes = readFileSync(new URL(entry.asset, grammars));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.asset);
    assert.ok(existsSync(new URL(`LICENSE-${id}`, grammars)), `LICENSE-${id}`);
  }
});

test("every pinned grammar loads in the pinned web-tree-sitter", async () => {
  await Parser.init();
  for (const entry of Object.values(manifest)) {
    const language = await Language.load(new Uint8Array(readFileSync(new URL(entry.asset, grammars))));
    assert.ok(language.abiVersion >= 13, `${entry.asset}: ABI ${language.abiVersion}`);
  }
});
