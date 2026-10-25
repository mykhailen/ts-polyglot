// The walker C and C++ share: tree-sitter-cpp's node types are a superset of tree-sitter-c's, so one
// visit serves both grammars. A first pass collects the plain structs, a second the function
// definitions, with every parameter and result typed from c-types.ts and the struct table. What a
// type can't be is still recorded (`pointer`, `array`, `unknown`), so the registry skips the
// function for a reason instead of the walker hiding it. Node and field names are the grammars'
// (src/node-types.json at the pinned tags).
import type { Node } from "web-tree-sitter";

import { headerText } from "../parser.ts";
import { oneLine, type NativeFunction, type NativeModule, type NativeStruct, type NativeType, type Param } from "../signatures.ts";
import { cType } from "./c-types.ts";

/** C spells a struct `struct tag`; C++ spells it by its qualified name, and warns when `struct` names a `class`. */
export type Dialect = "c" | "cpp";

// Nodes whose children are declarations in their own right. Every branch of a preprocessor
// conditional is walked, since nothing here can tell which one the compiler will take; the first
// definition of a name wins downstream, which makes `#ifdef`/`#else` pairs come out as one function.
const CONTAINERS = new Set(["translation_unit", "declaration_list", "preproc_if", "preproc_ifdef", "preproc_elif", "preproc_elifdef", "preproc_else"]);
// A field whose type node is one of these with a body defines a nested type, which a plain struct doesn't have.
const TYPE_SPECIFIERS = new Set(["struct_specifier", "class_specifier", "union_specifier", "enum_specifier"]);

export function cFamilyModule(root: Node, source: string, dialect: Dialect): NativeModule {
  const structs = new Structs(dialect);
  declarations(root, [], (node, path) => collectStruct(node, path, structs));
  structs.typeFields();
  const functions: NativeFunction[] = [];
  declarations(root, [], (node, path) => {
    if (node.type !== "function_definition") return;
    const fn = definition(node, path, structs, source);
    if (fn) functions.push(fn);
  });
  return { functions, structs: structs.all };
}

/** Calls `each` with every declaration-level node and the namespaces around it, descending the containers. */
function declarations(node: Node, path: readonly string[], each: (node: Node, path: readonly string[]) => void): void {
  for (const child of node.namedChildren) {
    if (CONTAINERS.has(child.type)) {
      declarations(child, path, each);
    } else if (child.type === "linkage_specification") {
      // `extern "C" { ... }` has a declaration list for a body; `extern "C" int f() {}` the definition itself.
      const body = child.childForFieldName("body");
      if (body?.type === "declaration_list") declarations(body, path, each);
      else if (body) each(body, path);
    } else if (child.type === "namespace_definition") {
      // An anonymous namespace has internal linkage, like `static`. `namespace a::b` is one name node.
      const name = child.childForFieldName("name");
      const body = child.childForFieldName("body");
      if (name && body) declarations(body, [...path, ...name.text.replace(/\s+/g, "").split("::")], each);
    } else {
      each(child, path);
    }
  }
  // Templates, classes with methods and prototypes (`declaration`) are among what `each` ignores.
}

/** A struct or class definition standing alone, under a typedef, or declaring a variable at the same time. */
function collectStruct(node: Node, path: readonly string[], structs: Structs): void {
  if (node.type === "struct_specifier" || node.type === "class_specifier") {
    structs.add(node, path, undefined);
  } else if (node.type === "type_definition") {
    const type = node.childForFieldName("type");
    const alias = node.childrenForFieldName("declarator").find((declarator) => declarator.type === "type_identifier");
    if (type && alias && (type.type === "struct_specifier" || type.type === "class_specifier")) structs.add(type, path, alias);
  } else if (node.type === "declaration") {
    const type = node.childForFieldName("type");
    if (type && (type.type === "struct_specifier" || type.type === "class_specifier")) structs.add(type, path, undefined);
  }
}

