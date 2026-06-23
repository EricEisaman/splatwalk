# Releasing SplatWalk

SplatWalk publishes `@splatwalk/core` to npm with a **manual `npm publish`**
using your npm login + 2FA one-time code. A tag push runs
[`release.yml`](.github/workflows/release.yml), which builds the WASM, assembles
the package, and attaches the artifacts (including the `splatwalk-core-*.tgz`
tarball) to a **GitHub release** - it does **not** publish to npm.

> CI publishing via npm Trusted Publishing (OIDC) is not enabled: it was never
> authorized for this package and only produced failing release runs. If you want
> hands-off CI publishing later, see [Optional: CI publishing](#optional-ci-publishing).

## Publishing to npm (manual)

From the repo root:

```bash
npm login                              # your @splatwalk-org account (2FA)
npm run build:wasm                     # ./scripts/build.sh         -> pkg/
npm run build:package                  # ./scripts/build-package.sh -> dist-pkg/
npm publish ./dist-pkg --access public --otp=XXXXXX   # XXXXXX = authenticator code
```

> Use the `./dist-pkg` path form (or `cd dist-pkg && npm publish ...`). A bare
> `npm publish dist-pkg` is interpreted by npm 11 as a *package spec* (it tries to
> fetch a package named `dist-pkg` and fails with `ENOVERSIONS`). Also publish the
> assembled `dist-pkg/`, **not** the repo root — `npm publish` from the root
> publishes the whole-repo `sigma-wasm` package, not the `@splatwalk/core` core.

Verify at <https://www.npmjs.com/package/@splatwalk/core>. (You can also publish
the `splatwalk-core-*.tgz` attached to the matching GitHub release instead of
rebuilding: `npm publish ./splatwalk-core-x.y.z.tgz --access public --otp=XXXXXX`.)

## Cutting a release

1. **Bump the version** in [`Cargo.toml`](Cargo.toml) `[workspace.package].version`
   (the crate inherits it) and [`package.json`](package.json). Keep them in
   lockstep per [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):
   MINOR for additive, PATCH for fixes, MAJOR for breaking changes.
2. **Update [`CHANGELOG.md`](CHANGELOG.md)**: add a dated `## [x.y.z] - YYYY-MM-DD`
   section (not `Unreleased`).
3. **Add release notes** at `docs/releases/vx.y.z.md` (used as the GitHub release
   body; the workflow falls back to `CHANGELOG.md` if absent).
4. **Commit** the version, changelog, and notes.
5. **Tag and push:**

   ```bash
   ./scripts/release-tag.sh     # validates, creates the annotated vX.Y.Z tag
   git push origin vX.Y.Z       # triggers .github/workflows/release.yml
   ```

6. CI verifies the tag matches `package.json`, rebuilds the WASM, assembles
   `@splatwalk/core`, and attaches the artifacts to a GitHub release.
7. **Publish to npm manually** (see [Publishing to npm](#publishing-to-npm-manual)
   above), then verify at <https://www.npmjs.com/package/@splatwalk/core>.

## Optional: CI publishing

To publish from CI without a token, configure npm Trusted Publishing (OIDC) and
re-add a publish step to `release.yml`:

1. In the package settings on npmjs.com -> **Trusted Publishing**, add a GitHub
   Actions publisher with these exact, case-sensitive values:
   - Organization or user: `EricEisaman`
   - Repository: `splatwalk`
   - Workflow filename: `release.yml`
2. Re-add an `id-token: write` permission and a `npm publish` step (Node 24 +
   npm 11.5.1+, `NPM_CONFIG_PROVENANCE=true`, no `NODE_AUTH_TOKEN`). Consumers
   can then verify provenance with `npm audit signatures`.

## The Pro tier

`@splatwalk/core-pro` is scaffolded (see [`package-pro/`](package-pro/)) and is
intentionally **not** wired into this workflow. It will get its own publish path
when its first feature ships.
