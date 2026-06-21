# Releasing SplatWalk

SplatWalk publishes `@splatwalk/core` to npm from GitHub Actions using **npm
Trusted Publishing (OIDC)** - no long-lived `NPM_TOKEN`, with automatic
[provenance](https://docs.npmjs.com/generating-provenance-statements). This
mirrors the [socket.io release process](https://socket.io/blog/npm-package-provenance/).
A tag push is the only trigger; CI builds the WASM, assembles the package, and
publishes.

## One-time setup on npmjs.com (owner only)

These require your npm login and cannot be automated from this repo:

1. **Create the scope/org.** Create the `@splatwalk` org at
   <https://www.npmjs.com/org/create> (free).
2. **Bootstrap the first publish.** Trusted publishing is configured against an
   existing package, so publish `@splatwalk/core` once manually to create it:

   ```bash
   npm login
   npm run build:wasm        # ./scripts/build.sh  -> pkg/
   npm run build:package     # ./scripts/build-package.sh -> dist-pkg/
   cd dist-pkg && npm publish --access public
   ```

3. **Add the Trusted Publisher.** In the package settings on npmjs.com ->
   **Trusted Publishing**, add a GitHub Actions publisher with these exact,
   case-sensitive values:
   - Organization or user: `EricEisaman`
   - Repository: `splatwalk`
   - Workflow filename: `release.yml`

   After this, every tagged release publishes from CI with no token.

> Requirements for the OIDC flow (handled by the workflow): a GitHub-hosted
> runner, Node 24 + npm 11.5.1+, `id-token: write` permission, and a
> `repository.url` in the published `package.json` that matches this repo (it
> does). Do not add `NODE_AUTH_TOKEN` to the workflow - a stored token
> short-circuits OIDC.

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

6. CI then verifies the tag matches `package.json`, rebuilds the WASM, assembles
   `@splatwalk/core`, attaches artifacts to a GitHub release, and publishes to
   npm with provenance. Verify at
   <https://www.npmjs.com/package/@splatwalk/core> (the "Provenance" section
   should show the signed attestation).

## Verifying provenance

Consumers can confirm the published package is built from this repo:

```bash
npm audit signatures
```

## The Pro tier

`@splatwalk/core-pro` is scaffolded (see [`package-pro/`](package-pro/)) and is
intentionally **not** wired into this workflow. It will get its own publish path
when its first feature ships.