class Structs {
  readonly all: NativeStruct[] = [];
  // Keyed by qualified name: `geometry::Point` for a typedef or C++ name, `struct geometry::Point` for a tag.
  private readonly byKey = new Map<string, NativeStruct>();
  private readonly pending: { struct: NativeStruct; body: Node }[] = [];
  private readonly dialect: Dialect;

  constructor(dialect: Dialect) {
    this.dialect = dialect;
  }

  /** Registers a plain struct under its tag and its typedef name. The first struct to claim a TypeScript name keeps it. */
  add(spec: Node, path: readonly string[], alias: Node | undefined): void {
    const tag = spec.childForFieldName("name");
    const nameNode = alias ?? tag;
    const body = spec.childForFieldName("body");
    if (nameNode?.type !== "type_identifier" || !body || !plain(spec, body)) return;
    const name = nameNode.text;
    if (this.all.some((struct) => struct.name === name)) return;
    const qualified = (text: string) => [...path, text].join("::");
    const spelling = this.dialect === "c" ? (alias ? alias.text : `struct ${tag!.text}`) : qualified(name);
    const struct: NativeStruct = { name, nameStart: nameNode.startIndex, fields: [], path: [...path], spelling };
    if (tag?.type === "type_identifier") {
      this.byKey.set(`struct ${qualified(tag.text)}`, struct);
      this.byKey.set(qualified(tag.text), struct);
    }
    if (alias) this.byKey.set(qualified(alias.text), struct);
    this.all.push(struct);
    this.pending.push({ struct, body });
  }

  /** Types every field once all structs are known, so a field can name a struct defined later in the file. */
  typeFields(): void {
    for (const { struct, body } of this.pending) {
      for (const member of body.namedChildren) {
        if (member.type !== "field_declaration" || isStatic(member)) continue;
        const base = baseType(member, struct.path, this);
        for (const declarator of member.childrenForFieldName("declarator")) {
          const { type, name } = declared(base.type, base.const, declarator);
          if (name) struct.fields.push({ name: name.text, nameStart: name.startIndex, type });
        }
      }
    }
  }

  /** A type name as written, resolved from inside `scope`: a bare name innermost namespace out, a qualified one from the root. */
  resolve(spelling: string, scope: readonly string[]): NativeStruct | undefined {
    const tagged = /^(struct|class)\s/.test(spelling);
    const bare = spelling.replace(/^(struct|class)\s+/, "");
    const absolute = bare.startsWith("::");
    const segments = (absolute ? bare.slice(2) : bare).split("::");
    const prefixes = absolute || segments.length > 1 ? [[]] : Array.from({ length: scope.length + 1 }, (_, i) => scope.slice(0, scope.length - i));
    for (const prefix of prefixes) {
      const key = [...prefix, ...segments].join("::");
      const found = (tagged ? undefined : this.byKey.get(key)) ?? this.byKey.get(`struct ${key}`);
      if (found) return found;
    }
    return undefined;
  }
}

const isStatic = (node: Node) => node.namedChildren.some((child) => child.type === "storage_class_specifier" && child.text === "static");
const hasConst = (node: Node) => node.namedChildren.some((child) => child.type === "type_qualifier" && child.text === "const");

/** "Plain" per the design: public data members only, no bases, methods, constructors, nested types or bitfields. */
function plain(spec: Node, body: Node): boolean {
  if (spec.namedChildren.some((child) => child.type === "base_class_clause")) return false;
  let access = spec.type === "class_specifier" ? "private" : "public";
  for (const member of body.namedChildren) {
    if (member.type === "comment") continue;
    if (member.type === "access_specifier") {
      access = member.text.replace(/\W/g, "");
      continue;
    }
    // Methods, constructors, friends, using-declarations, nested typedefs: anything that isn't a data member.
    if (member.type !== "field_declaration") return false;
    // A static member isn't part of an instance; the glue never touches it, whatever its access.
    if (isStatic(member)) continue;
    if (access !== "public") return false;
    const type = member.childForFieldName("type");
    if (!type || (TYPE_SPECIFIERS.has(type.type) && type.childForFieldName("body"))) return false;
    if (member.namedChildren.some((child) => child.type === "bitfield_clause")) return false;
    const declarators = member.childrenForFieldName("declarator");
    if (declarators.length === 0 || !declarators.every(dataMember)) return false;
  }
  return true;
}

