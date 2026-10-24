# Changelog

A section per package. The next version's entries go under `### x.y.z (unreleased)` in both
sections; `npm run release` dates the headings, and the Release workflow makes them the GitHub
release notes ([docs/releasing.md](docs/releasing.md)).

## ts-polyglot

### 0.1.0 (2026-10-23)

First release.

- Imports top-level C, C++ and Rust functions that take and return numbers and booleans from
  `.c`, `.cpp` and `.rs` files.
- Types come from a TypeScript 7.1 beta content mapper, for `tsc --runExternalCode` and the
  TypeScript 7 editor extension. Hover, go-to-definition, references and rename reach into the
  native file.
- Functions come from a Node hook, `node --import ts-polyglot/register`. Each file is compiled into
  a Node-API addon on first import and cached by source hash. The import resolves to a generated
  module in the cache, so a JavaScript debugger leaves breakpoints in the native file to the native
  debugger.
- Compilers: MSVC on Windows x64; `cc`, gcc or clang on Linux and macOS, chosen with `CC`/`CXX` or
  the `"ts-polyglot"` field in package.json. Rust files need `rustc`. macOS support is written but
  not yet verified.

## create-ts-polyglot

### 0.1.0 (2026-10-23)

First release.

- `npm create ts-polyglot` writes a project with a C, a C++ and a Rust file imported from
  `main.ts`, the `contentMappers` entry in tsconfig.json, `typecheck` and `start` scripts, and
  optionally the VS Code settings, extension recommendations and the F5 configurations for the OS:
  TypeScript and native code debugged together (the default on Windows; written but not yet tried
  on Linux and macOS).
- Installs with the package manager that ran it, checks for the compilers and reports what's
  missing.
