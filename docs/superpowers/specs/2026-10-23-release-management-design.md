# Release management: design

2026-10-23. The owner asked, in one line, for release management: two npm packages, published from
GitHub CI. They weren't available for questions, so everything below was decided while writing it.
Items marked **[call]** are judgment calls the owner may want to reverse; the rest follows from the
repo and from npm's current rules. [docs/releasing.md](../../releasing.md) is the operational doc;
this spec is the record of why. Revised the same day, when the owner asked to publish the packages
together: one publish step for both, in order, without waiting on the registry in between.

## Where things stand

- Both packages have been on npm since 2026-10-23 13:27 UTC: `ts-polyglot@0.1.0` and
  `create-ts-polyglot@0.1.0`, published by hand from this machine (npm 10.9.4, commit `dde68cf`).
  Each also carries a public `0.0.0-stage` placeholder version, which npm's staged publishing
  creates when a package that doesn't exist yet is staged. CLAUDE.md's open work item 5
  ("Publishing: `npm login`, then…") and the `(unreleased)` headings in CHANGELOG.md predate that.
- The versions are already in lockstep. `project.test.ts` fails unless the template's `ts-polyglot`
  dependency is `^<ts-polyglot's version>`, so every ts-polyglot release forces a create-ts-polyglot
  release anyway.
- npm's rules in October 2026:
  - Trusted publishing: GitHub Actions gets a short-lived token through OIDC, no npm token anywhere.
    Needs npm 11.5.1+ (Node 22 ships 10.9) and GitHub-hosted runners. Provenance is automatic for
    a public repo publishing a public package.
  - A trusted publisher is configured per package: GitHub owner, repository, workflow **filename**,
    optional environment. New configurations allow only `npm stage publish` unless `npm publish` is
    ticked. A new configuration expires if it hasn't published within 2 days (since 2026-10-02,
    after the "SlugFest" repository-rename flaw).
  - `repository.url` in package.json must match the GitHub repository exactly.
  - `npm trust github <pkg> --file release.yml --repo owner/repo --allow-publish` does the same from
    the CLI, with npm 11.15+.

## Why

Publishing by hand needs a long-lived token in `~/.npmrc` (there is one), gives no provenance, and
leaves nothing that ties a version on npm to a commit. The two packages must go out in order (the
template depends on the published ts-polyglot), with equal versions and a dated changelog: three
things that are easy to get wrong by hand and trivial for a script.

## What the owner does

**Once, per package.** Add a GitHub Actions trusted publisher on npmjs.com (Package settings →
Trusted Publisher) or with `npm trust`: owner `mykhailen`, repository `ts-polyglot`, workflow
`release.yml`, no environment, **allow `npm publish`**. Cut a release within 2 days; the first
successful publish validates the configuration. Then set Publishing access to "Require two-factor
authentication and disallow tokens", and drop the token from `~/.npmrc`.

**Each release.**

1. Write the entries in `CHANGELOG.md` under `### x.y.z (unreleased)`, under both `## ts-polyglot`
   and `## create-ts-polyglot`.
2. `npm run release -- x.y.z` (or `patch`, `minor`, `major`). It checks, bumps, dates the changelog,
   runs the type check and the tests, commits `Release vx.y.z` and tags `vx.y.z`.
3. Review with `git show`, then `git push origin main vx.y.z`.
4. The Release workflow runs the full CI matrix on the tag, publishes ts-polyglot and then
   create-ts-polyglot in one step, and creates the GitHub release with the two changelog sections
   as notes.

## Goals

- No npm token anywhere: OIDC and provenance.
- One command prepares a release and refuses when something is off: wrong branch, dirty tree, behind
  `origin/main`, version not newer, version already on npm, changelog entry missing.
- A tag can't publish mismatched files. CI re-checks the tag against both package.json files, the
  template's dependency, the lockfile and the changelog before publishing anything.
- A failed run can be re-run to completion: the publish step skips a version the registry already
  has, and the release step skips an existing GitHub release.
- Prereleases (`v0.2.0-beta.1`) go to npm's `next` dist-tag and a GitHub prerelease, never to
  `latest`.

