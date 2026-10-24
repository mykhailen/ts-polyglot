// The runtime half: `node --import ts-polyglot/register main.ts`. Importing a .c, .cpp or .rs
// file builds (or reuses) its Node-API addon and resolves the import to a generated module that
// loads the addon and exports its functions.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAddon } from "./build.ts";
import { languageOf, languages, loadLanguage } from "./languages/index.ts";

// Every grammar up front: `--import` waits for this module, and the hook below is synchronous, so it
// can't load one when a native file first shows up. All three take about 25 ms (measured). The async
// hooks API could load on demand, but it measured 84 to 113 ms of startup plus 0.6 ms on every import
// in the program, for the worker thread it runs on.
await Promise.all(languages.map((language) => loadLanguage(language.id)));

registerHooks({
  // A resolve hook, not a load hook returning the generated JavaScript under the native file's
  // URL: that made the JavaScript debugger take add.cpp for a script, so a breakpoint set in it
  // bound to the generated text, stopped there on import, and opened that text as a second, read-only
  // add.cpp. With the module under its own URL in the cache, breakpoints in native files are left to
  // the native debugger.
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith("file:") || !languageOf(resolved.url)) return resolved;
    const file = fileURLToPath(resolved.url);
    return { url: pathToFileURL(buildAddon(file, readFileSync(file, "utf8"))).href, format: "module" };
  },
});
