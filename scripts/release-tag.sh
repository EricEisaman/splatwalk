#!/bin/bash
set -euo pipefail

# Create the release tag for the current package version after a set of safety
# checks. This does NOT push: it prints the exact push command, which triggers
# `.github/workflows/release.yml` (OIDC Trusted Publishing) to publish to npm.
#
# Usage:
#   ./scripts/release-tag.sh
#   git push origin v<version>     # the printed command actually publishes

THIS_SCRIPTS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$THIS_SCRIPTS_DIR/.."

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

echo "Preparing release tag ${TAG}..."

# 1) Clean working tree (no uncommitted changes).
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit or stash changes before tagging." >&2
  git status --short >&2
  exit 1
fi

# 2) Crate version must match package.json (single source of truth lockstep).
CRATE_VERSION="$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"(.*)".*/\1/')"
if [ "$CRATE_VERSION" != "$VERSION" ]; then
  echo "ERROR: Cargo.toml version ($CRATE_VERSION) != package.json version ($VERSION)." >&2
  exit 1
fi

# 3) CHANGELOG must have a section for this version (and not still 'Unreleased').
if ! grep -q "^## \[${VERSION}\]" CHANGELOG.md; then
  echo "ERROR: CHANGELOG.md has no '## [${VERSION}]' section." >&2
  exit 1
fi
if grep -q "^## \[${VERSION}\] - Unreleased" CHANGELOG.md; then
  echo "ERROR: CHANGELOG.md '[${VERSION}]' is still marked 'Unreleased'. Stamp the date first." >&2
  exit 1
fi

# 4) Tag must not already exist.
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "ERROR: tag ${TAG} already exists." >&2
  exit 1
fi

# 5) Create the annotated tag.
git tag -a "${TAG}" -m "Release ${TAG}"

echo ""
echo "Created annotated tag ${TAG}."
echo "Push it to trigger the publish workflow:"
echo ""
echo "    git push origin ${TAG}"
echo ""
