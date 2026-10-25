import { cFamilyModule } from "./c-family.ts";
import { cAbi } from "./c-types.ts";
import type { Bridge, BridgeInput, LanguageModule } from "./language.ts";

export const c: LanguageModule = { id: "c", extensions: [".c"], grammar: "tree-sitter-c.wasm", parse: (root, source) => cFamilyModule(root, source, "c"), glue: "c", bridge: cBridge };

/** C needs no shim: the glue `#include`s the file and calls each function with its own types. Nothing reports errors. */
export function cBridge(input: BridgeInput): Bridge {
  return {
    prelude: `#include "${input.file.replaceAll("\\", "/")}"`,
    callee: (fn) => ({ name: fn.callee, params: fn.params.map((param) => cAbi(param.type, input.module)), returns: cAbi(fn.returns, input.module), reportsErrors: false }),
    libs: [],
  };
}
