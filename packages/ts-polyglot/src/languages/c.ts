import { cFamilyFunctions } from "./c-family.ts";
import type { LanguageModule } from "./language.ts";

export const c: LanguageModule = { id: "c", extensions: [".c"], grammar: "tree-sitter-c.wasm", functions: cFamilyFunctions };
