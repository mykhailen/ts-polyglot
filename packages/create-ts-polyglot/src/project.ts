// What the scaffold writes: the files in template/, with the project's name in package.json and the
// README, and the editor files only when asked for. The template is a working project itself, so
// it can be edited and type-checked in place.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Ide } from "./args.ts";

export interface ProjectOptions {
  /** The npm package name, which also titles the README. */
  name: string;
  ide: Ide;
}

export const templateDir = fileURLToPath(new URL("../template/", import.meta.url));

/** The files to write, by path relative to the project root, with forward slashes. */
export function planProject({ name, ide }: ProjectOptions): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(templateDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = join(entry.parentPath, entry.name);
    const path = relative(templateDir, source).split(sep).join("/");
    if (path.startsWith(".vscode/") && ide !== "vscode") continue;
    // npm leaves .gitignore out of every tarball, so the template carries it under another name.
    files.set(path === "_gitignore" ? ".gitignore" : path, readFileSync(source, "utf8"));
  }

  const pkg = JSON.parse(files.get("package.json")!);
  files.set("package.json", `${JSON.stringify({ ...pkg, name }, null, 2)}\n`);

  let readme = files.get("README.md")!.replaceAll("__NAME__", name);
  // The editor section sits between markers, so a project without an editor doesn't get it.
  readme = ide === "vscode" ? readme.replace(/<!-- \/?vscode -->\n/g, "") : readme.replace(/<!-- vscode -->\n[\s\S]*?<!-- \/vscode -->\n\n?/, "");
  files.set("README.md", readme);
  return files;
}

/** A valid npm package name made from a directory name, the way create-vite does it. */
export function packageNameFor(dirName: string): string {
  return dirName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^[._]+/, "")
    .replace(/[^a-z\d\-~]+/g, "-");
}

/** A project can go into a directory that doesn't exist yet or is empty. */
export function isUsableDir(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return statSync(dir).isDirectory() && readdirSync(dir).length === 0;
}

export function writeProject(dir: string, files: Map<string, string>): void {
  for (const [path, content] of files) {
    const target = join(dir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
