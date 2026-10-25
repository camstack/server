---
id: D236
title: The Electron bundle seeds addons from its OWN closure — no second Resources/addons tree
status: accepted
date: 2026-08-25
supersedes:
applies-to:
  - packages/desktop/package.json
  - packages/desktop/src/process-manager.ts
  - packages/desktop/src/main.ts
  - packages/desktop/scripts/stage-deps.mjs
  - packages/desktop/scripts/native-staging.mjs
  - packages/addon-pipeline/src/shared/host-external-import.ts
---

## Context

The desktop app shipped every addon twice. `packages/desktop/package.json`
`build.extraResources` copied `.deps/node_modules` whole into
`Contents/Resources/node_modules`, and then re-copied six addons plus
`@camstack/system` one by one into `Contents/Resources/addons/<short-name>`.
`main.ts` pointed `CAMSTACK_BUNDLED_ADDONS_DIR` at that second tree, the launcher
resolved `installSource: 'local'` from it, and `AddonInstaller` copied it a third
time into `<dataDir>/addons/@camstack/*`. Measured 2026-08-25 on
`release/mac-arm64/camstack.app/Contents/Resources`: `node_modules/@camstack`
285 MB / 15 packages, `addons/` 42 MB / 7 of those same packages.

This is [D45](adr-0045.md) in the shape the docker image had until
removed `/opt/camstack-seed-framework`, and the first question was the same one:
does anything RESOLVE from the second tree, or is it only a seed? Four readers of
`CAMSTACK_BUNDLED_ADDONS_DIR` exist, and only one opens a package inside it at
runtime — `resolveUiDistDir` in `server/backend/src/agent/agent-http.ts`, which
serves `<bundled>/addon-agent-ui/dist` over `@fastify/static` when it is newer
than the installed copy. `host-external-import.ts` uses the variable only to
locate the Electron `Resources` root and anchors at `Resources/node_modules`; the
launcher and `agent/main.ts` only seed from it.

**The failure that decided the direction.** The second tree was not a redundant
copy of the first, it was a DEGRADED one. (2026-07-21) plants each
hoisted native into the addon's own `node_modules` so the seed subtree is
self-contained, and `stage-deps.mjs` fails the build loudly if one is missing —
the fix for a fresh-app first-boot FATAL. It verified `.deps/node_modules/@camstack/<addon>`,
which is not what shipped: electron-builder DROPPED `node_modules` on every
per-package `extraResources` entry. Measured on the same bundle, built at 00:22
from a `.deps` tree that carried the natives at 23:50 the evening before: **zero
`.node` files under `Resources/addons/**`, all of them under
`Resources/node_modules/@camstack/**`.** So `copyBundledNativeModules` and
`ensureAddonNativePrebuilds({ bundledSourceDir })` were both no-ops against the
copy the installer actually seeded from, while the build printed
`verified 6 bundled addon copies carry their native prebuilds`. A guard that
verifies the wrong artefact reads as verification — the exact leftover class this
repo keeps paying for.

## Decision

The packaged desktop app ships **one** copy of every `@camstack` package: the
staged closure at `Contents/Resources/node_modules`. `CAMSTACK_BUNDLED_ADDONS_DIR`
names that closure's own scope dir, `Contents/Resources/node_modules/@camstack`,
and `build.extraResources` carries no per-package `addons/<name>` entry. An npm
scope dir already has the layout the second tree was hand-built to imitate —
`AddonInstaller.findLocalPackage('@camstack/addon-pipeline')` strips the scope and
joins `<dir>/addon-pipeline` — so this is a rename of the seed source, not a new
mechanism.

A consumer of `CAMSTACK_BUNDLED_ADDONS_DIR` must not assume the variable's DEPTH.
`electronResourcesRoot` climbs past `@camstack` / `node_modules` / `addons`
instead of taking one `path.dirname`.

## Consequences

- 42 MB leaves the bundle and the bundle drops from three `@camstack` seed copies
  to two (`Resources/node_modules`, plus the asar closure — see below).
- The seed roster GROWS: the closure carries ten bootstrap packages where the
  hand-written list carried seven. `addon-auth`, `addon-decoder-nodeav` and
  `addon-notifiers` were fetched from npm at first boot and are now seeded
  locally, so a first boot with no registry gets more, not less.
- The natives finally reach the seeded copy, which is what intended.
  `stage-deps.mjs` now plants into and verifies the closure's own package dirs
  (`bundledAddonSourceDirs`), which is what ships.
- `@camstack/system` is still skipped by `shouldSkipClosureProvidedSeed` when the
  closure resolves it, so the desktop node keeps ONE system copy regardless.
- **What this record does NOT fix.** `Resources/app.asar` carries a THIRD copy of
  all 15 `@camstack` packages plus 268 k `node_modules` entries, because
  `@camstack/server` is a production dependency of `@camstack/desktop` and
  electron-builder bundles the app's dependency closure. `dist/main.js` needs
  none of it (tsup keeps only `electron`, `electron-updater`, `electron-store`
  external). Removing it is NOT a drive-by: `hostExternalAnchors` deliberately
  anchors at `<resources>/app.asar.unpacked/node_modules`, so pruning the asar
  closure moves a live `sharp` / `node-av` resolution path for the forked decode
  worker and needs a packaged run to verify. Its own task.

## Enforcement

`scripts/check-single-copy-layout.ts` — `packages/desktop/package.json` joined
the layout file list with a `bundled-addons-seed-tree` marker
(`/"to":\s*"addons\//`), pinned at 0. The pre-change file scores 6, so a
reintroduced per-addon `extraResources` entry fails CI. Plus unit tests:
`resolveBundledAddonsDir` (`packages/desktop/src/__tests__/bundled-addons-dir.test.ts`),
the closure-scope layout `resolveUiDistDir` reads
(`server/backend/src/agent/__tests__/agent-http-ui-dist.test.ts`), the anchor
depth (`packages/addon-pipeline/src/shared/__tests__/lazy-sharp-resolution.spec.ts`)
and the staging list (`packages/desktop/src/__tests__/native-staging.test.ts`).
