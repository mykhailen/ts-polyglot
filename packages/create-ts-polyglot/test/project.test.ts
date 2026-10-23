// What the scaffold writes: the template, with the project's name in package.json and the editor
// files only when asked for. The files are checked here; that they work is the end-to-end test's job.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { isUsableDir, packageNameFor, planProject, writeProject } from "../src/project.ts";

const root = mkdtempSync(join(tmpdir(), "create-ts-polyglot test "));
after(() => rmSync(root, { recursive: true, force: true }));

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
// launch.json may carry comments, as VS Code allows.
const parseJsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

test("the project has the demo sources, the config and a README", () => {
  const files = planProject({ name: "my-app", ide: "none" });
  for (const name of ["package.json", "tsconfig.json", "main.ts", "add.cpp", "geometry.c", "numbers.rs", "README.md", ".gitignore"]) {
    assert.ok(files.has(name), name);
  }
  assert.ok(!files.has("_gitignore"));
  assert.match(files.get(".gitignore")!, /node_modules/);
});

test("package.json carries the name, the hook and the pinned versions", () => {
  const pkg = JSON.parse(planProject({ name: "my-app", ide: "none" }).get("package.json")!);
  assert.equal(pkg.name, "my-app");
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.match(pkg.scripts.start, /--import ts-polyglot\/register/);
  assert.match(pkg.scripts.typecheck, /--runExternalCode/);
  // In lockstep with this repo: the ts-polyglot that ships with it, and the TypeScript it was tested with.
  const polyglot = readJson(fileURLToPath(new URL("../../ts-polyglot/package.json", import.meta.url)));
  const repo = readJson(fileURLToPath(new URL("../../../package.json", import.meta.url)));
  assert.equal(pkg.dependencies["ts-polyglot"], `^${polyglot.version}`);
  assert.equal(pkg.devDependencies.typescript, repo.devDependencies.typescript);
});

test("tsconfig.json hands .c, .cpp and .rs files to ts-polyglot", () => {
  const tsconfig = JSON.parse(planProject({ name: "x", ide: "none" }).get("tsconfig.json")!);
  assert.deepEqual(tsconfig.contentMappers, [{ package: "ts-polyglot", extensions: [".c", ".cpp", ".rs"] }]);
});

test("VS Code gets the TypeScript 7 settings, the extension recommendation and an F5 configuration", () => {
  const files = planProject({ name: "x", ide: "vscode" });
  const settings = JSON.parse(files.get(".vscode/settings.json")!);
  assert.equal(settings["js/ts.experimental.useTsgo"], true);
  assert.equal(settings["js/ts.tsdk.path"], "./node_modules/typescript");
  const extensions = JSON.parse(files.get(".vscode/extensions.json")!);
  assert.ok(extensions.recommendations.includes("TypeScriptTeam.native-preview"));
  const [config] = parseJsonc(files.get(".vscode/launch.json")!).configurations;
  assert.equal(config.request, "launch");
  assert.match(config.program, /main\.ts$/);
  assert.deepEqual(config.runtimeArgs, ["--import", "ts-polyglot/register"]);
});

test("without an editor, no editor files", () => {
  const files = planProject({ name: "x", ide: "none" });
  assert.ok(![...files.keys()].some((name) => name.startsWith(".vscode/")), [...files.keys()].join(", "));
});

test("the README is titled after the project and explains the editor only when it has one", () => {
  const vscode = planProject({ name: "my-app", ide: "vscode" }).get("README.md")!;
  assert.match(vscode, /^# my-app\n/);
  assert.match(vscode, /Use Workspace Version/);
  assert.ok(!vscode.includes("<!--"), "markers are stripped");
  const none = planProject({ name: "my-app", ide: "none" }).get("README.md")!;
  assert.doesNotMatch(none, /Use Workspace Version/);
  assert.ok(!none.includes("<!--"), "markers are stripped");
});

test("the package name comes from the directory, made valid for npm", () => {
  assert.equal(packageNameFor("my-app"), "my-app");
  assert.equal(packageNameFor("My App"), "my-app");
  assert.equal(packageNameFor(".hidden_Thing"), "hidden-thing");
});

test("writing creates the directory tree", () => {
  const dir = join(root, "nested", "project");
  writeProject(dir, new Map([["package.json", "{}"], [".vscode/settings.json", "{}"]]));
  assert.ok(existsSync(join(dir, "package.json")));
  assert.ok(existsSync(join(dir, ".vscode", "settings.json")));
});

test("a missing or empty directory is usable; one with files isn't, nor is a file", () => {
  assert.equal(isUsableDir(join(root, "missing")), true);
  mkdirSync(join(root, "empty"));
  assert.equal(isUsableDir(join(root, "empty")), true);
  mkdirSync(join(root, "full"));
  writeFileSync(join(root, "full", "a.txt"), "");
  assert.equal(isUsableDir(join(root, "full")), false);
  assert.equal(isUsableDir(join(root, "full", "a.txt")), false);
});
