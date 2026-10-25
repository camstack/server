---
id: D313
title: "A notification states versions it READ BACK; unknown is an absent field, and a recovery taps where its failure taps"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/kernel/lifecycle/lifecycle-job-engine.ts
  - server/backend/src/core/addon/addon-package.service.ts
  - server/backend/src/core/addon/addon-registry.service.ts
  - packages/addon-post-analysis/src/notification-center/update-complete-coalescer.ts
  - packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts
---

## Context

An operator update of `@camstack/addon-terminal` on 2026-08-30 produced this
notification, minted by code that was current at the time:

```
@camstack/addon-terminal 0.0.0 → latest (hub)
```

The real transition was `0.1.47 → 0.1.51`, and `addons.listUpdates` had reported
exactly that pair minutes earlier. **Neither number in the sentence existed.**
Two independent faults, each of which restated a version instead of reading one:

- **`toVersion` was the REQUEST.** `addons.updatePackage` with no version
  resolves the input to the literal dist-tag `'latest'`
  (`cap-providers.ts`) and starts a lifecycle job with `toVersion: 'latest'`.
  `StagingArea.fetchAndStage` ALREADY resolves it — it unpacks the tarball,
  reads `version` out of the staged `package.json`, and returns
  `resolvedVersion` — and `LifecycleJobEngine.fetchAddonTask` destructured only
  `.stagedPath` and threw the answer away. The string `'latest'` then travelled
  into `applyStagedAddonUpdate`, into `AddonManifest` as the recorded installed
  version, into `refreshPackageVersion` as the version the Addons page
  displayed, and onto the `addon.updated` event.
- **`fromVersion` was a fallback.** `getInstalledPackageVersion` restated the
  on-disk layout as `<addonsDir>/<name-without-scope>/package.json`. Nothing
  has been installed flat since the scope directories landed — the package is
  at `<addonsDir>/@camstack/addon-terminal/`, which is where
  `AddonInstaller.applyUpdateFromStaged` swaps it and where
  `packInstalledPackage` reads it. The second chance,
  `require.resolve('<pkg>/package.json')`, cannot succeed either: an addon is
  installed under the data directory, never in the hub's own `node_modules`.
  Both misses landed on the literal `'0.0.0'`.

The same lookup fed `isFirstInstall = !previousVersion`, and `'0.0.0'` is
truthy — so a genuine first install took the update path and `applyUpdate`
threw `not currently tracked in manifest`. That latent bug and the false
sentence are one root cause.

A separate report the same day: a delivered push for "Il dispositivo
Camera sala feste è online" arrived with `tapAction.value: null`, while
the same camera's `device-offline` an hour earlier tapped through to the
Stream Broker tab. `device-online` simply had no entry in the D305 map, as did
`stream-online` and the legacy `camera-online`.

**What was ruled out.** The first read of that row was that the intake had lost
`nodeId` — the frozen `systemEvent` in `notificationRules.getHistory` carries
none. It has not: `historySystemEvent` projects `{kind, subject, title, body,
data}` and drops `nodeId`, `deviceId`, `deviceType` and `packageName` before
the operator ever sees the row. The durable outbox payload carries them, and
`viewerUrlBase` is demonstrably live — the delivered action buttons were signed
with `pickArtifactBaseUrl(await this.ncEndpoints())`, the identical expression
`viewerUrlBase` is bound to. Diagnosing from the history projection would have
produced a fix for a bug that does not exist.

## Decision

**A version a notification states is one the system READ BACK from disk, never
one it was asked for; and a version it could not read is an ABSENT field, never
a placeholder shaped like a version.**

1. **One resolver.** A dist-tag is resolved exactly once, by
   `LifecycleJobEngine.fetchAddonTask`, which rewrites the task's `toVersion`
   to the `resolvedVersion` the staging area read out of the tarball.
   Everything downstream — apply, manifest, registry, event, journal, the
   Addons page — receives that one answer. `applyStagedAddonUpdate` does NOT
   re-derive it: a second reader of "what version is this" is a second thing
   that can disagree.
2. **One layout authority.** "What is installed right now" is
   `AddonInstaller.getInstalledPackage`, which owns the scoped-and-flat path
   knowledge. No caller restates it.
3. **`null`, not `'0.0.0'`.** `getInstalledPackageVersion` returns
   `string | null`, `emitUpdateEvent` takes `string | null`, and
   `addonUpdatePayload` OMITS the key. `parseAddonUpdateComplete` accepts the
   absent field and the sentence reads `@camstack/addon-terminal → 0.1.51`.
   The notification still ARRIVES — the update happened — it just says nothing
   about the half it does not know. `toVersion` stays required, because it is
   what separates a package update from a settings save
   (`BaseAddon.updateGlobalSettings` emits the same category with no versions).
4. **A recovery taps where its failure taps.** `device-online`,
   `stream-online` and `camera-online` join their down twins in the D305 map.
   "Did it really come back, and what did it do while it was gone" is an
   action, and the page that answers it is the one the down-notification
   already opened. A recovery whose DOWN direction has no action still gets
   none — this widens no destination, only the set of kinds reaching one.

## Consequences

- The manifest and the Addons page stop recording `latest` as an installed
  version. Rows written before this still carry it; nothing migrates them, and
  the next real update of each package overwrites it.
- A first install now detects correctly, so `updatePackage` on an uninstalled
  package takes `installFromNpm` instead of throwing.
- `AddonUpdateComplete.fromVersion` is optional. Any future consumer must
  handle its absence; the sentence builder is the only one today.
- The rule tester's synthetic versions moved off `0.0.0` — a test fire is
  byte-for-byte an ordinary notification, so its placeholders teach the
  operator how to read the real ones.
- **`addon-updated` (past tense) still has NO tap target**, deliberately: the
  update is applied, and `/system/addons` would open a list showing the package
  already up to date. If an operator wants to see WHAT CHANGED, that is a
  changelog surface which does not exist, and inventing a link to a page that
  cannot answer is the failure D305 names as the worst of the three.
- `notificationRules.getHistory` still projects a lossy `systemEvent`. That is
  a read-model limitation, not a defect in the row — but it is the reason a
  future session must never diagnose tap targets from history.

## Enforcement

- `scripts/check-notification-tap-targets.ts` (CI) gained the two recovery
  cases and probes all eight mapped kinds, so a recovery losing its action
  fails the build.
- `packages/system/src/kernel/lifecycle/__tests__/lifecycle-job-engine.spec.ts`
  — a task whose `toVersion` is `'latest'` applies, and journals, the resolved
  exact version.
- `server/backend/src/core/addon/__tests__/addon-update-event-versions.spec.ts`
  — the emitted event's versions, through the real service against a real
  addons tree. It deliberately names a package with **no workspace copy**:
  `require.resolve` walks up out of a worktree into
  `camstack-server/node_modules/@camstack/*`, so a test named after the live
  package read `0.1.51` from the developer's checkout and never reproduced the
  hub. A separate case pins the emitted PAYLOAD (`addonUpdatePayload`), because
  the service-level test stubs `emitUpdateEvent` and would pass just as well if
  the registry wrote `fromVersion: null` onto the wire.
- `.../notification-center/__tests__/system-event-intake.spec.ts` — the
  rendered Italian sentence, both with and without a predecessor, plus a
  settings save still producing nothing.
- `.../__tests__/notification-center-system-event.spec.ts` — `nodeId` frozen on
  the durable outbox row, asserted from a RAW bus event. This one is a
  regression pin, not a fix: it passed before the change, and it exists so the
  history-projection red herring above is never chased twice.