/** A field_identifier, possibly behind pointer, reference or array declarators: a data member, not a method. */
function dataMember(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.type === "field_identifier") return true;
    if (!["pointer_declarator", "reference_declarator", "array_declarator"].includes(current.type)) return false;
    current = inner(current);
  }
  return false;
}

/** The declarator a pointer, reference or array declarator wraps, which the grammar sometimes leaves unnamed. */
const inner = (node: Node): Node | null => node.childForFieldName("declarator") ?? node.namedChildren.find((child) => child.type !== "type_qualifier") ?? null;

interface Base {
  type: NativeType;
  /** A `const` next to the type, before or after it; the declarator chain applies it to what is pointed at. */
  const: boolean;
}

function baseType(declaration: Node, scope: readonly string[], structs: Structs): Base {
  const typeNode = declaration.childForFieldName("type");
  return { type: typeNode ? namedType(typeNode, scope, structs) : { kind: "unknown", spelling: "" }, const: hasConst(declaration) };
}

/** A type node by itself: a primitive or string from the table, a struct from the file, or unknown. */
function namedType(typeNode: Node, scope: readonly string[], structs: Structs): NativeType {
  const spelling = oneLine(typeNode.text);
  if (typeNode.type === "struct_specifier" || typeNode.type === "class_specifier") {
    const found = structs.resolve(spelling, scope);
    return found ? { kind: "struct", name: found.name, spelling } : { kind: "unknown", spelling };
  }
  const known = cType(spelling);
  if (known) return { ...known.type, spelling };
  if (typeNode.type === "type_identifier" || typeNode.type === "qualified_identifier") {
    const found = structs.resolve(spelling, scope);
    if (found) return { kind: "struct", name: found.name, spelling };
  }
  return { kind: "unknown", spelling };
}

interface Declared {
  type: NativeType;
  /** The identifier the chain ends in, if it's named. */
  name: Node | undefined;
  /** The function declarator the chain reached instead: the function itself, or a function-pointer parameter. */
  fn: Node | undefined;
}

/** Applies a declarator chain, outermost first, to a base type. The chain's order is the type's: `*a[4]` is an array of pointers. */
function declared(base: NativeType, baseConst: boolean, declarator: Node | null): Declared {
  let type = base;
  // Whether the thing the next `*` or `&` refers to is const: the base's qualifier, then each pointer's own.
  let pointee = baseConst;
  let node = declarator;
  while (node) {
    switch (node.type) {
      case "identifier":
      case "field_identifier":
        return { type: cString(type), name: node, fn: undefined };
      case "function_declarator":
        return { type: cString(type), name: undefined, fn: node };
      case "pointer_declarator":
      case "abstract_pointer_declarator":
        type = { kind: "pointer", to: type, const: pointee, spelling: `${pointee ? "const " : ""}${type.spelling}*` };
        pointee = hasConst(node);
        node = inner(node);
        break;
      case "reference_declarator":
      case "abstract_reference_declarator": {
        const rvalue = node.children.some((child) => child.type === "&&");
        type = { kind: "reference", to: type, mutable: !pointee, spelling: `${pointee ? "const " : ""}${type.spelling}${rvalue ? "&&" : "&"}` };
        pointee = false;
        node = inner(node);
        break;
      }
      case "array_declarator":
      case "abstract_array_declarator": {
        const size = node.childForFieldName("size");
        const spelling = `${type.spelling}[${size?.text ?? ""}]`;
        type = size && /^\d+$/.test(size.text) ? { kind: "array", of: type, length: Number(size.text), spelling } : { kind: "array", of: type, spelling };
        node = inner(node);
        break;
      }
      default:
        return { type: { kind: "unknown", spelling: type.spelling }, name: undefined, fn: undefined };
    }
  }
  return { type: cString(type), name: undefined, fn: undefined };
}

