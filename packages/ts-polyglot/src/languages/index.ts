// The registry: which module owns a file, and the two steps around a module's walker. Loading is
// asynchronous and happens once per language; parsing is synchronous, so the runtime hook can call
// it from its resolve.
import { loadGrammar, parse } from "../parser.ts";
import type { LegacyFunction } from "../signatures.ts";
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

function moduleFor(language: Language): LanguageModule {
  const found = languages.find((candidate) => candidate.id === language);
  if (!found) throw new Error(`ts-polyglot: no language module for ${language}`);
  return found;
}

/** Loads the language's grammar; a no-op after the first time. */
export function loadLanguage(language: Language): Promise<void> {
  return loadGrammar(moduleFor(language).grammar);
}

/** The functions a file exports. The language must have been loaded. */
export function findFunctions(source: string, language: Language): LegacyFunction[] {
  const module = moduleFor(language);
  const tree = parse(module.grammar, source);
  let found: LegacyFunction[];
  try {
    found = module.functions(tree.rootNode, source);
  } finally {
    tree.delete();
  }
  // A C++ overload, a duplicate, or the same name in two preprocessor branches: the first one wins.
  const seen = new Set<string>();
  return found.filter((fn) => !seen.has(fn.name) && seen.add(fn.name));
}
