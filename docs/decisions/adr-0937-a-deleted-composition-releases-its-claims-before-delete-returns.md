---
id: D937
title: A deleted composition releases its claims before delete returns
status: accepted
date: 2026-10-25
applies-to:
  - packages/types/src/capabilities/composer.cap.ts
  - packages/system/src/builtins/composer/composer.ts
  - packages/system/src/builtins/composer/composer-live-set.ts
  - packages/system/src/builtins/composer/owned-fields-target.ts
  - packages/system/src/builtins/composer/composition-runtime.ts
  - packages/system/src/builtins/core-blocks/block-supervisor.ts
  - packages/system/src/builtins/core-blocks/core-blocks.addon.ts
  - packages/system/src/builtins/core-blocks/composition-api.ts
---

## Context

On the operator's hub (1.2.624, 2026-10-25) `coreBlocks.delete` of camera 101's
doorbell customization returned `{ success: true }` and the next call created a
new composition for the same device. The new block went `failed` with
`owned-by-other`: the deleted block still held `doorbell`. `composition-runtime`
treats that refusal as terminal. A later `releaseClaim` of the old owner
answered `not-claimed` — the two-apply gate had handed the claim back — and a
manual restart of the new block ran.

`delete` fired `convergeSoon()` and did not wait. The claim gate
([D663](adr-0663-a-customization-owns-single-fields-by-a-claim-at-the-hub-write-chokepoint-and-removing-it-restores-the-native-slice.md))
releases a block that merely vanished from one snapshot only after a second
apply agrees, because one absence can be a bad read ([D49](adr-0049.md)). That
gate is right for a snapshot. An operator delete is not a snapshot: the row is
already gone, and the replacement claims in the same apply, before the gate
would release. Treating `owned-by-other` as retryable when the owner is a
deleted block was the other option. It leaves the new block failed until a
release event arrives, and a refusal from a live owner must stay terminal. No
timer and no retry loop ([D3](adr-0003.md)).

## Decision

**A composition delete, and an edit whose new plan drops a cap, complete only
after those claims are released.** The supervisor names a deleted block on
`retiredBlockIds`. The composer stops that runtime, waits until its in-flight
claim has settled (`quiesce`), releases the claims, and only then starts a
replacement. An edit that changes `updatedAt` and no longer wants a claim takes
the same path. A release that throws or is refused is logged with
`tags: { deviceId }` and returned on the apply; `delete` and
`updateComposition` throw that text. `not-claimed` is a landed release. A block
that is absent from a snapshot and is not in `retiredBlockIds` still waits for
two agreeing applies. A disabled block still hands its fields back from its
runtime. `owned-by-other` from a live owner stays terminal.

## Consequences

The replacement never claims while the deleted block still holds the cap, so it
does not fail for good. An edit that removes a feature releases that claim on
the edit's apply, not the next one. If the release does not land, the row is
already deleted or saved and the RPC fails; the id stays retired so the next
converge tries again. A client that ignores the error and creates anyway can
still be refused `owned-by-other`.

## Enforcement

`packages/system/src/builtins/composer/__tests__/composer-existing.spec.ts` —
delete then create on the same device, an edit that drops a cap, and a release
that throws (the device id is on the warning). Removing `releaseConfirmed`
makes the delete-then-create spec fail with `owned-by-other`. The two-apply
spec for a block that is only omitted stays. No new guard.