/** Exactly one pointer level around `const char` is a C string, which may be NULL; every other pointer stays a pointer. */
function cString(type: NativeType): NativeType {
  return type.kind === "pointer" && type.const && type.to.kind === "int" && type.to.spelling === "char" ? { kind: "string", nullable: true, spelling: "const char*" } : type;
}

function definition(node: Node, path: readonly string[], structs: Structs, source: string): NativeFunction | undefined {
  // `static` keeps a function private to its file; `main` is the program, not a library function.
  if (isStatic(node)) return undefined;
  const typeNode = node.childForFieldName("type");
  const declarator = node.childForFieldName("declarator");
  // An error inside the declarator means the header itself is half-typed; one inside the body doesn't matter.
  if (!typeNode || !declarator || declarator.hasError) return undefined;
  // Declarators between the type and the function declarator belong to the result: `int* f()`.
  const base = baseType(node, path, structs);
  const { type: returns, fn } = declared(base.type, base.const, declarator);
  if (!fn) return undefined;
  // A qualified name (`geo::f`, `Foo::bar`) is an out-of-line definition: a class method can't be
  // told from a namespace function here, so neither exports.
  const nameNode = fn.childForFieldName("declarator");
  if (nameNode?.type !== "identifier" || nameNode.text === "main") return undefined;
  const params = parameters(fn.childForFieldName("parameters"), path, structs);
  if (!params) return undefined;
  return {
    name: nameNode.text,
    nameStart: nameNode.startIndex,
    callee: [...path, nameNode.text].join("::"),
    params,
    // `auto f() -> int`: the type is the placeholder, the real one trails the declarator.
    returns: typeNode.type === "placeholder_type_specifier" ? trailingReturn(fn, path, structs) : returns,
    signature: headerText(source, typeNode.startIndex, declarator.endIndex, node, ["comment"]),
  };
}

function trailingReturn(fn: Node, scope: readonly string[], structs: Structs): NativeType {
  const descriptor = fn.namedChildren.find((child) => child.type === "trailing_return_type")?.namedChildren[0];
  if (!descriptor) return { kind: "unknown", spelling: "auto" };
  const base = baseType(descriptor, scope, structs);
  return declared(base.type, base.const, descriptor.childForFieldName("declarator")).type;
}

function parameters(list: Node | null, scope: readonly string[], structs: Structs): Param[] | undefined {
  if (!list) return undefined;
  const declarations = list.namedChildren.filter((child) => child.type !== "comment");
  // `f(void)` declares no parameters.
  const [only] = declarations;
  if (declarations.length === 1 && only!.type === "parameter_declaration" && !only!.childForFieldName("declarator") && only!.childForFieldName("type")?.text === "void") return [];
  const params: Param[] = [];
  for (const [index, declaration] of declarations.entries()) {
    // A default argument (`optional_parameter_declaration`) is still a required parameter: the glue
    // always passes every argument. Anything else is `...`, which nothing here can carry.
    if (declaration.type !== "parameter_declaration" && declaration.type !== "optional_parameter_declaration") return undefined;
    const base = baseType(declaration, scope, structs);
    const { type, name, fn } = declared(base.type, base.const, declaration.childForFieldName("declarator"));
    // A function-pointer parameter has a function declarator of its own; the model has no shape for it.
    const resolved: NativeType = fn ? { kind: "unknown", spelling: oneLine(declaration.text) } : type;
    params.push(name ? { name: name.text, nameStart: name.startIndex, type: resolved } : { name: `arg${index}`, type: resolved });
  }
  return params;
}
