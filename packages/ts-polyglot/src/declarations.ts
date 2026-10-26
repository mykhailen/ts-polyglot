// The TypeScript that tsc checks in place of a C, C++ or Rust file: one `interface` per plain struct
// and one `declare function` per exported native function, typed by marshal.ts's rules.
import { basename } from "node:path";

import { languageOf, parseModule } from "./languages/index.ts";
import { jsType } from "./marshal.ts";
import { SpanMapKind, type SpanMapping, type TransformResult } from "./protocol.ts";
import { visibleParams } from "./signatures.ts";

export function toDeclarations(fileName: string, source: string): TransformResult {
  const language = languageOf(fileName);
  const module = language ? parseModule(source, language) : { functions: [], structs: [] };
  const file = basename(fileName);
  let text = "";
  const mappings: SpanMapping[] = [];
  // Function, parameter, struct and field names are the same text in both files. Mapping them
  // verbatim makes go-to-definition land on the native declaration, and errors about them point into
  // the native file.
  const verbatim = (originalStart: number, name: string) => {
    mappings.push([text.length, name.length, originalStart, name.length, SpanMapKind.Verbatim]);
    text += name;
  };

  // Interfaces first: TypeScript doesn't care, but a reader of the virtual file does.
  for (const struct of module.structs) {
    text += `/** \`${language === "rust" ? "pub struct" : "struct"} ${struct.name}\` from ${file} */\n`;
    text += "export interface ";
    verbatim(struct.nameStart, struct.name);
    text += " {\n";
    for (const field of struct.fields) {
      text += "  ";
      verbatim(field.nameStart, field.name);
      text += `: ${jsType(field.type, "field")};\n`;
    }
    text += "}\n";
  }

  for (const fn of module.functions) {
    // The parsers keep comments out of the signature; this is the backstop, because a `*/` here would
    // end the JSDoc early and break tsc's parse of the whole virtual file.
    text += `/** \`${fn.signature.replaceAll("*/", "* /")}\` from ${file}, run through a Node-API addon. */\n`;
    text += "export declare function ";
    verbatim(fn.nameStart, fn.name);
    text += "(";
    // A C length parameter has no TypeScript counterpart, and so no span.
    visibleParams(fn).forEach((param, index) => {
      if (index > 0) text += ", ";
      if (param.nameStart === undefined) text += param.name;
      else verbatim(param.nameStart, param.name);
      text += `: ${jsType(param.type, "param")}`;
    });
    text += `): ${jsType(fn.returns, "result")};\n`;
  }
  if (module.functions.length === 0 && module.structs.length === 0) text += "export {};\n";

  return { text, extension: ".ts", mappings };
}
