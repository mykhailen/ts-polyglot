// The Rust walker: `pub fn`s at the top level and inside modules the wrapper crate can reach, typed
// from rust/types.ts and the file's plain structs. The wrapper includes the user's file as `mod user;`,
// so a function is callable only when it and every module around it are visible from the crate
// root. What a type can't be is still recorded (`pointer`, `array`, `unknown`), so the registry skips
// the function for a reason. Node and field names are tree-sitter-rust's (src/node-types.json at the
// pinned tag).
import type { Node } from "web-tree-sitter";

import { headerText } from "../../parser.ts";
import { oneLine, toLegacy, type LegacyFunction, type NativeFunction, type NativeModule, type NativeStruct, type NativeType, type Param } from "../../signatures.ts";
import type { LanguageModule } from "../language.ts";
import { rustType } from "./types.ts";

export const rust: LanguageModule = { id: "rust", extensions: [".rs"], grammar: "tree-sitter-rust.wasm", functions: rustFunctions };

// tree-sitter-rust has two comment nodes where the C grammars have one.
const COMMENTS = ["line_comment", "block_comment"];

export function rustModule(root: Node, source: string): NativeModule {
  const structs = new Structs();
  items(root, [], (node, path) => {
    if (node.type === "struct_item") structs.add(node, path);
  });
  structs.typeFields();
  const functions: NativeFunction[] = [];
  items(root, [], (node, path) => {
    if (node.type !== "function_item") return;
    const fn = item(node, path, structs, source);
    if (fn) functions.push(fn);
  });
  return { functions, structs: structs.all };
}

/** Today's output, until the registry reads the module itself. */
export function rustFunctions(root: Node, source: string): LegacyFunction[] {
  return rustModule(root, source).functions.map(toLegacy).filter((fn) => fn !== undefined);
}

/** Calls `each` with every item of the file and of the modules the wrapper can reach, with the module path. */
function items(node: Node, path: readonly string[], each: (node: Node, path: readonly string[]) => void): void {
  for (const child of node.namedChildren) {
    if (child.type === "mod_item") {
      // A module with no `pub` of any form is private to its parent, so the wrapper at the crate root
      // can't call into it. `mod foo;` has no body here, and another file's functions aren't this
      // file's exports.
      const name = child.childForFieldName("name");
      const body = child.childForFieldName("body");
      const visible = child.namedChildren.some((n) => n.type === "visibility_modifier");
      if (name && body && visible) items(body, [...path, name.text], each);
    } else {
      each(child, path);
    }
    // impl blocks, traits, macros and the rest hold nothing the wrapper can call by name.
  }
}

const visibility = (node: Node) => node.namedChildren.find((n) => n.type === "visibility_modifier")?.text;

class Structs {
  readonly all: NativeStruct[] = [];
  // Keyed by module path: `geo::V`.
  private readonly byPath = new Map<string, NativeStruct>();
  private readonly pending: { struct: NativeStruct; body: Node }[] = [];

  /** Registers a plain struct: `pub`, no type parameters, named fields that are all `pub`. The first to claim a name keeps it. */
  add(node: Node, path: readonly string[]): void {
    // `pub(crate)` scopes a struct, or a field, to the crate on purpose, like a function.
    if (visibility(node) !== "pub" || node.childForFieldName("type_parameters")) return;
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!name || body?.type !== "field_declaration_list") return;
    const members = body.namedChildren.filter((n) => !COMMENTS.includes(n.type) && n.type !== "attribute_item");
    if (!members.every((member) => member.type === "field_declaration" && visibility(member) === "pub")) return;
    if (this.all.some((struct) => struct.name === name.text)) return;
    const struct: NativeStruct = { name: name.text, nameStart: name.startIndex, fields: [], path: [...path], spelling: ["user", ...path, name.text].join("::") };
    this.byPath.set([...path, name.text].join("::"), struct);
    this.all.push(struct);
    this.pending.push({ struct, body });
  }

  /** Types every field once all structs are known, so a field can name a struct defined later in the file. */
  typeFields(): void {
    for (const { struct, body } of this.pending) {
      for (const field of body.namedChildren) {
        if (field.type !== "field_declaration") continue;
        const name = field.childForFieldName("name");
        const type = field.childForFieldName("type");
        if (name && type) struct.fields.push({ name: name.text, nameStart: name.startIndex, type: typeOf(type, struct.path, this, false) });
      }
    }
  }

  /** Name resolution as far as one file goes: a bare name in the current module, a path relative to it and then from the root, `crate::` and `super::`. */
  resolve(spelling: string, scope: readonly string[]): NativeStruct | undefined {
    const segments = spelling.split("::");
    if (segments[0] === "crate") return this.byPath.get(segments.slice(1).join("::"));
    if (segments[0] === "super") {
      const base = [...scope];
      let i = 0;
      for (; segments[i] === "super"; i++) base.pop();
      return this.byPath.get([...base, ...segments.slice(i)].join("::"));
    }
    return this.byPath.get([...scope, ...segments].join("::")) ?? (segments.length > 1 ? this.byPath.get(spelling) : undefined);
  }
}

