---
id: D403
title: Using a device is not administering the system
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/types/src/capabilities/switch.cap.ts
  - packages/types/src/capabilities/brightness.cap.ts
  - packages/types/src/capabilities/color.cap.ts
  - packages/types/src/capabilities/cover.cap.ts
  - packages/types/src/capabilities/lock-control.cap.ts
  - packages/types/src/capabilities/alarm-panel.cap.ts
  - packages/types/src/capabilities/valve.cap.ts
  - packages/types/src/capabilities/climate-control.cap.ts
  - packages/types/src/capabilities/fan-control.cap.ts
  - packages/types/src/capabilities/button.cap.ts
  - packages/types/src/capabilities/media-player.cap.ts
  - packages/types/src/capabilities/vacuum-control.cap.ts
  - packages/types/src/capabilities/lawn-mower-control.cap.ts
  - packages/types/src/capabilities/pet-feeder.cap.ts
  - packages/types/src/capabilities/humidifier.cap.ts
  - packages/types/src/capabilities/water-heater.cap.ts
  - packages/types/src/capabilities/control.cap.ts
  - scripts/check-actuation-not-admin.ts
---

## Context

A household member on this installation holds a deliberate, explicit device
grant:

```json
{ "type": "device", "selector": { "kind": "all" },
  "access": ["view", "create"], "includeLinked": true }
```

Every part of that grant exists to say one thing: *this person may use every
device, including the accessory children hanging off each camera.* The matcher
that reads it (`server/backend/src/api/trpc/scope-access.ts`, over
`deviceSelectorMatches` + `scopeInherits`) implements exactly that, ancestor
walk included, and its `includeLinked` flag was designed for precisely the
"actuate a child you were granted through its parent" case.

She could not turn on a light. Not one control in the viewer worked.

The reason was not in the matcher, the grant, the UI or the viewer. Every
actuation method of every control cap declared `auth: 'admin'` —
`switch.setState`, all five `cover` methods, `lock-control`, `alarm-panel`,
`valve`, the eight of `climate-control`, the twelve of `media-player`, and so
on: 69 methods across 17 caps. `resolveMethodAuth` hands `'admin'` to
`procedureAuthKey`, which selects the admin procedure, which checks `isAdmin`
and **never looks at the scope set at all**. For those methods the entire
device-scope apparatus — selector, ancestor walk, `includeLinked`, the
access flavours — is dead code.

The failure mode is the worst shape available: the UI renders every control,
because the cap really is bound to the device and the *read* passes. Only the
tap fails. Nothing in the product says "you were never allowed to do this";
it just does not work.

The first fix considered was to make her an admin. That takes a minute and
also hands her addon installs, backups, node management and camera
credentials — the exact conflation the scope model was built to avoid, and the
one D103 records being exploited from the other direction.

## Decision

A capability method that ACTUATES a device declares `auth: 'protected'`, never
`auth: 'admin'`. Authorisation for it comes from the caller's `device` grant —
selector, access flavour, and `includeLinked` for accessory children — which is
the only thing in this system that can express "this person, these devices".

`auth: 'admin'` on a device-scope cap now means administration: credentials,
reboot, zones, masks, OSD, discovery, scripts, firmware installs, opening an
audio channel into the house. Using the thing is not administering it.

The set is an ALLOWLIST, held in `scripts/check-actuation-not-admin.ts`, not a
rule inferred from `scope: 'device'`. A heuristic reading "device cap ⇒ not
admin" would hand a house guest the camera's credentials; adding a cap to the
actuation set is a decision made once, in a diff someone reviewed.

## Consequences

- Anyone holding a `device` grant with `create` now actuates what the grant
  covers — including, where the grant inherits, a camera's linked accessories.
  That is the intended reading of `includeLinked`, and it is now the effective
  one.
- Two of the seventeen are security-critical by nature: `lock-control`
  (unlatching a door) and `alarm-panel` (disarming). They are actuation and
  they follow the rule; the protection is that a grant reaching them is
  explicit — an operator wrote `create` on a selector that covers them. An
  installation that does not want that narrows the selector or drops `create`.
  It is no longer possible to be protected from them by accident.
- Un-granted callers are unaffected: `protected` still refuses a session with
  no matching scope, and the refusal now carries the matcher's human-readable
  reason instead of a bare admin denial.
- The change is in `@camstack/types` and the generated cap routers, so it is
  live only once a `@camstack/server` containing it is installed on the node —
  not when the registry has it.

## Enforcement

`scripts/check-actuation-not-admin.ts`, wired into `.github/workflows/ci.yml`.
It asserts that none of the seventeen actuation caps declares a method with
`auth: 'admin'`, and fails naming the cap and the count. Verified red by
restoring `switch.setState` to `admin` before the fix landed.
