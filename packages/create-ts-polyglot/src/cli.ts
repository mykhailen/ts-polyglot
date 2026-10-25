#!/usr/bin/env node
// `npm create ts-polyglot`: asks for a directory, an editor and whether to install, writes the
// template, installs, looks for the compilers, and prints what's left to do by hand. Anything given
// on the command line isn't asked; with no terminal or -y, the defaults fill in the rest.
import { basename, relative, resolve } from "node:path";
import * as p from "@clack/prompts";

import { HELP, parseArgs, type Args, type Ide } from "./args.ts";
import { install, packageManager, runScriptCommand } from "./install.ts";
import { isUsableDir, packageNameFor, planProject, writeProject } from "./project.ts";
import { checkToolchain, findNode } from "./toolchain.ts";

const DEFAULT_DIR = "ts-polyglot-app";
const NOT_EMPTY = (dir: string) => `${dir} exists and is not empty`;

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const interactive = Boolean(process.stdin.isTTY) && !args.yes;

  p.intro("create-ts-polyglot");

  let dir = args.dir;
  if (dir === undefined) {
    if (args.yes) dir = DEFAULT_DIR;
    else if (!interactive) return cancel(`Give the project directory: create-ts-polyglot <dir>, or -y for "${DEFAULT_DIR}"`, 2);
    else {
      const answer = await p.text({
        message: "Project directory",
        placeholder: DEFAULT_DIR,
        defaultValue: DEFAULT_DIR,
        validate: (value) => (value && !isUsableDir(resolve(value)) ? NOT_EMPTY(value) : undefined),
      });
      if (p.isCancel(answer)) return cancel();
      dir = answer;
    }
  }
  const target = resolve(dir);
  if (!isUsableDir(target)) return cancel(NOT_EMPTY(dir), 1);

  let ide = args.ide;
  if (ide === undefined) {
    if (!interactive) ide = "vscode";
    else {
      const answer = await p.select<Ide>({
        message: "Editor",
        initialValue: "vscode",
        options: [
          { value: "vscode", label: "VS Code", hint: "settings, extension recommendations and F5 debugging" },
          { value: "none", label: "None", hint: "no editor files" },
        ],
      });
      if (p.isCancel(answer)) return cancel();
      ide = answer;
    }
  }

  let shouldInstall = args.install;
  if (shouldInstall === undefined) {
    if (!interactive) shouldInstall = true;
    else {
      const answer = await p.confirm({ message: "Install dependencies now?", initialValue: true });
      if (p.isCancel(answer)) return cancel();
      shouldInstall = answer;
    }
  }

  const files = planProject({ name: packageNameFor(basename(target)), ide, node: findNode() });
  writeProject(target, files);
  const shown = relative(process.cwd(), target) || ".";
  p.log.success(`Created ${shown} (${files.size} files)`);

  const manager = packageManager(process.env.npm_config_user_agent);
  let installed = false;
  if (shouldInstall) {
    const spinner = p.spinner();
    spinner.start(`Installing dependencies with ${manager}`);
    const result = install(manager, target);
    if (result.ok) {
      spinner.stop("Dependencies installed");
      installed = true;
    } else {
      spinner.error(`${manager} install failed`);
      p.log.error(result.output);
      p.log.warn("The project is in place. Fix the error above, then install by hand.");
    }
  }

  const checks = checkToolchain();
  p.note(checks.map((check) => (check.found ? `✔ ${check.tool}` : `✖ ${check.tool}\n  ${check.hint}`)).join("\n"), "Compilers");

  const steps: string[] = [];
  if (shown !== ".") steps.push(`cd ${shown}`);
  if (!installed) steps.push(`${manager} install`);
  steps.push(`${runScriptCommand(manager, "typecheck")}    type-checks src/main.ts and the native files`);
  steps.push(`${runScriptCommand(manager, "start")}            builds the addons on the first run, then runs src/main.ts`);
  if (ide === "vscode") {
    steps.push("");
    // Lines under 70 characters: the note wraps at the terminal width, and a wrapped line reads as
    // two steps.
    steps.push("In VS Code: open the folder and trust it.");
    steps.push("Install the recommended extensions, TypeScript (Native Preview)");
    steps.push("and C/C++.");
    steps.push('Run "TypeScript: Select TypeScript Version…" from the command palette');
    steps.push('and pick "Use Workspace Version" (once per folder).');
    if (process.platform === "win32") steps.push("Press F5 to debug src/main.ts and the native code together.");
    else steps.push("Press F5 to debug src/main.ts. The dropdown also has", '"Debug TypeScript + native", not yet tried on this OS.');
  }
  p.note(steps.join("\n"), "Next steps");
  p.outro("Done.");
  return 0;
}

function cancel(message = "Cancelled.", code = 1): number {
  p.cancel(message);
  return code;
}

process.exitCode = await main();
