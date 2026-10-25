---
title: Adding deviceId to idx_media_slot (D694 residual / D447)
status: design-only — do NOT rebuild overnight without a proven migration plan
date: 2026-10-02
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
---

# `idx_media_slot` + `deviceId`

## Why

D694 residual: the media uniqueness index is `(ownerKind, ownerId, kind,
slotTs)` (`MEDIA_SLOT_COLUMNS`). Two records that share a reused event rowid
and write the same kind at the same millisecond UPSERT one row — the second
re-homes `deviceId`/`path` and the first blob is orphaned on disk. Adding
`deviceId` to the slot would make the uniqueness key generation-aware.

## Why it is deferred

Rebuilding `idx_media_slot` over the live media table runs on the settings
store's **synchronous** thread (D447). That thread already measured 4–7 s
blocking every five minutes when an aggregate lacked a covering index; a
full index rebuild of the media table is the same class of hazard as adding
`AUTOINCREMENT` to the event tables (D694 considered and refused that path
for the same reason).

## What a safe migration must prove first

1. **Offline or async rebuild path** that never holds the settings store
   write lock for the whole rebuild — e.g. a new index built under a temporary
   name, then an atomic rename, with a measured upper bound on lock time.
2. **Collision census** on a copy of the live hub: how many
   `(ownerKind, ownerId, kind, slotTs)` groups already span more than one
   `deviceId`? Those rows need an explicit resolution policy before the new
   UNIQUE constraint can be applied.
3. **Writer audit**: every `MediaStore.put` / `putReplacing` / `reown` path
   already stamps `deviceId`; confirm none write `NULL` / omit it for event
   owners (otherwise the new index key is incomplete).
4. **Rollback**: drop/rename back must be documented; a half-applied UNIQUE
   constraint that rejects live writes is worse than the rare orphan.

## Out of scope for this note

Do not start the rebuild from an overnight agent. Pair with AUTOINCREMENT /
producer-allocated ids if those land first — either removes the reuse that
makes the collision possible.
