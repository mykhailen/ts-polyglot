// Keeps packages/ts-polyglot/grammars/ in step with the tree-sitter grammars it vendors. Each
// language's parser is the prebuilt .wasm from the grammar's GitHub release, pinned by tag and
// SHA-256 in manifest.json, with the grammar's LICENSE from the same tag beside it. `check` compares
// the files on disk with the manifest; `update <id> [<tag>]` downloads a release and rewrites the
// pin. The binaries are committed, so neither `npm ci` nor the tests need GitHub. The grammar npm
// packages aren't used because they run node-gyp at install time and peer-depend on native
// tree-sitter.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface GrammarEntry {
  /** GitHub `owner/name`. */
  repository: string;
  /** The release tag, such as `v0.24.2`. */
  tag: string;
  /** The release asset, which is also the file name under grammars/. */
  asset: string;
  sha256: string;
}

/** Keyed by language id. */
export type Manifest = Record<string, GrammarEntry>;

const grammars = new URL("../packages/ts-polyglot/grammars/", import.meta.url);
const manifestFile = new URL("manifest.json", grammars);

export function assetUrl(entry: GrammarEntry): string {
  return `https://github.com/${entry.repository}/releases/download/${entry.tag}/${entry.asset}`;
}

export function licenseUrl(entry: GrammarEntry): string {
  return `https://raw.githubusercontent.com/${entry.repository}/${entry.tag}/LICENSE`;
}

/** The manifest with one entry re-pinned. */
export function pin(manifest: Manifest, id: string, tag: string, sha256: string): Manifest {
  const entry = manifest[id];
  if (!entry) throw new Error(`grammars: no "${id}" in the manifest`);
  return { ...manifest, [id]: { ...entry, tag, sha256 } };
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`grammars: ${url}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

function check(manifest: Manifest): number {
  let problems = 0;
  for (const [id, entry] of Object.entries(manifest)) {
    const file = new URL(entry.asset, grammars);
    const found: string[] = [];
    if (!existsSync(file)) found.push(`${entry.asset} missing`);
    else if (digest(readFileSync(file)) !== entry.sha256) found.push(`${entry.asset} doesn't match the manifest's checksum`);
    if (!existsSync(new URL(`LICENSE-${id}`, grammars))) found.push(`LICENSE-${id} missing`);
    console.log(`${id}: ${entry.repository} ${entry.tag}: ${found.length ? found.join("; ") : "ok"}`);
    problems += found.length;
  }
  return problems ? 1 : 0;
}

async function update(manifest: Manifest, id: string, tag: string | undefined, repository: string | undefined): Promise<number> {
  // A language that isn't pinned yet needs to say where it comes from; its asset follows the
  // tree-sitter naming convention.
  const known = manifest[id] ?? (repository ? { repository, tag: "", asset: `tree-sitter-${id}.wasm`, sha256: "" } : undefined);
  if (!known) {
    console.error(`grammars: "${id}" isn't in the manifest. Pass its GitHub repository (owner/name) after the tag to add it.`);
    return 2;
  }
  const entry = { ...known, tag: tag ?? known.tag };
  if (!entry.tag) {
    console.error(`grammars: "${id}" needs a release tag`);
    return 2;
  }
  const [bytes, license] = await Promise.all([download(assetUrl(entry)), download(licenseUrl(entry))]);
  writeFileSync(new URL(entry.asset, grammars), bytes);
  writeFileSync(new URL(`LICENSE-${id}`, grammars), license);
  writeFileSync(manifestFile, JSON.stringify(pin({ ...manifest, [id]: entry }, id, entry.tag, digest(bytes)), null, 2) + "\n");
  console.log(`${id}: ${entry.repository} ${entry.tag} ${entry.asset} sha256 ${digest(bytes)}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command = "check", id, tag, repository] = argv;
  const manifest: Manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (command === "check") return check(manifest);
  if (command === "update" && id) return update(manifest, id, tag, repository);
  console.error("usage: node scripts/grammars.ts check | update <id> [<tag> [<owner/name>]]");
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
