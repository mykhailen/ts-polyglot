// Which package manager installs the dependencies: the one that ran `create`, read from the user
// agent npm, pnpm, yarn and bun all set.
import assert from "node:assert/strict";
import test from "node:test";

import { installCommand, packageManager, runScriptCommand } from "../src/install.ts";

test("the package manager that ran create installs the project", () => {
  assert.equal(packageManager("npm/10.9.0 node/v22.21.0 win32 x64 workspaces/false"), "npm");
  assert.equal(packageManager("pnpm/9.12.0 npm/? node/v22.21.0 linux x64"), "pnpm");
  assert.equal(packageManager("yarn/4.5.0 npm/? node/v22.21.0 darwin arm64"), "yarn");
  assert.equal(packageManager("bun/1.1.30 npm/? node/v22.6.0 linux x64"), "bun");
});

test("npm is the default when nothing says otherwise", () => {
  assert.equal(packageManager(undefined), "npm");
  assert.equal(packageManager(""), "npm");
  assert.equal(packageManager("something-else/1.0"), "npm");
});

test("the install command is the manager's plain install", () => {
  assert.deepEqual(installCommand("pnpm"), { command: "pnpm", args: ["install"] });
  assert.deepEqual(installCommand("npm"), { command: "npm", args: ["install"] });
});

test("the next steps run scripts the way the manager does", () => {
  assert.equal(runScriptCommand("npm", "typecheck"), "npm run typecheck");
  assert.equal(runScriptCommand("npm", "start"), "npm start");
  assert.equal(runScriptCommand("pnpm", "typecheck"), "pnpm typecheck");
  assert.equal(runScriptCommand("yarn", "start"), "yarn start");
  assert.equal(runScriptCommand("bun", "typecheck"), "bun run typecheck");
});
