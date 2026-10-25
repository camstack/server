---
title: Timer-driven collection reads in the admin UI — audit
date: 2026-08-31
status: audit (read-only; nothing here is fixed)
covers:
  - packages/addon-admin-ui/src
  - packages/ui-library/src
---

# Timer-driven collection reads — audit

Companion to [D320](../decisions/adr-0320-a-walk-that-answers-a-question-is-bounded-single-flighted-and-never-on-a-timer.md)
and to [the store-saturation note](2026-08-31-settings-store-saturation.md).

D320 fixed **one** timer-driven collection walk: `StorageMigrationSection`'s
residue census, which polled every 10 s, walked 1.26 M rows 200 at a time,
could not stop and was not single-flighted. Left open, it put a **~16 s
standing FIFO backlog in front of every settings-store call in the cluster**.

The operator's response was the general rule, and it is the reason this audit
exists:

> *a read whose cost is proportional to the filesystem or to a whole
> collection is initiated by the operator, never by a timer.*

This is the survey of every other timer-driven refetch in the two UI trees.
**Nothing below is fixed.** `useStorageMigrationResidue` is excluded — D320
covers it.

## Clear defects, worst first

| # | file:line | what it polls | interval | why it is expensive |
| --- | --- | --- | --- | --- |
| 1 | `ui-library/src/composites/device-export-panel.tsx:278` | `deviceManager.listAll({})` | **5 s** | full-table `SELECT … ORDER BY "deviceId"`, ~1 017 rows a call (`device-row-store.ts:554`) |
| 2 | `addon-admin-ui/src/components/pipeline/cameras/use-cameras-overview.ts:89` | `pipelineOrchestrator.getCameraStatuses({})` | **5 s** | `Promise.all(ids.map(getCameraStatus))` over the whole assigned fleet; each is a 7-stage cross-node RPC fan-out (`camera-status-service.ts:879`) |
| 3 | `addon-admin-ui/src/pages/system/Terminal.tsx:186` | `terminalSession.listLegacyCameras` | 10 s | resolves to `deviceManager.listAll` (`addon-terminal/src/addon.ts:723`) |
| 4 | `addon-admin-ui/src/components/detection-intelligence/use-stationary-objects.ts:35` | `zoneAnalytics.getCurrentSnapshot` | 15 s × N cameras | one query per camera (`StationarySection.tsx:85`) |
| 5 | `addon-admin-ui/src/pages/IntegrationDetail.tsx:220` | `deviceManager.listAll` | 30 s | same full-table read; the page comment already calls it "full, non-slim" |
| 6 | ~~`addon-admin-ui/src/components/detection-intelligence/UnassignedFaces.tsx:259`~~ **FIXED — [D323](../decisions/adr-0323-a-timer-may-keep-its-poll-if-the-question-becomes-a-predicate-and-a-name-map-is-a-lookup.md)** | `faceGallery.listRecentFaces` | 30 s (kept) | paging sweep up to 1 000 pages × 1 000 rows plus an unbounded `listIdentities()`. All four views were expressible as store predicates, so the sweep was a workaround: the poll stays and the QUESTION became one indexed statement whose cost is the answer |
| 7 | `addon-admin-ui/src/components/detection-intelligence/use-key-events-feed.ts:50` and `addon-admin-ui/src/hooks/use-scenes-feed.ts:37` | `pipelineAnalytics.getKeyEvents`, `sceneMonitor.listScenes` | 30 s × N cameras | one query per camera each |

## Arguable — judgement, not a verdict

- `NodeLoadOverview.tsx:75` — `getAgentLoad`, 20 s: scales with **nodes**, not rows. It is also the only `refetchOnWindowFocus: true` in either tree (`:76`).
- ~~`RecentPlates.tsx:267`~~ **FIXED — [D323](../decisions/adr-0323-a-timer-may-keep-its-poll-if-the-question-becomes-a-predicate-and-a-name-map-is-a-lookup.md)**: rows bounded at 200, but `plate-gallery-provider.ts` called an unbounded `vehicleStore.listVehicles()` per poll. The verdict: it shares the name-map defect exactly and not the sweep. The bound was also never the whole story — with no index on `timestamp` the bounded read still SCANned the table and sorted it whole.
- `IntegrationUsage.tsx:7` — unbounded query over a small collection.
- `StorageMigrationSection.tsx:529` — `movers`, 2 s: aggressive, but job-list sized.
- `AddonsJobProgress.tsx:125`, `AdoptJobProgress.tsx:46` — self-disable when idle, which bounds the blast radius.

## Verified cheap — do not re-investigate