## Non-goals

- **Independent versions per package.** Lockstep: one version, one tag, both packages **[call]**.
- **Changelogs generated from commits** (release-please, changesets). The changelog is written by
  hand and the commit history isn't conventional.
- **Bumping and committing from CI** (a `workflow_dispatch` that pushes to `main`). The version
  commit is made and reviewed locally; CI publishes what's tagged, nothing more **[call]**.
- **Staged publishing** (`npm stage publish`, then approval with 2FA on npmjs.com). Documented as
  the hardening option, not the default **[call]**.
- **A GitHub environment with required reviewers.** The tag push is the deliberate act **[call]**.
- Prebuilt binaries. Publishing from a fork. Dist-tags beyond `latest` and `next`.

## Anti-goals

- A version on npm that isn't a tag on GitHub, or a tag whose files say another version.
- create-ts-polyglot published before the ts-polyglot version its template asks for. Order is
  enough: a version is installable seconds after it's published, so the workflow doesn't wait on the
  registry in between **[call]**. `npm publish --workspaces` alone would publish in alphabetical
  order, the scaffold first, which is why the step names the packages.
- Secrets in the repo or in GitHub Actions.
- Reformatting package.json. The files keep one-line arrays, which `npm version` explodes onto
  many lines (measured). The script edits only the `"version"` value and the template's dependency,
  then refreshes the lockfile with `npm install --package-lock-only --ignore-scripts`, which changes
  exactly the two workspace entries (measured).

## Constraints

- CLAUDE.md's conventions: comments say why; erasable TypeScript so Node runs the script without a
  build; `node:test`; no new dependencies.
- `release.yml` is part of npm's trusted-publisher configuration for both packages. Renaming it
  means reconfiguring both.
- `repository.url` stays `git+https://github.com/mykhailen/ts-polyglot.git` in both packages.
- Node 22's npm can't do trusted publishing, so the publish job installs `npm@latest` first.
- `ci.yml` becomes callable (`workflow_call`) and stops running on tag pushes (`push.branches`), so
  a tag runs the matrix once, inside Release. Pushing the version commit and the tag together still
  runs the matrix twice, once for `main` and once for the tag. Accepted: public-repo minutes are
  free, and publishing something the matrix hasn't passed isn't.
- The script needs nothing outside the repo: it reads the two package.json files, the template's
  package.json, `package-lock.json` and `CHANGELOG.md`.

## The pieces

### `scripts/release.ts`

One file. Exported functions for the tests; `main()` runs only under `import.meta.main`.

```
node scripts/release.ts prepare <version|patch|minor|major> [--skip-tests]   # npm run release -- …
node scripts/release.ts check <tag>       # CI: tag vs files; prints version=, prerelease=, npm_tag=
node scripts/release.ts notes <version>   # CI: the GitHub release body, from CHANGELOG.md
```

`prepare`:

1. Guards, before touching anything: the branch is `main`; `git status --porcelain` shows no
   changes to tracked files (untracked files are fine **[call]**); after `git fetch origin main`,
   `origin/main` is an ancestor of HEAD; both packages agree on the current version; the new version
   parses as `X.Y.Z[-pre]` and is greater; `npm view <pkg>@<v> version` fails for both (404 means
   free); CHANGELOG.md has `### <v> (unreleased)` under both package headings.
2. Edits: `"version"` in both package.json files; `"ts-polyglot": "^<v>"` in the template; the
   lockfile through `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`;
   `(unreleased)` → `(<YYYY-MM-DD>)` (local date) in both headings.
3. `npm run typecheck` and `npm test`, unless `--skip-tests`. If either fails the edits are reverted
   with `git checkout`, so the tree is clean for the next attempt **[call]**.
4. `git add` those five files, `git commit -m "Release v<v>"`, `git tag -a v<v> -m "v<v>"`, and
   print the push command.

Errors name the fix, for example
`CHANGELOG.md: add "### 0.2.0 (unreleased)" under "## create-ts-polyglot" (found "### 0.3.0 (unreleased)")`.

