---
id: D594
title: A device-collection pin is honoured on the UDS route too, and the pin has ONE spelling for all three dispatchers
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - server/backend/src/api/trpc/cap-router-runtime.ts
  - server/backend/src/core/moleculer/moleculer.service.ts
  - packages/types/src/capabilities/capability-definition.ts
---

## Context

Three fixes for one bug, and the first two were each correct and each missed
the path the operator's clips actually take.

`videoclips` has three providers on this hub (`recorder`, `provider-reolink`,
`export-hap`). Every clip byte read named `provider-reolink`. Over two days the
operator got:

```
recorder   → "an analytics visit … has no file behind it"
export-hap → "was not minted by the HomeKit source"
```

The same clip, two different wrong answers, which is the signature of a
first-wins resolution seen from outside.

- **D592** fixed the tRPC MOUNT (`requireDeviceCollection` was unreachable in
  production). Correct, verified live — and a forked addon never reaches a
  mount.
- **D593** fixed the Moleculer transport link. Correct — and a hub-local runner
  is a **broker-less UDS child**: `addon-runner.ts` builds every forked addon
  with `createUdsAddonContext`, whose chain is `[localProviderLink,
  ipcParentLink]` with no `brokerTransportLink` in it at all
  (`addon-context-factory.ts`). So it never ran there either. I told the
  operator it was shipped and fixed. It was not.

The call lands on the parent's `onUnownedCall`, where the pin is discarded by
construction. The code says so in its own words
(`parent-unowned-call.ts:398-400`): *"routing is exactly what discards the
selector: `resolveCapRoute` takes only `nodeId` / `deviceId`, so the pin would
be dropped and the first registered provider would answer for a resource it
does not own."* The provider is then chosen by `cap-child-index.ts`: **"First
child wins, like the scan's first match."**

The gate that should have caught it was already there and did not apply:
`addonPinOf` reads `{ addonId }` and only for GLOBAL collections. `videoclips`
mounts `device-scoped` — `resolveCapMount` checks `scope: 'device' + kind:
'wrapper'` BEFORE `mode: 'collection'` (D554's own decision) — so the gate
returns `null` and routing proceeds.

This is the same defect `pinnedCollectionCall` was written for on 2026-08-09,
when Home Assistant's export read Homematic's `null` for `ha_001` and could
never open a link. Its docblock already carried the warning that predicted all
of this: **"a pin honoured only there is honoured never."**

## Decision

A **device-collection** pin (`{ provider }` beside a numeric `deviceId`) is
honoured on the child→parent UDS route, by `devicePinOf` +
`pinnedDeviceCollectionCall`, which dispatch through **the same
`requireDeviceCollection` the tRPC mount uses**. Nothing about narrowing,
refusing an unbound pin, or choosing fan-out versus scalar is re-derived here:
that would be a fourth authority on one question.

Both sides are wired together. `isAddonPinnedCall` (the sibling short-circuit)
and `callPinnedCollection` (the routing) recognise BOTH pins, because a pin the
bypass does not recognise is short-circuited to the first sibling and never
reaches the routing that would honour it.

Unlike the global pin this applies to ARRAY methods too: naming the provider is
required on `listClips` as well (D554), and the narrowing happens inside the
shared dispatcher, which decides fan-out or scalar afterwards.

**The pin has ONE spelling.** `PROVIDER_PIN_FIELD` lives in `@camstack/types`
and is imported by all three dispatchers. Three layers each fixed separately,
each in its own spelling, is how this bug kept returning wearing a different
addon's name.

## Consequences

- Unpinned calls are still routed positionally on this path. That is now the
  only remaining first-wins resolution for a device collection, and it is
  deliberately untouched here: 44 capabilities on this hub have more than one
  provider row, and changing them all at once is its own decision.
- A stale test is deleted-by-rewrite: `videoclips-read-clip-bytes.spec.ts`
  asserted that `provider` was optional and its comment read *"a `provider` pin
  would be a second way to say the same thing."* It had been failing since the
  pin became required, and it is the clearest example in the repo of a leftover
  that reads as verification.
- Shipping is wider than D593's: the constant is in `@camstack/types` and the
  route is in `@camstack/server`, so this needs a publish of types + system +
  server and a server INSTALL. A `camstack deploy` ships none of it.

## Enforcement

`server/backend/src/api/trpc/__tests__/pinned-device-collection-call.spec.ts` —
eight cases: the named provider answers although a sibling registered first;
an unbound pin is refused by name; an unpinned call declines so it routes
normally; the result is boxed so a legitimate `null` is not read as "not
handled"; and `devicePinOf` is null without a device, without a pin, and on an
empty pin.

Not covered by a unit test, and the reason this record exists: the WIRING in
`moleculer.service.ts`. The live probe, from the 2026-08-09 recipe, is a
deliberately bogus provider issued from a forked addon — refused by name if the
selector routes, answered by somebody else if it is discarded.
