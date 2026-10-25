---
id: D389
title: One type, one physical root — refused at the door, never on a read that failed
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/types/src/storage/physical-root.ts
  - packages/system/src/builtins/storage-orchestrator/location-root-collision.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts
  - packages/addon-pipeline/src/recorder/addon/eviction-domain.ts
---

## Context

Two storage locations of the same TYPE on one physical root are a
misconfiguration with no upside: their class subtrees are identical (D327 scores
occupancy by subtree — `high|mid` for `recordings`, `low` for `recordingsLow`),
so every per-location figure double-counts and every deletion under one is a
deletion under the other.

The system already noticed — late. `demoteWritableAliasConflicts` in the
recorder demotes the extras to read-only and logs an error naming the kept and
demoted ids. By then the operator has created the row and may have pointed
configuration at it, and the only signal is a log line on a node they are not
watching.

The obvious formulation of the check would break a configuration this system
uses on purpose: stock `recordings` and `recordingsLow` are DESIGNED to be able
to share one root, and the recorder's eviction domain deliberately merges
same-root aliases into one oldest-first pool. Refusing every shared root would
refuse the default install.

## Decision

`upsertLocation` refuses a location whose PHYSICAL root collides with an
existing location **of the same type**, naming the location it collides with and
the shared root. Different types on one root stay allowed. The recorder's
demotion stays: it guards rows created before this check existed, and a guard
that only exists at the door is not a guard.

Three properties decide whether this helps or hurts, and each has a test:

1. **Compare the PHYSICAL root, not the path string.** A symlink or bind mount
   reaches one disk under two names, and a string comparison misses exactly the
   case that matters. The derivation is `physicalRootOf` in
   `@camstack/types/node` — ONE derivation, which the recorder's
   `physicalRootKey` now delegates to. Two implementations of "is this the same
   disk" are two answers waiting to disagree.
2. **CONTAINMENT, not just equality, in both directions.** A location nested
   inside another's tree is worse than two equal roots: the accounting overlaps
   and a deletion under the outer one can take the inner one's footage with it.
   Compared on path SEGMENTS — `/mnt/disk1` is not inside `/mnt/disk`, though a
   `startsWith` says it is.
3. **"They collide" is not "I cannot tell".** A location on another node, or
   behind a remote provider, cannot be resolved from here. An unresolvable root
   WARNS and lets the write through; an unresolvable sibling is skipped rather
   than treated as a match. Refusing on an unanswerable read blocks the operator
   on a doubt — D49's spirit: a fallible read is not the gate. That is why
   `physicalRootOf` reports `resolved` instead of swallowing the failure the way
   the recorder's key derivation does; the recorder wants a key either way,
   because its fallback can only over-partition (treat one disk as two) and
   never merge two disks.

**An edit that does not MOVE the root is never refused**, even when the stored
row already collides. A check that refused every edit to a pre-existing
collision would leave the operator unable to re-point or disable the very
location they need to fix — it would make the problem permanent instead of
preventing it. Moving that same row onto another same-type root is still
refused.

## Consequences

- Two locations on DIFFERENT nodes never collide, however identical their paths
  look. `nodeId` absent normalises to `'hub'`, because the seed writes node-blind
  rows.
- A provider with no `basePath` (S3, WebDAV) has no physical root and is always
  clear.
- The refusal runs synchronously inside `upsertLocation` and takes one
  `realpathSync` per candidate root. `upsertLocation` is an operator action, not
  a hot path.
- The recorder's `physicalRootKey` is now a delegate. If the shared derivation
  changes, the eviction domain and this refusal change together — which is the
  point.
- `@camstack/types` and `@camstack/system` ship inside the published
  `@camstack/server` closure, so this is not live until a server containing it
  is installed.

## Enforcement

`packages/system/src/builtins/storage-orchestrator/__tests__/location-root-collision.spec.ts`
— same type same root refused, different types same root allowed, nesting
refused in both directions, a symlinked alias caught, a shared string prefix NOT
treated as containment, an unresolvable root and an unresolvable sibling both
allowed, another node never colliding, and an edit that does not move the root
not refusing itself (including the pre-existing-collision case).

No guard script: the derivation is a single exported function with two callers,
and the property that matters is behavioural rather than lexical.
