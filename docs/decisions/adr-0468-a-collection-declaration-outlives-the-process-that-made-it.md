---
id: D468
title: A collection declaration outlives the process that made it
status: accepted
date: 2026-09-12
applies-to:
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
  - packages/system/src/builtins/system-backup/system-backup.service.ts
---

## Context

For about six hours on 2026-09-12 the hub failed nearly every settings read and
write in the cluster with `collection "X" is not declared`. The operator could
not log in (`auth-webauthn:user_passkeys`), `BindingCache.isActive` failed and
the pipeline logged `frames will drop as inactive`, `recorder:segment-hours`
writes were lost ("this key may re-seed on boot"), and hub CPU went from its
212 % baseline to over 1 000 %. 161 857 occurrences were still in the log when
it was found — and only because the operator asked whether the server was dead.

**Reproduced deliberately**, by triggering a backup by hand:

```
before : [hub/sqlite-settings] pid 162      0 errors
after  : [hub/sqlite-settings] pid 349597   1 624 errors in two minutes

[process-service EXIT] runner=sqlite-settings code=null signal=SIGBUS state=running
```

The chain, end to end:

1. the nightly backup (`0 3 * * *`) opens a **second** connection to the live
   settings database and issues `wal_checkpoint(TRUNCATE)`;
2. TRUNCATE zeroes the WAL file — under the live process's **mmap** (this
   backend logs `mapsWholeFile`);
3. the live process touches a page that no longer exists → **SIGBUS**;
4. `CrashSupervisor` respawns the addon → a NEW `SqliteSettingsBackend` with an
   empty `declaredCollections` Map;
5. every other addon is still running and never re-declares — each declared
   once, at its own boot — so the cluster fails forever, silently, until each
   addon is restarted by hand.

The first investigation blamed the recorder, because restarting the recorder
fixed the recorder's rows. It fixed only its own, which is the tell: the damage
is in the BACKEND and the repair is per-owner.

## Decision

**Two layers, because the trigger and the blast radius are different bugs.**

The checkpoint is `PASSIVE`, never `TRUNCATE`. The archive already tars the
`-wal`/`-shm` sidecars and this service's own comment calls the result
"already crash-recoverable on restore" — the checkpoint is tidiness, and the
blocking, file-truncating variant is not worth a live production database.

And a declaration is **persisted** (`_collection_declarations`) and reloaded at
init, before the first read. The tables are durable; what the backend knows
about them is now durable too. A restored declaration is dropped when its table
is absent from `sqlite_master` — a memo for something that is gone is worse
than no memo.

## Consequences

- **`booleanColumns` is the reason a schema read-back is not enough.** SQLite
  has no boolean type, so "the table exists" cannot recover the semantics; a
  consumer that declared `z.boolean()` would be handed a `1`. The persisted
  form carries it, and the test pins it separately from the table name.
- The backend no longer depends on being the first thing that ever ran. Any
  respawn — SIGBUS, OOM, a crash, an operator restart — is now survivable.
- Persisting is best-effort and logged at `warn` on failure: a declaration must
  not fail because the memo could not be written, but silence there is what
  makes the NEXT respawn another outage. The restore logs at `info` with a
  count, because on a respawn that line is the difference between "it came
  back" and six hours of guessing.
- **Not fixed here: nothing announces that the settings store restarted.** No
  addon is told, no health check notices, and the failure presents as thousands
  of unrelated-looking errors in other addons. That is why this took six hours
  and a locked-out operator to find.

## Enforcement

`declarations-survive-respawn.spec.ts` opens a backend, declares, writes,
shuts down, and opens a FRESH backend on the same file with nothing
re-declaring — which is exactly the live failure. Both arms were watched fail
first. The `PASSIVE` change is gated by the existing sidecar-dropping
assertion in `system-backup.service.spec.ts`, disarm-checked: removing the
checkpoint entirely turns it red.

## Amendment 2026-09-29 — the diagnosis above is wrong; see D679

The chain in Context is wrong at steps 1–3, and so the `PASSIVE` half of the
Decision fixed nothing. The SIGBUS kept coming after most 03:00 backups for
17 more days (09-12 → 09-29).

- **The WAL is not mapped.** SQLite reads it with `pread`, so "TRUNCATE zeroes
  the WAL under the mmap" cannot fault.
- **What faulted was the `-shm`.** The checkpoint worker (D452) opened and
  closed `-shm` once a second. That `close()` dropped the runner's DMS lock on
  it. The backup's second connection, TRUNCATE or PASSIVE alike, then found
  no lock, believed it was first and rebuilt the `-shm` under the runner's
  mappings.
- **The trigger was the backup's OPEN, not its checkpoint mode.**

[D679](adr-0679-a-live-sqlite-file-is-reached-only-through-its-owners-connection.md)
has the evidence (`/proc/locks`, crash-after-backup timings, a reproduction).
It removes the worker's `-shm` read and the backup's connection, and guards
both shapes. Steps 4–5 and the persisted declarations are unaffected and stay:
they are why each of those crashes cost a second instead of six hours.
