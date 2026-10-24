// The pure parts of the release script: versions, the manifest edits and the changelog. The git and
// npm calls around them are rehearsed by hand in a scratch clone (docs/releasing.md).
import assert from "node:assert/strict";
import test from "node:test";

import {
  changelogSection,
  compareVersions,
  dateChangelog,
  findProblems,
  nextVersion,
  npmTag,
  parseVersion,
  releaseNotes,
  setDependency,
  setVersion,
  versionFromTag,
} from "./release.ts";

const changelog = `# Changelog

## ts-polyglot

### 0.2.0 (unreleased)

- Strings cross as \`string\`.

### 0.1.0 (2026-10-23)

First release.

- Imports top-level C, C++ and Rust functions.

## create-ts-polyglot

### 0.2.0 (unreleased)

- The template asks for ts-polyglot 0.2.0.

### 0.1.0 (2026-10-23)

First release.
`;

test("versions parse as X.Y.Z with an optional prerelease and nothing else", () => {
  assert.deepEqual(parseVersion("0.1.0"), { major: 0, minor: 1, patch: 0, prerelease: undefined });
  assert.deepEqual(parseVersion("1.2.3-beta.1"), { major: 1, minor: 2, patch: 3, prerelease: "beta.1" });
  for (const bad of ["v0.1.0", "0.1", "0.1.0.0", "0.1.0+build", "1.2.3-", "latest", ""]) {
    assert.equal(parseVersion(bad), undefined, bad);
  }
});

test("versions compare numerically, and a prerelease comes before its release", () => {
  const order = ["0.1.0", "0.1.1", "0.2.0-beta.1", "0.2.0-beta.2", "0.2.0", "1.0.0", "10.0.0"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(compareVersions(parseVersion(order[i - 1]!)!, parseVersion(order[i]!)!) < 0, `${order[i - 1]} < ${order[i]}`);
  }
  assert.equal(compareVersions(parseVersion("0.2.0")!, parseVersion("0.2.0")!), 0);
});

test("the next version is patch, minor, major or an explicit newer version", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.5", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.5", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.0", "0.3.0-beta.1"), "0.3.0-beta.1");
  // Finishing a prerelease, the way `npm version` does it.
  assert.equal(nextVersion("0.2.0-beta.1", "patch"), "0.2.0");
  assert.equal(nextVersion("0.2.0-beta.1", "minor"), "0.2.0");
  assert.equal(nextVersion("1.0.0-rc.1", "major"), "1.0.0");
  assert.throws(() => nextVersion("0.2.0", "0.1.9"), /not newer than 0\.2\.0/);
  assert.throws(() => nextVersion("0.2.0", "0.2.0"), /not newer than 0\.2\.0/);
  assert.throws(() => nextVersion("0.2.0", "v0.3.0"), /patch, minor, major or X\.Y\.Z/);
});

test("a release tag is v plus the version", () => {
  assert.equal(versionFromTag("v0.2.0"), "0.2.0");
  assert.equal(versionFromTag("v1.0.0-rc.1"), "1.0.0-rc.1");
  assert.throws(() => versionFromTag("0.2.0"), /v0\.2\.0/);
  assert.throws(() => versionFromTag("release-1"), /vX\.Y\.Z/);
});

test("prereleases publish under next, releases under latest", () => {
  assert.equal(npmTag("0.2.0"), "latest");
  assert.equal(npmTag("0.2.0-beta.1"), "next");
});

test("setting a version changes that value and nothing else", () => {
  const manifest = `{
  "name": "ts-polyglot",
  "version": "0.1.0",
  "keywords": ["typescript", "native", "import"],
  "files": ["dist", "src"],
  "peerDependenciesMeta": {
    "typescript": { "optional": true }
  }
}
`;
  const bumped = setVersion(manifest, "0.2.0");
  assert.equal(JSON.parse(bumped).version, "0.2.0");
  assert.equal(bumped, manifest.replace('"version": "0.1.0"', '"version": "0.2.0"'));
});

test("setting the template's dependency changes that range and nothing else", () => {
  const manifest = `{
  "name": "ts-polyglot-app",
  "version": "0.0.0",
  "scripts": { "start": "node --import ts-polyglot/register main.ts" },
  "dependencies": {
    "ts-polyglot": "^0.1.0"
  }
}
`;
  const bumped = setDependency(manifest, "ts-polyglot", "^0.2.0");
  assert.equal(JSON.parse(bumped).dependencies["ts-polyglot"], "^0.2.0");
  assert.equal(JSON.parse(bumped).version, "0.0.0");
  assert.equal(bumped, manifest.replace('"ts-polyglot": "^0.1.0"', '"ts-polyglot": "^0.2.0"'));
  assert.throws(() => setDependency(manifest, "typescript", "7.1.0-beta"), /typescript/);
});

