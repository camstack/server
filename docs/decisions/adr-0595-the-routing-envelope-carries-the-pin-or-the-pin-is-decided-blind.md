---
id: D595
title: The routing envelope carries the pin, or the decision that reads it is made blind
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/system/src/kernel/transport/cap-routing-hints.ts
---

## Context

Fourth fix for one bug. D592 fixed the tRPC mount, D593 the Moleculer
transport link, D594 the parent's UDS route — and after all three, the
operator's clip still came back:

```
clip playback: byte fetch failed
  provider: "provider-reolink"
  error: "…was not minted by the HomeKit source"
```

D594 is correct. It is also **unreachable**, and by the exact mechanism its
own neighbour had already written down.

`LocalChildRegistry` decides whether to short-circuit a child's cap call to a
local sibling, and that decision runs BEFORE `onUnownedCall`. It asks
`isAddonPinnedCall` — which D594 wired to recognise the `{ provider }` pin —
and it hands that predicate the **routing hints**, not the args:

```ts
const hints = out.hints ?? liftRoutingHints(out.args)
… this.isAddonPinnedCall?.(out.capName, out.method, hints) === true
```

`CapRoutingHints` carried `nodeId` and `addonId`. Nothing else. So the
predicate saw `{}`, answered false, the call was short-circuited, and
`resolveChildId` fell through `deviceOwner` — export-hap holds no per-device
descriptor for 3628 — to `singletonCandidates[0]`, which is export-hap. A
Reolink clip, answered by the HomeKit exporter, with the provider named in the
args the whole time.

`addonPinOf`'s docblock records this shape verbatim for the 2026-08-09
attempt: *"the handler was correct and unreachable … the probe that proved it
was a DELIBERATELY BOGUS addonId — refused if the selector routes, answered
`null` if it is discarded. It came back `null`."* I read that docblock while
writing D594, quoted its rule ("a pin honoured only there is honoured never"),
wired the predicate it names — and did not check what the predicate is given.

## Decision

**A field the routing envelope does not carry is a field the routing decision
cannot see.** `CapRoutingHints` carries the device-collection pin — `provider`
and the `deviceId` it applies to — alongside `nodeId` and `addonId`, and
`liftRoutingHints` lifts all four. One function serves both ends (the sender
in `local-child-client.ts`, the parent in `local-child-registry.ts`), so the
raw-forward and decoded paths cannot disagree.

`deviceId` rides with `provider` and never without it: a provider pin alone
cannot say which device's sources to narrow, and a pin that cannot be resolved
is not a pin.

## Consequences

- Every routing predicate downstream now sees the pin. That is the whole fix;
  D594's handler was already right.
- The envelope grows, deliberately. Under raw-forward the parent decodes
  nothing else, and the rule stays "only top-level scalar routing facts" — the
  test asserts that a clip id, a profile and a byte bound are NOT lifted.
- Still true and still unaddressed: `provider` and `addonId` hold the same kind
  of value — an addon id — under two names, read by two predicates, because
  `addonId` is ordinary DATA on a non-collection cap (`addons.getLogs`). The
  operator asked the obvious question ("provider non è l'addon id?" [isn't the provider the addon id?]) and he is
  right. Unifying the two NAMES is a cap-schema change and is not being done
  while clips are broken; the constant already lives in one place (D594).
- Four layers have now been found dispatching this one call. Each was fixed on
  its own evidence and each fix was correct. What none of them had was a test
  that exercised the call from a forked addon end to end, which is the only
  thing that would have caught any of them on the first day.

## Enforcement

`packages/system/src/kernel/__tests__/transport/cap-routing-hints-provider-pin.spec.ts`
— seven cases: the pin and its device are lifted together; the two older
fields still are; all four coexist; an empty provider and a non-numeric
deviceId are omitted rather than coerced; nothing else about the args is
lifted; and nothing throws on a non-object.

The live probe remains the 2026-08-09 recipe: a deliberately bogus provider
issued FROM a forked addon. Refused by name ⟹ the selector routes. Answered by
somebody else ⟹ it is still being discarded.
