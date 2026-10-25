---
id: D284
title: A module graph is purged WHOLE or not at all — a bundle does not live under its entry's directory
status: superseded
superseded-by:
  - D444
date: 2026-08-29
supersedes:
applies-to:
  - server/backend/src/core/addon/addon-registry.service.ts
---

> **Superseded by [D444](adr-0444-hub-main-measures-its-own-episodes-bounds-its-readers-and-reads-no-bundle.md)
> (2026-09-11).** hub-main no longer purges or re-imports any addon bundle —
> the runner describes its custom-action catalog in its register frame — so
> the purge this record scopes, `require-cache.ts` and
> `check-addon-bundle-reload.ts` were deleted. The record stays as the
> account of what a half-purged module graph did on 2026-08-29.

## Context

The hub re-imports a forked addon's entry to read its `customActions` catalog
(`AddonRegistryService.registerForkedAddonCustomActions`). Node serves a
CommonJS module out of the require cache keyed by the resolved filename, with
the `?t=` query stripped, so a cache-busting import busts nothing for a CJS
bundle — which every addon here is. The hub therefore PURGES the require cache
before re-importing, and that purge is what actually re-reads the bundle.

The purge was scoped to `dirname(entryPath)`. That is wrong, and it is wrong in
the direction that corrupts rather than staling.

`tools/build/vite-lib.preset.ts` emits every addon package as a MULTI-ENTRY
bundle: entries at `dist/<addon>/index.js`, **shared chunks one level up** at
`dist/dist-<hash>.js`, `dist/node-<hash>.js`, and so on. The preset believes
otherwise — `manualChunks: () => null` carries the comment "Disable
shared-chunk splitting between entries. Each entry bundles its own full
dependency tree" — and that belief is false in the emitted artefact, for
rolldown as it was for rollup: `manualChunks` decides manual ASSIGNMENT, it
does not stop a module used by two entries from being extracted.

So `dirname(entryPath)` evicts the entry chunk and keeps every shared chunk. The
re-import then RE-EXECUTES the entry against module state that was never reset.

On 2026-08-29 that cost the operator a media outage. `stream-broker` failed to
load with

    log channel "stream-broker.webrtc" is already declared in this process
    — two declarations of one name is a programming error, not a merge

`log-channels.ts` was not modified, declares two channels, and both names are
unique. What changed was the import graph: a perf commit in
`rtp-depacketizer.ts` / `stream-broker.ts` moved chunk boundaries, and
`log-channels.ts` — whose module scope calls `declareLogChannel` — ended up in
the ENTRY chunk while the `LogChannelRegistry` singleton it writes to stayed in
the shared chunk. Entry re-ran, registry survived, second declaration threw. The
broker was down, zero RTSP entries, WebRTC dead. `typecheck`, `test`, `lint` and
`docs:check` were all green, because **none of them loads the built bundle**.

The guard's message was correct and the addon was innocent. The same reload had
been silently failing for the catalog on the previous build too
(`Failed to load custom-action catalog for forked addon`, same error) — visible
in the hub log, harmless there, and therefore never chased.

## Decision

**A require-cache purge is scoped to a whole BUNDLE, never to an entry's own
directory.** `bundleGraphRootFor(addonDir, entryPath)` returns `<addonDir>/dist`
when the entry lives under it, and the entry's directory only for a loose module
with no bundle above it. The serializer key that keeps purge-then-import atomic
uses the SAME root, because two addon ids of one package now purge one graph and
a per-entry-folder key would let one evict the other's modules mid-evaluation.

`<addonDir>/node_modules` stays OUTSIDE the root deliberately: a package that
declares `camstack.nativeDependencies` installs `.node` bindings there, and
re-`dlopen`ing a native addon is not a refresh.

**Partial re-execution of a module graph is the fault, not the surviving
singleton.** The duplicate-declaration guard is not to be made idempotent — a
second declaration of one name IS a programming error, and silencing it would
have hidden this loader bug instead of naming it.

## Consequences

The catalog reload now re-reads the whole bundle, which is what it always
claimed to do — so a `camstack deploy` that adds a custom action is picked up
without a hub restart, for real this time rather than for the single-chunk
addons that happened to work.

Cost: the reload evicts and re-executes every entry of that package's bundle,
not one chunk of it. That is the correct unit and it is bounded by the package.

The preset's `manualChunks: () => null` comment is now known to be false. This
record does not change the build — making each entry genuinely self-contained
needs one rollup pass per entry — but nothing may be built on the assumption
that an addon entry is a single file again.

## Enforcement

`scripts/check-addon-bundle-reload.ts`, in the CI guard block (which runs after <!-- drift-ok: the guard was deleted with the purge it guarded (D444) -->
`npm run build`, so the artefact exists). For every package declaring
`camstack.addons`, in one Node process per package, it imports every declared
entry and then performs the hub's exact reload — `purgeRequireCacheUnder` at the
bundle root plus a cache-busted native import — and fails on any entry that
LOADED and then threw on RE-IMPORT. An entry that cannot load at all is reported
and skipped: that is `check-addon-entries.ts`' business, and failing here for it
would make this guard unreadable.

Verified both directions on the artefact: with the purge scoped to
`dirname(entryPath)` the guard reproduces the outage's exact message on
`stream-broker`; with `bundleGraphRootFor` all six entries of
`@camstack/addon-pipeline` reload cleanly.
