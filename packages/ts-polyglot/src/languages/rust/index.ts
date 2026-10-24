// The Rust walker: `pub fn`s at the top level and inside modules the wrapper crate can reach, with
// the types RUST_TYPES knows. The wrapper includes the user's file as `mod user;`, so a function is
// callable only when it and every module around it are visible from the crate root. Node and field
// names are tree-sitter-rust's (src/node-types.json at the pinned tag).
import type { Node } from "web-tree-sitter";

import { BOOL, F64, I32, I64, U32, VOID, oneLine, type Kind, type NativeFunction, type Param } from "../../signatures.ts";
import type { LanguageModule } from "../language.ts";

export const RUST_TYPES: Record<string, Kind> = {
  i8: I32, i16: I32, i32: I32, u8: U32, u16: U32, u32: U32, i64: I64, f32: F64, f64: F64, bool: BOOL, "()": VOID,
};

export const rust: LanguageModule = { id: "rust", extensions: [".rs"], grammar: "tree-sitter-rust.wasm", functions: rustFunctions };

export function rustFunctions(root: Node, source: string): NativeFunction[] {
  const found: NativeFunction[] = [];
  visit(root, [], source, found);
  return found;
}

/** `node` is the source file or a module body: a list of items. */
function visit(node: Node, modules: readonly string[], source: string, found: NativeFunction[]): void {
  for (const child of node.namedChildren) {
    if (child.type === "function_item") {
      const fn = item(child, modules, source);
      if (fn) found.push(fn);
    } else if (child.type === "mod_item") {
      // A module with no `pub` of any form is private to its parent, so the wrapper at the crate root
      // can't call into it. `mod foo;` has no body here, and another file's functions aren't this
      // file's exports.
      const name = child.childForFieldName("name");
      const body = child.childForFieldName("body");
      const visible = child.namedChildren.some((n) => n.type === "visibility_modifier");
      if (name && body && visible) visit(body, [...modules, name.text], source, found);
    }
    // impl blocks, traits, macros and the rest hold nothing the wrapper can call by name.
  }
}

function item(node: Node, modules: readonly string[], source: string): NativeFunction | undefined {
  // `pub(crate)` scopes a function to the crate on purpose: the author didn't mean it for the world,
  // even though the wrapper technically lives in that crate.
  if (node.namedChildren.find((n) => n.type === "visibility_modifier")?.text !== "pub") return undefined;
  // `extern "C"` and `const` functions are called like any other; `unsafe` would need an unsafe
  // block and `async` a runtime.
  const modifiers = node.namedChildren.find((n) => n.type === "function_modifiers");
  if (modifiers?.children.some((n) => n.type === "async" || n.type === "unsafe")) return undefined;
  // Generics, lifetime-only ones included for now, and where clauses leave nothing concrete to wrap.
  if (node.childForFieldName("type_parameters") || node.namedChildren.some((n) => n.type === "where_clause")) return undefined;
  const name = node.childForFieldName("name");
  const list = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const body = node.childForFieldName("body");
  // An error in the header means it's half-typed; one in the body doesn't matter.
  if (!name || !list || !body || name.hasError || list.hasError || returnType?.hasError) return undefined;
  const params = parameters(list);
  const returns = returnType ? kindOf(returnType) : { type: "()", kind: RUST_TYPES["()"]! };
  if (!params || !returns) return undefined;
  return {
    name: name.text,
    nameStart: name.startIndex,
    callee: [...modules, name.text].join("::"),
    params,
    returnType: returns.type,
    returns: returns.kind,
    signature: oneLine(source.slice(node.startIndex, body.startIndex)),
  };
}

function kindOf(typeNode: Node): { type: string; kind: Kind } | undefined {
  const type = oneLine(typeNode.text);
  const kind = RUST_TYPES[type];
  return kind && { type, kind };
}

function parameters(list: Node): Param[] | undefined {
  const params: Param[] = [];
  for (const parameter of list.namedChildren) {
    if (parameter.type === "comment") continue;
    // `self`, `...` and parameter attributes have no place in the wrapper.
    if (parameter.type !== "parameter") return undefined;
    // `mut x` keeps `x` as the pattern, with the `mut` beside it; a tuple or struct pattern has no one name.
    const pattern = parameter.childForFieldName("pattern");
    const type = parameter.childForFieldName("type");
    if (pattern?.type !== "identifier" || !type) return undefined;
    const resolved = kindOf(type);
    if (!resolved || resolved.kind.ts === "void") return undefined;
    params.push({ name: pattern.text, nameStart: pattern.startIndex, type: resolved.type, kind: resolved.kind });
  }
  return params;
}
