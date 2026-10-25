---
id: D330
title: A kill-switched feature is deleted, or it is re-opened — it is never left switched off
status: accepted
date: 2026-09-01
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-selection.ts
  - scripts/check-summary-ladder-reachable.ts
---

## Context

The co-moving GROUP entity shipped on 2026-08-24 — a second detection line
beside the track, with its own crop, its own two tables
(`pipeline-analytics:track-groups`, `:track-group-members`), two cap methods
(`listGroups` / `getGroup`), two custom actions (`analytics.listGroups` /
`analytics.getGroup`), a cascade leg, an orphan-audit resolver, and two head
rungs on the digest media ladder (`groupCrop`, `nativeFrame`).

It was kill-switched the SAME DAY: duplicate sealed rows made Library → Gruppi
show the same camera and the same minute a dozen times. `GROUPS_PROCESS_ENABLED`
went to `false` in `group-enabled.ts`, `LIBRARY_GROUPS_ENABLED` went to `false`
in the viewer, and the roadmap said "re-open only after a field verification".

Eight days of that state cost more than the feature ever paid for:

- The digest shipped a WHOLE FRAME instead of the subjects for three days,
  because the same commit that turned the switch off had also moved the two
  group-only rungs to the head of the ladder. Nothing owned the pair; both
  halves reviewed as correct in isolation ([D247](adr-0247-a-digest-tile-is-a-subject-and-a-kill-switch-never-amputates-a-ladder.md)).
- `group-sealer.ts` kept a live `fullFrameBoxed` write with no reader, flagged
  in the event-media inventory as a leftover to delete "when next touching that
  file".
- Every reader of `buildSummaryPorts.listTracks`, of the cascade registry, of
  `TrackCascadeCounts` and of the orphan audit had to carry a second, dead
  branch and reason about which one was live.
- 4 123 lines of code and 12 spec files stayed green while running nothing.

A switch that is off is not free. It is a second live design that the type
system, the tests and the reviewer all still have to serve.

## Decision

**A feature behind a kill switch is either re-opened or DELETED. "Off" is not a
resting state.** When the operator decides against re-opening, the removal takes
everything with it in one change — the code, the switch, the cap methods, the
custom actions, the tests, the docs, and the tables
([D183](adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)).

The instance, executed 2026-09-01 on operator decision: the group entity is
gone. `packages/addon-post-analysis/src/pipeline-analytics/group/` is deleted; <!-- drift-ok: naming the deleted directory IS the record -->
both tables are in `RETIRED_COLLECTIONS` and are dropped at every boot of the
settings engine; `listGroups` / `getGroup` and the two custom actions are off
the wire; `TrackCascadeCounts.groups` is off the cap; `SUMMARY_MEDIA_LADDER`
starts at `thumbnail`.

**Media outlives its owner's table, so a retired owner kind is named rather
than forgotten.** Group-owned rows in the SHARED `pipeline-analytics:media`
collection cannot be retired with a table drop and cannot be left resolving to
`unresolvable` — that answer means "I do not know", and the audit never deletes
what it does not know. `RETIRED_OWNER_KINDS` (media-store) lists `'group'`,
`'group'` is NOT a member of `OWNER_KINDS` so nothing can write it again, and
`resolveMediaOwner` maps it to `{ kind: 'retired-owner' }` — an owner that can
never exist, therefore always an orphan, collected by the existing audit under
the same grace window and the same reclaim ceiling as everything else.

## Consequences

- The notification-center burst merge ([D143](adr-0143.md)) is UNTOUCHED and
  stays on. It is a different path with a different table
  (`notification-center:track-groups`), a different buffer
  (`NcGroupBuffer`) and a different card. Anyone reading "groups" in this repo
  now means that one.
- `SUMMARY_GROUP_ONLY_RUNGS` is gone: with no group process there is no rung a
  switch can make unreachable. `scripts/check-summary-ladder-reachable.ts`
  keeps the invariant that outlived the switch — the HEAD of the ladder must be
  a subject crop — and no longer reads a kill switch.
- `pruneTracksBefore` / `wipeAllAnalytics` return six counters, not seven. The
  cascade registry is five legs, not six.
- Re-introducing groups is a new design, not a flag flip. That is the intended
  cost: the previous version was never made to work, and preserving it as dead
  code preserved the illusion that it had been.

## Enforcement

- `packages/system/src/builtins/sqlite-storage/__tests__/retired-collections.spec.ts` <!-- drift-ok: deleted 2026-10-22 (D901) -->
  runs the real `SqliteSettingsBackend` on `:memory:` — the two group tables are
  dropped like any other retired collection, and a table listed there while
  something still declares it produces a drop/re-create churn on every boot.
- `orphan-audit.spec.ts` pins the retired-owner resolution: a media row with
  `ownerKind: 'group'` resolves to `{ kind: 'retired-owner' }`, NOT to
  `unresolvable` — the difference between a row that gets collected and a row
  that is stranded forever.
- `cascade-completeness.spec.ts` seeds one row of every entry in
  `TRACK_OWNED_FAMILIES` and asserts none survives; deleting a family without
  deleting its seeder turns it red in both directions.
- `scripts/check-summary-ladder-reachable.ts` in CI.
- Nothing enforces the RULE itself — a new kill switch cannot be detected by a
  script. What is enforced is the removal being complete once the decision is
  made.
