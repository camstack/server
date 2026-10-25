---
id: D184
title: The closure carries no package nothing imports
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - packages/system/package.json
  - server/backend/package.json
---

## Context

[D18](adr-0018.md) moved cross-process frames off shared memory. The imports
went with it: as of today the ONLY `import '@camstack/shm-ring'` left in the
whole repository is in one test
(`packages/addon-pipeline/src/stream-broker/__tests__/frame-handle-plane.spec.ts`), <!-- drift-ok: deleted with the broker frame plane, D762 -->
which drives the broker's frame-handle plane with a real ring as its fixture.
No production file — hub, agent, builtin or addon — imports it.

It was still a declared dependency of `@camstack/system` and `@camstack/server`,
so it travelled in the closure of every install. That is not a free leftover:
it is the last **native** package in the closure, which means an `npm install`
that has to find or build a per-platform N-API prebuild, an ABI pinned to the
node version on every host in the fleet, and a CI job maintaining the prebuild.
The cost was being paid for a module the running system never loads.

Deleting the package outright is a different, larger change, and it is not
safe yet: `HOST_EXTERNAL_SPECIFIERS` and the vite preset keep
`@camstack/shm-ring` external precisely so an addon **deployed before D18**
still resolves it, and `packages/shm-ring` is where the ring's own tests live. <!-- drift-ok: deleted in D763 -->
Removing the repo package is the final slice, once no deployed addon imports
it — as `docs/design/2026-07-16-shm-removal-one-process-design.md` already
plans.

## Decision

**A package stays in the `@camstack/server` closure only while something in
the closure imports it.** `@camstack/shm-ring` is therefore out of the
`dependencies` of `@camstack/system` and `@camstack/server`. The workspace
package, its host-external entries and its prebuild CI job stay: they serve
addons deployed before D18 and the ring's own test suite, neither of which is
in the closure.

## Consequences

- A fresh install no longer needs the shm-ring prebuild. The repo still builds
  it for `packages/shm-ring`'s own tests, so CI is unchanged. <!-- drift-ok: deleted in D763 -->
- **An addon deployed before D18 that still imports `@camstack/shm-ring`, and
  that carries no copy of its own, will not resolve it after a fresh install
  of the new closure.** The fix is to redeploy that addon — which is the same
  action the stale-addon detector already asks for. Nothing in this repository
  produces such a bundle any more.
- `CLOSURE_PROVIDED_PACKAGES` (`single-copy-cleanup.ts`) still lists it, and
  that is correct: the cleanup only removes an addon-local copy when
  `closureProvides(pkg)` says the running closure resolves it. With shm-ring
  out of the closure the answer is now `false`, so an old addon's own copy is
  KEPT rather than deleted out from under it.
- `server/backend/src/__tests__/dev-bootstrap-shm-ring.spec.ts` <!-- drift-ok: deleted by this very change --> is deleted with
  the dependency: it asserted that the server's bootstrap could `require` the
  native module, which is exactly the property being retired. The module's own
  coverage lives in `packages/shm-ring/src/__tests__/`. <!-- drift-ok: deleted in D763 -->

## Enforcement

`scripts/check-deps.ts` (CI) fails on an `@camstack/*` import with no declared
dependency, so re-introducing an import without re-introducing the dependency
is caught — and re-introducing the dependency is a reviewable diff on two
`package.json` files. Nothing forbids adding it back silently; that is what
this record is for.
