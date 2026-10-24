// The walker C and C++ share: tree-sitter-cpp's node types are a superset of tree-sitter-c's, so one
// visit serves both grammars. Only definitions export, only when every type is in the table and
// every parameter is a plain identifier; everything else is skipped, not reported. Node and field
// names are the grammars' (src/node-types.json at the pinned tags).
import type { Node } from "web-tree-sitter";

import { C_TYPES, oneLine, type Kind, type NativeFunction, type Param } from "../signatures.ts";

// Nodes whose children are declarations in their own right. Every branch of a preprocessor
// conditional is walked, since nothing here can tell which one the compiler will take; the first
// definition of a name wins downstream, which makes `#ifdef`/`#else` pairs come out as one function.
const CONTAINERS = new Set(["translation_unit", "declaration_list", "preproc_if", "preproc_ifdef", "preproc_elif", "preproc_elifdef", "preproc_else"]);

export function cFamilyFunctions(root: Node, source: string): NativeFunction[] {
  const found: NativeFunction[] = [];
  visit(root, source, found);
  return found;
}

function visit(node: Node, source: string, found: NativeFunction[]): void {
  if (node.type === "function_definition") {
    const fn = definition(node, source);
    if (fn) found.push(fn);
  } else if (CONTAINERS.has(node.type)) {
    for (const child of node.namedChildren) visit(child, source, found);
  }
}

function definition(node: Node, source: string): NativeFunction | undefined {
  // `static` keeps a function private to its file; `main` is the program, not a library function.
  if (node.children.some((child) => child.type === "storage_class_specifier" && child.text === "static")) return undefined;
  const type = node.childForFieldName("type");
  const declarator = node.childForFieldName("declarator");
  // Anything but a function declarator (a pointer, say) returns something the table can't hold. An
  // error inside the declarator means the header itself is half-typed; one inside the body doesn't matter.
  if (!type || declarator?.type !== "function_declarator" || declarator.hasError) return undefined;
  const nameNode = declarator.childForFieldName("declarator");
  if (nameNode?.type !== "identifier" || nameNode.text === "main") return undefined;
  const returns = kindOf(type);
  const params = parameters(declarator.childForFieldName("parameters"));
  if (!returns || !params) return undefined;
  return {
    name: nameNode.text,
    nameStart: nameNode.startIndex,
    callee: nameNode.text,
    params,
    returnType: returns.type,
    returns: returns.kind,
    signature: oneLine(source.slice(type.startIndex, declarator.endIndex)),
  };
}

/** The type's spelling with its whitespace normalized, and how it crosses; undefined when the table doesn't know it. */
function kindOf(typeNode: Node): { type: string; kind: Kind } | undefined {
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
    // Anything else is `...`.
    if (declaration.type !== "parameter_declaration") return undefined;
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
