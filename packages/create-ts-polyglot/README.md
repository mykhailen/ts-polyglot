# create-ts-polyglot

Starts a TypeScript project that imports C, C++ and Rust functions straight from their source files,
with [ts-polyglot](https://www.npmjs.com/package/ts-polyglot):

```sh
npm create ts-polyglot
```

It asks for a project directory, an editor, and whether to install, then writes:

- `main.ts`, which imports and calls `add.cpp`, `geometry.c` and `numbers.rs`;
- `package.json` with TypeScript 7.1 (beta) and ts-polyglot, `npm run typecheck`
  (`tsc --runExternalCode`) and `npm start` (`node --import ts-polyglot/register main.ts`);
- `tsconfig.json` with the `contentMappers` entry that hands `.c`, `.cpp` and `.rs` files to
  ts-polyglot;
- for VS Code: `.vscode/settings.json` (the TypeScript 7 extension on the workspace TypeScript),
  `extensions.json` (recommends **TypeScript (Native Preview)**, so VS Code offers to install it)
  and `launch.json` (F5 debugs `main.ts`);
- a README with the same instructions.

Then it installs the dependencies, checks for the compilers ts-polyglot needs, and prints what's
left. One step can't be a file: in VS Code, run **TypeScript: Select TypeScript Version…** and pick
**Use Workspace Version**, once per folder. The extension's own TypeScript is 7.0, which has no
content mappers, and VS Code only takes a workspace TypeScript when asked.

## Options

```
npm create ts-polyglot [dir] -- [--ide vscode|none] [--install|--no-install] [-y]
```

Anything given isn't asked. Without a terminal, as in CI, the directory is required and the
defaults apply: VS Code files, and an install. `-y` takes every default, including the directory
`ts-polyglot-app`. The install uses the package manager that ran `create` (npm, pnpm, yarn or bun).

## Requirements

- Node 22.18 or newer.
- A C and C++ compiler. Windows: the Visual Studio 2022 Build Tools with "Desktop development with
  C++". Linux: gcc or clang. macOS: the Xcode Command Line Tools.
- Rust (`rustc` on PATH) for `.rs` files.

The check at the end reports what's missing and where to get it; nothing blocks.
