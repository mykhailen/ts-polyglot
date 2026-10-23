# Changelog

## ts-polyglot

### 0.1.0 (unreleased)

First release.

- Imports top-level C, C++ and Rust functions that take and return numbers and booleans from
  `.c`, `.cpp` and `.rs` files.
- Types come from a TypeScript 7.1 beta content mapper, for `tsc --runExternalCode` and the
  TypeScript 7 editor extension. Hover, go-to-definition, references and rename reach into the
  native file.
- Functions come from a Node hook, `node --import ts-polyglot/register`. Each file is compiled into
  a Node-API addon on first import and cached by source hash.
- Compilers: MSVC on Windows x64; `cc`, gcc or clang on Linux and macOS, chosen with `CC`/`CXX` or
  the `"ts-polyglot"` field in package.json. Rust files need `rustc`. macOS support is written but
  not yet verified.

## create-ts-polyglot

### 0.1.0 (unreleased)

First release.

- `npm create ts-polyglot` writes a project with a C, a C++ and a Rust file imported from
  `main.ts`, the `contentMappers` entry in tsconfig.json, `typecheck` and `start` scripts, and
  optionally the VS Code settings, extension recommendation and F5 debug configuration.
- Installs with the package manager that ran it, checks for the compilers and reports what's
  missing.
