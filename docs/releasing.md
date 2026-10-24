# Releasing

A release is one `npm version` run on a clean `main`. Its lifecycle scripts regenerate everything that depends on the version in the same commit, so the release commit passes CI. The 0.1.0 release commit did not: the bump renamed the demo chunks that read the version and the tarball name in `report/size-matrix.*`, and CI failed on the stale reports.

Publishing to npm is not part of a release yet (`"private": true`).

## Command

```sh
git config user.name      # Volodymyr Bondarets
git config user.email     # bondaretsdirect@gmail.com
npm version minor -m "chore(release): bumped the version to %s"
git push --follow-tags
gh release create v0.2.0 --title 0.2.0 --notes "$(node scripts/release-prep.mjs --notes 0.2.0)"
```

- `minor` or `patch` follows the [0.x policy](api.md#versioning); `%s` is the new version.
- The release commit and its tag use the repository's git identity, which must be Volodymyr Bondarets <bondaretsdirect@gmail.com>. The repository-local `git config` sets it; `preversion` prints the identity it will commit with.
- `git push --follow-tags` pushes `main` and the annotated tag `vX.Y.Z` that `npm version` creates.
- The GitHub Release takes its notes from the CHANGELOG section of the version.

## What runs

1. **`preversion`** (`node scripts/release-prep.mjs --preversion`): refuses a working tree with any change or untracked file, and an empty Unreleased section in the CHANGELOG. Then it runs the fast gates: typecheck, lint, `check:aliases`, vitest, the comparison self-test and the comparison of every engine against the committed references, the size report and check-dist self-tests, and `readme-tables --check`.
2. **npm** bumps `package.json` and `package-lock.json`.
3. **`version`** (`node scripts/release-prep.mjs`):
   - moves the CHANGELOG Unreleased section under `## X.Y.Z - YYYY-MM-DD` (today, local clock) and leaves an empty `## Unreleased` heading;
   - rebuilds the demo and rewrites `report/size.*` with the budget check;
   - packs the new tarball, installs the consumer fixtures from the npm cache only (`CONSUMERS_OFFLINE=1`), builds them and rewrites `report/size-matrix.*` with the budget check;
   - regenerates the tables of the README, `docs/benchmarks.md` and `docs/bundlers.md`;
   - stages exactly the files that changed, and fails when the run changed any other file.
4. **npm** commits the bump with the staged files and tags it.

The consumer install needs the pinned Vite, peers and React in the npm cache, which `npm ci` leaves there. `CONSUMERS_DIR` places the consumer fixtures on a disk with room (default: the OS temp directory).

When a step fails, npm stops before the commit and the tag. The bump and the regenerated files stay in the working tree: fix the cause, discard them (`git restore --staged --worktree -- .`) and run the command again.