test("a changelog section is found under its own package heading", () => {
  assert.deepEqual(changelogSection(changelog, "ts-polyglot", "0.2.0"), {
    date: "unreleased",
    body: "- Strings cross as `string`.",
  });
  assert.deepEqual(changelogSection(changelog, "create-ts-polyglot", "0.1.0"), {
    date: "2026-10-23",
    body: "First release.",
  });
  // Multi-paragraph bodies stop at the next heading.
  assert.equal(changelogSection(changelog, "ts-polyglot", "0.1.0")?.body, "First release.\n\n- Imports top-level C, C++ and Rust functions.");
  assert.equal(changelogSection(changelog, "ts-polyglot", "0.3.0"), undefined);
  assert.equal(changelogSection(changelog, "something-else", "0.1.0"), undefined);
});

test("dating a release touches the unreleased heading of each package and nothing else", () => {
  const dated = dateChangelog(changelog, "0.2.0", "2026-11-01");
  assert.equal(dated, changelog.replaceAll("### 0.2.0 (unreleased)", "### 0.2.0 (2026-11-01)"));
  assert.equal(changelogSection(dated, "ts-polyglot", "0.2.0")?.date, "2026-11-01");
  assert.equal(changelogSection(dated, "create-ts-polyglot", "0.2.0")?.date, "2026-11-01");
});

test("dating refuses when a package has no unreleased heading for the version, and says what it found", () => {
  assert.throws(
    () => dateChangelog(changelog, "0.3.0", "2026-11-01"),
    /add "### 0\.3\.0 \(unreleased\)" under "## ts-polyglot" \(found "### 0\.2\.0 \(unreleased\)"\)/,
  );
  const onlyOne = changelog.replace("### 0.2.0 (unreleased)\n\n- The template asks for ts-polyglot 0.2.0.\n\n", "");
  assert.throws(() => dateChangelog(onlyOne, "0.2.0", "2026-11-01"), /add "### 0\.2\.0 \(unreleased\)" under "## create-ts-polyglot"$/);
  assert.throws(() => dateChangelog(changelog, "0.1.0", "2026-11-01"), /"### 0\.1\.0 \(2026-10-23\)" under "## ts-polyglot" is already dated/);
});

test("release notes are the dated sections of both packages", () => {
  const dated = dateChangelog(changelog, "0.2.0", "2026-11-01");
  assert.equal(
    releaseNotes(dated, "0.2.0"),
    "## ts-polyglot 0.2.0\n\n- Strings cross as `string`.\n\n## create-ts-polyglot 0.2.0\n\n- The template asks for ts-polyglot 0.2.0.\n",
  );
  assert.throws(() => releaseNotes(changelog, "0.2.0"), /"### 0\.2\.0 \(unreleased\)" under "## ts-polyglot" isn't dated/);
  assert.throws(() => releaseNotes(changelog, "0.3.0"), /no "### 0\.3\.0" under "## ts-polyglot"/);
});

const files = (version: string, templateRange = `^${version}`) => ({
  "packages/ts-polyglot/package.json": JSON.stringify({ name: "ts-polyglot", version }),
  "packages/create-ts-polyglot/package.json": JSON.stringify({ name: "create-ts-polyglot", version }),
  "packages/create-ts-polyglot/template/package.json": JSON.stringify({ dependencies: { "ts-polyglot": templateRange } }),
  "package-lock.json": JSON.stringify({ packages: { "packages/ts-polyglot": { version }, "packages/create-ts-polyglot": { version } } }),
  "CHANGELOG.md": dateChangelog(changelog, "0.2.0", "2026-11-01"),
});

test("the files agree on a release when every version and the changelog match", () => {
  assert.deepEqual(findProblems(files("0.2.0"), "0.2.0"), []);
});

test("every disagreement between the files and the release is a problem that names the file", () => {
  const stale = { ...files("0.2.0"), "packages/create-ts-polyglot/package.json": JSON.stringify({ version: "0.1.0" }) };
  assert.deepEqual(findProblems(stale, "0.2.0"), ['packages/create-ts-polyglot/package.json: version is 0.1.0, not 0.2.0']);

  assert.deepEqual(findProblems(files("0.2.0", "^0.1.0"), "0.2.0"), [
    'packages/create-ts-polyglot/template/package.json: ts-polyglot is "^0.1.0", not "^0.2.0"',
  ]);

  const lock = { ...files("0.2.0"), "package-lock.json": JSON.stringify({ packages: { "packages/ts-polyglot": { version: "0.1.0" }, "packages/create-ts-polyglot": { version: "0.2.0" } } }) };
  assert.deepEqual(findProblems(lock, "0.2.0"), ["package-lock.json: packages/ts-polyglot is 0.1.0, not 0.2.0 (run npm install --package-lock-only)"]);

  const unreleased = { ...files("0.2.0"), "CHANGELOG.md": changelog };
  assert.deepEqual(findProblems(unreleased, "0.2.0"), [
    'CHANGELOG.md: "### 0.2.0 (unreleased)" under "## ts-polyglot" isn\'t dated',
    'CHANGELOG.md: "### 0.2.0 (unreleased)" under "## create-ts-polyglot" isn\'t dated',
  ]);

  // Both versions, the template and the two lockfile entries; the changelog is right.
  assert.equal(findProblems(files("0.1.0"), "0.2.0").length, 5);
});
