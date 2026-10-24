// web-tree-sitter and the grammars vendored under grammars/ (see grammars/manifest.json). Loading a
// grammar is asynchronous, because WASM instantiation is, and it's kept apart from parsing, which is
// synchronous: the runtime hook's resolve can't await, so it loads every grammar before it registers,
// while the mapper loads one the first time a file of that language arrives. Parsers live for the
// process; trees are the caller's to delete.
import { readFile } from "node:fs/promises";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

import { oneLine } from "./signatures.ts";

// Resolved from this module, so the same path works from src/ under type stripping and from dist/.
const grammars = new URL("../grammars/", import.meta.url);

let runtime: Promise<void> | undefined;
const parsers = new Map<string, Parser>();
const loading = new Map<string, Promise<void>>();

/** Initializes web-tree-sitter and loads grammars/<file> once; later calls resolve at once. */
export function loadGrammar(file: string): Promise<void> {
  let pending = loading.get(file);
  if (!pending) {
    pending = load(file);
    loading.set(file, pending);
    // A failed load (a missing file, say) isn't cached, so the next caller gets a fresh attempt.
    pending.catch(() => loading.delete(file));
  }
  return pending;
}

async function load(file: string): Promise<void> {
  runtime ??= Parser.init();
  await runtime;
  let language: Language;
  try {
    language = await Language.load(new Uint8Array(await readFile(new URL(file, grammars))));
  } catch (error) {
    throw new Error(`ts-polyglot: can't load the grammar ${file}: ${(error as Error).message}`);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  parsers.set(file, parser);
}

/**
 * `source` from `start` to `end` as one line, without the comments among `node`'s descendants
 * (`commentTypes` names the grammar's comment nodes). A comment's closing delimiter would otherwise end
 * the JSDoc the signature is quoted in and break tsc's parse of the whole virtual file.
 */
export function headerText(source: string, start: number, end: number, node: Node, commentTypes: string[]): string {
  let text = source.slice(start, end);
  const comments = node.descendantsOfType(commentTypes).filter((comment) => comment.startIndex >= start && comment.endIndex <= end);
  // From the back, so the earlier offsets stay valid; a space keeps neighbors apart.
  for (const comment of comments.reverse()) text = `${text.slice(0, comment.startIndex - start)} ${text.slice(comment.endIndex - start)}`;
  // The gaps that comments and line breaks leave before `,` and `)` and after `(`.
  return oneLine(text).replace(/\(\s+/g, "(").replace(/\s+([,)])/g, "$1");
}

/** Parses with a grammar loaded earlier. The caller must tree.delete(). Throws if the grammar isn't loaded. */
export function parse(file: string, source: string): Tree {
  const parser = parsers.get(file);
  if (!parser) throw new Error(`ts-polyglot: the grammar ${file} isn't loaded`);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`ts-polyglot: ${file} returned no syntax tree`);
  return tree;
}
