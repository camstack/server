---
id: D343
title: A library the server closure provides is linked, not copied — and boot repairs what a restore left unresolvable
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/system/src/kernel/deps/closure-dedupe.ts
  - packages/system/src/kernel/addon-installer.ts
---

## Context

Every path that materialises an addon tree npm-installs the addon's declared
`camstack.runtimeDependencies` — and their whole transitive tree — into
`<addonsDir>/<pkg>/node_modules`. Measured on the live hub 2026-09-04: 196 MB
across 23 addons, of which **62.6 MB were byte-for-byte re-copies of packages
at the identical version** one directory away in the server closure
(`/data/server-root/current/node_modules`): `mediabunny` 11 MB twice, the
`werift` tree three times (pipeline 22.3 M, provider-reolink 24.1 M,
provider-hikvision 12.4 M of identical copies each). The closure was already
on the runtime resolution path — pipeline runs in production with zod, sharp
and node-av resolved from it via the framework resolver hook — the installer
just never looked there.

The failure mode that forbids a naive dedupe was also measured live: the
closure ships `zod@4.5.4` while `@apocaliss92/nodelink-js` requires `zod@^3`
and carries `3.25.76`. Deduping by name would silently hand a dependent an
incompatible major.

Separately, D338 made system backups node_modules-free, and only *bootstrap*
addons were reinstalled at boot — so a restored node ran every other addon
dependency-less until an operator redeployed each one by hand.

## Decision

After an addon tree's npm install completes (tgz deploy, OTA staged swap,
workspace copy — all three call sites), every top-level `node_modules` entry
the closure also provides is replaced by a **symlink into the closure** —
but ONLY when the closure version is identical, or satisfies every
requirement range recorded for that package across the addon's own tree
under a deliberately conservative parser (exact / caret / tilde; `*`, `>=`,
unions, prereleases refuse). `@camstack/*` and declared
`camstack.nativeDependencies` are never linked. Refusal keeps the addon's
own copy and is logged by name. Symlinks were verified on the hub to resolve
for both `require()` and `import()` at any tree depth, and a dependency the
closure later drops fails LOUDLY (dangling link) instead of silently
degrading.

At boot, `ensureAddonRuntimeDeps` (hub launcher + agent main) makes every
installed addon's declared deps resolvable, doing the least work that
achieves it: a satisfied addon is not touched; a missing dep the closure
serves compatibly becomes a link (no npm, no network); a closure link that
stopped holding (dangling, or the closure moved past what the tree's ranges
accept) is dropped and that addon's deps are reinstalled; only a genuinely
unresolvable dep triggers an in-place npm install, followed by the same
dedupe + native tail as a fresh install. Failures are per-addon and loud,
never boot-fatal.

## Consequences

- Self-containment survives in the sense that matters: each addon still
  declares its own deps and fails loudly when one is missing — it just no
  longer *stores* a copy the runtime already has. This is NOT one shared
  tree.
- ~63 MB reclaimed per node at current versions as addons are redeployed or
  updated (existing satisfied trees are left alone — reclamation rides each
  addon's next install, never a boot-time rewrite).
- A restore now ends with every addon able to load, reinstalling only what
  is absent and not resolvable from the closure — D338's "silently broken
  until redeployed" consequence is closed.
- A closure update that crosses a major for a linked package is caught at
  the next boot (link dropped, real copy reinstalled) — the window between
  closure swap and restart is accepted.
- The conservative range parser will keep copies it cannot prove linkable
  (unions, `>=`). That is the intended trade: an unprovable range never
  borrows the closure's copy.

## Enforcement

`packages/system/src/kernel/deps/__tests__/closure-dedupe.spec.ts` (plan
rules — including the live zod-3-vs-4 refusal — and executor resolution
through the link),
`packages/system/src/kernel/__tests__/addon-installer-closure-dedupe.spec.ts`
(the deploy path links / keeps correctly), and
`packages/system/src/kernel/__tests__/addon-installer-ensure-runtime-deps.spec.ts`
(restore repair; "only when necessary" — a satisfied addon sees zero npm
calls and zero writes). All three were verified RED against mutated code:
removing the version rule failed 5 tests, forcing always-reinstall failed 3,
disabling the repair failed 4.
