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
| `video-fps-probe/react` | `react` (and `react-dom`) | `>=18` |

## First publish (0.2.0), from the owner's machine

Trusted publishing is configured on the package's settings page, and `npm trust` needs the package to exist, so the first version is published by hand.

1. **Two-factor authentication.** npm publishes only from an account with 2FA on, or with a granular token that bypasses it. On npmjs.com, Account > Two-Factor Authentication > Enable 2FA, with a security key: a hardware key or a platform authenticator such as Windows Hello, Touch ID or Face ID (WebAuthn, set up on the website only). Keep the recovery codes off that device.
2. **Log in.** `npm login`, whose default `auth-type` is `web`; `npm whoami` prints the account.
3. **Publish the tag** from a clean clone, with the Node version of `.nvmrc`:

   ```sh
   git fetch --tags
   git switch --detach v0.2.0
   npm ci
   npm publish --access public
   ```

   `npm publish` runs `prepack`, which builds `dist/` and runs `scripts/check-dist.mjs`, then asks for the second factor. `--access public` is already the default of a new unscoped package (an unscoped package cannot be restricted); it keeps the command the same as the workflow's. npm refuses to publish while `package.json` has `"private": true`.
4. **Confirm.** `npm view video-fps-probe` shows the package, and `npm view video-fps-probe dist-tags` shows `latest: 0.2.0`.

A version published from a laptop has no provenance; npm generates it only for a publish from a supported CI system.

## Trusted publishing for later releases

Set this up just before the next release, not right after 0.2.0: a new trusted publisher configuration expires when it has not completed a publish within 2 days.

1. **npm.** On npmjs.com, the package's settings > Trusted Publisher > GitHub Actions: organization or user `vbondarets`, repository `video-fps-probe`, workflow filename `release.yml` (the file name only), environment name `npm`. Allow `npm publish` under the allowed actions: a configuration created since 2026-09-03 allows only `npm stage publish` until that box is ticked, and the workflow publishes directly, with the GitHub environment as its approval. The same from the CLI, with npm 11.15.0 or later and 2FA on the account:

   ```sh
   npm trust github video-fps-probe --file release.yml --repository vbondarets/video-fps-probe --environment npm --allow-publish
   ```

2. **GitHub.** Settings > Environments > New environment `npm`: required reviewers, the owner. Leave "Prevent self-review" off, because the owner both starts and approves the run. Deployment branches and tags: `main`, the branch the workflow is started from.
3. **Afterwards.** Once a trusted publish has worked, npm recommends Settings > Publishing access > "Require two-factor authentication and disallow tokens".

Trusted publishing needs npm 11.5.1 or later and Node 22.14.0 or later (the workflow uses Node 24 from `.nvmrc` and fails before publishing on an older npm), the `id-token: write` permission and a GitHub-hosted runner; self-hosted runners are not supported. It needs no npm token, and the published version gets provenance without `--provenance`, which needs the public repository that `repository` in `package.json` names.

## Each later release

1. `npm version minor -m "chore(release): bumped the version to %s"` (or `patch`) on a clean `main` ([Releasing](releasing.md)), then `git push --follow-tags`.
2. `gh release create vX.Y.Z --title X.Y.Z --notes "$(node scripts/release-prep.mjs --notes X.Y.Z)"`.
3. `gh workflow run release.yml -f tag=vX.Y.Z`, or Actions > Release > Run workflow with the tag. Pushing a tag starts nothing.
4. The run checks out the tag in every CI job (`ci.yml` called with the tag as its ref). The publish job then waits for the `npm` environment: approve it under Review deployments. It checks out the tag, fails unless the tag is `v` plus the `package.json` version, `private` is not true and npm is 11.5.1 or later (`node scripts/release-prep.mjs --publish-check vX.Y.Z`), runs `npm ci` and `npm publish --access public`, with `--tag next` for a prerelease such as `1.0.0-rc.1` so that `latest` stays on the last release.
5. `npm view video-fps-probe dist-tags` shows the new version.

## Deprecate or unpublish

A version that should not be used is deprecated: it still installs, with a warning, so no build that depends on it breaks.

```sh
npm deprecate video-fps-probe@0.2.1 "use 0.2.2: <what is wrong>"
npm deprecate video-fps-probe@"< 0.2.2" "<message>"   # a range
npm deprecate video-fps-probe@0.2.1 ""                # undeprecate
```

npm allows an unpublish within 72 hours of the publish, when no other package on the registry depends on the version. Later, only when no package depends on it, it had fewer than 300 downloads in the last week and it has a single owner. A `video-fps-probe@version` can never be published again once it was used, and after every version is unpublished no new version can be published for 24 hours. Where those rules do not allow an unpublish, npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish) points to deprecation.

## Sources

Read on 2026-10-25:

- npm: [trusted publishing](https://docs.npmjs.com/trusted-publishers), [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust), [provenance](https://docs.npmjs.com/generating-provenance-statements), [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish), [lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts), [`npm login`](https://docs.npmjs.com/cli/v11/commands/npm-login), [two-factor authentication](https://docs.npmjs.com/about-two-factor-authentication) and [configuring it](https://docs.npmjs.com/configuring-two-factor-authentication), [`package.json`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json) (`private`, `peerDependenciesMeta`), [`npm deprecate`](https://docs.npmjs.com/cli/v11/commands/npm-deprecate), [unpublish policy](https://docs.npmjs.com/policies/unpublish).
- Other package managers: [pnpm `autoInstallPeers`](https://pnpm.io/settings/peer-dependencies), [bun install](https://bun.com/docs/pm/cli/install), [Yarn `peerDependencies`](https://yarnpkg.com/configuration/manifest).
- GitHub: [environments and required reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).
