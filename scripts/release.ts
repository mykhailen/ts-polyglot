// Cuts a release. `prepare` runs here: it moves both packages and the template to one version, dates
// the changelog, runs the checks, and commits and tags. `check` and `notes` run in the Release
// workflow: the first refuses a tag whose files say another version, the second prints the GitHub
// release body. Both packages share a version because the template pins ts-polyglot to it
// (project.test.ts), so a release of one is a release of both. Node runs this file as is.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGES = ["ts-polyglot", "create-ts-polyglot"] as const;

const POLYGLOT = "packages/ts-polyglot/package.json";
const CREATE = "packages/create-ts-polyglot/package.json";
const TEMPLATE = "packages/create-ts-polyglot/template/package.json";
const LOCK = "package-lock.json";
const CHANGELOG = "CHANGELOG.md";
/** Everything a release commit changes, relative to the repo root. */
export const RELEASE_FILES = [POLYGLOT, CREATE, TEMPLATE, LOCK, CHANGELOG] as const;
export type ReleaseFiles = Record<(typeof RELEASE_FILES)[number], string>;

const root = fileURLToPath(new URL("../", import.meta.url));

// Versions

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

export function formatVersion({ major, minor, patch, prerelease }: Version): string {
  return `${major}.${minor}.${patch}${prerelease === undefined ? "" : `-${prerelease}`}`;
}

