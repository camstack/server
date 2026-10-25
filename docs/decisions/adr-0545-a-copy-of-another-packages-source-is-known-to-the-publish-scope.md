---
id: D545
title: A package that carries a copy of another package's source is known to the publish scope, and an authoritative copy is republished with its source
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - scripts/ci/publish-scope.mjs
  - scripts/ci/pin-root-deps.mjs
  - scripts/check-inlined-sources-known.ts
  - packages/system/vite.config.ts
---

## Context

`@camstack/system` builds every tRPC cap router from the cap definitions it
INLINES — `bundleTypesMainEntry: true` in `packages/system/vite.config.ts`
bundles the bare `@camstack/types` entry into system's own dist, so that
`camstack deploy packages/system` refreshes the hub's capability surface with
no new server image. The hub never reads those symbols from `@camstack/types`.

The publish workflow decides what to republish from a resolver
(`scripts/ci/publish-scope.mjs`, 2026-09-17) whose "bundled-into" rule read one
form from the build configs: a `'../<name>/src'` alias. The preset flag names
no such path. So on 2026-09-19 the operator added `event-saving` as the ninth
camera switch id at 09:22; `types` shipped as 1.2.229, 1.2.230 and 1.2.231
across five runs that day; `system` was in none of them and stayed at 1.2.273,
built at 22:00 the evening before with `types@1.2.226`. Each closure pinned
`system@1.2.273 (npm — not in this publish set)` next to the new `types`. On
the hub, `dist-D5ONNqL6.js:4235` carried an eight-id enum while
`@camstack/types@1.2.231` beside it carried nine, and every "Event saving"
switch on the fleet was refused with a zod error. A forced republish produced
`system@1.2.274` with nine ids from unchanged source.

What was tried first: three hypotheses about the build — an `nx reset` that
might not run, a build order that might not respect `system → types`, a bump
that might follow the build. The run logs refute all three: the reset has no
`if:`, `@camstack/types:build` transformed 351 modules in that run with no
cache read, and the order is detect → bump → build → pin → publish. The
artifact was right. It was never published.

The wider fact the artifacts then showed: forty-seven packages carry a copy of
`@camstack/types` — every `externals: 'self-contained'` addon (the preset's
self-contained externals do not keep types outside the bundle), the CLI
(tsup bundles a devDependency and what it reaches), the admin UI. The
workflow's own `include_dependents` help text says those dependents "gain
nothing from the bump"; for the copies, that is false.

## Decision

The resolver knows every copy, by kind, and cascades on kind:

- An **authoritative** copy is one something OUTSIDE the package runs against:
  `system`'s copy of `types` (the hub's API surface), a browser bundle's copy
  of `ui-library` or `types`. It is republished whenever its source changes.
- A **private** copy is read only by the package's own code: a
  self-contained addon's `types`, the CLI's everything, the server's
  `node-root`. It is declared — so an unknown copy can be told from a known
  one — and not cascaded.

Both kinds are DERIVED from the build configs (`inlinedSources`): the alias
form, the preset flag, the self-contained mode, a `noExternal` list, tsup's
devDependency rule. Never a list of names.

Two checks make the rule a fact rather than a paragraph:

1. `scripts/check-inlined-sources-known.ts` (CI, after the build) asks the
   BUILT dists which packages' source they carry — string literals of forty
   or more characters unique to one package's `src/`, three or more of them
   and at least 5 % of that package's markers — and fails on any copy the
   resolver does not know. A build-config form the resolver was not taught
   goes red on the first artifact that uses it.
2. `pin-root-deps.mjs pin` refuses to pin, from the registry, a closure member
   whose artifact carries an authoritative copy of a package this run
   publishes (`staleRegistryPins`) — the 2026-09-19 closure, asked at the one
   step that knows which pins come from npm.

## Consequences

- A `types` edit republishes `system` (and the admin UI, which already
  cascaded through its alias) and therefore the server closure — one more
  package per `types` change, which is the cost of the hub having the schema
  it validates against.
- Forty-plus private copies of `types` stay stale until their addon ships.
  This is chosen, not overlooked: an addon's inlined schemas validate what
  that addon parses, consistently with the code it was built with, and the
  hub's routers never consult them. Flipping the choice is one filter
  (`bundledSources`), and the guard prints every private copy each CI run so
  the count stays visible. The alternatives — cascade every copy (forty
  publishes per `types` edit) or stop inlining `types` into self-contained
  addons (make it host-external through the resolver hook, a runtime change on
  every node) — are recorded here as not taken, not as wrong.
- The `include_dependents` help text in `publish-packages.yml` still says
  dependents gain nothing from the bump; it should say "nothing the hub
  reads".

## Enforcement

`scripts/check-inlined-sources-known.ts` in `.github/workflows/ci.yml`;
`staleRegistryPins` in `scripts/ci/pin-root-deps.mjs` on every publish;
`scripts/__tests__/publish-scope.spec.ts` (a `types` change must contain
`packages/system`; the stale-pin question must name it).
