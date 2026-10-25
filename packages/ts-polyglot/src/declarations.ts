// The TypeScript that tsc checks in place of a C, C++ or Rust file: one `declare function` per
// exported native function, typed by marshal.ts's rules.
import { basename } from "node:path";

import { languageOf, parseModule } from "./languages/index.ts";
import { jsType } from "./marshal.ts";
import { SpanMapKind, type SpanMapping, type TransformResult } from "./protocol.ts";

export function toDeclarations(fileName: string, source: string): TransformResult {
  const language = languageOf(fileName);
  const functions = language ? parseModule(source, language).functions : [];
  let text = "";
  const mappings: SpanMapping[] = [];
  // Function and parameter names are the same text in both files. Mapping them verbatim makes
  // go-to-definition land on the native function, and errors about them point into the native file.
  const verbatim = (originalStart: number, name: string) => {
    mappings.push([text.length, name.length, originalStart, name.length, SpanMapKind.Verbatim]);
    text += name;
  };

  for (const fn of functions) {
    // The parsers keep comments out of the signature; this is the backstop, because a `*/` here would
    // end the JSDoc early and break tsc's parse of the whole virtual file.
    text += `/** \`${fn.signature.replaceAll("*/", "* /")}\` from ${basename(fileName)}, run through a Node-API addon. */\n`;
    text += "export declare function ";
    verbatim(fn.nameStart, fn.name);
    text += "(";
    fn.params.forEach((param, index) => {
      if (index > 0) text += ", ";
      if (param.nameStart === undefined) text += param.name;
      else verbatim(param.nameStart, param.name);
      text += `: ${jsType(param.type, "param")}`;
    });
    text += `): ${jsType(fn.returns, "result")};\n`;
  }
  if (functions.length === 0) text += "export {};\n";

  return { text, extension: ".ts", mappings };
}
