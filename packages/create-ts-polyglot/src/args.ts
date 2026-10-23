// The command line: `create-ts-polyglot [dir] [--ide vscode|none] [--install|--no-install] [-y]`.
// Everything is optional; the prompts ask for what's missing. `npm create ts-polyglot my-app -- --ide none`
// passes options through npm.
import { parseArgs as nodeParseArgs } from "node:util";

export const IDES = ["vscode", "none"] as const;
export type Ide = (typeof IDES)[number];

export interface Args {
  dir: string | undefined;
  ide: Ide | undefined;
  install: boolean | undefined;
  yes: boolean;
  help: boolean;
}

export const HELP = `Usage: npm create ts-polyglot [dir] -- [options]

Creates a TypeScript project that imports C, C++ and Rust files with ts-polyglot.

Options:
  --ide <vscode|none>   editor files to write (default: vscode)
  --install             install dependencies when done (default: yes)
  --no-install          don't install dependencies
  -y, --yes             take every default without asking
  -h, --help            show this help
`;

const options = {
  ide: { type: "string" },
  install: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
} as const;

// --no-install needs allowNegative.
const parse = (argv: string[]) => nodeParseArgs({ args: argv, options, allowPositionals: true, allowNegative: true });

export function parseArgs(argv: string[]): Args {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n\n${HELP}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new Error(`unexpected argument "${positionals[1]}"\n\n${HELP}`);
  if (values.ide !== undefined && !IDES.includes(values.ide as Ide)) {
    throw new Error(`--ide must be one of ${IDES.join(", ")}, not "${values.ide}"\n\n${HELP}`);
  }
  return {
    dir: positionals[0],
    ide: values.ide as Ide | undefined,
    install: values.install,
    yes: values.yes ?? false,
    help: values.help ?? false,
  };
}
