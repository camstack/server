---
id: D584
title: Each desktop product owns its update CHANNEL end to end, and a mac product ships the zip its updater applies
status: accepted
date: 2026-09-21
applies-to:
  - packages/desktop/package.json
  - packages/desktop/electron-builder.viewer.json
  - packages/desktop/src/product/update-channel.ts
  - packages/desktop/src/auto-updater.ts
  - scripts/check-desktop-update-feeds.ts
last-verified: 2026-10-02
---

## Context

The desktop shell builds TWO products from one source tree (D402): the full
`CamStack`, which stages the whole `@camstack/server` closure, and the reduced
`CamStack Viewer`, which stages nothing and spawns no node process.

Both declared the same publish block — `github / camstack / server`, no
`channel` — and both attach their assets to the SAME GitHub release.
electron-updater's feed is **one file per channel per platform**:
`latest-mac.yml`, `latest-linux.yml`, `latest.yml`. So the two products were
writing the same three names, and the last leg to finish won. Downloaded from
release `v1.2.338`:

```
version: 1.2.338
path: CamStackViewer-1.2.338-arm64.dmg
```

That is `latest-mac.yml` — the file the **full** app reads. The full CamStack
app's macOS updater was pointed at the reduced product, on every install in the
field, for every release since the viewer leg was added (2026-09-09).

It has not yet turned a hub into a viewer, and the reason is an accident.
`MacUpdater.doDownloadUpdate` resolves the feed's files, keeps only the ones
matching the running arch, and calls `findFile(files, "zip", …)` — Squirrel.Mac
applies a **zip**, never a dmg. The viewer declared `mac.target: [{target:
"dmg"}]`, so the release holds `CamStack-1.2.338-arm64.zip` but no
`CamStackViewer-*.zip`, and the full app threw `ERR_UPDATER_ZIP_FILE_NOT_FOUND`
instead of installing the wrong product over the right one. The viewer's own
updater failed the same way, for the same reason — it detected an update it
could never apply.

The sequencing is the whole point of this record. **Adding the missing zip
before separating the channels converts a failure into a real cross-product
install.** The two changes are not independent, and they are not ordered by
taste.

The same collision exists on linux (`latest-linux.yml`; both products ship an
AppImage, both legs run x64) and would exist on windows (`latest.yml`) the day a
win runner is added — the viewer declares no `win` block, so it would inherit
the shared name.

The alternative that was already tried and reverted is in `release.yml` near the
`max-parallel` note: **splitting the viewer onto its own tag and its own
release**. It was reverted because it moves only ~232 MB of a ~2.2 GB release —
about 10% — and costs a second release to remember, for a product that is built
from the same commit as the first. It does separate the feeds, but only as a
side effect of separating everything else, and it pays in operator procedure
what a channel pays in one JSON key. A channel is the mechanism electron-builder
offers for exactly this, it is read by both halves (publish and runtime) from
the same value, and it leaves the single-tag release — which the workflow header
calls its shape — intact.

## Decision

Each desktop product declares an explicit `publish[].channel`, and the runtime
selects the same one. The full app keeps `latest`; the reduced app is `viewer`.
The channel lives once, in `packages/desktop/src/product/update-channel.ts`,
from which `initAutoUpdater` sets `autoUpdater.channel` per product and against
which the guard asserts both electron-builder configs. A product that ships a
mac target with electron-updater in it ships `zip` alongside `dmg`, because a
dmg-only feed is an update that downloads and cannot apply — and that zip is
only safe once the channels are separate.

The full app keeps `latest` deliberately, and it is not symmetry: every CamStack
install in the field carries an `app-update.yml` with no channel in it and will
ask for `latest-*.yml` forever. Leaving the full product there rescues that
installed base the moment the viewer stops overwriting its feed; moving it would
strand it.

## Consequences

- Feed filenames, before → after:

  | product | platform | before | after |
  | --- | --- | --- | --- |
  | CamStack | mac | `latest-mac.yml` | `latest-mac.yml` |
  | CamStack | linux x64 | `latest-linux.yml` | `latest-linux.yml` |
  | CamStack | windows | `latest.yml` | `latest.yml` |
  | CamStack Viewer | mac | `latest-mac.yml` ⟵ collision | `viewer-mac.yml` |
  | CamStack Viewer | linux x64 | `latest-linux.yml` ⟵ collision | `viewer-linux.yml` |
  | CamStack Viewer | windows | `latest.yml` (would collide) | `viewer.yml` |

- **Viewer installs made before this change are stranded, and must not be left
  to auto-update.** Their baked `app-update.yml` has no channel, so they will
  keep asking for `latest-mac.yml` — which from the next release names the FULL
  CamStack zip, and, the zip now being present, Squirrel.Mac would apply it.
  A viewer would become a CamStack. The product is twelve days old and lives on
  the operator's own machines: those installs get replaced from the release page
  once, by hand. This is the one-time cost of having shipped two products on one
  feed name, and it is paid on the smaller, newer base rather than the larger,
  older one.
- The release workflow stages the feed by a **per-leg** glob (`matrix.feed_glob`)
  rather than a shared `latest*.yml`, which after the split would have attached
  no viewer feed at all.
- The viewer's mac zip is signed like its dmg but, like the full product's zip,
  is not separately notarized — the workflow's `xcrun notarytool` loop iterates
  `*.dmg`. That is unchanged posture, not a new gap: an in-place Squirrel update
  is not subject to quarantine.
- **Not fixed here, same species, found while verifying this:** the full
  product's two mac legs (arm64 and x64) run as separate jobs and each writes
  its own `latest-mac.yml` listing only its own arch's files. The second upload
  overwrites the first, so one of the two arches reads a feed with nothing for
  it (`filterFilesForArch` empties the list, `findFile` throws
  `ERR_UPDATER_NO_FILES_PROVIDED`). A channel cannot fix that — electron-updater
  reads one `<channel>-mac.yml` regardless of arch — it needs the two legs'
  feeds MERGED before upload. Stated so the next reader does not mistake a
  green guard for a working mac updater on both arches.

## Enforcement

`scripts/check-desktop-update-feeds.ts`, wired into `.github/workflows/ci.yml`.
It fails when either config omits an explicit channel, when the two products'
computed feed filenames collide on any platform/arch, when a mac product with
the updater shipped has no `zip` target, when the runtime constants disagree
with what the configs publish, or when a release leg stages a feed glob that is
not its channel's. Proved red by reverting each of those five, one at a time.
`packages/desktop/src/__tests__/update-channel.test.ts` pins the filename
algorithm (it replicates `getUpdateInfoFileName` in app-builder-lib 26.15.3 and
`Provider.getChannelFilePrefix` in electron-updater 6.8.9) and re-asserts the
config↔runtime agreement inside the package's own suite.
