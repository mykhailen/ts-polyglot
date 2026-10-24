# Tree-sitter parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex signature scanner with tree-sitter, one module per language, with the
same `NativeFunction` output for today's code and the structural gaps closed: `extern "C"` blocks,
namespaces, Rust `pub mod`, attributes, `noexcept`, trailing return types, default arguments and
half-typed files.

**Architecture:**
- `parser.ts` owns web-tree-sitter: loads a vendored grammar `.wasm` once per process and parses.
- `languages/` holds one module per language (`c`, `cpp`, `rust`) behind the `LanguageModule`
  interface, plus a registry: `languageOf`, `loadLanguage` (async, once) and `findFunctions`
  (synchronous). C and C++ share one walker over the C-family node types.
- `signatures.ts` keeps only the shared shapes (`Kind`, `Param`, `NativeFunction`). The type tables
  move into their language modules. `NativeFunction` gains `callee`, the qualified name the glue calls.
- The mapper's `transform` becomes async and loads a grammar the first time it sees a language. The
  runtime hook stays synchronous and preloads every grammar at `--import` time.
- Grammar binaries are committed under `grammars/` with a checksum manifest and a refresh script.

**Tech Stack:** TypeScript 7.1 beta, Node 22.18+ (type stripping, `node:test`, `import.meta.main`),
web-tree-sitter 0.27.1 (WASM), tree-sitter grammars C v0.24.2, C++ v0.23.4, Rust v0.24.2.

**Spec:** `docs/superpowers/specs/2026-10-24-tree-sitter-parser-design.md`. The spec's "The C and C++
walker" and "The Rust walker" sections are the acceptance rules; this plan names the code and the
tests that pin them and does not restate the rules.

## Global Constraints

- Node `>=22.18`. `typescript` stays pinned to `7.1.0-beta`. `web-tree-sitter` is pinned exactly:
  `"web-tree-sitter": "0.27.1"`. No other new dependency, and no install scripts.
- `dist/` is what runs: `exports["./register"]` and the mapper's `exec` point there. Anything that
  exercises `tsc`, the editor, the probe or `node --import ts-polyglot/register` builds first
  (`npm test`, `npm run typecheck` and `npm run example` do).
- `src/` stays runnable by Node's type stripping: erasable syntax only, `.ts` extensions on relative
  imports, `import type` for types. Unit tests import `src/` directly.
- Grammar files are read relative to the package root from `import.meta.url`, so the same code works
  from `src/` and from `dist/`.
- Offsets are JavaScript string indices (UTF-16 code units), straight from `node.startIndex`. Never
  byte offsets.
- Every `Tree` is `delete()`d after use. Parsers live for the process.
- `initialize` does no WASM work. Skipped functions never become mapper diagnostics. Verbatim spans
  carry identical text on both sides.
- First definition wins on a name clash. Only definitions export, never prototypes.
- Comments say why, not what, at the density of the existing files.
- Bump `GLUE_VERSION` in `build.ts` when the generated code changes (Task 7).
- The owner edits this checkout while work is in progress: change existing files with targeted edits,
  never by rewriting them whole, and leave unrelated changes alone.
- Work on branch `tree-sitter-parser` from `main`. Commit messages are one imperative sentence, like
  the history, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Package tests run from `packages/ts-polyglot`: one file with `node --test test/<name>.test.ts`,
  everything with `npm test` (builds `dist/` first, then unit, end-to-end and pack tests).

## Review Focus

1. **CRLF line endings.** Windows editors save them; offsets must still index the string as given.
   Task 3: `offsets are string indices with CRLF line endings`.
2. **A UTF-8 BOM at the start of the file.** Node's `readFileSync` keeps it as `﻿`. The first
   function must still be found and every offset must count it. Task 3: `a BOM doesn't hide the
   first function or shift offsets`.
3. **An empty file, or one with only comments.** The virtual TypeScript is `export {};` and nothing
   throws. Task 6: `a file without functions exports nothing`.
4. **An upper-case extension** such as `ADD.CPP`, which today's regexes accept. Task 3:
   `languageOf ignores case`.
5. **A grammar file missing from the install.** The error names the file instead of a WASM
   stack trace. Task 2: `loadGrammar rejects for a file that isn't there, naming it`.

---

### Task 1: Vendored grammars, their manifest and refresh script

**Files:**
- Modify: `packages/ts-polyglot/package.json` (`dependencies`, `files`)
- Modify: `package.json` (root; one script)
- Create: `packages/ts-polyglot/grammars/manifest.json`
- Create: `packages/ts-polyglot/grammars/tree-sitter-c.wasm`, `tree-sitter-cpp.wasm`, `tree-sitter-rust.wasm`, `LICENSE-c`, `LICENSE-cpp`, `LICENSE-rust` (downloaded by the script)
- Create: `scripts/grammars.ts`
- Test: `scripts/grammars.test.ts`, `packages/ts-polyglot/test/grammars.test.ts`

**Interfaces:**
- Produces: `grammars/manifest.json` of shape
  `Record<languageId, { repository: string; tag: string; asset: string; sha256: string }>`, keyed
  `c`, `cpp`, `rust`, with `asset` the file name under `grammars/`. Later tasks read grammar files by
  that `asset` name.
- Produces: `scripts/grammars.ts` exporting `assetUrl(entry): string`, `licenseUrl(entry): string`
  and `pin(manifest, id, tag, sha256): Manifest`; CLI `node scripts/grammars.ts check` and
  `node scripts/grammars.ts update <id> [<tag>]`.

- [ ] **Step 1: Add the dependency and ship the grammars**

In `packages/ts-polyglot/package.json`: `"dependencies": { "node-api-headers": "^1.9.0", "web-tree-sitter": "0.27.1" }` and `"files": ["dist", "src", "grammars"]`. In the root `package.json` scripts: `"grammars": "node scripts/grammars.ts"`. Run `npm install` at the root. Expected: `node_modules/web-tree-sitter/web-tree-sitter.wasm` exists and the lockfile changed.

- [ ] **Step 2: Write the failing script tests**

