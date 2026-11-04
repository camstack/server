---
id: D1006
title: A storage type is pruned only when no INSTALLED package declares it, and a missing writable location is an alert
status: accepted
date: 2026-11-04
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts
  - packages/system/src/builtins/storage-orchestrator/storage-writability-monitor.ts
  - packages/system/src/kernel/addon-loader.ts
---

## Context

On 2026-11-01 a boot where nine addons failed to load (`Cannot find module`)
made the storage orchestrator delete the `<type>:default` row of every type
those addons declared (`artifacts`, `eventMedia`, `recordings`, `recordingsLow`).
The registry the prune consulted was built from LOADED addons only, so "its
declarer did not load" read as "nobody declares it". The prune also left the
seed memory in place, so once the addons were repaired the type was never seeded
again and every event-media write was refused until the operator noticed 404
thumbnails days later.

## Decision

The prune consults every INSTALLED declarer: `kernel.listStorageLocationDeclarers`
lists loaded and failed-to-load addons (a failed load keeps the declarations its
manifest carried). A type declared by an unloaded addon is kept and the skip is
logged by name; a package the kernel could not read at all makes the declarations
unknown, so the whole pass is skipped. A pruned type forgets its seed marker, so a
later re-declaration seeds again, while an operator's delete (which never clears
the marker) keeps sticking. A declared type with no location in a writing mode
raises an alert through the existing alert centre (a liveness finding under
`storage:no-writable-location:<type>`, linking to the Storage page) and clears
itself when one exists; an unanswered store, an unloaded declarer or an unreadable
package raise nothing.

## Consequences

Hubs already hit keep their seed marker with zero rows. That shape is NOT an
operator delete: the service refuses to delete or disable the last enabled
location of a type, so the operator cannot produce it. The repair is therefore safe
on the shape alone: the one-shot D987 migration
`storage-orchestrator/2026-11-04-reseed-pruned-defaults` re-seeds, with the normal
seed rules (media and backup roots), every declared type that has a marker and zero
rows, and logs each one (`seed-marker-without-rows`). It is a ledger migration, not
a runtime fallback. It is offered only once the picture is known (every declarer
loaded and readable, the seed pass answered); otherwise it is not offered and the
next seed pass tries again. Its failure policy is `tolerate`: `block-owner` would
stop the storage orchestrator, and with it the settings store, from booting over the
repair of a default, and a repair that did not run leaves the alert in place.
Liveness events are telemetry: the monitor re-announces on every seed pass and
location change, and a first healthy pass clears a card whose recovery was dropped.

## Enforcement

`prune-keeps-unloaded-declarations.spec.ts`, `storage-writability-monitor.spec.ts`,
`storage-writability-alert.spec.ts`, `addon-loader.spec.ts` and
`migrations/__tests__/reseed-pruned-defaults.sqlite.spec.ts` (real SQLite).
