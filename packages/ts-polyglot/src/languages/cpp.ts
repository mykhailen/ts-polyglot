import { cFamilyModule } from "./c-family.ts";
import type { LanguageModule } from "./language.ts";

// Its own grammar, because C code isn't always valid C++, but the same walker: tree-sitter-cpp's
// node types are a superset of tree-sitter-c's.
export const cpp: LanguageModule = { id: "cpp", extensions: [".cpp", ".cc", ".cxx"], grammar: "tree-sitter-cpp.wasm", parse: (root, source) => cFamilyModule(root, source, "cpp") };
