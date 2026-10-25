---
id: D335
title: Eviction prefers footage no device owns, and an absent device is never believed the first time
status: accepted
date: 2026-09-02
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/orphan-device-lane.ts
  - packages/addon-pipeline/src/recorder/storage-evictable-provider.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
---

## Context

Under disk pressure the recorder freed space strictly oldest-first across the
whole volume. `deviceId` appeared in `summarizeEvictionsByDevice` — a post-hoc
summary — and nowhere in the ordering.

Two consequences, and the second is the one that surprised the operator.

A camera dead for a week kept its final days of footage until that footage
became the oldest thing on the disk. Meanwhile its residual gigabytes shortened
every LIVE camera's retention horizon by exactly that amount, for roughly one
retention window after the camera died. The literal fear — "recent footage of a
live camera deleted while a dead camera's is held" — cannot happen on a shared
eviction domain, because ranking is strictly by age. But "the dead camera's
newest week held while the live cameras' week-old footage goes" happens by
construction.

Worse: a camera that is REMOVED loses its recording-config row, so it has no
retention policy, and the hourly sweep prunes only devices with an explicit one
("NEVER prune a device without an explicit policy"). On a disk that never
breaches `minFreePercent`, that footage is held **forever**, and nothing anywhere
reports "this footage belongs to no known device".

The operator asked for dead-device footage to go first, under disk pressure
only — explicitly not a time-based sweep — and for the reason to be visible
afterwards.

## Decision

**Footage whose `deviceId` the device registry does not know is evicted before
anything is chosen by age.** Oldest-first still orders within that tier, and
within the ordinary tier below it. The two tiers spend ONE budget: the second is
asked only for the remainder, and a path in both is not deleted twice. This
changes the ORDER, never the amount.

**An absent device is never believed on one reading.** A registry read that
fails must not resemble "this camera is gone", because footage is the one output
that cannot be re-run. So an absence must be confirmed by two ANSWERED reads,
and four further gates cover what repetition cannot:

- an unanswered read (throw, timeout) arms nothing and disarms nothing;
- an EMPTY enumeration is refused — indistinguishable from a [D44](./adr-0044.md)
  empty snapshot;
- a read that knows NONE of the cameras holding footage is refused loudly: that
  is id-space drift, a *systematic* wrong answer, which corroboration would
  happily confirm a second time ([D72](./adr-0072.md));
- one read per pressure sweep, so eight reads inside one transient window are
  one observation rather than eight;
- a device seen present clears its streak immediately.

**The corroboration memory is in RAM, deliberately.** A persisted "seen absent
once" is a latch: it outlives the process that made the observation, cannot be
re-graded, and converts one bad read into a standing authorisation to delete.
After a restart the first answered read re-arms and the second confirms; in
between, eviction is exactly what it was before this record.

**Every eviction says which rule freed it.** `'orphaned-device'` joins the
existing reasons in `recorder:ops-log`, which the Activity table prints
verbatim. Bytes freed with no attributable rule is a policy nobody can audit,
and therefore one nobody should trust.

## Consequences

The pressure path now needs the set of devices holding footage before it can
tier. It is answered from the resident hour summary, not from disk, so the cost
is a map read.

A page-local re-sort of the existing oldest-first read cannot implement this:
that read starts at the global oldest, so an orphan whose footage is NEWER than
every live row never appears in it. The tier therefore needs a device-scoped
query — the same ordered, paged, bounded statement narrowed by `deviceId IN (…)`.

Relief is deferred by one sweep after a restart, and by one sweep whenever a
registry read cannot be believed. That is the price of the rule and it is small:
the fallback is the behaviour this record replaces, which is always safe.

**Removed devices are still held forever on a disk that never fills.** This
record deliberately does not fix that — the operator chose pressure-only. If it
is ever wanted, the missing piece is a default policy for footage whose device
is gone, and it must carry the same corroboration this lane does.

## Enforcement

`orphan-device-eviction.spec.ts`. Two claims are mandatory and both were
disarmed before being trusted: an orphan's segments are evicted before a live
camera's OLDER ones (9 of 11 red when the orphan set is forced empty), and a
registry read that cannot be believed evicts exactly as before and orphans
nothing (red when an unanswered read is treated as "the registry knows nobody" —
the precise bug the lane exists to prevent, verified independently).

The observation the second test makes is the device-scoped archive read itself:
that read IS the tier running, so "was the tier even entered" is directly
observable rather than inferred from the outcome.
