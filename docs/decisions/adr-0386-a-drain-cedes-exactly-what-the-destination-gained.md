---
id: D386
title: A drain cedes exactly what the destination gained — there is no rate knob
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/drain-ratchet.ts
  - packages/system/src/builtins/storage-orchestrator/drain-state-store.ts
  - packages/system/src/builtins/storage-orchestrator/storage-pressure-manager.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
---

## Context

D385 gives a location four states. Three of them are static; `drain` is the one
that has to DO something: shrink a disk the operator is retiring, until it is
empty, without being told how fast.

`readonly` takes a location out of pressure eviction entirely, so it cannot be
the mechanism. Two things were considered first and neither works:

- **Priority ordering inside the existing pressure sweep** — "evict the draining
  disk before the others". It does nothing here. Pressure eviction is triggered
  by free space ON A VOLUME, and the draining disk and the destination are
  different physical devices. The destination filling up can never trigger
  eviction on the disk being drained, no matter how the candidates are ordered.
  On this hub the draining location is `/mnt/mixed` and the destination is a
  different array; a full destination and an idle drain would coexist forever.
- **An operator-facing rate** ("drain at N GB/day"). It is a number nobody can
  choose correctly: too fast destroys retention the operator still wants, too
  slow never finishes, and the right answer depends on how much the cameras are
  actually recording — which the system knows and the operator does not.

## Decision

A draining location gets a **monotonically descending effective usage cap**,
enforced through the existing `relieveToUsageCap` machinery. There is no second
eviction path and no operator-facing rate: the operator sets one flag.

**The pace is growth-matched.** Each sweep, the draining location cedes as many
bytes as the ACTIVE locations of its class gained since the previous sweep. The
archive therefore keeps a constant total size while the drain runs: every byte
written to the destination is one byte of the oldest footage leaving the disk
being retired, and retention shrinks at exactly the rate new footage arrives —
not faster.

Five properties, each a named test:

1. **No growth in the destination ⇒ nothing is deleted this sweep.** A stopped
   recorder must not eat the archive.
2. **The cap never rises.** A sweep where growth is negative (the destination
   ran its own eviction) or unmeasurable (no active peer, a failed provider
   read) leaves the shrunken cap exactly where it was. Unmeasurable is not zero
   with a different name and is never folded into the observed rate.
3. **The state survives a process restart.** The cap, the drain start and the
   observed growth are persisted every sweep in `storage_drain_state`. A cap
   recomputed from today's usage would restart at the top of the disk and
   silently undo every byte of progress. A node with no data-store engine to
   persist it REFUSES to drain and says so, rather than deleting on a pace
   nobody chose.
4. **Reaching zero stops the ratchet** and the location is reported drained.
5. **Switching back to `readonly` or `active` stops it immediately** — the plan
   is rebuilt from live modes every sweep, and the persisted state is dropped,
   so a later re-drain starts a fresh ratchet rather than resuming a cap the
   operator has since overruled.

`storage.listDrainProgress` exposes, per draining location, `bytesRemaining` and
`estimatedEmptyAtMs` — the latter derived from the growth actually OBSERVED, and
`null` when none has been. Never a fabricated date: a drain with no observed
growth has no honest ETA, and inventing one is how an operator learns not to
believe the screen.

## Consequences

- A `drain` location REMAINS evictable. This is the one state where eviction
  policy is neither `normal` nor `never`, and the recorder's
  `StorageEvictableProvider` gate (`isEvictionFrozen`) had to be re-expressed as
  "policy `never`" rather than "read-only" for that to be true.
- A drain finishes in a time the system, not the operator, determines. On a hub
  writing ~1 TB/week into the destination class, a 10 TB drain takes ~10 weeks.
  That is the honest number and it is reported, not hidden; an operator who
  needs it faster uses the relocate mover, which copies rather than deletes.
- The ratchet only sees what the `storage-evictable` providers report. Footage a
  provider does not account for is not ceded and not deleted — a drain
  under-delivers rather than over-deletes, which is the correct failure
  direction.
- The drain adds one more `getEvictableUsage` fan-out per sweep per draining
  location, plus one for its peers. The pressure sweep already does this per
  location on a 60 s timer; the cost is proportional to the number of disks
  being retired at once, which is one.
- `@camstack/system` ships inside the published `@camstack/server` closure, so
  this is not live until a server containing it is installed on all three nodes.

## Enforcement

Tests, and they are the deliverable:
`packages/system/src/builtins/storage-orchestrator/__tests__/drain-ratchet.spec.ts`
pins the arithmetic (the no-growth, negative-growth, unmeasurable-growth,
restart and zero cases) and
`__tests__/storage-drain-sweep.spec.ts` pins the wiring end to end through
`StoragePressureManager` — including that a location leaving `drain` stops
immediately and that the state comes back off the store rather than being
recomputed.

No guard script: the ratchet is a single pure module with one caller, and the
property that matters (monotone cap) is expressible as a test in a way it is not
expressible as a grep.
