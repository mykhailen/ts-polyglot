// Runs the built CLI the way `npm create ts-polyglot` does, non-interactively, and then makes the
// project it created work: ts-polyglot comes from a tarball packed like `npm publish` would (the
// registry only has released versions, and the test mustn't depend on it), then the real tsc
// type-checks the project and the real node runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const polyglotDir = fileURLToPath(new URL("../../ts-polyglot/", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "create-ts-polyglot e2e "));
after(() => rmSync(root, { recursive: true, force: true }));

// npm sets npm_execpath for the scripts it runs, so the tests that need npm want `npm test`.
const npmCli = process.env.npm_execpath;
const skip = npmCli ? false : "run it with npm test, which sets npm_execpath";

/** Runs the CLI with no terminal on stdin, as CI would. */
function create(args: string[], cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, output: result.stdout + result.stderr };
}

function npm(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(process.execPath, [npmCli!, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `npm ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

test("creates a VS Code project from the command line alone", () => {
  const { status, output } = create(["my-app", "--ide", "vscode", "--no-install"]);
  assert.equal(status, 0, output);
  const dir = join(root, "my-app");
  const expected = ["package.json", "tsconfig.json", "main.ts", "add.cpp", "geometry.c", "numbers.rs", "README.md", ".gitignore", ".vscode/settings.json", ".vscode/extensions.json", ".vscode/launch.json"];
  for (const file of expected) assert.ok(existsSync(join(dir, file)), file);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "my-app");
  // The native debugger launches node by full path: the one that ran the CLI, which here is this one.
  assert.ok(readFileSync(join(dir, ".vscode", "launch.json"), "utf8").includes(JSON.stringify(process.execPath)), process.execPath);
  // The next steps include what no file can do: choosing the workspace TypeScript in the editor.
  assert.match(output, /Use Workspace Version/);
  assert.match(output, /cd my-app/);
  assert.match(output, /npm install/);
});

test("the project it creates type-checks and runs", { skip }, () => {
  const project = join(root, "runs");
  const { status, output } = create(["runs", "--no-install"]);
  assert.equal(status, 0, output);
  // Packing runs prepack, which builds ts-polyglot's dist/ in case it isn't there yet.
  const [{ filename }] = JSON.parse(npm(["pack", "--json", "--pack-destination", root], polyglotDir));
  // typescript and @types/node come from npm's cache, filled when the repo was installed.
  npm(["install", join(root, filename), "--prefer-offline", "--no-audit", "--no-fund"], project);
  npm(["run", "typecheck"], project);
  // In a terminal that defines FORCE_COLOR (VS Code's debug terminal, for one), console.log colors
  // the values even into this pipe.
  const stdout = stripVTControlCharacters(npm(["start"], project, { TS_POLYGLOT_CACHE_DIR: join(root, "cache") }));
  assert.match(stdout, /add\(1, 2\)\s+= 3/);
  assert.match(stdout, /fib\(50\)\s+= 12586269025/);
});

test("--ide none writes no editor files", () => {
  const { status, output } = create(["plain", "--ide", "none", "--no-install"]);
  assert.equal(status, 0, output);
  assert.ok(existsSync(join(root, "plain", "main.ts")));
  assert.ok(!existsSync(join(root, "plain", ".vscode")));
  assert.doesNotMatch(output, /Use Workspace Version/);
});

test("--yes takes the defaults without a terminal", () => {
  const cwd = join(root, "defaults");
  mkdirSync(cwd);
  const { status, output } = create(["--yes", "--no-install"], cwd);
  assert.equal(status, 0, output);
  assert.ok(existsSync(join(cwd, "ts-polyglot-app", ".vscode", "launch.json")));
});

test("without a terminal, the directory has to be given", () => {
  const { status, output } = create(["--no-install"]);
  assert.notEqual(status, 0);
  assert.match(output, /directory/);
});

test("refuses a directory with files in it", () => {
  mkdirSync(join(root, "taken"));
  writeFileSync(join(root, "taken", "keep.txt"), "");
  const { status, output } = create(["taken", "--no-install"]);
  assert.notEqual(status, 0);
  assert.match(output, /not empty/);
  assert.ok(existsSync(join(root, "taken", "keep.txt")));
});

test("--help prints the usage", () => {
  const { status, output } = create(["--help"]);
  assert.equal(status, 0);
  assert.match(output, /npm create ts-polyglot/);
  assert.match(output, /--no-install/);
});

test("the tarball carries the template, dotfiles included", { skip }, () => {
  // --ignore-scripts: prepack would rebuild dist/ while the other tests here are running it.
  const [{ files }] = JSON.parse(npm(["pack", "--dry-run", "--ignore-scripts", "--json"], packageDir));
  const paths = files.map((file: { path: string }) => file.path);
  // npm doesn't pack the root LICENSE for a workspace, so the package carries its own copy.
  for (const path of ["dist/cli.js", "LICENSE", "template/package.json", "template/main.ts", "template/_gitignore", "template/.vscode/settings.json", "template/.vscode/launch.windows.json", "template/.vscode/launch.linux.json", "template/.vscode/launch.osx.json", "template/.vscode/extensions.json"]) {
    assert.ok(paths.includes(path), `${path} not in ${paths.join(", ")}`);
  }
});
