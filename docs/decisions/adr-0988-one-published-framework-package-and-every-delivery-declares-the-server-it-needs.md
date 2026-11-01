---
id: D988
title: One published framework package, and every delivery declares the server it needs
status: accepted
date: 2026-11-01
supersedes: the system/server package split (D15 amended)
applies-to:
  - packages/system/**
  - packages/types/src/addon/package-requires.ts
  - packages/node-root/src/requirements.ts
  - server/backend/src/core/addon/addon-requirements.ts
  - scripts/ci/stamp-requires.mjs
  - scripts/check-no-system-package.ts
  - scripts/check-requires-declared.ts
---

## Context

`@camstack/system` and `@camstack/server` were published separately and had to be
moved together. Every capability change needed `force_packages=@camstack/system`
(nx-affected does not see it), a node could hold a system copy that disagreed with
its server, and an addon built against a newer framework could be installed on an
older server with nothing refusing it. Version skew was found by a running node.

## Decision

There is ONE published framework package. `@camstack/system` is no longer
published: its source stays in `packages/system` as the private workspace
`@camstack/server-framework`, and its built dist ships inside the
`@camstack/server` tarball as `@camstack/server/system`. Every import is
`@camstack/server/system*`; there is no shim and no alias. D15 is amended: the
host-provided set is the server closure, not a separate system package.

Every package installed apart from the server declares the minimum it needs in
`camstack.requires` (schema in `@camstack/types`, `PackageRequiresSchema`): an
addon `server`, the server `addons` and `wrapper`, a wrapper (desktop, node-root)
`server`. The publish workflow STAMPS these after the version bump. Every
delivery path (`updatePackage`, the sweeps, auto-update, `reconcileAgentAddons`,
`applyServerUpdate`) checks them and refuses with a typed reason naming the
versions; the Addons page shows "requires server >= X". An agent that reports no
server version has a declaring delivery HELD, not sent.

## Consequences

One version scale for the framework. A held update is visible, never silent. The
agent roster path is not requirement-gated. Wrapper minimums start permissive.

## Enforcement

`check-no-system-package.ts` (no published system package, no old import),
`check-requires-declared.ts` (every addon declares), `check-host-externals-identical.ts`,
and the discriminating specs for the resolver, the node-root gate and the delivery hold.
