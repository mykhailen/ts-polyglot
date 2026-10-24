# Releasing

Both packages ship together, at one version, from one tag. `npm run release` prepares the commit and
the tag here; pushing them makes GitHub Actions publish to npm and create the GitHub release. No npm
token is involved anywhere: the workflow authenticates with npm's trusted publishing (OIDC), and npm
attaches provenance to each version it publishes that way.

## Once: let the workflow publish

npm has to trust `.github/workflows/release.yml` for each package. Do this right before the first
release: a configuration that hasn't published within 2 days expires and has to be recreated.

For each of `ts-polyglot` and `create-ts-polyglot`, on npmjs.com: the package → Settings → Trusted
Publisher → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `mykhailen` |
| Repository | `ts-polyglot` |
| Workflow filename | `release.yml` |
| Environment name | leave empty |
| Allowed actions | tick **Allow npm publish**. New configurations allow only `npm stage publish`, and the workflow runs `npm publish` |

Or from a terminal, which needs npm 11.15 or later (`npx npm@latest` runs it without upgrading):

```sh
npx npm@latest trust github ts-polyglot --repo mykhailen/ts-polyglot --file release.yml --allow-publish
npx npm@latest trust github create-ts-polyglot --repo mykhailen/ts-polyglot --file release.yml --allow-publish
npx npm@latest trust list ts-polyglot
```

Each one asks for 2FA.

After the first release has published, for both packages: Settings → Publishing access → **Require
two-factor authentication and disallow tokens**, and delete the publish token from `~/.npmrc`.
Trusted publishing keeps working; tokens stop.

What breaks the trust silently: renaming `release.yml` (reconfigure both packages), renaming or
transferring the GitHub repository (delete and recreate both configurations), or a `repository.url`
in a package.json that no longer matches `github.com/mykhailen/ts-polyglot`.

## Each release

1. In `CHANGELOG.md`, write what changed under `### x.y.z (unreleased)`, under **both**
   `## ts-polyglot` and `## create-ts-polyglot`. When nothing else changed in the scaffold, say that
   its template now asks for ts-polyglot x.y.z. Commit that with the rest of the work.
2. On `main`, with a clean tree, up to date with `origin/main`:

   ```sh
   npm run release -- 0.2.0        # or patch, minor, major; --skip-tests leaves the testing to CI
   ```

   It refuses when the version isn't newer, is already on npm, or has no `(unreleased)` heading for
   one of the packages, and says what to fix. Otherwise it sets the version in both packages and in
   the template's dependency, refreshes `package-lock.json`, dates the two headings, runs
   `npm run typecheck` and `npm test`, and commits `Release v0.2.0` with the annotated tag `v0.2.0`.
   If a check fails, the files are put back.
3. Review with `git show`, then push both:

   ```sh
   git push origin main v0.2.0
   ```

4. Watch **Actions → Release**. It runs the full CI matrix on the tag, then on Ubuntu: checks the
   tag against the files, publishes `ts-polyglot` and then `create-ts-polyglot` in one step (the
   template asks for that ts-polyglot version, which is installable seconds after it's published),
   and creates the GitHub release `v0.2.0` with the two changelog sections as its notes.

A prerelease (`npm run release -- 0.2.0-beta.1`) publishes under npm's `next` tag, so
`npm install ts-polyglot` keeps giving the last release, and the GitHub release is marked a
prerelease.

## When it fails

- **CI fails on the tag.** Nothing was published. Fix on `main` and release the next version. The
  dead tag can go: `git push --delete origin v0.2.0 && git tag -d v0.2.0`.
- **Publishing fails:** the trusted publisher isn't configured, has expired, or doesn't allow
  `npm publish`; or the registry is down. Fix the cause and **Re-run failed jobs**. Every step skips
  what already exists, a version the registry has or a release GitHub has, so `ts-polyglot` out and
  `create-ts-polyglot` not is exactly what a re-run finishes.
- **The tag doesn't match the files** (a tag made by hand). The check step lists the mismatches.
  Release the next version from `main`, or move the tag.

## The pieces

- `scripts/release.ts`: `prepare` (what `npm run release` runs), and `check <tag>` and
  `notes <version>` for the workflow. `scripts/release.test.ts` covers the version, manifest and
  changelog logic; `npm test` runs it, and the root `tsconfig.json` type-checks it.
- `.github/workflows/release.yml`: the workflow. `ci.yml` is called from it (`workflow_call`) and no
  longer runs on tag pushes by itself.
- The version lives in `packages/ts-polyglot/package.json`, `packages/create-ts-polyglot/package.json`,
  the template's `ts-polyglot` dependency, and the two workspace entries of `package-lock.json`.
  `project.test.ts` fails when the template drifts; `check` fails when anything does.

## Tightening later

- **Stage, then approve.** Configure the trusted publishers with only `npm stage publish` allowed
  and make the two publish steps run `npm stage publish`. Each version then waits in the package's
  Staged Packages tab until someone approves it with 2FA (`npm stage approve <id>` or on npmjs.com).
  Nothing goes live from CI alone.
- **A GitHub environment** (`npm`) with required reviewers on the `publish` job, named in both
  trusted publisher configurations, if more people get push access.
