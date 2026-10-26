// The walker C and C++ share: tree-sitter-cpp's node types are a superset of tree-sitter-c's, so one
// visit serves both grammars. A first pass collects the plain structs, a second the function
// definitions, with every parameter and result typed from c-types.ts and the struct table. What a
// type can't be is still recorded (`pointer`, `array`, `unknown`), so the registry skips the
// function for a reason instead of the walker hiding it. Node and field names are the grammars'
// (src/node-types.json at the pinned tags).
import type { Node } from "web-tree-sitter";

import { headerText } from "../parser.ts";
import { oneLine, parseIntegerLiteral, type NativeFunction, type NativeModule, type NativeStruct, type NativeType, type Param } from "../signatures.ts";
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
  declarations(root, [], (node, path) => {
    collectStruct(node, path, structs);
    collectConstant(node, path, structs.constants);
  });
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

/**
 * An integer constant the file defines: a `#define` of a literal, or a `const`/`constexpr` variable
 * initialized with one. An array size may name one; anything the file doesn't define this way is
 * a size the walker can't read.
 */
class Constants {
  // Keyed by qualified name, like structs; the first definition of a name wins, like everything else.
  private readonly byKey = new Map<string, number>();

  add(name: string, path: readonly string[], value: number): void {
    const key = [...path, name].join("::");
    if (!this.byKey.has(key)) this.byKey.set(key, value);
  }

