---
id: D331
title: A rename that spans two stores is ONE server call, never a client sequence
status: accepted
date: 2026-09-01
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/addon-admin-ui/src/pages/Locations.tsx
---

## Context

Renaming a room in the admin UI was three calls issued from the browser:

```
addLocation(to) → N × setLocation(device, to) → removeLocation(from)
```

Nothing bound them together. A closed tab, a dropped network or a reload
between the second and third call leaves the fleet **split across two rooms**,
one of which the operator has been told no longer exists. With 29 cameras the
window is 29 sequential round trips wide.

The same guard also refused any rename whose target differed only in case
(`name.toLowerCase() === from.toLowerCase()`), so the capitalisation of a room
could never be corrected — the one edit that is guaranteed to be a no-op under
the registry's own case-insensitive equality was the one the UI forbade.

Two facts about this data made a naive server implementation wrong twice, and
both were found by DISARMING a passing test rather than by reading:

1. **`listLocations` sorts and de-duplicates on read.** A first implementation
   replaced the label *in place* to "preserve the operator's order", and the
   test that claimed to pin it stayed GREEN when the implementation was
   disarmed to append. The stored order is not observable through any API, so
   the ceremony was untestable and was removed.
2. **A duplicate label is invisible for the same reason.** The merge case
   (renaming onto a room that already exists) is only observable in the raw
   `locations` array, so the spec had to read the addon store directly. Without
   that, the "no duplicate" gate stayed green while disarmed — every rename onto
   an existing room would have appended another copy of that room's label,
   forever.

## Decision

A rename that has to touch two stores is **one server operation**, exposed as
one cap method (`deviceManager.renameLocation`), and the client calls it once.

It follows the lock order `removeLocation({ cascade: true })` already
documents, and that order is not an implementation detail: the registry edit
takes the addon-store lock and **releases it** before the device cascade takes
the meta lock. Holding both, in that order, is the reverse of
`allocateNextDeviceId`'s meta ⊃ addon-store nesting — the pair that deadlocks.

Validation happens before either lock is taken. A rename that throws halfway is
the exact failure the method exists to remove, so an empty target is refused
while nothing has been written.

Three properties that are consequences, not extras:

- **`from` need not be registered.** The registry is a suggestion list, and a
  label carried by devices but registered nowhere is precisely the case that
  most needs renaming.
- **Renaming onto an existing room MERGES into it**, leaving no duplicate entry.
- **A case-only rename is a real edit** and is applied.

## Consequences

The UI reports what happened, because the method returns `{ moved }` — a silent
count is how "it did nothing" and "it did everything" come to look the same.

This is a cap change, so it reaches a node only through a published
`@camstack/server` (D16). Until then the admin UI running against an older hub
will get a method-not-found on rename; the three-call sequence is gone and is
not coming back as a fallback, because a fallback that reproduces the split-fleet
hazard is worse than an error that names it.
