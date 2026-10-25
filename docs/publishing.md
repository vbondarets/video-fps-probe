# Publishing

The owner publishes `video-fps-probe` to the npm registry; the first npm release is 0.2.0. [Releasing](releasing.md) makes the version commit and its tag, and this page publishes the tag: the first version by hand, every later one with the Release workflow and npm trusted publishing. Every npm fact here was checked against the [sources](#sources) on 2026-10-25.

## One publish for every package manager

npm, Yarn (classic and berry), pnpm and bun all install from the npm registry, so one `npm publish` serves them all:

```sh
npm install video-fps-probe
yarn add video-fps-probe   # Yarn classic and Yarn berry
pnpm add video-fps-probe
bun add video-fps-probe
```

The package has no dependencies. mp4box, mediabunny and React are optional peers, and none of these package managers installs them for the app: npm and pnpm leave optional peers out, bun only uses a copy that is already installed, and Yarn takes a peer from the app's own dependencies. An app installs a peer only for the entry that imports it:

| Entry | The app installs | Peer range |
|---|---|---|
| `video-fps-probe/mp4box` | `mp4box` | `^2.4.1` |
| `video-fps-probe/mediabunny` | `mediabunny` | `^1.62.0` |
| `video-fps-probe/react` | `react` (and `react-dom`) | `^18.0.0 \|\| ^19.0.0` |

## First publish (0.2.0), from the owner's machine

Trusted publishing is configured on the package's settings page, and `npm trust` needs the package to exist, so the first version is published by hand.

0. **Make the package public, then release.** npm refuses to publish a package whose `package.json` has `"private": true`, so a `chore(package)` commit on `main` sets `"private": false` before the release. Only then [Releasing](releasing.md) makes the 0.2.0 commit and the `v0.2.0` tag; its `preversion` step refuses `"private": true`, so a tag that npm cannot publish is never pushed.
1. **Two-factor authentication.** npm publishes only from an account with 2FA on, or with a granular token that bypasses it. On npmjs.com, Account > Two-Factor Authentication > Enable 2FA, with a security key: a hardware key or a platform authenticator such as Windows Hello, Touch ID or Face ID (WebAuthn, set up on the website only). Keep the recovery codes off that device.
2. **Log in.** `npm login`, whose default `auth-type` is `web`; `npm whoami` prints the account.
3. **Publish the tag** from a clean clone, with the Node version of `.nvmrc`:

   ```sh
   git fetch --tags
   git switch --detach v0.2.0
   npm ci --ignore-scripts
   node scripts/release-prep.mjs --publish-check v0.2.0   # prints latest
   npm publish --access public
   ```

   `--publish-check` is the check the Release workflow runs before it publishes: it fails unless the tag is `v` plus the `package.json` version, `private` is not true and npm is 11.5.1 or later, and prints the dist-tag. `--ignore-scripts` keeps the install scripts of the dev dependencies from running in a shell that is logged in to npm; the build needs none (only `fsevents`, which is for macOS, has one). `npm publish` still runs the package's own `prepack`, which builds `dist/` and runs `scripts/check-dist.mjs`, then asks for the second factor. `--access public` is already the default of a new unscoped package (an unscoped package cannot be restricted); it keeps the command the same as the workflow's.
4. **Confirm.** `npm view video-fps-probe --prefer-online` shows the package, and `npm view video-fps-probe dist-tags --prefer-online` shows `latest: 0.2.0`. A new package goes through npm's review first ([what the first publish showed](#what-the-first-publish-showed)).
5. **GitHub Release**, once npm has the version, from a notes file ([Releasing](releasing.md#github-release)). In Bash:

   ```sh
   notes="$(node scripts/release-prep.mjs --notes 0.2.0 --out release-notes.md)"
   gh release create v0.2.0 --title 0.2.0 --notes-file "$notes"
   ```

   In Windows PowerShell 5.1:

   ```powershell
   $notes = node scripts/release-prep.mjs --notes 0.2.0 --out release-notes.md
   gh release create v0.2.0 --title 0.2.0 --notes-file $notes
   ```

A version published from a laptop has no provenance; npm generates it only for a publish from a supported CI system.

### What the first publish showed

0.2.0 was published on 2026-10-25:

- **2FA in the browser.** The first `npm publish` failed with `E403`. It went through once the second factor was completed in the browser. npm restricts granular access tokens that bypass 2FA ([changelog](https://gh.io/npm-gat-bypass2fa-deprecation)): they lose direct publish, so a publish from a laptop always needs the 2FA challenge.
- **Staged publishing.** A new package goes through npm [staged publishing](https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/). Until the version is out, the registry has a placeholder `0.0.0-stage`: a stub and a prerelease, so no semver range and no `npx video-fps-probe` ever selects it. On npmjs.com the version shows "Validating" until npm's automated review finishes, then "Published".
- **No manual approval.** 0.2.0 needed none. A version that waits for approval is approved on npmjs.com > Staged Packages, or with `npm stage list` and `npm stage approve <stage-id>` ([`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage), npm 11.15.0 or later). Both ask for the second factor.
- **Verify online.** `npm view video-fps-probe dist-tags --prefer-online` reads the registry. Without `--prefer-online`, the local npm cache can still serve the placeholder for a few minutes after the version is published.

## Trusted publishing for later releases

Set this up just before the next release, not right after 0.2.0: a new trusted publisher configuration expires when it has not completed a publish within 2 days, and an expired one can no longer be used or edited. Create the GitHub environment first: a run that references an environment that does not exist creates it without protection rules, and would publish without an approval.

1. **GitHub.** Settings > Environments > New environment `npm`: required reviewers, the owner. Leave "Prevent self-review" off, because the owner both starts and approves the run. Deployment branches and tags: `main`, the branch the workflow is started from.
2. **npm.** On npmjs.com, the package's settings > Trusted Publisher > GitHub Actions: organization or user `vbondarets`, repository `video-fps-probe`, workflow filename `release.yml` (the file name only), environment name `npm`. Allow `npm publish` under the allowed actions: a configuration created since 2026-09-03 allows only `npm stage publish` until that box is ticked, and the workflow publishes directly, with the GitHub environment as its approval. The same from the CLI, with npm 11.15.0 or later and 2FA on the account:

   ```sh
   npm trust github video-fps-probe --file release.yml --repository vbondarets/video-fps-probe --environment npm --allow-publish
   ```

   npm does not verify the configuration when it is saved: a field that does not match, all of them case-sensitive, shows only when the workflow publishes, as an authentication error such as `ENEEDAUTH`, so compare the workflow filename and the environment name first. An expired configuration is deleted and created again, on the settings page or with `npm trust list video-fps-probe`, which prints its id, and `npm trust revoke video-fps-probe --id=<id>`.
3. **Afterwards.** Once a trusted publish has worked, npm recommends Settings > Publishing access > "Require two-factor authentication and disallow tokens".

Trusted publishing needs npm 11.5.1 or later and Node 22.14.0 or later (the workflow uses Node 24 from `.nvmrc` and fails before publishing on an older npm), the `id-token: write` permission and a GitHub-hosted runner; self-hosted runners are not supported. It needs no npm token, and the published version gets provenance without `--provenance`, which needs the public repository that `repository` in `package.json` names.

### Staged publishing and the Release workflow

Staged publishing changes nothing in `release.yml` as long as the trusted publisher allows `npm publish`. Checked against the [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage) and [trusted publishing](https://docs.npmjs.com/trusted-publishers) pages:

- **What OIDC can run.** The short-lived OIDC token of a trusted publisher can run `npm publish` and `npm stage publish`, each only when the configuration allows it. `npm stage publish` is always allowed. `npm publish` is allowed only when its box is ticked, which is why step 2 above passes `--allow-publish`.
- **`npm publish`, what the workflow runs.** The version goes out when the job publishes. The `npm` environment's required reviewer is the approval, before the job starts. npm's automated review of a new version can still show it as "Validating" for a while, as with 0.2.0.
- **`npm stage publish`, the alternative.** The job would only stage the version. The OIDC token cannot run `npm stage list`, `view`, `approve` or `reject`, so a maintainer approves the version afterwards, with 2FA, on npmjs.com or with `npm stage approve <stage-id>`. This is a second approval after the GitHub environment.
- **The tag of a staged version.** A staged version keeps the dist-tag it was staged with. A prerelease needs an explicit tag such as `--tag next`, and changing the tag means rejecting the staged version and staging it again.

npm recommends stage-only trust relationships. This workflow keeps `npm publish`, with the GitHub environment as its approval. To switch to stage-only:

1. Replace `npm publish` with `npm stage publish` in `release.yml`, with the same `--access public` and `--tag next` arguments.
2. Untick `npm publish` on the trusted publisher.
3. Approve every staged version after the run. Step 4 of each later release then waits for that approval.

## Each later release

1. `npm version minor -m "chore(release): bumped the version to %s"` (or `patch`) on a clean `main` ([Releasing](releasing.md)), then `git push --follow-tags`.
2. `gh workflow run release.yml -f tag=vX.Y.Z`, or Actions > Release > Run workflow with the tag. Pushing a tag starts nothing.
3. The run checks out the tag in every CI job (`ci.yml` called with the tag as its ref). The publish job then waits for the `npm` environment: approve it under Review deployments. It checks out the tag, fails unless the tag is `v` plus the `package.json` version, `private` is not true and npm is 11.5.1 or later (`node scripts/release-prep.mjs --publish-check vX.Y.Z`), runs `npm ci --ignore-scripts`, so that no install script of a dev dependency runs while the job holds `id-token: write`, and `npm publish --access public`, which still runs `prepack`, with `--tag next` for a prerelease such as `1.0.0-rc.1` so that `latest` stays on the last release.
4. `npm view video-fps-probe dist-tags --prefer-online` shows the new version, once npm's review of it has finished ([what the first publish showed](#what-the-first-publish-showed)).
5. Only then the GitHub Release, from a notes file ([Releasing](releasing.md#github-release)), with `--prerelease` for a version such as `1.0.0-rc.1`, so that GitHub, like npm, keeps its latest release on the last stable version. A declined approval or a failed publish then leaves no GitHub Release that npm does not have. In Bash:

   ```sh
   notes="$(node scripts/release-prep.mjs --notes X.Y.Z --out release-notes.md)"
   gh release create vX.Y.Z --title X.Y.Z --notes-file "$notes"   # add --prerelease for X.Y.Z-rc.N
   ```

   In Windows PowerShell 5.1:

   ```powershell
   $notes = node scripts/release-prep.mjs --notes X.Y.Z --out release-notes.md
   gh release create vX.Y.Z --title X.Y.Z --notes-file $notes   # add --prerelease for X.Y.Z-rc.N
   ```

## Deprecate or unpublish

A version that should not be used is deprecated: it still installs, with a warning, so no build that depends on it breaks.

```sh
npm deprecate video-fps-probe@0.2.1 "use 0.2.2: <what is wrong>"
npm deprecate video-fps-probe@"< 0.2.2" "<message>"   # a range
npm deprecate video-fps-probe@0.2.1 ""                # undeprecate
```

Windows PowerShell 5.1 drops an empty argument before npm sees it, so the last line does not undeprecate in it: write the message as `'""'`, or run the line in Git Bash.

npm allows an unpublish within 72 hours of the publish, when no other package on the registry depends on the version. Later, only when no package depends on it, it had fewer than 300 downloads in the last week and it has a single owner. A `video-fps-probe@version` can never be published again once it was used, and after every version is unpublished no new version can be published for 24 hours. Where those rules do not allow an unpublish, npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish) points to deprecation.

## Sources

Read on 2026-10-25:

- npm: [trusted publishing](https://docs.npmjs.com/trusted-publishers), [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust), [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage), [provenance](https://docs.npmjs.com/generating-provenance-statements), [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish), [lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts), [`npm login`](https://docs.npmjs.com/cli/v11/commands/npm-login), [two-factor authentication](https://docs.npmjs.com/about-two-factor-authentication) and [configuring it](https://docs.npmjs.com/configuring-two-factor-authentication), [`package.json`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json) (`private`, `peerDependenciesMeta`), [`npm deprecate`](https://docs.npmjs.com/cli/v11/commands/npm-deprecate), [unpublish policy](https://docs.npmjs.com/policies/unpublish).
- Other package managers: [pnpm `autoInstallPeers`](https://pnpm.io/settings/peer-dependencies), [bun install](https://bun.com/docs/pm/cli/install), [Yarn `peerDependencies`](https://yarnpkg.com/configuration/manifest).
- GitHub changelog: [staged publishing and new install-time controls for npm](https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/) (2026-05-22), [restricting npm granular access tokens that bypass 2FA](https://gh.io/npm-gat-bypass2fa-deprecation) (2026-07-31).
- GitHub: [environments and required reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) (a missing environment is created on first use), [reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).