`check <tag>`: the tag must be `v<version>`; both package.json versions, the template's dependency
and the lockfile's two workspace entries must match; the changelog must have `### <version>
(YYYY-MM-DD)`, dated, under both packages. Prints `version=…`, `prerelease=true|false` and
`npm_tag=latest|next` for `$GITHUB_OUTPUT`.

`notes <version>`: Markdown, `## <package> <version>` followed by that section's body, for each
package.

### `.github/workflows/release.yml`

Trigger `push.tags: ["v*"]`; top-level `permissions: contents: read`; `concurrency` per ref.

- `ci`: `uses: ./.github/workflows/ci.yml`.
- `publish`, needs `ci`, `ubuntu-latest`, `permissions: contents: write, id-token: write`:
  checkout; setup-node 22 with `registry-url: https://registry.npmjs.org` (the documented trusted
  publishing setup); `npm install -g npm@latest`; `npm ci`; `check` into step outputs; one step
  that runs `npm publish --workspace <name> --tag <npm_tag>` for ts-polyglot and then
  create-ts-polyglot, skipping a version `npm view` already finds; `gh release create <tag>
  --verify-tag` with the notes (`--prerelease` when applicable) unless `gh release view` finds it.
  Step outputs reach `run:` through `env:`, not through `${{ }}` inside the script.

### `ci.yml`

`on: push: branches: ["**"]`, `pull_request`, `workflow_call: {}`. Nothing else changes.

### Root `package.json` and `tsconfig.json`

- `"release": "node scripts/release.ts prepare"`.
- `"test"` runs `node --test "scripts/*.test.ts"` before the workspaces.
- `"typecheck"` adds `tsc -p .`; a root `tsconfig.json` covers `scripts/*.ts` with the packages'
  options.

### CHANGELOG.md

Both `0.1.0` headings get `(2026-10-23)`. Two lines at the top say how the file works: a section per
package; the next version's entries go under `### x.y.z (unreleased)`; `npm run release` dates it.

### Docs

- New `docs/releasing.md`: the one-time npm setup (website and `npm trust`), cutting a release, what
  the workflow does, re-running a failed release, prereleases, and the hardening options.
- `README.md`: a row for `docs/releasing.md` in "This repository".
- `CLAUDE.md`: layout rows for `release.yml` and `scripts/release.ts`; the `release` command;
  conventions (lockstep, the workflow filename is configuration, the changelog heading format);
  open work item 5 rewritten.
- `packages/create-ts-polyglot/test/e2e.test.ts`: its header says ts-polyglot "is not on the
  registry yet". The reason to install from a tarball is now that the registry may not have *this*
  version.

## Testing, and what counts as done

- `scripts/release.test.ts` (`node:test`, no network, no git): version parsing, comparison and
  bumping; manifest edits that change only the value and keep the formatting; the template
  dependency edit; changelog lookup per package (the same version under both packages must not
  bleed into each other), dating, the missing-heading error text, notes; tag parsing; the file
  consistency check behind `check`.
- A rehearsal in a scratch clone of this repo with a local `origin`: `npm run release -- 0.1.1
  --skip-tests` makes the expected commit and tag; `check v0.1.1` passes and prints the outputs;
  `notes 0.1.1` prints both sections; `check v0.1.1` against the unbumped repo fails.
- `npm run typecheck` and `npm test` pass on Windows here.
- The workflow can't run without pushing a tag. It's validated by reading; **the first tag after the
  trusted publishers are configured is the real end-to-end test.**

## Left to the owner

- Configure the two trusted publishers right before the first release (the 2-day window).
- Decide about the `0.0.0-stage` placeholders: `npm deprecate <pkg>@0.0.0-stage "placeholder"`, or
  leave them.
- After the first CI publish: Publishing access → require 2FA and disallow tokens; remove the token
  from `~/.npmrc`.

## Later

- Stage-only trusted publishers and `npm stage publish` in the workflow, approving each release with
  2FA on npmjs.com or `npm stage approve`.
- A GitHub environment with required reviewers on the publish job, if more people get push access.
- Tarballs or prebuilt binaries attached to the GitHub release.
