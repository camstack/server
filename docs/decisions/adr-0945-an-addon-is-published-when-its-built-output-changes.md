---
id: D945
title: An addon is published when its built output changes, not when a library it bundles changes
status: accepted
date: 2026-10-26
supersedes:
applies-to:
  - scripts/ci/publish-scope.mjs
  - scripts/ci/publish-output.mjs
  - scripts/ci/publish-output-hash.mjs
  - scripts/ci/pin-root-deps.mjs
  - .github/workflows/publish-packages.yml
---

## Context

D545 records why a package that compiles another package's source into its
own artifact has to be rebuilt when that source changes: the published
library is not what the node runs. The publish workflow therefore cascades
from the build configs (`bundledSources`) and republishes every such package.

The cascade decides from the graph. On 2026-10-26 run 40374002262 a change
to one ui-library field and the admin Integrations grid published
admin-ui, ui-library and the server — and also agent-ui, benchmark,
model-studio, osd-manager and training, none of which contain that field.
Earlier `@camstack/types` edits bumped dozens of addons the same way. The
copy those addons hold did not change. The version did, and every node
treated it as an update.

What was tried first, and rejected: deleting the cascade. That is how
`system` stayed on the previous day's `types` while the closure pinned the
new one (2026-09-19, D545). The select stays. The publish decision moves to
the bytes.

## Decision

A package whose own files changed is published. `force_packages` and
`include_dependents=true` keep that meaning. `@camstack/server` is published
when anything in its pinned closure is published.

A package selected only because it bundles another package's source is a
candidate. After the build, hash what `npm pack` would ship — the file list
and the bytes, with the package version, `@camstack/*` versions, absolute
build paths, vite content-hash filenames, and a bare host-provided
`@module-federation/runtime` import normalised — and hash the
tarball already on the registry the same way. Equal: drop the candidate,
and the server keeps pinning the registry version. Different: publish it.
A comparison that cannot be made fails the run; it does not drop the
candidate.

`dry_run` prints the final set and each decision and does not publish.

## Consequences

A library edit no longer bumps addons that bundle it and do not use the
edit. An edit that does change the inlined bytes still publishes the addon,
which is the failure D545 forbids missing. Two builds of one tree must hash
equal after that normalisation, or the comparison is noise.

The stale-pin refusal still fires when a closure member is pinned from the
registry while this run publishes something it inlines — unless that member
was dropped because the bytes matched. Skipping the comparison and passing
the same exception re-opens 2026-09-19.

## Enforcement

`scripts/__tests__/publish-output.spec.ts` (an unchanged candidate is
dropped, a changed bundle is kept, a direct change is kept, the server pins
the old version of a dropped candidate, normalisation covers the stamped
fields, two builds of `addon-agent-ui` hash equal). `actionlint` on
`.github/workflows/publish-packages.yml`.
