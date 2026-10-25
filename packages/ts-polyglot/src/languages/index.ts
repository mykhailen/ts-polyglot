// The registry: which module owns a file, and the steps around a module's walker. Loading is
// asynchronous and happens once per language; parsing is synchronous, so the runtime hook can call
// it from its resolve. `parseModule` applies `supported` here, so a walker records what a type is and
// the registry decides what the glue can carry.
import { loadGrammar, parse } from "../parser.ts";
import { supported, type NativeFunction, type NativeModule } from "../signatures.ts";
import { c } from "./c.ts";
import { cpp } from "./cpp.ts";
import type { Language, LanguageModule } from "./language.ts";
import { rust } from "./rust/index.ts";

export type { Language, LanguageModule } from "./language.ts";

export const languages: readonly LanguageModule[] = [c, cpp, rust];

export function languageOf(fileName: string): Language | undefined {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return undefined;
  const extension = fileName.slice(dot).toLowerCase();
  return languages.find((language) => language.extensions.includes(extension))?.id;
}

export function languageModule(language: Language): LanguageModule {
  const found = languages.find((candidate) => candidate.id === language);
  if (!found) throw new Error(`ts-polyglot: no language module for ${language}`);
  return found;
}

/** Loads the language's grammar; a no-op after the first time. */
export function loadLanguage(language: Language): Promise<void> {
  return loadGrammar(languageModule(language).grammar);
}

/** The walker's raw output for a file. The language must have been loaded. */
function walk(source: string, language: Language): NativeModule {
  const module = languageModule(language);
  const tree = parse(module.grammar, source);
  try {
    return module.parse(tree.rootNode, source);
  } finally {
    tree.delete();
  }
}

/**
 * What the glue and the mapper work from: the structs whose fields all cross, then the functions whose
 * parameters and result do. A C++ overload, a duplicate, or the same name in two preprocessor
 * branches: the first supported one wins, so an unsupported first overload doesn't hide a usable second.
 */
export function parseModule(source: string, language: Language): NativeModule {
  const raw = walk(source, language);
  // A struct is only as supported as its fields, which may be structs themselves.
  const module: NativeModule = { functions: [], structs: raw.structs.filter((struct) => struct.fields.every((field) => supported(field.type, raw))) };
  const seen = new Set<string>();
  module.functions = raw.functions.filter((fn) => [fn.returns, ...fn.params.map((param) => param.type)].every((type) => supported(type, module)) && !seen.has(fn.name) && seen.add(fn.name));
  return module;
}

/** The functions a file exports: `parseModule`'s, for callers that don't need the structs. */
export function findFunctions(source: string, language: Language): NativeFunction[] {
  return parseModule(source, language).functions;
}
