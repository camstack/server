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

Hubs already hit keep their seed marker with zero rows, which cannot be told from
an operator delete; the alert now shows them, and a D987 migration (re-seed a
declared type that has a marker and zero rows) is the proposed repair, not yet
written. Liveness events are telemetry: the monitor re-announces on every seed
pass and location change, and a first healthy pass clears a card whose recovery
was dropped.

## Enforcement

`prune-keeps-unloaded-declarations.spec.ts`, `storage-writability-monitor.spec.ts`,
`storage-writability-alert.spec.ts` and `addon-loader.spec.ts`.
