# Content mappers: what we know

Notes from building ts-polyglot against `typescript@7.1.0-beta`, as of 2026-10-22. Facts marked
**measured** were observed on this machine. The rest comes from the spec.

## Sources

- Announcement: <https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/#content-mappers>.
  It has no API details.
- The spec is the description of [microsoft/typescript-go#4712](https://github.com/microsoft/typescript-go/pull/4712),
  amended by [microsoft/TypeScript#63936](https://github.com/microsoft/TypeScript/pull/63936). `gh` isn't
  installed; read them with `curl https://api.github.com/repos/<repo>/pulls/<n>`.
- Samples: [DanielRosenwasser/content-mapper-sample](https://github.com/DanielRosenwasser/content-mapper-sample)
  (HTML `<script>` blocks; matches the beta protocol) and [colinhacks/reylo](https://github.com/colinhacks/reylo)
  (`.sql` typed from a live database; targets nightlies).

## Wiring

1. **The project's `tsconfig.json`** has a top-level
   `"contentMappers": [{ "package": "ts-polyglot", "extensions": [".c", ".cpp", ".rs"], "options"?: {} }]`.
   Files with those extensions are included by `include` and by imports.
2. **The mapper package's `package.json`** has
   `"typescript": { "contentMapper": { "exec": ["node", "dist/mapper.js"], "compilerOptions"?: [...], "dynamicConfig"?: true } }`.
   - `package` is resolved like a dependency.
   - `exec` runs with the package directory as the working directory and can be any command.
3. **Running it:**
   - `tsc` needs `--runExternalCode`. Without it you get TS18068 plus "Cannot find module".
   - The VS Code extension passes the same thing as `initializationOptions.runExternalCode`.

## Protocol

JSON-RPC 2.0 over the mapper's stdin and stdout, with LSP-style `Content-Length` framing. TypeScript
sends every request, and the mapper only answers. The methods are `initialize`, `openProject`,
`transform` and `closeProject`. Types are in [packages/ts-polyglot/src/protocol.ts](../packages/ts-polyglot/src/protocol.ts),
and the full set is in the spec.

What the beta actually sends (**measured** with `TS_CONTENT_MAPPER_DEBUG=1`):

- **`initialize`:** `{ positionEncodings: ["utf-8", "utf-16"] }`. There's no `protocolVersion`. #63936
  removed it; Reylo still echoes it for older nightlies.
  - The mapper answers `{ positionEncoding, diagnosticSource }`.
  - ts-polyglot picks `utf-16`, so JavaScript string offsets can be used as they are.
- **Request ids** are strings: `"api1"`, `"api2"`, ...
- **`openProject`:** `projectHandle` looks like `"<package>@<version>:0"`, and `compilerOptions` arrives
  with numeric enums (for example `module: 199` for nodenext). One process serves every project that
  uses the same package and version, so any per-project state must be keyed by `projectHandle`.
- **`transform`:** `{ fileName, content, projectHandle }` → `{ text, extension, mappings?, diagnostics?, supplemental? }`.
  - `text` is the TypeScript (or JS or JSON) to check instead of the file.
  - Built-in extensions such as `.ts` and `.json` can't be registered for mapping.

### Span mappings

`[virtualStart, virtualLength, originalStart, originalLength, kind, features?]`

- **Kinds:**
  - `Verbatim` (0): the same text on both sides. TypeScript checks this and errors on a mismatch.
    Only verbatim spans can carry rename and code-fix edits back into the original file.
  - `Atom` (1): different text that stands for the original span.
  - `Alias` (2): like Atom, but diagnostics quote the original text.
- **`features`:** a bitmask choosing which editor features use the span. Omitted means all.
- **Unmapped virtual text** is generated code. Errors in it are shown with a snippet of the virtual
  text.
- **Synthesized exports:** go-to-definition on an export that has no mapping returns nothing, per
  #63936. Map it to a zero-length range at the top of the file with the Definition feature.

ts-polyglot maps each function name and parameter name verbatim. That alone gives hover,
go-to-definition, references, and rename from inside the native file (**measured** via
`scripts/lsp-probe.cjs`).

## Behavior that surprised us (**measured**)

- **Mapper `diagnostics` are parse errors.** `tsc` skips semantic checking for the whole program while
  any file has one, just as it does for a syntax error. Only return them for real errors.
- **`initialize` has a 5-second timeout.** After that you get TS18099, "could not be initialized".
  `transform` has no timeout: `tsc` waited 90 s and then succeeded, so pausing in `transform` under a
  debugger is fine.
- **Mapped files are never emitted as JavaScript.** Only `.d.ts` files are emitted, with
  `--declaration`. Running the code needs a runtime hook; ours is `register.ts`.
- **`NODE_OPTIONS` passes through `tsc.exe` to the mapper process.** That's why VS Code's
  child-process auto-attach and the JavaScript Debug Terminal can debug the mapper under `tsc`.
- **Node refuses to strip types from files under `node_modules`.** An installed copy of the package
  failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` in both the mapper and the hook, so both
  run from a JavaScript build in `dist/`. Inside this repo `.ts` would work, because npm workspaces
  link packages as junctions.
- **Static-config mappers are cached by package name and version.** When `--incremental` or
  `--build` is used, editing the mapper needs a version bump or `--force`.
- **`^7.1.0-beta` also matches nightlies (`7.1.0-dev.*`),** which is why `typescript` is pinned
  exactly.

## Editor (VS Code)

The TypeScript 7 extension (`typescriptteam.native-preview`, 1.0.1 here) behaves like this:

- **Its bundled server is 7.0.2, with no content mappers.** Use **TypeScript: Select TypeScript
  Version… → Use Workspace Version**. That option is only offered in trusted workspaces. The choice is
  stored in workspace state (`typescript.native-preview.useWorkspaceTsdk`) and makes the extension
  honor `js/ts.tsdk.path`.
- **It doesn't run in untrusted workspaces** (`untrustedWorkspaces.supported: false`).
  `js/ts.contentMappers.enabled` (default `true`) is what becomes `runExternalCode`.
- **Mapper traffic logs:** set the **TypeScript 7** output channel's log level to Trace, then restart
  the server. The level is sent once at startup as `logVerbosity`. At Trace, the mapper's JSON-RPC and
  its stderr show up there.
- **The server tells VS Code which files to sync.** It registers `didOpen` and `diagnostic` for
  `**/*.c`, `**/*.cpp` and `**/*.rs`, which covers every such file in the workspace.
- **Checked against the language server** (`scripts/lsp-probe.cjs`), all working:
  - hover on an import shows the native signature;
  - go-to-definition lands on the function name in the native file;
  - find-references includes the native definition;
  - renaming inside the `.cpp` renames its TypeScript uses;
  - editing a native signature updates errors in `main.ts` immediately.
  - Renaming at a TypeScript call site gives `x as y`, which is normal TypeScript behavior for imports.
- **The C/C++ extension and rust-analyzer** also handle these files. Expect two hover cards, and
  rust-analyzer complaining that a lone `.rs` file isn't in a crate.

## Debugging

- **Mapper under `tsc`:** use the **Mapper: debug under tsc** launch configuration, or run any
  command in a JavaScript Debug Terminal. Set `TS_CONTENT_MAPPER_DEBUG=1` to print every message,
  virtual text included.
- **Mapper in the editor:** use **Mapper: attach to the editor's mapper** and pick
  `node dist/mapper.js` from the process list. Node can be switched into debug mode by PID, and that
  doesn't disturb stdout.
- **TypeScript into native code:** use the **Example: TS + native** compound. The C++ debugger
  launches `node --inspect-brk` with `TS_POLYGLOT_DEBUG=1`, which builds with `/Od` and `.pdb` files,
  and the JavaScript debugger attaches to the same process. There's no single F11 across the
  boundary; set a breakpoint in the native function instead. The `.pdb` files reference the real
  source paths.
