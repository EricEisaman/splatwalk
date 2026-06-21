# Contributing to SplatWalk

Thanks for your interest in improving SplatWalk. This guide covers how to
contribute and the licensing terms that apply to your contributions.

## License of contributions

SplatWalk's core is published under the [MIT License](LICENSE), and the project
follows an open-core model with a reserved commercial tier (see
[`LICENSING.md`](LICENSING.md)). By contributing, you agree that:

- Your contributions to the core are licensed under the MIT License, and
- The project maintainer may also include your contributions in the commercial
  `@splatwalk/core-pro` tier under different terms.

This dual ability is only possible if the project has a clear license to every
contribution, so we require a Developer Certificate of Origin (DCO) sign-off on
each commit (below). Do not contribute code you do not have the right to
license this way.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Sign off every commit to certify you wrote the patch or otherwise have the right
to submit it under the project's license:

```bash
git commit -s -m "your message"
```

The `-s` flag appends a `Signed-off-by: Your Name <you@example.com>` line. The
name and email must be real and match your git identity.

## Development

- WASM core (Rust): see [`wasm-splatwalk/`](wasm-splatwalk/). Build with
  `./scripts/build.sh` (or `npm run build:wasm`).
- Reference UI and TypeScript bridge: `npm run dev`.
- Before opening a pull request: `npm run check` (type-check + lint) and, for
  core changes, rebuild the WASM and run `./scripts/build-package.sh`.
- Keep the WASM result contract stable: the integer `api_version` is the hard
  gate; advertise additive changes via `capabilities` instead of bumping it.
  See [`docs/wasm-api.md`](docs/wasm-api.md).

## Versioning

SplatWalk follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
The crate version is single-sourced from the Cargo workspace root and kept in
lockstep with the npm package version. Note your change's nature (additive ->
MINOR, fix -> PATCH, breaking -> MAJOR) in your pull request so it lands in the
right `CHANGELOG.md` section. Maintainers: see [`RELEASING.md`](RELEASING.md) for
the tag-triggered npm publish process.
