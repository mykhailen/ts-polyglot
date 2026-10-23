// The runtime half: `node --import ts-polyglot/register main.ts`. Importing a .c, .cpp or .rs
// file builds (or reuses) its Node-API addon and exports the addon's functions by name.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

import { buildAddon } from "./build.ts";
import { languageOf } from "./signatures.ts";

// Linux and macOS bind an addon's symbols lazily, so a function the native file declares but never
// defines would kill node at its first call. RTLD_NOW fails the import instead, catchably. Windows
// has no dlopen flags; its linker already refuses such an addon.
const dlopenFlags: number | undefined = constants.dlopen.RTLD_NOW;

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !languageOf(url)) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const { addon, functions } = buildAddon(file, readFileSync(file, "utf8"));
    const source = [
      "const native = { exports: {} };",
      `process.dlopen(native, ${JSON.stringify(addon)}${dlopenFlags === undefined ? "" : `, ${dlopenFlags}`});`,
      ...functions.map((fn) => `export const ${fn.name} = native.exports.${fn.name};`),
    ].join("\n");
    return { format: "module", source, shortCircuit: true };
  },
});
