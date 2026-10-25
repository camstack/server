---
id: D327
title: Occupancy of a location that shares a disk is the class subtree, never the shared root
status: accepted
date: 2026-09-01
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/location-occupancy.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
  - packages/system/src/builtins/storage-orchestrator/__tests__/location-occupancy.spec.ts
---

## Context

[D293](adr-0293-a-location-is-deleted-only-after-it-is-verified-empty-and-unreachable-is-not-empty.md)
still holds: `deleteLocation` proceeds only on a verified `'empty'`, `'unknown'`
refuses, `force` overrides both. What D293's probe *measured* was wrong on this
hub.

A recordings disk hosts several classes at one `basePath`:

```
<root>/<camera>/high|mid   recordings
<root>/<camera>/low        recordingsLow
<root>/<camera>/events     eventMedia
```

The live layout after the 2026-08-29/30 drain is exactly that: `recordings:default`
writes high/mid under `/recordings`, while a drained `eventMedia:default` and
`recordingsLow:default` still *named* the same root. D293's probe did a shallow
`readdir` of that root. Camera directories plus `.camstack-location` made every
class look occupied, so a drained events/low location could not be deleted
without `force` — and `force` is how you lose an archive you cannot see.

Observed 2026-09-01, after a verified empty of the `events/` and `low/` trees:
the UI still refused the delete. The sibling `high/` footage was the only
occupant.

A recursive `find` of the volume is not the fix. One hung this hub on
2026-08-29; that is why D293 forbade a walk.

## Decision

**Occupancy of a class-mapped location is the class subtree under each camera
directory, never any non-dot entry at the shared root.**

| `location.type` | occupied iff any `<camera>/…` has an entry |
| --- | --- |
| `eventMedia` | `events/` |
| `recordingsLow` | `low/` |
| `recordings` | `high/` or `mid/` |
| anything else | any non-dot entry at the root (legacy: backups, addon-data) |

The walk stays shallow: one `readdir` of the root (one dirent per camera) plus
`opendir`+first-entry of each named subtree. Missing root is `'empty'`. Any
errno other than `ENOENT` is `'unknown'` (D49). Dotfiles at the root
(`.camstack-location`) are not occupancy.

The subtree map is the same as the discard wipe (`DISCARD_SUBTREES` in the
recorder and pipeline-analytics addons). Those two copies must stay in sync;
a third, different map is how a drained class looks full again.

## Consequences

- A drained `eventMedia` / `recordingsLow` location that shares `/recordings`
  with live high footage deletes without `force` when its subtree is empty.
- D293's refuse-unless-empty / unknown-refuses / force-override rule is
  unchanged. This record replaces only the measurement.
- A type not in the map still uses the root. Adding a class that shares the
  recordings tree without adding it to `STORAGE_CLASS_SUBTREES` reintroduces
  this bug.
- `.camstack-location` is not occupancy. Wiping or reformatting a volume still
  requires restoring that marker, or the recorder freezes the location as a
  volume mismatch — a different failure, observed the same day.

## Enforcement

`packages/system/src/builtins/storage-orchestrator/__tests__/location-occupancy.spec.ts`
— class subtree occupied, sibling class ignored, missing root empty, dotfile
at the root ignored, unmapped type still uses the root. Disarming the subtree
map fails the sibling-class case. Review-only that the walk stay non-recursive.
