---
id: D851
title: One SQLite engine process serves several owned database files, one serving thread per file; a collection's file is declared on declareCollection and a misplaced table is refused, never moved
status: accepted
date: 2026-10-14
supersedes:
applies-to:
  - packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
  - packages/system/src/builtins/storage-orchestrator/data-store-dispatch.ts
  - packages/types/src/capabilities/settings-store.cap.ts
  - packages/types/src/capabilities/data-store-provider.cap.ts
  - packages/system/src/builtins/sqlite-storage/owned-sqlite-file.ts
  - packages/system/src/builtins/sqlite-storage/placement-router.ts
  - packages/system/src/builtins/sqlite-storage/file-host-worker.ts
---

## Context

`camstack.db` holds configuration next to ~1.5 GB of event and detection
ledgers. Every statement runs synchronously on the `sqlite-settings` runner's
main thread, so a scheduled aggregate over the big tables held every
configuration read in the cluster for 4–7 s (D447). Covering indexes fixed that
one statement; the next big table will need the next one. A new history store
(D850) would add another ~1 GB of write-heavy rows to the same file and thread.

Three alternatives were weighed: three engine runners (one process per file —
three times the runner memory and a second engine registrant the data door has
no routing rule for, `data-store-dispatch.ts` refuses more than one engine); a
separate addon owning its own `history.db` (an engine outside the door, which
D44 forbids); and one process with one thread per file — chosen by the operator.

## Decision

**`sqlite-settings` is the one engine and owns several files — `camstack.db`
(settings), `events.db`, `history.db` — each with its own connection on its own
serving thread, its own WAL checkpointer, `-shm` canary, maintenance and
verified snapshot.** Settings keeps the main thread; events and history each run
on a dedicated worker. A collection's file is declared by its owner on
`declareCollection` (`database`, absent = settings) and persisted in that file's
`_collection_declarations`; at boot the engine maps every collection to its file
from those tables, and an undeclared collection is settings. A declaration
whose table already lives in another file is REFUSED with an error naming the
offline split — the engine never moves a table. A `transact` spans one file.
A serving thread that dies fails the runner (respawn, D5/D6).

## Consequences

- The door forwards one more field untouched; routing happens inside the engine,
  so the dispatcher's "one engine" rule stands and its `engine` hint stays unbuilt.
- `declareCollection` also gains composite primary keys, `WITHOUT ROWID` and
  `upsertMany` (fixed on the door, D44).
- A file is created on the first declaration that names it, so a hub where
  nothing names it is unchanged.
- `database-snapshot` becomes per-file (D852).
- Calls to events and history cross a thread boundary (structured clone;
  buffers transferred); the in-flight queue per worker is bounded.

## Enforcement

Engine specs, each with a disarm that turns it red
(`packages/system/src/builtins/sqlite-storage/__tests__/`):
`placement-router.spec.ts` (a table lands only in its file, checked by reopening
the files), `placement-refusal.spec.ts` (the misplaced-table refusal naming the
split), `cross-database-transact.spec.ts`, `file-host-worker.spec.ts` (a typed
error keeps its class, the in-flight bound, a dead worker calls the injected
exit), `owned-file-lifecycle.spec.ts` (one checkpointer, canary and thread per
file; `auto_vacuum` = 2 on a created file), `composite-pk-plan.spec.ts`,
`upsert-many.spec.ts`, and `addon-layout-neutral.spec.ts` (an engine on which
nothing names `events` or `history` creates no other file).
`scripts/check-sqlite-files-not-opened-by-fs.ts` covers the new files.

Not yet built: the guard `check-collection-database-placement`, which checks
that a collection's `@durable database=` and its `declareCollection` literal
agree. It has nothing to check until the first collection names a file other
than `settings`; it lands with that phase (plan P5), together with the
`@durable database=` annotation it reads. Architecture and traps:
`docs/architecture/storage-files.md`.