/** A type node, structured. `isResult` applies the rule for borrowed results. */
function typeOf(node: Node, scope: readonly string[], structs: Structs, isResult: boolean): NativeType {
  const spelling = oneLine(node.text);
  switch (node.type) {
    case "primitive_type":
    case "unit_type": {
      const known = rustType(spelling);
      return known ? { ...known.type, spelling } : { kind: "unknown", spelling };
    }
    case "type_identifier":
    case "scoped_type_identifier": {
      const known = rustType(spelling);
      if (known) return { ...known.type, spelling };
      const found = structs.resolve(spelling, scope);
      return found ? { kind: "struct", name: found.name, spelling } : { kind: "unknown", spelling };
    }
    case "reference_type": {
      const lifetime = node.namedChildren.find((n) => n.type === "lifetime")?.text;
      // A result borrowing from anything but 'static borrows from an argument the wrapper owns, which
      // is gone when the wrapper returns: `fn f(s: &str) -> &str` can't cross.
      if (isResult && lifetime !== "'static") return { kind: "unknown", spelling };
      const inner = node.childForFieldName("type");
      const mutable = node.namedChildren.some((n) => n.type === "mutable_specifier");
      const to: NativeType = inner ? typeOf(inner, scope, structs, false) : { kind: "unknown", spelling };
      return { kind: "reference", to, mutable, spelling: `&${lifetime ? `${lifetime} ` : ""}${mutable ? "mut " : ""}${to.spelling}` };
    }
    case "pointer_type": {
      const inner = node.childForFieldName("type");
      const to: NativeType = inner ? typeOf(inner, scope, structs, false) : { kind: "unknown", spelling };
      return { kind: "pointer", to, const: !node.namedChildren.some((n) => n.type === "mutable_specifier"), spelling };
    }
    case "array_type": {
      const element = node.childForFieldName("element");
      const length = node.childForFieldName("length");
      const of: NativeType = element ? typeOf(element, scope, structs, false) : { kind: "unknown", spelling };
      return length && /^\d+$/.test(length.text) ? { kind: "array", of, length: Number(length.text), spelling } : { kind: "array", of, spelling };
    }
    default:
      // Generics, tuples, function types, `dyn` and `impl`: nothing the model has a shape for.
      return { kind: "unknown", spelling };
  }
}

function item(node: Node, modules: readonly string[], structs: Structs, source: string): NativeFunction | undefined {
  // `pub(crate)` scopes a function to the crate on purpose: the author didn't mean it for the world,
  // even though the wrapper technically lives in that crate.
  if (visibility(node) !== "pub") return undefined;
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
  const params = parameters(list, modules, structs);
  if (!params) return undefined;
  return {
    name: name.text,
    nameStart: name.startIndex,
    callee: [...modules, name.text].join("::"),
    params,
    returns: returnType ? typeOf(returnType, modules, structs, true) : { kind: "void", spelling: "()" },
    signature: headerText(source, node.startIndex, body.startIndex, node, COMMENTS),
  };
}

function parameters(list: Node, scope: readonly string[], structs: Structs): Param[] | undefined {
  const params: Param[] = [];
  for (const parameter of list.namedChildren) {
    if (COMMENTS.includes(parameter.type)) continue;
    // `self`, `...` and parameter attributes have no place in the wrapper.
    if (parameter.type !== "parameter") return undefined;
    // `mut x` keeps `x` as the pattern, with the `mut` beside it; a tuple or struct pattern has no one name.
    const pattern = parameter.childForFieldName("pattern");
    const type = parameter.childForFieldName("type");
    if (pattern?.type !== "identifier" || !type) return undefined;
    params.push({ name: pattern.text, nameStart: pattern.startIndex, type: typeOf(type, scope, structs, false) });
  }
  return params;
}
