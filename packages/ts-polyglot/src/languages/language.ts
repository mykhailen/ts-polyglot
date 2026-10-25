// What a language module gives the rest of the package: which files it owns, which grammar parses
// them, and how to read the functions and plain structs off a syntax tree. The build half (the
// bridge that lowers a language's functions to C-ABI callees) joins once the glue reads the model.
import type { Node } from "web-tree-sitter";

import type { NativeModule } from "../signatures.ts";

export type Language = "c" | "cpp" | "rust";

export interface LanguageModule {
  id: Language;
  /** Lower-case, with the dot. */
  extensions: readonly string[];
  /** A file under grammars/: the manifest's `asset`. */
  grammar: string;
  /** Every plain struct and every function the visitation rules reach, typed, in source order, same-named functions included; the registry filters. */
  parse(root: Node, source: string): NativeModule;
}
