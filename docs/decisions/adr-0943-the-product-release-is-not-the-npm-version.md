---
id: D943
title: The product release is its own version line, starting at 0.1.0 beta
status: accepted
date: 2026-10-25
supersedes:
applies-to:
  - .github/workflows/release.yml
  - scripts/ci/product-release.mjs
  - scripts/ci/verify-release-npm.mjs
  - Dockerfile
  - packages/desktop/**
  - product-version.json
---

## Context

One number used to name three different things: the npm packages (`@camstack/server`
and the rest, on 1.2.x), the container image tags, and the desktop app. Cutting
a release meant tagging whatever `server/backend/package.json` had just been
published, and `verify-release-npm` refused to build unless `latest` equalled
that tag. The desktop app pinned `@camstack/server@${VERSION}` while the image
installed `@latest`, so the two artifacts diverged whenever the tag and the
dist-tag did not match.

The npm line is a package line. The thing an operator installs — the image, the
desktop app, the GitHub release — is a product, and it was being forced to move
every time a package did. The viewer app (the Expo client) was already on its
own 1.0.x line.

## Decision

`vX.Y.Z` is the product version. It restarts at **0.1.0**, is labelled **beta**
while the major is 0 (`CamStack 0.1.0 beta`), and moves on its own
(`product-version.json`, and the same number in `packages/desktop/package.json`).
`@camstack/*` stay on 1.2.x. The viewer app stays on 1.0.x and this release
does not build it.

The image and the desktop app both install `@camstack/server@latest` at build
time. The job records that closure as the image label
`io.camstack.server.version` and as a line in the release notes. Image tags stay
accel-prefixed (`intel-X.Y.Z`, `amd-X.Y.Z`, `intel-latest`, `amd-latest`): a bare
`:X.Y.Z` would name two accelerator images.

electron-updater keeps the existing feeds (`latest`, `viewer`). A 1.2.x install
will not move to 0.1.0, because that is a lower semver. That install is
reinstalled once. Later releases on the 0.x line update on the same feeds.

The About line shows both numbers: the product release, and the running server
package. `CAMSTACK_PRODUCT_VERSION` carries the product (the image and the
desktop shell set it). The server package is the process's own `package.json`.

## Consequences

A product tag no longer waits on, and no longer equals, an npm version. Publish
and `applyServerUpdate` stay the way a running node gets new server code. An
image recreate is how a node gets a new product version.

`workflow_dispatch` with `dry_run=true` derives the product version and resolves
npm `latest`, and does not build or publish. The command is in
`camstack-publish-ci`.

The previous product tag is the one created before this one, not the highest
semver. `v0.1.0` sorts below every `v1.2.*` tag.

## Enforcement

`scripts/__tests__/product-release.spec.ts` and
`scripts/__tests__/verify-release-npm.spec.ts`. The derive job fails when
`product-version.json` and `packages/desktop/package.json` disagree, when a
`publish_release` finds tag `v<version>` already present, and when `latest`
cannot be resolved. Nothing checks the GitHub Actions YAML.

## Amendment (2026-10-25) — the workflow creates the tag

A product release is `workflow_dispatch` from `main` with `publish_release=true`.
`derive-version` reads `product-version.json` and refuses when `v<version>`
already exists. `create-release` creates that tag on the dispatched commit
(`github.sha`). An artifact-only dispatch still bumps by `version_type` and
creates no tag and no GitHub release.
