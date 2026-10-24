// What a language module gives the rest of the package: which files it owns, which grammar parses
// them, and how to read the exportable functions off a syntax tree. The build half (toolchain, glue
// shape) isn't part of this yet: build.ts still branches on the language until the marshaling design
// says what a language has to provide there.
import type { Node } from "web-tree-sitter";

import type { NativeFunction } from "../signatures.ts";

export type Language = "c" | "cpp" | "rust";

export interface LanguageModule {
  id: Language;
  /** Lower-case, with the dot. */
  extensions: readonly string[];
  /** A file under grammars/: the manifest's `asset`. */
  grammar: string;
  /** The exportable functions in a parsed file, in source order, same-named duplicates included. */
  functions(root: Node, source: string): NativeFunction[];
}