export function compareVersions(a: Version, b: Version): number {
  for (const part of ["major", "minor", "patch"] as const) {
    if (a[part] !== b[part]) return a[part] - b[part];
  }
  if (a.prerelease === b.prerelease) return 0;
  // A release comes after its own prereleases.
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

// Semver's rules: dot-separated identifiers, numeric ones compared as numbers and before words.
function comparePrerelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x);
    if (numeric !== /^\d+$/.test(y)) return numeric ? -1 : 1;
    if (numeric && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (!numeric && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** `patch`, `minor` or `major` from the current version, or an explicit version, which must be newer. */
export function nextVersion(current: string, spec: string): string {
  const from = parseVersion(current);
  if (!from) throw new Error(`the current version "${current}" isn't X.Y.Z`);
  let next: Version;
  if (spec === "patch" || spec === "minor" || spec === "major") next = bump(from, spec);
  else {
    const explicit = parseVersion(spec);
    if (!explicit) throw new Error(`"${spec}" isn't patch, minor, major or X.Y.Z[-prerelease]`);
    next = explicit;
  }
  if (compareVersions(next, from) <= 0) throw new Error(`${formatVersion(next)} is not newer than ${current}`);
  return formatVersion(next);
}

// As `npm version` does it: bumping a prerelease that already sits on the boundary finishes it.
function bump({ major, minor, patch, prerelease }: Version, kind: "patch" | "minor" | "major"): Version {
  const pre = prerelease !== undefined;
  if (kind === "patch") return { major, minor, patch: pre ? patch : patch + 1, prerelease: undefined };
  if (kind === "minor") return pre && patch === 0 ? { major, minor, patch: 0, prerelease: undefined } : { major, minor: minor + 1, patch: 0, prerelease: undefined };
  return pre && minor === 0 && patch === 0 ? { major, minor: 0, patch: 0, prerelease: undefined } : { major: major + 1, minor: 0, patch: 0, prerelease: undefined };
}

/** The version a release tag names: `v1.2.3` is 1.2.3. */
export function versionFromTag(tag: string): string {
  const version = tag.startsWith("v") ? parseVersion(tag.slice(1)) : undefined;
  if (!version) throw new Error(`"${tag}" isn't a release tag: expected ${parseVersion(tag) ? `v${tag}` : "vX.Y.Z"}`);
  return formatVersion(version);
}

/** Prereleases must not become `latest`, which is what `npm install` picks. */
export function npmTag(version: string): "latest" | "next" {
  return parseVersion(version)?.prerelease === undefined ? "latest" : "next";
}

// Manifests. The edits replace one value and leave the formatting alone: `npm version` rewrites the
// whole file and puts every array on several lines.

export function setVersion(manifest: string, version: string): string {
  const edited = manifest.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
  if (JSON.parse(edited).version !== version) throw new Error('no top-level "version" to set');
  return edited;
}

export function setDependency(manifest: string, name: string, range: string): string {
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const edited = manifest.replace(new RegExp(`("${key}":\\s*")[^"]*(")`), `$1${range}$2`);
  if (JSON.parse(edited).dependencies?.[name] !== range) throw new Error(`no "${name}" dependency to set`);
  return edited;
}

// The changelog: `## <package>` sections, each with `### <version> (<date>|unreleased)` headings.

export interface Section {
  /** `YYYY-MM-DD`, or `unreleased`. */
  date: string;
  body: string;
}

interface Heading {
  line: number;
  version: string;
  date: string;
}

const PACKAGE_HEADING = /^## (\S+)\s*$/;
const VERSION_HEADING = /^### (\S+) \((unreleased|\d{4}-\d{2}-\d{2})\)\s*$/;
const ANY_HEADING = /^#{1,3} /;

function outline(lines: string[]): Map<string, Heading[]> {
  const packages = new Map<string, Heading[]>();
  let current: Heading[] | undefined;
  lines.forEach((text, line) => {
    const pkg = PACKAGE_HEADING.exec(text);
    if (pkg) {
      current = [];
      packages.set(pkg[1]!, current);
      return;
    }
    const heading = VERSION_HEADING.exec(text);
    if (heading && current) current.push({ line, version: heading[1]!, date: heading[2]! });
  });
  return packages;
}

function body(lines: string[], heading: number): string {
  let end = heading + 1;
  while (end < lines.length && !ANY_HEADING.test(lines[end]!)) end++;
  return lines.slice(heading + 1, end).join("\n").trim();
}

const label = (version: string, date: string) => `"### ${version} (${date})"`;
const under = (pkg: string) => `under "## ${pkg}"`;

export function changelogSection(changelog: string, pkg: string, version: string): Section | undefined {
  const lines = changelog.split("\n");
  const heading = outline(lines).get(pkg)?.find((h) => h.version === version);
  return heading && { date: heading.date, body: body(lines, heading.line) };
}

/** Dates the version's `(unreleased)` heading under every package, or says which heading to add. */
export function dateChangelog(changelog: string, version: string, date: string): string {
  const lines = changelog.split("\n");
  const sections = outline(lines);
  for (const pkg of PACKAGES) {
    const headings = sections.get(pkg) ?? [];
    const heading = headings.find((h) => h.version === version);
    if (!heading) {
      const unreleased = headings.filter((h) => h.date === "unreleased").map((h) => label(h.version, h.date));
      throw new Error(`${CHANGELOG}: add ${label(version, "unreleased")} ${under(pkg)}${unreleased.length ? ` (found ${unreleased.join(", ")})` : ""}`);
    }
    if (heading.date !== "unreleased") throw new Error(`${CHANGELOG}: ${label(version, heading.date)} ${under(pkg)} is already dated`);
    lines[heading.line] = lines[heading.line]!.replace("(unreleased)", `(${date})`);
  }
  return lines.join("\n");
}

/** The GitHub release body: each package's dated section for the version. */
export function releaseNotes(changelog: string, version: string): string {
  return PACKAGES.map((pkg) => {
    const section = changelogSection(changelog, pkg, version);
    if (!section) throw new Error(`${CHANGELOG}: no "### ${version}" ${under(pkg)}`);
    if (section.date === "unreleased") throw new Error(`${CHANGELOG}: ${label(version, "unreleased")} ${under(pkg)} isn't dated`);
    return `## ${pkg} ${version}\n\n${section.body}\n`;
  }).join("\n");
}

/** Everything in the files that disagrees with releasing `version`. Empty means the tag may be published. */
export function findProblems(files: ReleaseFiles, version: string): string[] {
  const problems: string[] = [];
  for (const path of [POLYGLOT, CREATE] as const) {
    const actual = JSON.parse(files[path]).version;
    if (actual !== version) problems.push(`${path}: version is ${actual}, not ${version}`);
  }
  const range = JSON.parse(files[TEMPLATE]).dependencies?.["ts-polyglot"];
  if (range !== `^${version}`) problems.push(`${TEMPLATE}: ts-polyglot is "${range}", not "^${version}"`);
  const lock = JSON.parse(files[LOCK]).packages ?? {};
  for (const entry of ["packages/ts-polyglot", "packages/create-ts-polyglot"]) {
    const actual = lock[entry]?.version;
    if (actual !== version) problems.push(`${LOCK}: ${entry} is ${actual}, not ${version} (run npm install --package-lock-only)`);
  }
  for (const pkg of PACKAGES) {
    const section = changelogSection(files[CHANGELOG], pkg, version);
    if (!section) problems.push(`${CHANGELOG}: no "### ${version}" ${under(pkg)}`);
    else if (section.date === "unreleased") problems.push(`${CHANGELOG}: ${label(version, "unreleased")} ${under(pkg)} isn't dated`);
  }
  return problems;
}

// The commands

type Command = [command: string, ...args: string[]];
const git = (...args: string[]): Command => ["git", ...args];
// Under `npm run`, npm_execpath is npm's own entry point; node runs it on every OS. Outside, `npm`
// on Windows is npm.cmd, which Node only runs through a shell.
const npm = (...args: string[]): Command => (process.env.npm_execpath ? [process.execPath, process.env.npm_execpath, ...args] : ["npm", ...args]);

function exec([command, ...args]: Command, { inherit = false, check = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: command === "npm" && process.platform === "win32",
  });
  if (result.error) throw result.error;
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (check && result.status !== 0) throw new Error(`${[command, ...args].join(" ")} failed${stderr ? `\n${stderr}` : ""}`);
  return { status: result.status ?? 1, stdout, stderr };
}

function fail(message: string): never {
  throw new Error(message);
}

function readFiles(): ReleaseFiles {
  return Object.fromEntries(RELEASE_FILES.map((path) => [path, readFileSync(join(root, path), "utf8")])) as ReleaseFiles;
}

const localDate = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

function prepare(spec: string, skipTests: boolean): void {
  // Every guard runs before anything changes.
  const branch = exec(git("rev-parse", "--abbrev-ref", "HEAD")).stdout;
  if (branch !== "main") fail(`releases are cut from main, not ${branch}`);
  const changed = exec(git("status", "--porcelain", "--untracked-files=no")).stdout;
  if (changed) fail(`commit or stash these first:\n${changed}`);
  exec(git("fetch", "--quiet", "origin", "main"));
  if (exec(git("merge-base", "--is-ancestor", "origin/main", "HEAD"), { check: false }).status !== 0) fail("main is behind origin/main: pull first");

  const files = readFiles();
  const current: string = JSON.parse(files[POLYGLOT]).version;
  const other: string = JSON.parse(files[CREATE]).version;
  if (other !== current) fail(`the packages disagree: ts-polyglot is ${current}, create-ts-polyglot is ${other}`);
  const version = nextVersion(current, spec);
  const changelog = dateChangelog(files[CHANGELOG], version, localDate());
  for (const pkg of PACKAGES) {
    const view = exec(npm("view", `${pkg}@${version}`, "version", "--json"), { check: false });
    if (view.status === 0) fail(`${pkg}@${version} is already on npm`);
    // Only "no such version" means the version is free; anything else is the registry or the network.
    const error = view.stdout ? JSON.parse(view.stdout).error : undefined;
    if (error?.code !== "E404") fail(`npm view ${pkg}@${version} failed: ${error?.summary ?? view.stderr}`);
  }

  const edits: Partial<ReleaseFiles> = {
    [POLYGLOT]: setVersion(files[POLYGLOT], version),
    [CREATE]: setVersion(files[CREATE], version),
    [TEMPLATE]: setDependency(files[TEMPLATE], "ts-polyglot", `^${version}`),
    [CHANGELOG]: changelog,
  };
  try {
    for (const [path, text] of Object.entries(edits)) writeFileSync(join(root, path), text);
    exec(npm("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"));
    const problems = findProblems(readFiles(), version);
    if (problems.length) fail(problems.join("\n"));
    if (!skipTests) {
      for (const script of ["typecheck", "test"]) {
        if (exec(npm("run", script), { inherit: true, check: false }).status !== 0) fail(`npm run ${script} failed, so nothing was committed`);
      }
    }
  } catch (error) {
    // Leave the tree as it was, so the next attempt starts clean.
    exec(git("checkout", "--quiet", "--", ...RELEASE_FILES), { check: false });
    throw error;
  }
  exec(git("add", "--", ...RELEASE_FILES));
  exec(git("commit", "--quiet", "-m", `Release v${version}`));
  exec(git("tag", "-a", `v${version}`, "-m", `v${version}`));
  console.log(`Committed and tagged v${version}. Review it with git show, then push both:\n\n  git push origin main v${version}\n\nThe Release workflow publishes from the tag (docs/releasing.md).`);
}

function check(tag: string): void {
  const version = versionFromTag(tag);
  const problems = findProblems(readFiles(), version);
  if (problems.length) fail(`${tag} doesn't match the files:\n${problems.join("\n")}`);
  // Lines for $GITHUB_OUTPUT.
  console.log(`version=${version}\nprerelease=${npmTag(version) === "next"}\nnpm_tag=${npmTag(version)}`);
}

const USAGE = `Usage:
  npm run release -- <version|patch|minor|major> [--skip-tests]   bump, date the changelog, test, commit and tag
  node scripts/release.ts check <tag>                              CI: the tag against the files; prints outputs
  node scripts/release.ts notes <version>                          CI: the GitHub release body`;

function main(argv: string[]): number {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const [command, arg] = argv.filter((arg) => !arg.startsWith("--"));
  try {
    if (command === "prepare" && arg) prepare(arg, flags.includes("--skip-tests"));
    else if (command === "check" && arg) check(arg);
    else if (command === "notes" && arg) process.stdout.write(releaseNotes(readFiles()[CHANGELOG], arg));
    else {
      console.error(USAGE);
      return 2;
    }
    return 0;
  } catch (error) {
    console.error(`release: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
