// The walker C and C++ share: tree-sitter-cpp's node types are a superset of tree-sitter-c's, so one
// visit serves both grammars. Only definitions export, only when every type is in the table and
// every parameter is a plain identifier; everything else is skipped, not reported. Node and field
// names are the grammars' (src/node-types.json at the pinned tags).
import type { Node } from "web-tree-sitter";

import { headerText } from "../parser.ts";
import { BOOL, F64, I32, I64, U32, VOID, oneLine, type Kind, type NativeFunction, type Param } from "../signatures.ts";

// `long` is 32-bit on Windows but 64-bit on Linux and macOS, so it crosses as 64-bit everywhere and
// every OS sees the same functions. `unsigned long` would need 64-bit unsigned values, which don't
// cross yet.
export const C_TYPES: Record<string, Kind> = {
  int: I32, "signed int": I32, short: I32, int8_t: I32, int16_t: I32, int32_t: I32,
  unsigned: U32, "unsigned int": U32, "unsigned short": U32, uint8_t: U32, uint16_t: U32, uint32_t: U32,
  long: I64, "long long": I64, int64_t: I64,
  float: F64, double: F64,
  bool: BOOL, _Bool: BOOL,
  void: VOID,
};

// Nodes whose children are declarations in their own right. Every branch of a preprocessor
// conditional is walked, since nothing here can tell which one the compiler will take; the first
// definition of a name wins downstream, which makes `#ifdef`/`#else` pairs come out as one function.
const CONTAINERS = new Set(["translation_unit", "declaration_list", "preproc_if", "preproc_ifdef", "preproc_elif", "preproc_elifdef", "preproc_else"]);

export function cFamilyFunctions(root: Node, source: string): NativeFunction[] {
  const found: NativeFunction[] = [];
  visit(root, [], source, found);
  return found;
}

function visit(node: Node, namespaces: readonly string[], source: string, found: NativeFunction[]): void {
  if (node.type === "function_definition") {
    const fn = definition(node, namespaces, source);
    if (fn) found.push(fn);
  } else if (CONTAINERS.has(node.type)) {
    for (const child of node.namedChildren) visit(child, namespaces, source, found);
  } else if (node.type === "linkage_specification") {
    // `extern "C" { ... }` has a declaration list for a body; `extern "C" int f() {}` the definition itself.
    const body = node.childForFieldName("body");
    if (body) visit(body, namespaces, source, found);
  } else if (node.type === "namespace_definition") {
    // An anonymous namespace has internal linkage, like `static`. `namespace a::b` is one name node.
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (name && body) visit(body, [...namespaces, name.text.replace(/\s+/g, "")], source, found);
  }
  // Templates, classes and prototypes (`declaration`) are among what falls through.
}

function definition(node: Node, namespaces: readonly string[], source: string): NativeFunction | undefined {
  // `static` keeps a function private to its file; `main` is the program, not a library function.
  if (node.children.some((child) => child.type === "storage_class_specifier" && child.text === "static")) return undefined;
  const type = node.childForFieldName("type");
  const declarator = node.childForFieldName("declarator");
  // Anything but a function declarator (a pointer, say) returns something the table can't hold. An
  // error inside the declarator means the header itself is half-typed; one inside the body doesn't matter.
  if (!type || declarator?.type !== "function_declarator" || declarator.hasError) return undefined;
  // A qualified name (`geo::f`, `Foo::bar`) is an out-of-line definition: a class method can't be
  // told from a namespace function here, so neither exports.
  const nameNode = declarator.childForFieldName("declarator");
  if (nameNode?.type !== "identifier" || nameNode.text === "main") return undefined;
  // `auto f() -> int`: the type is the placeholder, the real one trails the declarator.
  const returns = kindOf(type.type === "placeholder_type_specifier" ? trailingReturnType(declarator) : type);
  const params = parameters(declarator.childForFieldName("parameters"));
  if (!returns || !params) return undefined;
  return {
    name: nameNode.text,
    nameStart: nameNode.startIndex,
    callee: [...namespaces, nameNode.text].join("::"),
    params,
    returnType: returns.type,
    returns: returns.kind,
    signature: headerText(source, type.startIndex, declarator.endIndex, node, ["comment"]),
  };
}

function trailingReturnType(declarator: Node): Node | undefined {
  return declarator.namedChildren.find((child) => child.type === "trailing_return_type")?.namedChildren[0];
}

/** The type's spelling with its whitespace normalized, and how it crosses; undefined when the table doesn't know it. */
function kindOf(typeNode: Node | null | undefined): { type: string; kind: Kind } | undefined {
  if (!typeNode) return undefined;
  const type = oneLine(typeNode.text);
  const kind = C_TYPES[type];
  return kind && { type, kind };
}

function parameters(list: Node | null): Param[] | undefined {
  if (!list) return undefined;
  const declarations = list.namedChildren.filter((child) => child.type !== "comment");
  // `f(void)` declares no parameters.
  const [only] = declarations;
  if (declarations.length === 1 && only!.type === "parameter_declaration" && !only!.childForFieldName("declarator") && only!.childForFieldName("type")?.text === "void") return [];
  const params: Param[] = [];
  for (const [index, declaration] of declarations.entries()) {
    // A default argument (`optional_parameter_declaration`) is still a required parameter: the glue
    // always passes every argument. Anything else is `...`.
    if (declaration.type !== "parameter_declaration" && declaration.type !== "optional_parameter_declaration") return undefined;
    const type = declaration.childForFieldName("type");
    const resolved = type && kindOf(type);
    if (!resolved || resolved.kind.ts === "void") return undefined;
    // A pointer, array, reference or function-pointer declarator wraps the name in another node.
    const nameNode = declaration.childForFieldName("declarator");
    if (nameNode && nameNode.type !== "identifier") return undefined;
    params.push(
      nameNode
        ? { name: nameNode.text, nameStart: nameNode.startIndex, type: resolved.type, kind: resolved.kind }
        : { name: `arg${index}`, type: resolved.type, kind: resolved.kind },
    );
  }
  return params;
}