~20 sites poll a **single device**, a single addon's status object, or an
in-memory map: `AlertBell`, `StreamsTab`, `DiskReconcileSection`,
`ExportsSection`, `NodeServerManagementSection`, `HubHero` + `discovery-panel`,
`Terminal.tsx:176/182`, `ScriptsTab`/`AutomationsTab`, `DeviceAggregateSection`,
`DeviceLiveInfoSection`, `NodeInferenceDevices`, `TracksTab`, `OverviewTab`,
`DeviceDetail.tsx:285/589/613/624`, `use-device-autotrack`, and the per-addon
status reads in `MeshNetworks` / `RemoteAccess` / `PublicMediaOrigin` /
`Integrations`. **The rule is not "no timers" — it is "no timer on a walk."**

A `setInterval` sweep of both trees found only clock ticks and
player/session-local polls; none drives a collection or filesystem read.

## Unresolved — implementation not located

Not classified, and three of them are plausible filesystem walks:

- `llm.listRuntimeNodes` — `AiRuntimes.tsx:37` at 5 s (model directories)
- `system.getLoggingSettings` — `LogDiagnostics.tsx:47` at 5 s (a log-dir walk would matter at this cadence)
- `localNetwork.getTlsStatus` / `list` — `NetworkAddresses.tsx:71,96`, `LocalAccess.tsx:32`, 15–30 s (may shell out or read certs)

Also unresolved: `addons.list` / `listCapabilityProviders` / `listUpdates`
(registry-side, likely in-memory but unverified), `deviceManager.getChildren`
(`useDevice.ts:106`, 2 s — indexed `whereIn` or fleet scan is undetermined),
`storageMigration.status`, `notificationRules.listSnoozes`,
`nc.getRuleStatus`, `addons.listJobs`, `deviceManagerAdoption.listJobs`,
`addonWidgets.listWidgets`, `deviceExport.listExposedDevices`, and the
addon-pages query at `AppLayout.tsx:150`.

## What is owed

Each clear defect needs the D320 treatment, chosen per site rather than
uniformly: a **Refresh button** with a `Measured <time>` stamp where the
operator wants a current figure; a push subscription where one already exists;
a narrower question where the caller needs one fact rather than the collection.

**A fourth option, and it should be tried first** — added after fixing #6, which
turned out to need none of the above. If the question is expressible as an
indexed PREDICATE, the timer may stay: make the read cost the answer instead of
the table and a 30 s poll is unremarkable. A page loop with a thousand-page
ceiling is usually there because someone concluded the question could not be
expressed, and that conclusion is worth re-checking before reaching for an
affordance — the faces sweep said so in its own docblock and was wrong about all
four of its filters. See [D323](../decisions/adr-0323-a-timer-may-keep-its-poll-if-the-question-becomes-a-predicate-and-a-name-map-is-a-lookup.md).
D320 deliberately shipped **no guard** for this rule — it could not be stated
precisely enough to be cheap, and a vague guard is worse than none — so these
sites are review-only until someone can express it exactly.

## Acted on — [D322](../decisions/adr-0322-a-poll-asks-each-question-once-and-a-batch-answers-for-every-id.md), 2026-08-31

Rows **2, 4 and 7** are done, and NOT by the Refresh-button remedy above. The
operator's direction on these four was explicit — *"va bene il refetch
continuo, ma devono essere query ottimizzate al massimo"* [continuous refetch is fine, but the queries must be optimised to the maximum] — so the polls stay
and the QUESTION got smaller instead:

| # | site | remedy | before → after |
| --- | --- | --- | --- |
| 2 | `getCameraStatuses` | the pass asks each distinct question once | **16 → 8** round trips per camera, plus 8 per pass regardless of fleet size (464 → 240 at 29 cameras) |
| 4 | `zoneAnalytics.getCurrentSnapshot` | `getCurrentSnapshotBatch` | **N → 1** per 15 s refresh |
| 7 | `pipelineAnalytics.getKeyEvents`, `sceneMonitor.listScenes` | `getKeyEventsBatch`, `listScenesBatch` | **N → 1** each per 30 s refresh |

The verdict on row 2's "7-stage fan-out": two of the seven stages were already
free, and the cost was that **six questions that are not about a camera were
asked once per camera**. A maintained snapshot was REFUSED for it — the
orchestrator owns none of those six facts, so a snapshot there would be D224's
forbidden second copy six times over. See D322 for the full stage table.

Still open from the list above: rows 1, 3, 5 (`deviceManager.listAll`) and row
6 (the face sweep) — held by other work at the time of writing.