  /** A name as written, resolved from inside `scope`: a bare name innermost namespace out, a qualified one from the root. */
  resolve(spelling: string, scope: readonly string[]): number | undefined {
    const absolute = spelling.startsWith("::");
    const segments = (absolute ? spelling.slice(2) : spelling).split("::");
    const prefixes = absolute || segments.length > 1 ? [[]] : Array.from({ length: scope.length + 1 }, (_, i) => scope.slice(0, scope.length - i));
    for (const prefix of prefixes) {
      const found = this.byKey.get([...prefix, ...segments].join("::"));
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

/** A `#define NAME <literal>` or a `const`/`constexpr` variable with a literal initializer, parentheses allowed around either, a comment after a define too. */
function collectConstant(node: Node, path: readonly string[], constants: Constants): void {
  if (node.type === "preproc_def") {
    const name = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    // The define's value is the rest of the line, comments included.
    const text = value?.text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/, "").trim().replace(/^\((.*)\)$/, "$1").trim();
    const literal = text ? parseIntegerLiteral(text, "c") : undefined;
    if (name && literal !== undefined) constants.add(name.text, path, literal);
  } else if (node.type === "declaration" && node.namedChildren.some((child) => child.type === "type_qualifier" && /^(const|constexpr)$/.test(child.text))) {
    for (const declarator of node.childrenForFieldName("declarator")) {
      if (declarator.type !== "init_declarator") continue;
      const name = declarator.childForFieldName("declarator");
      let value = declarator.childForFieldName("value");
      while (value?.type === "parenthesized_expression") value = value.namedChildren[0] ?? null;
      const literal = value?.type === "number_literal" ? parseIntegerLiteral(value.text, "c") : undefined;
      if (name?.type === "identifier" && literal !== undefined) constants.add(name.text, path, literal);
    }
  }
}

class Structs {
  readonly all: NativeStruct[] = [];
  // Collected in the same pass and resolved the same way, so the one object travels with the structs.
  readonly constants = new Constants();
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
      const sizes: Sizes = { constant: (name) => this.constants.resolve(name, struct.path) };
      for (const member of body.namedChildren) {
        if (member.type !== "field_declaration" || isStatic(member)) continue;
        const base = baseType(member, struct.path, this);
        for (const declarator of member.childrenForFieldName("declarator")) {
          const { type, name } = declared(base.type, base.const, declarator, sizes);
          if (name) struct.fields.push({ name: name.text, nameStart: name.startIndex, type: fieldArrays(type) });
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

/** The declarator a pointer, reference or array declarator wraps, which the grammar sometimes leaves unnamed. An abstract array's size isn't it. */
function inner(node: Node): Node | null {
  const size = node.childForFieldName("size");
  return node.childForFieldName("declarator") ?? node.namedChildren.find((child) => child.type !== "type_qualifier" && child.id !== size?.id) ?? null;
}

interface Base {
  type: NativeType;
  /** A `const` next to the type, before or after it; the declarator chain applies it to what is pointed at. */
  const: boolean;
}

function baseType(declaration: Node, scope: readonly string[], structs: Structs): Base {
  const typeNode = declaration.childForFieldName("type");
  return { type: typeNode ? namedType(typeNode, scope, structs) : { kind: "unknown", spelling: "" }, const: hasConst(declaration) };
}

/** A type node by itself: a primitive or string from the table, a std::vector or std::array, a struct from the file, or unknown. */
function namedType(typeNode: Node, scope: readonly string[], structs: Structs): NativeType {
  const spelling = oneLine(typeNode.text);
  if (typeNode.type === "struct_specifier" || typeNode.type === "class_specifier") {
    const found = structs.resolve(spelling, scope);
    return found ? { kind: "struct", name: found.name, spelling } : { kind: "unknown", spelling };
  }
  const known = cType(spelling);
  if (known) return { ...known.type, spelling };
  if (typeNode.type === "qualified_identifier") {
    const container = stdContainer(typeNode, scope, structs);
    if (container) return container;
  }
  if (typeNode.type === "type_identifier" || typeNode.type === "qualified_identifier") {
    const found = structs.resolve(spelling, scope);
    if (found) return { kind: "struct", name: found.name, spelling };
  }
  return { kind: "unknown", spelling };
}

/**
 * `std::vector<T>` and `std::array<T, N>`, qualified: an unqualified `vector` could be anything. The
 * element goes through the declarator rules, so `const char*` is a string; one that is itself a
 * C array (`std::array<int[2], 2>`) is unknown, since nothing converts that storage.
 */
function stdContainer(typeNode: Node, scope: readonly string[], structs: Structs): NativeType | undefined {
  const template = typeNode.childForFieldName("name");
  if (typeNode.childForFieldName("scope")?.text !== "std" || template?.type !== "template_type") return undefined;
  const which = template.childForFieldName("name")?.text;
  const args = template.childForFieldName("arguments")?.namedChildren.filter((child) => child.type !== "comment") ?? [];
  const spelling = oneLine(typeNode.text);
  const unknown: NativeType = { kind: "unknown", spelling };
  if ((which !== "vector" && which !== "array") || args.length !== (which === "vector" ? 1 : 2) || args[0]!.type !== "type_descriptor") return undefined;
  const descriptor = args[0]!;
  const base = baseType(descriptor, scope, structs);
  const of = declared(base.type, base.const, descriptor.childForFieldName("declarator"), { constant: (name) => structs.constants.resolve(name, scope) }).type;
  if (of.kind === "array" && cStyle(of)) return unknown;
  if (which === "vector") return { kind: "array", of, spelling };
  // A named size parses as a type_descriptor here, so its text is looked up like an identifier would be.
  const size = args[1]!;
  const length = size.type === "number_literal" ? parseIntegerLiteral(size.text, "c") : size.type === "type_descriptor" ? structs.constants.resolve(oneLine(size.text), scope) : undefined;
  return length === undefined ? unknown : { kind: "array", of, length, spelling };
}

/** How an array declarator's size is read: a name is a file constant, or in a parameter list possibly another parameter (`xs[n]`). */
interface Sizes {
  constant(name: string): number | undefined;
  parameter?(name: string): boolean;
}

/**
 * The array rules for a field: `char[N]` is a bounded string (so `char[M][N]` is an array of them),
 * a flexible member is nothing the glue can size, and a size the walker couldn't read already made
 * the type unknown.
 */
function fieldArrays(type: NativeType): NativeType {
  if (type.kind !== "array") return type;
  if (cStyle(type) && type.length === undefined) return { kind: "unknown", spelling: type.spelling };
  return charArray(type) ?? { ...type, of: fieldArrays(type.of) };
}

/** Whether an array is a C declarator (`T x[N]`, `T xs[]`) rather than a std container, which the C rules leave alone. */
const cStyle = (type: NativeType & { kind: "array" }) => type.spelling.endsWith("]");

/** A fixed `char[N]`, which holds N - 1 bytes before its NUL, as a bounded string; undefined for any other array (a `std::array<char, N>` is numbers). */
function charArray(type: NativeType & { kind: "array" }): NativeType | undefined {
  return cStyle(type) && type.length !== undefined && type.of.kind === "int" && type.of.spelling === "char" ? { kind: "string", nullable: false, max: type.length - 1, spelling: type.spelling } : undefined;
}

interface Declared {
  type: NativeType;
  /** The identifier the chain ends in, if it's named. */
  name: Node | undefined;
  /** The function declarator the chain reached instead: the function itself, or a function-pointer parameter. */
  fn: Node | undefined;
}

/** Applies a declarator chain, outermost first, to a base type. The chain's order is the type's: `*a[4]` is an array of pointers. */
function declared(base: NativeType, baseConst: boolean, declarator: Node | null, sizes: Sizes): Declared {
  let type = base;
  // Whether the thing the next `*` or `&` refers to is const: the base's qualifier, then each pointer's own.
  let pointee = baseConst;
  // A size the walker can't read makes the whole type unknown, but the chain still has the name to find.
  let unreadable = false;
  let node = declarator;
  const done = (): NativeType => (unreadable ? { kind: "unknown", spelling: type.spelling } : cString(type));
  while (node) {
    switch (node.type) {
      case "identifier":
      case "field_identifier":
        return { type: done(), name: node, fn: undefined };
      case "function_declarator":
        return { type: done(), name: undefined, fn: node };
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
        // The chain is walked outermost first but `a[2][3]` is read inner first, so a new dimension goes
        // before the ones already there; a std container's brackets are its template's, not dimensions.
        const dims = type.kind === "array" && cStyle(type) ? type.spelling.indexOf("[") : type.spelling.length;
        const spelling = `${type.spelling.slice(0, dims)}[${size?.text ?? ""}]${type.spelling.slice(dims)}`;
        const length = !size ? undefined : size.type === "number_literal" ? parseIntegerLiteral(size.text, "c") : size.type === "identifier" && sizes.parameter?.(size.text) ? undefined : size.type === "identifier" ? sizes.constant(size.text) : undefined;
        if (size && length === undefined && !(size.type === "identifier" && sizes.parameter?.(size.text))) unreadable = true;
        type = length === undefined ? { kind: "array", of: type, spelling } : { kind: "array", of: type, length, spelling };
        node = inner(node);
        break;
      }
      default:
        return { type: { kind: "unknown", spelling: type.spelling }, name: undefined, fn: undefined };
    }
  }
  return { type: done(), name: undefined, fn: undefined };
}

/** Exactly one pointer level around `const char` is a C string, which may be NULL; every other pointer stays a pointer. Array elements follow the same rule. */
function cString(type: NativeType): NativeType {
  if (type.kind === "array") return { ...type, of: cString(type.of) };
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
  const { type: returns, fn } = declared(base.type, base.const, declarator, { constant: (name) => structs.constants.resolve(name, path) });
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
  return declared(base.type, base.const, descriptor.childForFieldName("declarator"), { constant: (name) => structs.constants.resolve(name, scope) }).type;
}

/** The identifier a declarator chain ends in, if any. */
function declaratorName(node: Node | null): string | undefined {
  for (let current = node; current; current = inner(current)) {
    if (current.type === "identifier" || current.type === "field_identifier") return current.text;
    if (!["pointer_declarator", "reference_declarator", "array_declarator", "parenthesized_declarator"].includes(current.type)) return undefined;
  }
  return undefined;
}

/** The parameter an array declarator's size names, C99 style (`xs[n]`), if it names one. */
function sizeParameter(node: Node | null, isParameter: (name: string) => boolean): string | undefined {
  for (let current = node; current; current = inner(current)) {
    const size = current.type === "array_declarator" ? current.childForFieldName("size") : null;
    if (size?.type === "identifier" && isParameter(size.text)) return size.text;
    if (!["pointer_declarator", "array_declarator", "parenthesized_declarator"].includes(current.type)) return undefined;
  }
  return undefined;
}

function parameters(list: Node | null, scope: readonly string[], structs: Structs): Param[] | undefined {
  if (!list) return undefined;
  const declarations = list.namedChildren.filter((child) => child.type !== "comment");
  // `f(void)` declares no parameters.
  const [only] = declarations;
  if (declarations.length === 1 && only!.type === "parameter_declaration" && !only!.childForFieldName("declarator") && only!.childForFieldName("type")?.text === "void") return [];
  // A size may name a parameter, which shadows a file constant of the same name, so the names come first.
  const names = new Set(declarations.map((declaration) => declaratorName(declaration.childForFieldName("declarator"))).filter((name) => name !== undefined));
  const sizes: Sizes = { constant: (name) => structs.constants.resolve(name, scope), parameter: (name) => names.has(name) };
  const params: Param[] = [];
  const namedLengths: (string | undefined)[] = [];
  for (const [index, declaration] of declarations.entries()) {
    // A default argument (`optional_parameter_declaration`) is still a required parameter: the glue
    // always passes every argument. Anything else is `...`, which nothing here can carry.
    if (declaration.type !== "parameter_declaration" && declaration.type !== "optional_parameter_declaration") return undefined;
    const base = baseType(declaration, scope, structs);
    const declarator = declaration.childForFieldName("declarator");
    const { type, name, fn } = declared(base.type, base.const, declarator, sizes);
    // A function-pointer parameter has a function declarator of its own; the model has no shape for it.
    const resolved: NativeType = fn ? { kind: "unknown", spelling: oneLine(declaration.text) } : type;
    params.push(name ? { name: name.text, nameStart: name.startIndex, type: resolved } : { name: `arg${index}`, type: resolved });
    namedLengths.push(sizeParameter(declarator, sizes.parameter!));
  }
  pairLengths(params, declarations, namedLengths);
  for (const [i, param] of params.entries()) param.type = paramArrays(param.type, hasConst(declarations[i]!));
  return params;
}

/**
 * The C length rule. An unsized array parameter's length is the parameter its size names, else the
 * first integer parameter after it, shared by the unsized arrays in a row before that one. Without
 * either, or when the function could write the elements (they aren't const, and aren't pointers
 * to const), or when the elements are arrays themselves, the parameter is unknown and hides the
 * function. A paired `char` array is a counted string.
 */
function pairLengths(params: Param[], declarations: Node[], namedLengths: (string | undefined)[]): void {
  // A std::vector is an unsized array too, but it carries its own length.
  const unsized = (param: Param) => param.type.kind === "array" && param.type.length === undefined && cStyle(param.type);
  const hide = (param: Param) => (param.type = { kind: "unknown", spelling: param.type.spelling });
  const pair = (param: Param, length: Param | undefined, declaration: Node) => {
    const element = (param.type as NativeType & { kind: "array" }).of;
    if (!length || length.type.kind !== "int" || element.kind === "array" || (element.kind !== "string" && !hasConst(declaration))) return hide(param);
    param.length = { name: length.name, type: length.type };
    if (element.kind === "int" && element.spelling === "char") param.type = { kind: "string", nullable: false, spelling: param.type.spelling };
  };
  for (let i = 0; i < params.length; i++) {
    if (!unsized(params[i]!)) continue;
    const named = namedLengths[i];
    if (named) {
      pair(params[i]!, params.find((candidate) => candidate.name === named), declarations[i]!);
      continue;
    }
    let end = i;
    while (end < params.length && unsized(params[end]!) && !namedLengths[end]) end++;
    const length = params[end];
    for (let j = i; j < end; j++) pair(params[j]!, length && !unsized(length) ? length : undefined, declarations[j]!);
    i = end - 1;
  }
}

/**
 * The array rules for a parameter after pairing: a fixed `char[N]` is a bounded string, nested fixed
 * arrays recurse. A fixed C array whose elements aren't const hides the function, as an unsized one
 * does: the function could write into it, and a `char[N]` would be writing into the glue's buffer,
 * which is the argument's size, not N.
 */
function paramArrays(type: NativeType, isConst: boolean): NativeType {
  if (type.kind !== "array" || type.length === undefined) return type;
  const innermost = (t: NativeType): NativeType => (t.kind === "array" ? innermost(t.of) : t);
  if (cStyle(type) && !isConst && innermost(type).kind !== "string") return { kind: "unknown", spelling: type.spelling };
  return charArray(type) ?? { ...type, of: paramArrays(type.of, isConst) };
}
