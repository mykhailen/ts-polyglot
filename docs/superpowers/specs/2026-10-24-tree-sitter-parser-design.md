# Tree-sitter parser and per-language layout: design

2026-10-24. The owner wants real parsers for the native languages instead of the regex scanner in
`signatures.ts`, because more types (strings, buffers, structs) and more languages (Zig, Go, Python
were named) are coming, and every one of them is a special case for a regex. The work is split in
two. This document is **part one**: the parser becomes tree-sitter, the code is reorganized with one
module per language, and a language's grammar is loaded only when a file of that language shows up.
The set of types that cross into JavaScript, and the generated glue, stay as they are. **Part two**
(types and marshaling: `char*`, `std::string`, `&str`, `String`, buffers, `bigint`) is a separate
design that builds on this one. Items marked **[call]** are judgment calls the owner may want to
reverse; facts marked **measured** were observed on this machine on 2026-10-24 with Node 22.21.1. Revised
the same day after the builder check: the runtime hook keeps the synchronous API and preloads the
grammars, because loading them on demand measured slower in every case (see "The runtime hook").

## Where things stand

- `signatures.ts` (178 lines) blanks comments, strings and preprocessor lines, scans braces at depth
  0, and matches the text before each `{` with one regex per language. Parameters are split on `,`.
  Types are looked up by their normalized spelling in two tables, `C_TYPES` and `RUST_TYPES`, which
  map to a `Kind` (TypeScript type, C type, Rust type, the two Node-API calls).
- Anything the regexes don't expect hides the function silently, which is the right outcome but for
  the wrong reasons: `extern "C" { }` blocks, namespaces, Rust `pub mod`, attributes, `noexcept`,
  trailing return types, default arguments, and a half-typed function anywhere in the file (an
  unbalanced brace shifts the depth count for everything after it).
- Both halves share the parser: `declarations.ts` (the mapper's virtual TypeScript and the verbatim
  span mappings) and `build.ts` (the glue and the Rust wrapper crate) call `findFunctions`.
- The runtime hook, `register.ts`, uses `module.registerHooks`, the synchronous in-thread API. Its
  resolve hook calls `buildAddon` synchronously. The lab adopted it in its first commit; no reason is
  recorded.
- The mapper is one process for every project. `initialize` has a 5 s timeout; `transform` has none.
  **measured:** `openProject` carries `configFileName` and `compilerOptions`, not the extension list
  from the tsconfig's `contentMappers` entry.

## Measured

A throwaway script in the session's scratchpad, with web-tree-sitter 0.27.1 and the grammar `.wasm`
files, both from npm and from the grammars' GitHub releases:

| What | Result |
| --- | --- |
| `import("web-tree-sitter")` plus `Parser.init()` | 10 ms |
| `Language.load()` of one grammar | 2 to 3 ms each (C 626 KB, C++ 3.4 MB, Rust 1.1 MB) |
| ABI versions accepted by the 0.27.1 runtime | 14 (C++ 0.23.4) and 15 (C 0.24.2, Rust 0.24.2) both load |
| Full parse, 5400-line C++ file with 1200 functions | 12 to 25 ms; 2 to 5 ms for the example files |
| Incremental reparse after one edit | 1.5 ms |
| Resident memory with the runtime and the C++ grammar loaded | 89 MB |
| Gzipped size of the three grammars together | 470 KB (5.2 MB unpacked) |
| `node.startIndex` on a file with non-ASCII text before the function | equals the JavaScript string index, not the byte offset |
| `node --import x.mjs main.mjs` with a top-level `await` in `x.mjs` | the entry point waits for it |
| A promise returned from a `module.registerHooks` resolve hook | rejected with `ERR_INVALID_RETURN_PROPERTY_VALUE` |
| An `async resolve` under `module.register` that awaits, then redirects the import | works; runs on a worker thread |
| Process start to the entry module, median of 7, and resident memory: no hook | 30 ms, 31 MB |
| … `registerHooks`, with the runtime and all three grammars preloaded at `--import` time | 68 ms (the preload itself 25 ms), 54 MB |
| … `module.register` with a pass-through hook, nothing native imported | 84 ms, 43 MB |
| … `module.register`, one native import loading the runtime and one grammar on the hooks thread | 113 ms, 60 MB |
| 200 plain imports: no hook, `registerHooks`, `module.register` | 105 ms, 103 ms, 228 ms: about 0.6 ms per import for the worker round trip |
| Half-typed `int partial(int a,` at the end of a file | becomes one `ERROR` node; every function before it parses normally |
| `int broken(int a) { return a + ; }` | a `function_definition` whose body has the error; the signature is intact |

