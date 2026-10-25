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
  for (const name of ["package.json", "tsconfig.json", "src/main.ts", "src/add.cpp", "src/geometry.c", "src/numbers.rs", "README.md", ".gitignore"]) {
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

test("VS Code gets the TypeScript 7 settings and the extension recommendations", () => {
  const files = planProject({ name: "x", ide: "vscode" });
  const settings = JSON.parse(files.get(".vscode/settings.json")!);
  assert.equal(settings["js/ts.experimental.useTsgo"], true);
  assert.equal(settings["js/ts.tsdk.path"], "./node_modules/typescript");
  const extensions = JSON.parse(files.get(".vscode/extensions.json")!);
  assert.ok(extensions.recommendations.includes("TypeScriptTeam.native-preview"));
  // The native half of the debug compound is the C/C++ extension's, on every OS.
  assert.ok(extensions.recommendations.includes("ms-vscode.cpptools"));
});

const launchFor = (platform: NodeJS.Platform, node = "/usr/local/bin/node") => parseJsonc(planProject({ name: "x", ide: "vscode", platform, node }).get(".vscode/launch.json")!);
const entry = (launch: any, name: string) => [...launch.configurations, ...launch.compounds].find((c: any) => c.name === name);

test("launch.json debugs main.ts alone, and TypeScript and native code together", () => {
  const launch = launchFor("linux");
  const main = entry(launch, "Debug main.ts");
  assert.equal(main.request, "launch");
  assert.equal(main.program, "${workspaceFolder}/src/main.ts");
  assert.deepEqual(main.runtimeArgs, ["--import", "ts-polyglot/register"]);
  const compound = entry(launch, "Debug TypeScript + native");
  assert.deepEqual(compound.configurations, ["native half", "TypeScript half"]);
  assert.equal(compound.stopAll, true);
  const native = entry(launch, "native half");
  assert.deepEqual(native.args, ["--inspect-brk=9229", "--import", "ts-polyglot/register", "src/main.ts"]);
  assert.deepEqual(native.environment, [{ name: "TS_POLYGLOT_DEBUG", value: "1" }]);
  const ts = entry(launch, "TypeScript half");
  assert.equal(ts.request, "attach");
  assert.equal(ts.port, 9229);
  assert.equal(ts.continueOnAttach, true);
});

test("the native debugger is the OS's, launching the node that ran the scaffold", () => {
  const windows = entry(launchFor("win32", "C:\\nvm4w\\nodejs\\node.exe"), "native half");
  assert.equal(windows.type, "cppvsdbg");
  assert.equal(windows.program, "C:\\nvm4w\\nodejs\\node.exe");
  const linux = entry(launchFor("linux"), "native half");
  assert.equal(linux.type, "cppdbg");
  assert.equal(linux.MIMode, "gdb");
  assert.equal(linux.program, "/usr/local/bin/node");
  const mac = entry(launchFor("darwin"), "native half");
  assert.equal(mac.type, "cppdbg");
  assert.equal(mac.MIMode, "lldb");
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const files = planProject({ name: "x", ide: "vscode", platform });
    assert.ok(!files.get(".vscode/launch.json")!.includes("__NODE__"), platform);
    // Only the OS's launch file is written, under the name VS Code reads.
    assert.deepEqual([...files.keys()].filter((name) => name.startsWith(".vscode/launch")), [".vscode/launch.json"]);
  }
});

test("F5 defaults to the compound on Windows, where it has been tried, and to main.ts elsewhere", () => {
  // VS Code selects the first visible entry, sorting configurations and compounds together by
  // presentation.order, so every entry carries one.
  const order = (launch: any, name: string) => entry(launch, name).presentation.order;
  const windows = launchFor("win32");
  assert.ok(order(windows, "Debug TypeScript + native") < order(windows, "Debug main.ts"));
  for (const platform of ["linux", "darwin"] as const) {
    const launch = launchFor(platform);
    assert.ok(order(launch, "Debug main.ts") < order(launch, "Debug TypeScript + native"), platform);
  }
  // The halves only make sense inside the compound, so the dropdown doesn't list them.
  for (const name of ["native half", "TypeScript half"]) assert.equal(entry(windows, name).presentation.hidden, true, name);
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