`scripts/grammars.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { assetUrl, licenseUrl, pin } from "./grammars.ts";

const c = { repository: "tree-sitter/tree-sitter-c", tag: "v0.24.2", asset: "tree-sitter-c.wasm", sha256: "old" };

test("release assets and licenses come from the pinned tag", () => {
  assert.equal(assetUrl(c), "https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.2/tree-sitter-c.wasm");
  assert.equal(licenseUrl(c), "https://raw.githubusercontent.com/tree-sitter/tree-sitter-c/v0.24.2/LICENSE");
});

test("pin rewrites one entry's tag and checksum and leaves the rest alone", () => {
  const manifest = { c, cpp: { ...c, repository: "tree-sitter/tree-sitter-cpp", asset: "tree-sitter-cpp.wasm" } };
  const pinned = pin(manifest, "c", "v0.24.3", "new");
  assert.deepEqual(pinned.c, { ...c, tag: "v0.24.3", sha256: "new" });
  assert.deepEqual(pinned.cpp, manifest.cpp);
  assert.deepEqual(manifest.c, c);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run from the root: `node --test scripts/grammars.test.ts`. Expected: FAIL, cannot find `./grammars.ts`.

- [ ] **Step 4: Write `scripts/grammars.ts`**

Shape it like `scripts/release.ts`: a `main(argv: string[]): number` run under `import.meta.main`, exported pure helpers, Node's global `fetch`. Types:

```ts
export interface GrammarEntry { repository: string; tag: string; asset: string; sha256: string }
export type Manifest = Record<string, GrammarEntry>;
export function assetUrl(entry: GrammarEntry): string;   // https://github.com/<repository>/releases/download/<tag>/<asset>
export function licenseUrl(entry: GrammarEntry): string; // https://raw.githubusercontent.com/<repository>/<tag>/LICENSE
export function pin(manifest: Manifest, id: string, tag: string, sha256: string): Manifest; // a new object
```

The manifest lives at `packages/ts-polyglot/grammars/manifest.json`, resolved from `import.meta.url`. Commands:
- `check`: for every entry, the file `grammars/<asset>` exists, its SHA-256 equals `sha256`, and `grammars/LICENSE-<id>` exists. Print one line per grammar; exit 1 on any mismatch.
- `update <id> [<tag>]`: download `assetUrl` (the tag given, else the manifest's) and `licenseUrl`, write `grammars/<asset>` and `grammars/LICENSE-<id>`, and write the manifest back through `pin` with the downloaded file's SHA-256, two-space indented with a trailing newline. An `id` that isn't in the manifest needs a `<repository>` as a third argument, so a future language can be added with the same command.

Start the manifest by hand with the three entries from the spec's table, `sha256` left as `""` for `update` to fill:
`c` = `tree-sitter/tree-sitter-c` `v0.24.2` `tree-sitter-c.wasm`; `cpp` = `tree-sitter/tree-sitter-cpp` `v0.23.4` `tree-sitter-cpp.wasm`; `rust` = `tree-sitter/tree-sitter-rust` `v0.24.2` `tree-sitter-rust.wasm`.

- [ ] **Step 5: Run the script tests and the root type check**

Run: `node --test scripts/grammars.test.ts` then `npx tsc -p .` at the root. Expected: both tests PASS; no type errors.

- [ ] **Step 6: Download the grammars**

Run from the root: `npm run grammars -- update c`, `npm run grammars -- update cpp`, `npm run grammars -- update rust`, then `npm run grammars -- check`. Expected: six files under `packages/ts-polyglot/grammars/` plus the manifest, `check` exits 0, and the manifest's checksums are exactly those in the spec's table:
`c` `83e8d7902b9d7f8c7c5cd4bd9acb5c7eb5faf42c09f85546b183964d3b5f48f9`,
`cpp` `174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf`,
`rust` `24c89bd9252255e4aebbcbd7d2d308bd92c86dd95a130fdc80efa49577b8d738`.
A different checksum means a different build than the one the spec measured: stop and say so.

- [ ] **Step 7: Write the failing grammar test**

`packages/ts-polyglot/test/grammars.test.ts`:

```ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { Language, Parser } from "web-tree-sitter";

const grammars = new URL("../grammars/", import.meta.url);
const manifest: Record<string, { asset: string; sha256: string }> = JSON.parse(readFileSync(new URL("manifest.json", grammars), "utf8"));

test("every pinned grammar is on disk with its checksum and license", () => {
  assert.deepEqual(Object.keys(manifest).sort(), ["c", "cpp", "rust"]);
  for (const [id, entry] of Object.entries(manifest)) {
    const bytes = readFileSync(new URL(entry.asset, grammars));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.asset);
    assert.ok(existsSync(new URL(`LICENSE-${id}`, grammars)), `LICENSE-${id}`);
  }
});

test("every pinned grammar loads in the pinned web-tree-sitter", async () => {
  await Parser.init();
  for (const entry of Object.values(manifest)) {
    const language = await Language.load(new Uint8Array(readFileSync(new URL(entry.asset, grammars))));
    assert.ok(language.abiVersion >= 13, `${entry.asset}: ABI ${language.abiVersion}`);
  }
});
```

- [ ] **Step 8: Run it**

Run from `packages/ts-polyglot`: `node --test test/grammars.test.ts`. Expected: PASS (both tests; C and Rust report ABI 15, C++ ABI 14).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json packages/ts-polyglot/package.json packages/ts-polyglot/grammars scripts/grammars.ts scripts/grammars.test.ts packages/ts-polyglot/test/grammars.test.ts
git commit -m "Vendor the C, C++ and Rust tree-sitter grammars with a checksum manifest"
```

---

### Task 2: `parser.ts`, the web-tree-sitter wrapper

**Files:**
- Create: `packages/ts-polyglot/src/parser.ts`
- Test: `packages/ts-polyglot/test/parser.test.ts`

**Interfaces:**
- Consumes: `grammars/<asset>` files from Task 1.
- Produces:
  ```ts
  /** Initializes web-tree-sitter and loads grammars/<file> once; later calls resolve at once. */
  export async function loadGrammar(file: string): Promise<void>;
  /** Parses with a grammar loaded earlier. The caller must tree.delete(). Throws if the grammar isn't loaded. */
  export function parse(file: string, source: string): Tree;
  ```
  `Tree` and `Node` are web-tree-sitter's (`import type { Node, Tree } from "web-tree-sitter"`).

- [ ] **Step 1: Write the failing tests**