## Why tree-sitter, and why the WASM build

A grammar gives the structure for free: where a function starts, what its declarator is, which
parameters have defaults, what is a namespace. It keeps parsing a file that is being typed, which the
editor does on every keystroke. And every language the owner has named has a maintained grammar with
a prebuilt `.wasm` on its GitHub release page (Zig's lives at `tree-sitter-grammars/tree-sitter-zig`).
What a grammar does not do is semantics: typedefs, macros and `using namespace std` stay unresolved,
so types remain a whitelist of spellings, exactly as now.

The WASM build (`web-tree-sitter`) rather than the native `tree-sitter` npm binding: no node-gyp at
install, no Node ABI coupling, one code path on every OS in the CI matrix, and it runs wherever the
mapper runs (tsc and the editor start it with the `node` on PATH).

## Goals

1. **Same output for today's code.** Every function the regex parser finds is found, with the same
   `NativeFunction` fields: names, `nameStart` offsets, normalized type spellings, `signature`. The
   current unit, end-to-end and pack tests keep passing; only the mapper's `transform` becomes async.
2. **The grammar's understanding stops hiding functions.** Found: functions inside `extern "C"` (both
   the block and the single-declaration form), inside named namespaces, inside Rust `pub mod`
   blocks; functions with attributes, `__declspec`, calling-convention keywords, `inline`,
   `constexpr`, `noexcept`, trailing return types, default arguments; every intact function in a
   half-typed file.
3. **One module per language** behind one interface. Adding a language is a grammar file plus one
   module (plus, later, a build recipe). Nothing in the parsing half outside `languages/` names a
   language; `build.ts` keeps its Rust branch until part two defines the build half.
4. **In the mapper, grammars load on demand**, one per language, the first time a file of that
   language is transformed, so only the configured languages ever load. `initialize` does no WASM
   work. The runtime hook preloads the runtime and every grammar at `--import` time instead; "The
   runtime hook" has the measurements behind that.
5. **Grammars are vendored, pinned and checksummed**, with a script to refresh them, and licensed.
6. **Parser tests per language**, including offsets and half-typed input (open work item 1).

## Non-goals

- New types or any change to how values cross. The `Kind` tables keep their entries. Part two.
- Default arguments as optional TypeScript parameters: the glue would have to call with fewer
  arguments. Part two.
- Header files, prototypes without a body, overload dispatch, templates and generics (including
  lifetime-only generics such as `fn f<'a>(s: &'a str)`; part two decides with strings).
- Reading the tsconfig to preload grammars per project. Lazy loading already loads exactly the
  configured languages, because tsc only sends files with the configured extensions.
- Evaluating preprocessor conditions, resolving typedefs, macros or `using` declarations.
- A public plugin API, or a package per language. Whether Zig, Go and Python live in this package or
  in packages installed next to it is **deferred by the owner**; see "Deferred".
- Telling a namespace function from a class method defined out of line (`int Foo::bar()`).
- Loading grammars on demand at runtime. Measured slower and heavier than preloading in every case;
  see "The runtime hook" and "Deferred".

## Anti-goals

- A native npm dependency or an install-time compile step for users. The grammar npm packages have
  `install: node-gyp-build` and peer-depend on native `tree-sitter`, so we don't depend on them.
