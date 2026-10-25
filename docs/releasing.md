# Releasing

A release is one `npm version` run on a clean `main`. Its lifecycle scripts regenerate everything that depends on the version in the same commit, so the release commit passes CI. The 0.1.0 release commit did not: the bump renamed the demo chunks that read the version and the tarball name in `report/size-matrix.*`, and CI failed on the stale reports.

Publishing to npm is a separate step after the release, by the owner: [Publishing](publishing.md). The GitHub Release comes last, once npm has the version.

## Command

```sh
git config user.name      # Volodymyr Bondarets
git config user.email     # bondaretsdirect@gmail.com
npm version minor -m "chore(release): bumped the version to %s"
git push --follow-tags
# publish the tag to npm (docs/publishing.md), then the GitHub Release (below)
```

- `package.json` has `"private": false`, committed on `main` before the run: once for 0.2.0, the first npm release (a `chore(package)` commit), and kept afterwards. `preversion` refuses `"private": true`, because npm would refuse to publish the tag after it was pushed.
- `minor` or `patch` follows the [0.x policy](api.md#versioning); `%s` is the new version.
- The release commit and its tag use the repository's git identity, which must be Volodymyr Bondarets <bondaretsdirect@gmail.com>. The repository-local `git config` sets it; `preversion` prints the identity it will commit with, and fails before any gate when `user.name` or `user.email` is not set, naming the value it found for each.
- `git push --follow-tags` pushes `main` and the annotated tag `vX.Y.Z` that `npm version` creates.
## GitHub Release

The GitHub Release comes after the npm publish: create it once `npm view video-fps-probe dist-tags` shows the version, so GitHub never lists a release that npm does not have. Its notes are the CHANGELOG section of the version, written to a file: `--notes <version> --out <file>` writes the section as UTF-8 with LF line ends, prints the absolute path of the file, and fails when the version has no section or an empty one. A GitHub Release does not resolve a relative link such as `docs/api.md#check` against the repository, so the file points each one at the file of the tag (`https://github.com/vbondarets/video-fps-probe/blob/v0.2.0/docs/api.md#check`), from `repository` in `package.json`. `release-notes.md` in the repository root is git-ignored, so the file never makes the tree dirty for the next `preversion`.

Bash (Git Bash, Linux, macOS):

```sh
notes="$(node scripts/release-prep.mjs --notes 0.2.0 --out release-notes.md)"
gh release create v0.2.0 --title 0.2.0 --notes-file "$notes"
```

Windows PowerShell 5.1 (and PowerShell 7):

```powershell
$notes = node scripts/release-prep.mjs --notes 0.2.0 --out release-notes.md
gh release create v0.2.0 --title 0.2.0 --notes-file $notes
```

For a prerelease such as `1.0.0-rc.1`, which npm publishes under `next`, add `--prerelease`, so that GitHub, like npm, keeps its latest release on the last stable version: `gh release create v1.0.0-rc.1 --title 1.0.0-rc.1 --prerelease --notes-file $notes`.

The notes go through a file, not an argument such as `--notes "$(...)"`: in PowerShell, `"$(...)"` joins the output lines with spaces, so the notes lose their line breaks, Windows PowerShell 5.1 mangles the double quotes inside an argument it passes to a native program, and a Windows command line holds at most 32,767 characters.

## What runs

1. **`preversion`** (`node scripts/release-prep.mjs --preversion`): refuses a working tree with any change or untracked file, an empty Unreleased section in the CHANGELOG, `"private": true` in `package.json`, and a git `user.name` or `user.email` that is not set (the error names both values). It prints the identity of the release commit. Then it runs the fast gates: typecheck, lint, `check:aliases`, vitest, the comparison self-test and the comparison of every engine against the committed references, the size report and check-dist self-tests, and `readme-tables --check`.
2. **npm** bumps `package.json` and `package-lock.json`.
3. **`version`** (`node scripts/release-prep.mjs`):
   - moves the CHANGELOG Unreleased section under `## X.Y.Z - YYYY-MM-DD` (today, local clock) and leaves an empty `## Unreleased` heading. Text between `## Unreleased` and its first `###` heading is an intro about the coming release ("These changes go into 0.2.0 ..."): it is dropped, not moved, and printed, so the released section starts at its first `###` heading. A note that readers of the released version need, such as a migration step, belongs under a `###` heading. A section without any `###` heading moves whole;
   - rebuilds the demo and rewrites `report/size.*` with the budget check;
   - packs the new tarball, installs the consumer fixtures from the npm cache only (`CONSUMERS_OFFLINE=1`), builds them and rewrites `report/size-matrix.*` with the budget check;
   - regenerates the tables of the README, `docs/benchmarks.md`, `docs/bundlers.md` and `report/README.md`;
   - stages exactly the files that changed, and fails when the run changed any other file.
4. **npm** commits the bump with the staged files and tags it.

The consumer install needs the pinned Vite, peers and React in the npm cache, which `npm ci` leaves there. React 18.3.1 and ReactDOM 18.3.1 of the `react18` fixture are not dev dependencies, so `npm ci` does not cache them: install them once into a scratch directory with an empty user config (`npm install react@18.3.1 react-dom@18.3.1 --userconfig <an empty file>`), which caches them without sending your registry credentials. `CONSUMERS_DIR` places the consumer fixtures on a disk with room (default: the OS temp directory).

When a step fails, npm stops before the commit and the tag. The bump and the regenerated files stay in the working tree: fix the cause, discard them (`git restore --staged --worktree -- .`) and run the command again.