`test/parser.test.ts` (the first test must run before any `loadGrammar` of the C grammar; `node:test` runs a file's tests in order):

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { loadGrammar, parse } from "../src/parser.ts";

test("parse throws until the grammar is loaded, naming it", () => {
  assert.throws(() => parse("tree-sitter-c.wasm", "int x;"), /tree-sitter-c\.wasm/);
});

test("loadGrammar rejects for a file that isn't there, naming it", async () => {
  await assert.rejects(loadGrammar("tree-sitter-missing.wasm"), /tree-sitter-missing\.wasm/);
});

test("parses with string offsets, not byte offsets", async () => {
  await loadGrammar("tree-sitter-c.wasm");
  await loadGrammar("tree-sitter-c.wasm"); // a second load is a no-op
  const source = "// ünïcödé 😀\nint add(int a) { return a; }\n";
  const tree = parse("tree-sitter-c.wasm", source);
  try {
    assert.equal(tree.rootNode.type, "translation_unit");
    const fn = tree.rootNode.namedChildren.find((n) => n.type === "function_definition")!;
    const name = fn.childForFieldName("declarator")!.childForFieldName("declarator")!;
    assert.equal(name.text, "add");
    assert.equal(name.startIndex, source.indexOf("add"));
  } finally {
    tree.delete();
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/parser.test.ts`. Expected: FAIL, cannot find `../src/parser.ts`.

- [ ] **Step 3: Write `src/parser.ts`**

`Parser.init()` once (keep the promise, not a flag, so concurrent first calls share it). Per `file`: read `new URL(file, new URL("../grammars/", import.meta.url))`, `Language.load(bytes)`, one `new Parser()` with `setLanguage`, kept in a `Map<string, Parser>`; keep the loading promise in the map's companion so a second `loadGrammar` during the first awaits the same load. A missing file surfaces as `Error("ts-polyglot: can't read the grammar <file>: <cause>")`. `parse` throws `Error("ts-polyglot: the grammar <file> isn't loaded")` when the map has no parser, and throws if web-tree-sitter returns `null`. Comment why loading is separate from parsing: the hook's resolve is synchronous.

- [ ] **Step 4: Run the tests**

Run: `node --test test/parser.test.ts`. Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/parser.ts packages/ts-polyglot/test/parser.test.ts
git commit -m "Add the web-tree-sitter wrapper that loads vendored grammars"
```

---

### Task 3: Language interface, registry, and the C walker

**Files:**
- Modify: `packages/ts-polyglot/src/signatures.ts` (export the `Kind` constants, `C_TYPES`, `RUST_TYPES` and `oneLine`; add `callee` to `NativeFunction` and set it to `name` in `cHeader` and `rustHeader`; the old parser otherwise stays until Task 6)
- Create: `packages/ts-polyglot/src/languages/language.ts`, `index.ts`, `c-family.ts`, `c.ts`, `cpp.ts`
- Test: `packages/ts-polyglot/test/c.test.ts`

**Interfaces:**
- Consumes: `loadGrammar`, `parse` from Task 2.
- Produces, in `signatures.ts`:
  ```ts
  export interface NativeFunction { name: string; nameStart: number; callee: string; params: Param[]; returnType: string; returns: Kind; signature: string }
  export const oneLine: (text: string) => string;   // whitespace collapsed to single spaces, trimmed
  ```
  `callee` is what the glue calls: `geo::area`, `inner::nested`, else the name.
- Produces, in `languages/language.ts`:
  ```ts
  import type { Node } from "web-tree-sitter";
  export type Language = "c" | "cpp" | "rust";
  export interface LanguageModule {
    id: Language;
    extensions: readonly string[];   // lower-case, with the dot
    grammar: string;                 // a file name under grammars/, equal to the manifest's asset
    functions(root: Node, source: string): NativeFunction[];   // exportable functions, in source order, duplicates included
  }
  ```
- Produces, in `languages/index.ts`:
  ```ts
  export type { Language, LanguageModule } from "./language.ts";
  export const languages: readonly LanguageModule[];           // [c, cpp, rust]
  export function languageOf(fileName: string): Language | undefined;   // by extension, case-insensitive
  export async function loadLanguage(language: Language): Promise<void>;
  export function findFunctions(source: string, language: Language): NativeFunction[];   // parses, walks, deletes the tree; keeps the first of same-named functions
  ```
- Produces, in `languages/c-family.ts`: `export function cFamilyFunctions(root: Node, source: string): NativeFunction[]` (imports `C_TYPES` and `oneLine` from `../signatures.ts` until Task 6 moves the table here).
- Produces: `languages/c.ts` exporting `c: LanguageModule` (`id: "c"`, `extensions: [".c"]`, `grammar: "tree-sitter-c.wasm"`) and `languages/cpp.ts` exporting `cpp` (`id: "cpp"`, `extensions: [".cpp", ".cc", ".cxx"]`, `grammar: "tree-sitter-cpp.wasm"`), both with `functions: cFamilyFunctions`.

- [ ] **Step 1: Write the failing tests**

`test/c.test.ts`, with `before(() => loadLanguage("c"))` and a helper `const find = (source: string) => findFunctions(source, "c")`:

```ts
test("languageOf ignores case and knows the three languages", () => {
  assert.equal(languageOf("ADD.CPP"), "cpp");
  assert.equal(languageOf("x.cc"), "cpp");
  assert.equal(languageOf("x.c"), "c");
  assert.equal(languageOf("x.rs"), "rust");
  assert.equal(languageOf("x.h"), undefined);
});

test("a definition with names, offsets, spellings and the header as written", () => {
  const source = "int add(int a, int b) {\n  return a + b;\n}\n";
  const [fn] = find(source);
  assert.equal(fn?.name, "add");
  assert.equal(fn?.callee, "add");
  assert.equal(fn?.nameStart, source.indexOf("add"));
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart, p.type]), [["a", source.indexOf("a,"), "int"], ["b", source.indexOf("b)"), "int"]]);
  assert.equal(fn?.returnType, "int");
  assert.equal(fn?.returns.ts, "number");
  assert.equal(fn?.signature, "int add(int a, int b)");
});

test("static, static inline and main are skipped", () => {
  assert.deepEqual(find("static int hidden(int a) { return a; }\nstatic inline int also(int a) { return a; }\nint main(void) { return 0; }"), []);
});

test("unnamed parameters are arg<i> without an offset, and (void) is no parameters", () => {
  const [f, g] = find("int f(int, double) { return 0; }\nint g(void) { return 0; }");
  assert.deepEqual(f?.params.map((p) => [p.name, p.nameStart]), [["arg0", undefined], ["arg1", undefined]]);
  assert.deepEqual(g?.params, []);
});

test("const and volatile qualifiers are dropped from a type", () => {
  const [fn] = find("int f(const int a, int const b, volatile int c) { return 0; }");
  assert.deepEqual(fn?.params.map((p) => p.type), ["int", "int", "int"]);
});

test("pointers, arrays, function pointers and variadics skip the function", () => {
  assert.deepEqual(find("int f(const char *s) { return 0; }\nint g(int a[]) { return 0; }\nint h(int (*cb)(int)) { return 0; }\nint v(int a, ...) { return 0; }\nint *p(int a) { return 0; }"), []);
});

test("an unknown type skips the function", () => {
  assert.deepEqual(find("size_t f(int a) { return 0; }\nint g(size_t a) { return 0; }"), []);
});

test("prototypes without a body are not exported", () => {
  assert.deepEqual(find("int declared(int a);\nint defined(int a) { return a; }").map((f) => f.name), ["defined"]);
});

test("every branch of a preprocessor conditional is walked and the first definition wins", () => {
  const source = "#ifdef _WIN32\nint f(int a) { return 1; }\n#else\nint f(int a) { return 2; }\nint g(int a) { return a; }\n#endif\n";
  const found = find(source);
  assert.deepEqual(found.map((f) => f.name), ["f", "g"]);
  assert.equal(found[0]?.nameStart, source.indexOf("f(int"));
});

test("__declspec and a calling convention don't hide a function", () => {
  assert.deepEqual(find("__declspec(dllexport) int __cdecl win(int a) { return a; }").map((f) => f.name), ["win"]);
});

test("sized types keep today's spellings", () => {
  const [fn] = find("unsigned   int f(long long x, unsigned short y) { return 0; }");
  assert.equal(fn?.returnType, "unsigned int");
  assert.deepEqual(fn?.params.map((p) => p.type), ["long long", "unsigned short"]);
});

test("a half-typed file keeps the functions before the break", () => {
  assert.deepEqual(find("int ok(int a) { return a; }\nint partial(int a,").map((f) => f.name), ["ok"]);
});

test("an error inside a body doesn't hide the function", () => {
  assert.deepEqual(find("int broken(int a) { return a + ; }\nint after(int a) { return a; }").map((f) => f.name), ["broken", "after"]);
});

test("offsets are string indices after non-ASCII text", () => {
  const source = "// ünïcödé 😀\nint add(int a) { return a; }\n";
  const [fn] = find(source);
  assert.equal(fn?.nameStart, source.indexOf("add"));
  assert.equal(fn?.params[0]?.nameStart, source.indexOf("a)"));
});

test("offsets are string indices with CRLF line endings", () => {
  const source = "// first\r\n// second\r\nint add(int a,\r\n        int b) { return a + b; }\r\n";
  const [fn] = find(source);
  assert.equal(fn?.nameStart, source.indexOf("add"));
  assert.equal(fn?.params[1]?.nameStart, source.indexOf("b)"));
  assert.equal(fn?.signature, "int add(int a, int b)");
});

test("a BOM doesn't hide the first function or shift offsets", () => {
  const source = "﻿int add(int a) { return a; }\n";
  const [fn] = find(source);
  assert.equal(fn?.name, "add");
  assert.equal(fn?.nameStart, source.indexOf("add"));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/c.test.ts`. Expected: FAIL, cannot find `../src/languages/index.ts`.

- [ ] **Step 3: Extend `signatures.ts`**

Export `I32`, `U32`, `I64`, `F64`, `BOOL`, `VOID`, `C_TYPES`, `RUST_TYPES` and `oneLine`. Add `callee: string` to `NativeFunction`, and `callee: name` to the objects `cHeader` and `rustHeader` return. Nothing else in the old parser changes.

- [ ] **Step 4: Write `languages/language.ts`, `c.ts`, `cpp.ts` and `index.ts`**

As in Interfaces. `languageOf` lower-cases the extension (everything from the last `.`) and finds the module whose `extensions` include it. `loadLanguage` is `loadGrammar(module.grammar)`. `findFunctions` is `parse(module.grammar, source)`, `module.functions(tree.rootNode, source)` in a `try` with `tree.delete()` in `finally`, then the first-wins filter by `name`.

- [ ] **Step 5: Write `languages/c-family.ts`**

`cFamilyFunctions` is a recursive visit over `root` following the spec's "The C and C++ walker": containers (`translation_unit`, `declaration_list`, the five `preproc_*` kinds, and in Task 4 `linkage_specification` and `namespace_definition`) descend; `function_definition` is examined; everything else is skipped. Decisions the spec leaves open:
- `signature` is `oneLine(source.slice(typeNode.startIndex, functionDeclarator.endIndex))`: from the return type through the parameter list and whatever the grammar attaches to the declarator (`noexcept`, a trailing return type).
- `returnType` and a parameter's `type` are `oneLine(typeNode.text)` looked up in `C_TYPES`.
- A function is skipped when its declarator subtree `hasError`; a body error doesn't matter.
- Parameter names and `nameStart` come from the `identifier` declarator node; an unnamed parameter is `arg<i>` with no `nameStart`.
- `callee` is the name for now; Task 4 prefixes namespaces.
- If the BOM test fails because the grammar can't recover from `﻿`, replace a leading BOM with a space before parsing: same length, so offsets stay honest. Comment why.

- [ ] **Step 6: Run the tests**

Run: `node --test test/c.test.ts` then `node --test test/signatures.test.ts` (the old parser still passes) and `npx tsc -p .` in `packages/ts-polyglot`. Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ts-polyglot/src/signatures.ts packages/ts-polyglot/src/languages packages/ts-polyglot/test/c.test.ts
git commit -m "Add the language registry and a tree-sitter walker for C"
```

---

### Task 4: C++ constructs in the shared walker

**Files:**
- Modify: `packages/ts-polyglot/src/languages/c-family.ts`
- Test: `packages/ts-polyglot/test/cpp.test.ts`

**Interfaces:**
- Consumes: `cFamilyFunctions`, `findFunctions`, `loadLanguage` from Task 3.
- Produces: `callee` with the `::`-joined namespace path; no new exports.

- [ ] **Step 1: Write the failing tests**

`test/cpp.test.ts`, with `before(() => loadLanguage("cpp"))` and `const find = (source: string) => findFunctions(source, "cpp")`:

```ts
test("extern \"C\" in both forms", () => {
  const found = find('extern "C" int one(int a) { return a; }\nextern "C" {\n  int two(int a) { return a; }\n}\n');
  assert.deepEqual(found.map((f) => [f.name, f.callee, f.signature]), [["one", "one", "int one(int a)"], ["two", "two", "int two(int a)"]]);
});

test("functions in namespaces export their unqualified name with a qualified callee", () => {
  const found = find("namespace geo { namespace shapes { double area(double r) { return r; } } }\nnamespace a::b { int f(int x) { return x; } }\n");
  assert.deepEqual(found.map((f) => [f.name, f.callee, f.signature]), [["area", "geo::shapes::area", "double area(double r)"], ["f", "a::b::f", "int f(int x)"]]);
});

test("anonymous namespaces and out-of-line qualified definitions are skipped", () => {
  assert.deepEqual(find("namespace { int hidden(int a) { return a; } }\nnamespace geo { int f(int); }\nint geo::f(int a) { return a; }\n"), []);
});

test("templates are skipped and only the first overload is kept", () => {
  const found = find("template <typename T> T twice(T x) { return x + x; }\nint over(int a) { return a; }\nint over(int a, int b) { return a + b; }\n");
  assert.deepEqual(found.map((f) => [f.name, f.params.length]), [["over", 1]]);
});

test("attributes, constexpr, noexcept and a trailing return type don't hide a function", () => {
  const [f, g] = find("[[nodiscard]] constexpr int f(int a) noexcept { return a; }\nauto g(int a) -> int { return a; }\n");
  assert.equal(f?.returnType, "int");
  assert.equal(f?.signature, "int f(int a) noexcept");
  assert.equal(g?.returnType, "int");
  assert.equal(g?.signature, "auto g(int a) -> int");
});

test("auto without a trailing return type is skipped", () => {
  assert.deepEqual(find("auto f(int a) { return a; }"), []);
});

test("a default argument is a required parameter for now", () => {
  const [fn] = find("int f(int a, int b = 2) { return a + b; }");
  assert.deepEqual(fn?.params.map((p) => [p.name, p.type]), [["a", "int"], ["b", "int"]]);
});

test("references skip the function", () => {
  assert.deepEqual(find("#include <string>\nint f(const std::string& s) { return 0; }\nint g(int& r) { return r; }"), []);
});

test("a class method is not a function, its neighbor is", () => {
  assert.deepEqual(find("struct S { int m(int a) { return a; } };\nint free_fn(int a) { return a; }\n").map((f) => f.name), ["free_fn"]);
});

test("a half-typed C++ file keeps the functions before the break", () => {
  assert.deepEqual(find("namespace n { int ok(int a) { return a; } }\nint partial(int a,").map((f) => f.callee), ["n::ok"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/cpp.test.ts`. Expected: the namespace, `extern "C"` block and trailing-return tests FAIL; the skip tests may already pass.

- [ ] **Step 3: Extend `c-family.ts`**

Per the spec's walker rules: descend into `linkage_specification` (its `body` is a `declaration_list`, a `function_definition` or a `declaration`: visit it whatever it is) and into a `namespace_definition` that has a `name` (push `oneLine(name.text)` onto the namespace path; a `nested_namespace_specifier` text is already `a::b`); skip a `namespace_definition` without a name and every `template_declaration`. The declarator must be a plain `identifier` (a `qualified_identifier`, `operator_name`, `destructor_name` or `field_identifier` skips). When the `type` field is a `placeholder_type_specifier` and the `function_declarator` has a `trailing_return_type`, the return type is `oneLine(trailing.namedChildren[0].text)` (its `type_descriptor`); a placeholder without one skips. `optional_parameter_declaration` is a parameter like `parameter_declaration`; `variadic_parameter_declaration` skips. `callee` = `[...namespaces, name].join("::")`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/cpp.test.ts test/c.test.ts`. Expected: PASS, all tests in both files.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/languages/c-family.ts packages/ts-polyglot/test/cpp.test.ts
git commit -m "Walk extern \"C\" blocks, namespaces and C++ declarator forms"
```

---

### Task 5: The Rust walker

**Files:**
- Create: `packages/ts-polyglot/src/languages/rust/index.ts`
- Modify: `packages/ts-polyglot/src/languages/index.ts` (register `rust`)
- Test: `packages/ts-polyglot/test/rust.test.ts`

**Interfaces:**
- Consumes: `LanguageModule`, `RUST_TYPES` and `oneLine` (from `../../signatures.ts` until Task 6).
- Produces: `rust: LanguageModule` (`id: "rust"`, `extensions: [".rs"]`, `grammar: "tree-sitter-rust.wasm"`) and `rustFunctions(root: Node, source: string): NativeFunction[]`. `callee` is the `::`-joined module path plus the name, which the wrapper calls as `user::<callee>`.

- [ ] **Step 1: Write the failing tests**

`test/rust.test.ts`, with `before(() => loadLanguage("rust"))` and `const find = (source: string) => findFunctions(source, "rust")`:

```ts
test("a pub fn with names, offsets, spellings and the header as written", () => {
  const source = "pub fn fib(n: u32) -> i64 {\n    0\n}\n";
  const [fn] = find(source);
  assert.equal(fn?.name, "fib");
  assert.equal(fn?.callee, "fib");
  assert.equal(fn?.nameStart, source.indexOf("fib"));
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart, p.type]), [["n", source.indexOf("n:"), "u32"]]);
  assert.equal(fn?.returnType, "i64");
  assert.equal(fn?.signature, "pub fn fib(n: u32) -> i64");
});

test("no return type is ()", () => {
  const [fn] = find("pub fn ping(x: i32) {}");
  assert.equal(fn?.returnType, "()");
  assert.equal(fn?.returns.ts, "void");
});

test("private and pub(crate) functions stay private", () => {
  assert.deepEqual(find("fn a(x: i32) -> i32 { x }\npub(crate) fn b(x: i32) -> i32 { x }"), []);
});

test("extern and const are fine; unsafe and async are skipped", () => {
  const found = find('#[no_mangle]\npub extern "C" fn e(n: u32) -> u32 { n }\npub const fn c(n: u32) -> u32 { n }\npub unsafe fn u(n: u32) -> u32 { n }\npub async fn a(n: u32) -> u32 { n }\n');
  assert.deepEqual(found.map((f) => f.name), ["e", "c"]);
  assert.equal(found[0]?.signature, 'pub extern "C" fn e(n: u32) -> u32');
});

test("generics, where clauses, self and non-identifier patterns are skipped", () => {
  assert.deepEqual(find("pub fn g<T>(x: T) -> i32 { 0 }\npub fn w(x: i32) -> i32 where i32: Copy { x }\npub fn t((a, b): (i32, i32)) -> i32 { a }\nstruct S;\nimpl S { pub fn m(&self) -> i32 { 0 } }\n"), []);
});

test("a mut parameter keeps its name and offset", () => {
  const source = "pub fn m(mut x: i32) -> i32 { x }";
  const [fn] = find(source);
  assert.deepEqual(fn?.params.map((p) => [p.name, p.nameStart]), [["x", source.indexOf("x: i32")]]);
});

test("pub mod nesting gives a module path callee; a private mod hides its functions", () => {
  const found = find("pub mod outer { pub mod inner { pub fn deep(x: i32) -> i32 { x } } }\nmod hidden { pub fn h(x: i32) -> i32 { x } }\npub(crate) mod seen { pub fn s(x: i32) -> i32 { x } }\n");
  assert.deepEqual(found.map((f) => [f.name, f.callee]), [["deep", "outer::inner::deep"], ["s", "seen::s"]]);
});

test("unknown types skip the function", () => {
  assert.deepEqual(find("pub fn s(x: &str) -> i32 { 0 }\npub fn v(x: Vec<u8>) -> i32 { 0 }\npub fn r(x: i32) -> String { String::new() }"), []);
});

test("a half-typed file keeps the functions before the break", () => {
  assert.deepEqual(find("pub fn ok(x: i32) -> i32 { x }\npub fn half(a: i32,").map((f) => f.name), ["ok"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/rust.test.ts`. Expected: FAIL, `findFunctions` has no module for `rust` (or cannot find `rust/index.ts`).

- [ ] **Step 3: Write `languages/rust/index.ts` and register it**

`rustFunctions` follows the spec's "The Rust walker": visit `source_file` and the `body` of a `mod_item` that has a `visibility_modifier` and an inline body, pushing the module name; examine `function_item`; skip everything else. Decisions the spec leaves open:
- `signature` is `oneLine(source.slice(item.startIndex, body.startIndex))`: from `pub` to just before the `{`.
- `function_modifiers` is checked by its children's `type`: `extern_modifier` and `const` pass, `async` and `unsafe` skip.
- The parameter name is the `pattern` field's `identifier` (a `mutable_specifier` sibling is ignored); any other pattern kind skips the function.
- A function is skipped when its `name`, `parameters` or `return_type` node `hasError`; a body error doesn't matter.
- `callee` = `[...modules, name].join("::")`.

Add `rust` to `languages` in `languages/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/rust.test.ts test/c.test.ts test/cpp.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/languages packages/ts-polyglot/test/rust.test.ts
git commit -m "Add the tree-sitter walker for Rust"
```

---

### Task 6: Cut over: the mapper, the hook and the callers use the registry

**Files:**
- Modify: `packages/ts-polyglot/src/signatures.ts` (delete the old parser; keep the shapes)
- Modify: `packages/ts-polyglot/src/languages/c-family.ts` (now owns `C_TYPES`), `packages/ts-polyglot/src/languages/rust/index.ts` (now owns `RUST_TYPES`)
- Modify: `packages/ts-polyglot/src/declarations.ts`, `build.ts`, `register.ts`, `mapper.ts`
- Modify: `packages/ts-polyglot/test/signatures.test.ts`
- Test: `packages/ts-polyglot/test/declarations.test.ts`

**Interfaces:**
- Consumes: `languages`, `languageOf`, `loadLanguage`, `findFunctions` from `./languages/index.ts`.
- Produces: `signatures.ts` exports only `Kind`, the six `Kind` constants, `Param`, `NativeFunction`, `oneLine`. `declarations.ts` keeps `toDeclarations(fileName, source): TransformResult`, synchronous; its caller must have awaited `loadLanguage` first.

- [ ] **Step 1: Write the failing test**

`test/declarations.test.ts`, with `before(() => Promise.all(languages.map((language) => loadLanguage(language.id))))` (the empty-file case parses `.c`):

```ts
import { SpanMapKind } from "../src/protocol.ts";
import { toDeclarations } from "../src/declarations.ts";

function checkVerbatim(fileName: string, source: string) {
  const { text, mappings = [] } = toDeclarations(fileName, source);
  assert.ok(mappings.length > 0, "no mappings");
  for (const [vStart, vLength, oStart, oLength, kind] of mappings) {
    assert.equal(kind, SpanMapKind.Verbatim);
    assert.equal(vLength, oLength);
    assert.equal(text.slice(vStart, vStart + vLength), source.slice(oStart, oStart + oLength));
  }
  return text;
}

test("the declaration text for a C++ function", () => {
  const text = checkVerbatim("add.cpp", "int add(int a, int b) {\n  return a + b;\n}\n");
  assert.equal(text, "/** `int add(int a, int b)` from add.cpp, run through a Node-API addon. */\nexport declare function add(a: number, b: number): number;\n");
});

test("verbatim spans hold for namespaced C++ and nested Rust", () => {
  checkVerbatim("geo.cpp", "// ünïcödé\nnamespace geo {\n  double area(double r, int sides = 4) noexcept { return r * sides; }\n}\n");
  checkVerbatim("m.rs", "pub mod inner {\n    pub fn nested(mut x: i32) -> i32 { x }\n}\n");
});

test("a file without functions exports nothing", () => {
  assert.equal(toDeclarations("empty.c", "").text, "export {};\n");
  assert.equal(toDeclarations("comments.rs", "// nothing here\n/* or here */\n").text, "export {};\n");
  assert.deepEqual(toDeclarations("empty.c", "").mappings, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/declarations.test.ts`. Expected: FAIL, `declarations.ts` still imports the old `findFunctions` (synchronous regex parser), so the namespaced function produces no mappings.

- [ ] **Step 3: Move the tables and delete the old parser**

Move `C_TYPES` with its `long` comment into `c-family.ts` and `RUST_TYPES` into `rust/index.ts`. Delete from `signatures.ts`: `Language`, `languageOf`, `findFunctions`, `blankNonCode`, the noise and header regexes, `normalizeC`, `cHeader`, `cParams`, `rustHeader`. Rewrite its header comment: the shared shapes the languages produce and the glue consumes. `languages/language.ts` keeps `Language`.

- [ ] **Step 4: Switch the callers**

- `declarations.ts` and `build.ts` import `findFunctions` and `languageOf` from `./languages/index.ts` (`build.ts` also `type Language` if it names the type).
- `mapper.ts`: `transform` becomes `async ({ fileName, content }) => { const language = languageOf(fileName); if (language) await loadLanguage(language); return toDeclarations(fileName, content); }`. `respond` awaits the handler (`Promise.resolve().then(() => handler(params))`); a rejection, such as a grammar that fails to load, becomes the same `-32603` error response a thrown error does today; header and body are written as one `Buffer.concat` so two in-flight transforms can't interleave on stdout. `initialize` stays synchronous. Update the file's header comment: `transform` is the only async method, because the grammar loads lazily.
- `register.ts`: before `registerHooks`, `await Promise.all(languages.map((language) => loadLanguage(language.id)));` with a comment: the synchronous hook API can't await, `--import` waits for this module, and preloading measured cheaper than async hooks on a worker thread (25 ms for the three grammars; 84 to 113 ms and 0.6 ms per import for the worker).

- [ ] **Step 5: Update `signatures.test.ts`**

Import `findFunctions` and `loadLanguage` from `../src/languages/index.ts`; add `before(() => loadLanguage("c"))`. Assertions unchanged.

- [ ] **Step 6: Run everything**

Run from `packages/ts-polyglot`: `npm test`. Expected: build succeeds; all unit files PASS (`grammars`, `parser`, `c`, `cpp`, `rust`, `signatures`, `declarations`, `compiler`, `toolchain`); `e2e.test.ts` and `pack.test.ts` PASS unchanged. Then from the root: `npm run typecheck`. Expected: no errors, including `tsc --runExternalCode` over the example.

- [ ] **Step 7: Commit**

```bash
git add packages/ts-polyglot/src packages/ts-polyglot/test/signatures.test.ts packages/ts-polyglot/test/declarations.test.ts
git commit -m "Parse native files with tree-sitter in the mapper and the runtime hook"
```

---

### Task 7: Qualified callees in the glue, proven end to end

**Files:**
- Modify: `packages/ts-polyglot/src/build.ts` (`GLUE_VERSION`, the two callee sites)
- Modify: `packages/ts-polyglot/test/fixtures/project/add.cpp`, `numbers.rs`, `main.ts`
- Modify: `packages/ts-polyglot/test/e2e.test.ts`, `packages/ts-polyglot/test/pack.test.ts`

**Interfaces:**
- Consumes: `NativeFunction.callee` from Task 3.
- Produces: the generated C/C++ glue calls `fn.callee`; the Rust wrapper calls `user::<callee>`; exports and wrapper symbols keep using `fn.name`.

- [ ] **Step 1: Extend the fixture and the failing assertions**

Append to `test/fixtures/project/add.cpp`:

```cpp
// Inside a namespace: exported as `scale`, called as `geometry::scale` by the glue.
namespace geometry {
    int scale(int a, int factor) {
        return a * factor;
    }
}
```

Append to `test/fixtures/project/numbers.rs`:

```rust
// Inside a `pub mod`: exported as `clamp`, called as `user::stats::clamp` by the wrapper.
pub mod stats {
    pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 {
        x.max(lo).min(hi)
    }
}
```

In `main.ts`, import `scale` from `./add.cpp` and `clamp` from `./numbers.rs` and add `scale: scale(3, 4), clamp: clamp(15, 0, 10)` to the printed object. In `e2e.test.ts` ("C, C++ and Rust functions run") and `pack.test.ts` ("… run from the installed tarball") add `assert.equal(output.scale, 12); assert.equal(output.clamp, 10);`.

- [ ] **Step 2: Run the end-to-end test to verify it fails**

Run: `npm test` from `packages/ts-polyglot`. Expected: the addon build for the fixture fails (the glue calls `scale`, which isn't in the global namespace; the Rust wrapper calls `user::clamp`), so "C, C++ and Rust functions run" FAILS.

- [ ] **Step 3: Use `callee` in the glue**

In `build.ts`: the C/C++ `glueSource` call passes `(fn) => fn.callee`; `rustWrapper` calls `user::${fn.callee}`; `GLUE_VERSION` becomes `5`. The export name, the `ts_polyglot__js_<name>` and `ts_polyglot__<name>` symbols keep `fn.name`.

- [ ] **Step 4: Run everything**

Run: `npm test` from `packages/ts-polyglot`. Expected: PASS, including the two new assertions in `e2e` and `pack`.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-polyglot/src/build.ts packages/ts-polyglot/test
git commit -m "Call namespaced and module functions by their qualified name"
```

---

### Task 8: Move the Rust build code next to the Rust parser

**Files:**
- Create: `packages/ts-polyglot/src/languages/rust/build.ts`
- Modify: `packages/ts-polyglot/src/build.ts`, `packages/ts-polyglot/src/toolchain.ts`
- Modify: `packages/ts-polyglot/test/toolchain.test.ts` (imports only)

**Interfaces:**
- Produces, in `languages/rust/build.ts`:
  ```ts
  export function rustStaticLib(file: string, functions: NativeFunction[], dir: string, libName: string, debug: boolean): string[];
  export function rustWrapper(fn: NativeFunction): string;
  export function rustPrototype(fn: NativeFunction): string;
  export function rustTargetArgs(platform: NodeJS.Platform, arch: string): string[];
  export function rustStaticLibName(compiler: Compiler): string;
  ```
  Bodies move unchanged from `build.ts` and `toolchain.ts`; `debug` becomes a parameter because it was a module constant of `build.ts`.

- [ ] **Step 1: Move the code**

Create `rust/build.ts` with the five functions and their comments (`run` comes from `../../toolchain.ts`, `Compiler` from `../../compiler.ts`). `build.ts` imports the three it uses and passes `debug`; `toolchain.ts` loses `rustTargetArgs` and `rustStaticLibName`. In `toolchain.test.ts`, import those two from `../src/languages/rust/build.ts`.

- [ ] **Step 2: Run everything**

Run: `npm test` from `packages/ts-polyglot`, then `npx tsc -p .` there. Expected: PASS, no type errors. The addon cache key is unchanged by a move, so no `GLUE_VERSION` bump.

- [ ] **Step 3: Commit**

```bash
git add packages/ts-polyglot/src packages/ts-polyglot/test/toolchain.test.ts
git commit -m "Keep the Rust build recipe with the Rust language module"
```

---

### Task 9: Example, docs and changelog

**Files:**
- Modify: `examples/native-demo/add.cpp`, `numbers.rs`, `main.ts`
- Modify: `CLAUDE.md`, `docs/content-mappers.md`, `README.md`, `packages/ts-polyglot/README.md`, `CHANGELOG.md`

- [ ] **Step 1: Extend the example**

Append to `examples/native-demo/add.cpp` a `namespace math { int square(int a) { return a * a; } }` with a one-line comment that namespaced functions export under their own name; to `numbers.rs` a `pub mod stats { pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 { x.max(lo).min(hi) } }` with a comment that `pub fn`s inside a `pub mod` export too. In `main.ts` add `square` and `clamp` to the imports and two `console.log` lines after the Rust ones, aligned like the existing ones: `C++   math::square(12)             =` and `Rust  stats::clamp(15, 0, 10)       =`. Leave the existing lines untouched: `scripts/lsp-probe.cjs` finds its positions by their text.

- [ ] **Step 2: Run the example, the type check and the probe**

Run from the root: `npm run example` (expected: the two new lines print `144` and `10`), `npm run typecheck` (expected: clean), `node scripts/lsp-probe.cjs` (expected: hover, definition, references and rename results as before, and `add.cpp diagnostics : none`).

- [ ] **Step 3: Update the docs**

- `CLAUDE.md`: in the Layout table, replace the `signatures.ts` row with rows for `src/signatures.ts` (the shared shapes), `src/languages/` (one module per language behind `LanguageModule`; the registry; C and C++ share `c-family.ts`; Rust's parser and build recipe under `rust/`), `src/parser.ts` (web-tree-sitter, loads `grammars/`), and `grammars/` (vendored `.wasm`, `manifest.json`, licenses; `npm run grammars -- update <id> [tag]` and `check`). Change the `register.ts` row to say it preloads every grammar before installing the synchronous resolve hook. In Environment, add that `web-tree-sitter` is pinned exactly and bumped together with the grammars, with `test/grammars.test.ts` as the check. In Conventions, add "Adding a language": a grammar entry and `update`, a module under `src/languages/` registered in `index.ts`, a test file, and a note that the build half is still shared `build.ts`. In Open work: item 1 loses the parser tests it now has; item 6 becomes the remaining limits (a macro before the return type hides a function; both branches of `#ifdef` are taken; included headers aren't in the cache key).
- `docs/content-mappers.md`: in the `openProject` bullet, add that the beta sends `configFileName` and not the extension list (**measured**).
- `README.md` Status: say functions are found with tree-sitter, including inside `extern "C" { }` blocks and namespaces.
- `packages/ts-polyglot/README.md`: "How it works" links `src/languages/` instead of `src/signatures.ts`; the "What it exports" table says C/C++ functions may sit in `extern "C"` blocks and named namespaces and may carry attributes, `noexcept`, trailing return types and default arguments, and Rust `pub fn`s may sit in `pub mod`s; the "Everything else is skipped" sentence drops `namespaces` and `extern "C" { }` blocks; Limits gains the macro-before-return-type limitation.
- `CHANGELOG.md`: under `## ts-polyglot`, a new `### 0.3.0 (unreleased)` above 0.2.0 with entries for tree-sitter parsing (what is now found, what still isn't), the `grammars/` directory and its size, and the unchanged runtime API; under `## create-ts-polyglot`, `### 0.3.0 (unreleased)` with "The template asks for ts-polyglot 0.3.0" (the release script bumps it).

- [ ] **Step 4: Run the full suite one last time, and measure the budgets**

Run from the root: `npm test` (expected: all packages PASS, including create-ts-polyglot's e2e, which installs the packed ts-polyglot). If Docker Desktop is running, `npm run test:linux` (expected: PASS); if it isn't, say so in the hand-off instead of claiming it.

Then the spec's budgets, from `packages/ts-polyglot`:
- `npm pack --dry-run 2>&1 | grep -E "unpacked size|package size"`. Expected: unpacked size under 6.5 MB, and `npm pack --dry-run --json | grep -c '"install"'` prints `0`.
- `node --input-type=module -e "const t0 = performance.now(); const { loadLanguage, findFunctions } = await import('./src/languages/index.ts'); await loadLanguage('cpp'); const t1 = performance.now(); const unit = (await import('node:fs')).readFileSync('test/fixtures/project/add.cpp', 'utf8'); const big = Array.from({ length: 600 }, (_, i) => unit.replaceAll('add', 'add' + i).replaceAll('multiply', 'multiply' + i).replaceAll('scale', 'scale' + i)).join('\n'); findFunctions(big, 'cpp'); const t2 = performance.now(); findFunctions(big, 'cpp'); console.log('first load', Math.round(t1 - t0), 'ms; parse', Math.round(t2 - t1), 'ms; warm parse', Math.round(performance.now() - t2), 'ms')"`. Expected: first load under 100 ms, warm parse of the 600-copy file under 50 ms. Report the numbers in the hand-off.

- [ ] **Step 5: Commit**

```bash
git add examples/native-demo CLAUDE.md docs/content-mappers.md README.md packages/ts-polyglot/README.md CHANGELOG.md
git commit -m "Show namespaced and module functions in the example and document the tree-sitter parser"
```
