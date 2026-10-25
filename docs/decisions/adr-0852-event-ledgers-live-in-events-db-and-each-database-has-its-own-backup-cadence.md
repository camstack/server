---
id: D852
title: Event and detection ledgers live in events.db; each database is backed up on its own cadence — settings nightly, events and history weekly — and an archive restores only the databases it carries
status: proposed
date: 2026-10-14
supersedes:
applies-to:
  - packages/types/src/capabilities/database-snapshot.cap.ts
  - packages/system/src/builtins/system-backup/system-backup.service.ts
  - packages/system/src/builtins/backup-orchestrator/schedule-store.ts
  - server/backend/src/sqlite-restore.ts
---

## Context

Every nightly archive carries a verified snapshot of the whole `camstack.db`
(D693), ~1.3 GB, of which configuration is ~150 MB; the rest is tracks, events,
media index, vectors and notification history. The archive walk swaps every
owned database it finds under `addons-data` for its snapshot, so a second file in
that directory would ride in every archive too. A nightly copy of 1.5 GB of
observations, written again every night, buys little: losing a week of them is a
gap in history, losing a day of configuration is an outage.

> **Backup half implemented (P1, 2026-10-15)** — per-database snapshots, the
> weekly schedule, per-cadence retention. Status stays `proposed` until the
> `events.db` half (P5) lands.

## Decision

**`events.db` holds what was observed — tracks and their relations, object,
motion, audio and sensor events, the media index, faces, plates and samples, the
retrain frames and annotations, the sweep cursors over them, notification
history (outbox, artifacts, track groups, suppressed) and every vector index.
Configuration and small live-state ledgers that gate decisions stay in
`camstack.db`.** `database-snapshot` lists and writes snapshots per database
id. An archive carries only the databases it was asked for; absent a selection
it carries settings alone. The existing schedules stay settings-only and nightly;
a seeded weekly schedule carries settings, events and history together.
`history.db` is weekly: it is a statistical store whose loss costs chart gaps,
and nightly would add its size to every archive. A restore promotes only the
snapshots the archive carries and leaves every other live file in place.

## Consequences

- A restore can mix ages (nightly settings, weekly events); a reference from one
  file to a row of the other may dangle and is read as absent, which every
  reader already does for a pruned track or media row.
- The manual backup dialog and the schedule editor choose databases; the restore
  wizard says which ones an archive carries.
- `camstack.db` shrinks to configuration, so its snapshot, checkpoint and
  integrity check get cheap.

## Enforcement

`system-backup` specs: a settings-only archive omits the events snapshot (with a
disarm), a live database file never enters the tar, a settings-only restore
leaves `events.db` untouched; the seed is created once and never overwrites.
The new guard `check-collection-database-placement` refuses a `config` collection
outside settings. Not yet built.
