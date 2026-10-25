---
id: D328
title: The live SQLite file is the bind the container has open — a sibling camstack.db is not a backup, it is a different database
status: accepted
date: 2026-09-01
supersedes:
applies-to:
  - packages/system/src/builtins/sqlite-storage/**
---

## Context

[D147](adr-0147.md) recorded the 2026-08-14 layout: `/data` bound to
`/mnt/cache/appdata/camstack`, so `camstack.db` lived on the NVMe cache pool
and shfs was out of the picture. That was true then. It is not the live file
now.

On 2026-08-25 the sqlite-settings tree was given **its own bind**:

```
/mnt/mixed/camstack/addons-data/sqlite-settings  →  /data/addons-data/sqlite-settings
```

`/mnt/mixed` is `/dev/sdb1`, XFS, a Samsung 870 QVO SSD — not the recordings
HDD, not the cache RAID1. The container still binds `/mnt/cache/appdata/camstack`
→ `/data`, so a `camstack.db` continues to exist under the cache path. That
copy **stopped being written on 2026-08-25**. Opening it looks like opening
production. It is not.

The 2026-08-19 incident (sqlite3 via `/mnt/user` while the container wrote via
`/mnt/cache`) already forbade opening the live file with sqlite3. The 2026-09-01
cleanup added the second half: **which path is live**. The cache file was 1.2 GB
and stale. The mixed file was the one the process had open. VACUUM, DELETE and
integrity_check against the wrong file would have left production untouched and
produced a convincing report about a corpse.

[D147](adr-0147.md) is not superseded: the backup-skip and "don't put the DB
on shfs" halves still hold. Only the *path* it named is stale.

## Decision

**The live SQLite file is the one behind the container's
`sqlite-settings` bind, identified by `docker inspect` on `CamStack`, never by
a path that happens to contain `camstack.db`.**

On this hub that bind is:

```
/mnt/mixed/camstack/addons-data/sqlite-settings/camstack.db
```

Rules:

- Never open that file — or any sibling `camstack.db` — with sqlite3 while
  CamStack is running. Not `mode=ro`. Not `VACUUM INTO`. The 2026-08-19
  corruption was a writer via a second connection.
- A cleanup, VACUUM or integrity_check runs only with the container
  **stopped**, against the bind source `docker inspect` just named, and
  copies the whole trio (`db` / `-wal` / `-shm`) first.
- `/mnt/cache/appdata/camstack/addons-data/sqlite-settings/camstack.db` is
  not a backup of mixed. Treat it as a different database that happens to
  share a name.
- `/data/addons/@camstack/system` must not exist. A shadow copy of the
  kernel there silently wins over the published closure.

## Consequences

- D147's measured path (`/mnt/cache/.../camstack.db`) is historical. Docs
  that still name it as live (load-ledger 2026-08-27, older skill text) are
  wrong and will send the next session to the stale copy.
- Unraid Appdata Backup still skips CamStack (`skip: yes`). The mixed bind
  is even further outside that plugin's walk than the cache path was.
- Reformatting a recordings volume does not touch this file. Wiping
  `/mnt/mixed/camstack/media` would: that tree is `/media-fast` inside the
  container.

## Enforcement

Nothing in CI can see the hub's mounts. Review-only, plus the ops skill and
`CLAUDE.md`. The test is: before any sqlite3 invocation, `docker inspect
CamStack` names the bind, and `docker inspect -f '{{.State.Running}}'` is
`false`.

## Amendment 2026-09-29 — the same rule holds inside the container (D679)

"Never open the live file while CamStack runs" also binds CamStack itself.
It covers any process other than the `hub/sqlite-settings` runner: the
nightly backup opened the live database from hub-main, and that open is what
SIGBUSed the runner. It also covers the runner, which must never open the
files with `fs`: a `close()` of any descriptor drops SQLite's locks.
[D679](adr-0679-a-live-sqlite-file-is-reached-only-through-its-owners-connection.md)
has the chain, and `scripts/check-sqlite-files-not-opened-by-fs.ts` enforces
it.