- Any WASM work in `initialize`, or a transform that reports "unsupported" as a mapper diagnostic.
- WASM memory growing with every transform in the long-lived mapper process.
- Breaking the debugging story in `.vscode/launch.json` without noticing.
- Behavior that differs between `src/` under type stripping and `dist/`.

## Constraints

- Everything in CLAUDE.md's Conventions: `src/` runnable by Node's type stripping, `.ts` extensions
  on relative imports, `import type`, comments say why, `GLUE_VERSION` bump when the generated code
  changes, `dist/` is what runs, `files` lists what ships, one version for both packages, CHANGELOG
  entries under `### x.y.z (unreleased)` in both package sections.
- The mapper rules: verbatim spans identical on both sides; no diagnostics for skipped functions;
  per-project state under `projectHandle` (this design needs none: grammars are per process).
- Offsets: the mapper chose the `utf-16` position encoding, so JavaScript string indices are used as
  they are. web-tree-sitter's `startIndex`/`endIndex` are those indices (**measured**), so no
  conversion is needed. Nothing may use byte offsets.
- `Tree` and `Parser` objects live on the WASM heap; `tree.delete()` after every parse.
  Parsers are kept for the life of the process, one per language.
- Node `>=22.18` (the package's `engines`); `module.registerHooks` exists since 22.15.
- `web-tree-sitter` is pinned **exactly** **[call]**, like TypeScript is: the runtime and the grammar
  binaries are ABI-coupled, so both are bumped deliberately, with the grammar test as the check.

## The pieces

### Dependencies and vendored grammars

- `packages/ts-polyglot/package.json`: `dependencies` gains `"web-tree-sitter": "0.27.1"`; `files`
  gains `grammars`.
- `packages/ts-polyglot/grammars/` holds the three `.wasm` files and a manifest with, per grammar:
  the language id, the GitHub repository, the release tag, the asset name and its SHA-256. Pinned
  now (**measured** to load):

  | File | Source | SHA-256 |
  | --- | --- | --- |
  | `tree-sitter-c.wasm` | `tree-sitter/tree-sitter-c` v0.24.2 | `83e8d7902b9d7f8c7c5cd4bd9acb5c7eb5faf42c09f85546b183964d3b5f48f9` |
  | `tree-sitter-cpp.wasm` | `tree-sitter/tree-sitter-cpp` v0.23.4 | `174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf` |
  | `tree-sitter-rust.wasm` | `tree-sitter/tree-sitter-rust` v0.24.2 | `24c89bd9252255e4aebbcbd7d2d308bd92c86dd95a130fdc80efa49577b8d738` |

- Each grammar's license (all MIT) is copied next to the binaries, the way each package carries a
  copy of the root `LICENSE`.
- A script under `scripts/` (where `release.ts` lives) downloads the assets named in the manifest,
  verifies the checksums, and with a flag fetches a new tag and rewrites the checksum. The repo
  commits the binaries, so `npm ci` and the pack test need no network beyond npm.
- Why not `@vscode/tree-sitter-wasm`: it has no C grammar and no Zig, and its grammars are built for
  the runtime version VS Code ships.

### Layout

```
packages/ts-polyglot/
  grammars/                  the .wasm files, manifest, licenses
  src/
    languages/
      language.ts            the Language interface
      index.ts               the registry: the list of languages, languageOf(), findFunctions()
      c-family.ts            the walker C and C++ share
      c.ts                   { id: "c", extensions: [".c"], grammar: "tree-sitter-c.wasm", functions }
      cpp.ts                 { id: "cpp", extensions: [".cpp", ".cc", ".cxx"], grammar: "tree-sitter-cpp.wasm", functions }
      rust/
        index.ts             the Rust language object and walker
        build.ts             the wrapper crate and static library, moved from build.ts and toolchain.ts
    parser.ts                web-tree-sitter: init once, load a grammar once, one Parser per language, parse, delete
    signatures.ts            the shared shapes: NativeFunction, Param, Kind, and the Kind constants
    register.ts              preloads the parser (top-level await), then registerHooks as today
    build.ts, compiler.ts, toolchain.ts, declarations.ts, mapper.ts, protocol.ts   as today
```

The exact file split inside `languages/` is the builder's; the principles are fixed: one module per
language, nothing language-specific outside `languages/`, the two C-family grammars share one
walker, and the Rust build code moves next to the Rust parser **[call]**. The shared glue generator
and the addon cache stay in `build.ts`; the `Kind` tables move into their language modules
(`C_TYPES` to the C family, `RUST_TYPES` to Rust) while the `Kind` type and constants stay shared
**[call]**. Part two reshapes `Kind`; moving the tables once now keeps "nothing language-specific
outside `languages/`" true.

### The language interface

```ts
export interface Language {
  id: "c" | "cpp" | "rust";          // also what cache keys and messages say
  extensions: readonly string[];     // lower-case, with the dot
  grammar: string;                   // a file name under grammars/
  /** The exportable functions in a parsed file, in source order. */
  functions(root: Node, source: string): NativeFunction[];
}
```

The registry keeps the list of languages; `languageOf(fileName)` stays synchronous and
extension-based. Loading is separate from parsing: `loadLanguage(language): Promise<void>`
initializes the runtime and loads that grammar once (the only asynchronous steps web-tree-sitter
has), and `findFunctions(source, language)` stays **synchronous**: it parses with the loaded grammar,
calls `functions`, deletes the tree and returns, or throws if the language was never loaded. The
mapper awaits `loadLanguage` in `transform`; the runtime hook awaits it for every language at
startup, so `buildAddon` and the resolve hook stay synchronous. The build half of a
language (toolchain, glue shape) is **not** part of this interface yet; part two adds it once the
marshaling design exists. `NativeFunction` gains one field:

```ts
/** What the generated glue calls: `geo::area` for a function in a namespace, `inner::nested` in a Rust mod, else the name. */
callee: string;
```

The `name` stays the unqualified identifier and is the JavaScript export. `signature` stays the
header as written, one line, unqualified. First definition wins on a name clash, as today for
overloads and duplicates.

### The C and C++ walker

Node names are from the grammars' `node-types.json` at the pinned tags; the fields named here were
checked there.

- **Descend into:** `translation_unit`; `linkage_specification` (`body` is a `declaration_list` or a
  single `function_definition`); `namespace_definition` with a `name` (the `callee` prefix is the
  name's text, so `namespace a::b` gives `a::b::f`); `declaration_list`; every branch of
  `preproc_if`, `preproc_ifdef`, `preproc_elif`, `preproc_elifdef`, `preproc_else`. An anonymous
  namespace has internal linkage: skip its subtree, like `static` **[call]**.
- **Skip subtrees:** `template_declaration`, class/struct/union bodies, `declaration` (a prototype
  without a body: as today, only definitions export), and everything else at those levels.
- **A `function_definition` exports when:** no child `storage_class_specifier` is `static` (so
  `static inline` is skipped); the name isn't `main`; the `declarator` chain is a
  `function_declarator` whose own `declarator` is a plain `identifier` (a `qualified_identifier`,
  operator or destructor name skips the function); every parameter is accepted; the return type is
  accepted.
- **Parameters** (`parameter_list` children): `parameter_declaration` with no `declarator` is
  unnamed, named `arg<i>` with no span, as today; a single unnamed `void` means no parameters.
  `optional_parameter_declaration` (a default argument) is taken as a required parameter with the
  same type **[call]** (part two may make it optional). A `declarator` that isn't a plain
  `identifier` (pointer, reference, array, function pointer) skips the function, as do
  `variadic_parameter_declaration` and C's `variadic_parameter`: part two's territory.
- **Type spelling:** the text of the `type` field with whitespace collapsed, looked up in `C_TYPES`;
  a miss skips the function. Qualifiers are separate `type_qualifier` nodes in the grammar and are
  ignored, which drops `const` as today and now also `volatile` **[call]**. `sized_type_specifier`
  text (`unsigned int`, `long long`) matches today's normalized spellings.
- **Return type:** the `type` field; when it is a `placeholder_type_specifier` (`auto`) and the
  `function_declarator` has a `trailing_return_type`, that type is used; `auto` without one, and
  `decltype`, skip the function.
- **Ignored, no longer hiding a function:** `attribute_declaration` (`[[nodiscard]]`),
  `attribute_specifier` (`__attribute__`), `ms_declspec_modifier`, `ms_call_modifier`, `inline`,
  `constexpr`, `noexcept`, `throw_specifier`, `ref_qualifier`.
- **Errors:** a `function_definition` whose `body` has an error still exports if its declarator and
  parameters parse. An `ERROR` node is never a function.
- **Preprocessor branches:** all are walked, so `#ifdef _WIN32 int f() … #else int f() … #endif`
  gives one `f`. Same as today's behavior, now by rule rather than by accident.
- **Known limitation, unchanged:** an unknown macro before the return type (`MYAPI int f(int)`)
  misparses and hides the function.

### The Rust walker

- **Descend into:** `source_file`; `mod_item` with an inline `body` and any `visibility_modifier`
  (`pub`, `pub(crate)`, `pub(super)`, …), because the wrapper crate at the root can only reach a
  module that is visible from there. The `callee` prefix is the module path, so the wrapper calls
  `user::inner::nested`. Skip `impl_item`, `trait_item`, `macro_invocation`, `mod foo;` and the rest.
- **A `function_item` exports when:** its `visibility_modifier` text is exactly `pub` (`pub(crate)`
  stays private: the author scoped it, even though our wrapper is technically in the crate
  **[call]**); `function_modifiers` contains nothing but `extern_modifier` (any ABI string) or
  `const` **[call]** (today only `extern` passes; `const fn` is callable and harmless); no
  `type_parameters` and no `where_clause`; no `self_parameter`, `variadic_parameter` or
  `attribute_item` among the parameters.
- **Parameters:** a `parameter` whose `pattern` is an `identifier`, with or without a
  `mutable_specifier`; the `type` text looked up in `RUST_TYPES`; a miss skips the function.
- **Return type:** the `return_type` field's text, `()` when absent.
- `attribute_item`s (`#[no_mangle]`, `#[cfg(...)]`) are ignored. Names and offsets come from the
  `name` identifier and the parameter `pattern` nodes.

### Loading

`parser.ts` owns web-tree-sitter: `Parser.init()` once per process, on the first `loadLanguage`; per language, read
the grammar bytes from `grammars/` (resolved relative to the package root from `import.meta.url`,
which works from `src/` and from `dist/` alike), `Language.load()`, one `Parser` with
`setLanguage()`, all cached for the process. Every parse ends with `tree.delete()`. The grammar
test (below) is what makes a web-tree-sitter bump safe.

### The mapper

`transform` becomes `async`: it awaits `loadLanguage` for the file's language, then calls the
synchronous `findFunctions`. `respond` awaits the handler and writes each response as one buffer
(header and body together) so two in-flight transforms can't interleave on stdout. `initialize`
stays synchronous and instant. A grammar that fails to load is a JSON-RPC error on that transform,
not a diagnostic. The first transform of a language pays about 15 ms (**measured**); the rest a few.

### The runtime hook

The hook stays on `module.registerHooks`, synchronous and in-thread, as today. `register.ts` gains a
top-level `await` that initializes the runtime and loads every grammar before registering the hook;
`--import` waits for it (**measured**). `buildAddon` and the resolve hook stay synchronous, and the
debugger comment in `register.ts`, the comments in `.vscode/launch.json`, the template's three
`launch.*.json` and CLAUDE.md's description of the hook all stay true.

This reverses the proposal the owner heard, which was `module.register`, async hooks on a worker
thread, so that a `.rs` import would load only the Rust grammar **[call]**. The builder check
measured both and a rerun confirmed it (table above): the worker thread costs more at startup than
preloading all three grammars does (84 ms against 68 ms before any native file is imported, 113 ms
once one is), uses more memory in that case (60 MB against 54 MB), and adds about 0.6 ms to every
import in the user's program, native or not, because each resolve round-trips to the worker. What
on-demand loading saves is the two unused grammars: about 5 ms and a few megabytes. Preloading grows
by a few milliseconds per future language; "Deferred" says what to do if that ever matters.

### Glue

The C/C++ call and the Rust wrapper's `user::` path use `callee`. Nothing else in the generated
code changes. `GLUE_VERSION` is bumped.

### Example and fixtures

The example and the e2e `project` fixture gain at least one function the old parser couldn't see: a
C++ function in a namespace, and a Rust `pub fn` in a `pub mod` **[call]** (the builder picks which;
the end-to-end test is what proves the `callee` path end to end).

## Testing, and what counts as done

- **Grammar test:** every manifest entry exists on disk, matches its checksum, loads in the pinned
  web-tree-sitter, and reports an ABI version the runtime accepts.
- **Parser tests, one file per language** (`node:test`, importing `src/`): the acceptance and skip
  rules above, each as a case; `nameStart` and parameter offsets equal to `source.indexOf(...)`,
  including a file with non-ASCII text before the function; the half-typed file keeps the functions
  before the break; `callee` for namespaces and modules; the `#ifdef` both-branches case; today's
  type-table tests (`signatures.test.ts`), made async.
- **Mapper test:** for a native file through `toDeclarations`, every verbatim mapping has identical
  text on both sides, and the declaration text is what's expected. Open work item 1's second half.
- **End-to-end and pack tests** keep passing, with the new fixture functions exercised. The pack
  test proves the grammars ship.
- `npm run typecheck`, `npm test`, `npm run example`, `node scripts/lsp-probe.cjs` and
  `npm run test:linux` pass. CI's matrix runs unchanged.
- Budget: a warm transform of the 5400-line file under 50 ms; the first transform of a language
  under 100 ms; the tarball grows by no more than 6 MB unpacked; no install scripts are added.
- Docs: CLAUDE.md's layout table (`languages/`, `grammars/`, `parser.ts`), an "adding a
  language" note in Conventions, open work item 6 rewritten (the two parser gaps closed, the macro
  limitation and the cache key remaining); `docs/content-mappers.md` gains the measured
  `openProject` payload; the READMEs say which constructs are recognized; CHANGELOG entries under the
  next minor's `(unreleased)` heading in both package sections.

## Left to the builder

- Field-based walking versus tree-sitter queries; one `Parser` per language versus one shared parser.
- The manifest's format (JSON or a TypeScript module) and the refresh script's command line.
- The exact files inside `languages/` and the test layout, within the principles above.
- Error message texts; how a missing or corrupt grammar reads to a user.
- Which new functions the example and fixtures get.

## Deferred

- **Languages in this package or in separate packages.** Owner: "we will decide later." Nothing here
  may preclude either: a language is a plain object, the registry is a list, the grammar file is per
  language. A separate package would add an object and a `.wasm`; a bundled one would add them here.
- **Part two:** the types and marshaling design: strings, buffers, structs, `bigint`; the build half
  of the language interface; default arguments as optional parameters; lifetime-only generics;
  whether `pub(crate)` should export.
- Preloading grammars per project from `configFileName`, if the first-transform cost ever matters.
- **Loading grammars on demand at runtime** with `module.register`. Measured slower and heavier than
  preloading (table above), so not now. If grammars ever grow large enough to matter: on the hooks
  thread the hook's own imports go back through the hook chain, and `Parser.init()` itself performs
  a dynamic `import()`, so a "runtime loaded?" guard placed before `nextResolve` recurses until the
  stack overflows (found by the builder check). The hook must act only after `nextResolve` has
  identified a native file. Errors thrown on the hooks thread do reach the main thread with their
  message intact.
- Incremental parsing (`parser.parse(text, oldTree)`), if transform latency ever matters.
