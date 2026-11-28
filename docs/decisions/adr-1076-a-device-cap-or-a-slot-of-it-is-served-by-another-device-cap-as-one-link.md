---
id: D1076
title: A device's capability, or a slot of it, is served by another device's capability as ONE link — projected when it is the same cap, referenced when it is a slot of another
status: accepted
date: 2026-11-21
supersedes:
applies-to:
  - packages/types/src/capabilities/customize-spec.ts
  - packages/types/src/composition/composition.ts
  - packages/types/src/composition/cap-link.ts
  - packages/types/src/composition/validate-composition.ts
  - packages/system/src/builtins/core-blocks/cap-links.ts
  - packages/system/src/builtins/core-blocks/cap-links.ts
---

## Context

Customize links a device to another one value by value: the dryer's `power-meter`
takes `power`, `energy`, `voltage` and `current` from a plug as four stored
`from` fields (`sourceGroups` only gave the picker a "fill all" button; storage
stayed N records that drift apart). The live audit of 2026-11-21 found three
such sets (dryer, washer, dishwasher), one of them partial (it stays a per-field link until the operator decides). The operator asked
for the whole capability to be passed, never single values. The energy card
needs the same thing across caps: a heat pump device that feeds the `heatPump`
branch of an `energy-system`.

Rejected: reviving `deviceLinks` / the wiring (D1063 deleted it as a second
authority; `check-no-device-links` keeps it out); a D648 extension slot (an
energy-system provider does not own this link); the reserved `passthrough`
variant (data-plane caps with method forwarding); keeping scalar targets with
a fill-all picker (the drift the operator rejected).

## Decision

A cap declares `customize.links`. Each declared link is stored as ONE
composition feature `{ kind: 'capLink', cap, linkId, source, enabled? }` in the
host's existing customization — no second store (D676, D1063).

- `mode: 'project'` (same cap, or a declared `map`): the planner expands the
  one feature into the field claims the composer already runs (D663). The hub
  keeps serving the host's slice, so history, exporters and readers keep reading
  the host's own cap (D984).
- `mode: 'reference'` (a slot of another cap): nothing is written into the host
  slice and the plan has no claims. A consumer reads the source device's own cap
  and history through `core-blocks.getCapLinks` (role `viewer`, see below; `not-loaded` until
  read, D315). The two meters are never mixed or copied (D224).

`core-blocks.migrateCapLinks({ dryRun })` converts a plain identity `from` group
from one source device and cap into one `capLink` only when the link claims
EXACTLY what the group claimed: a link serves every top-level field of the cap
plus the clock as `now`, so a PARTIAL set (the dishwasher's `power` alone) would
newly take the rest from the source and silently replace the device's own
readings. It is reported as `mixed` (`partial-set: would also take ...`), as is a
group whose `lastFetchedAt` reads the source (the link writes `now`), a group
with an expression or another source, and a cap another enabled feature also
writes (`overlap: ...`). Mixed groups are left untouched and the operator
decides per device. Stamped (`contributedBy`) and disabled features are skipped
and counted. The run is idempotent (D345).

### The UI (phase 4) and the role of `getCapLinks`

The admin Customize table shows one "Source device" row per declared link
(`CapLinkCell` in ui-library, one stored `capLink` feature per pick, a planner
refusal shown on the row). A link is offered on the device types its
`customize.links` entry names. The retired `sourceGroups` mechanism and its
row are deleted.

`core-blocks` methods default to role `admin`, but `getCapLinks` is `viewer`:
the energy card is viewer-facing and reads the linked heat pump (live slice and
the day's COP) through it. It returns only link ids, caps, the source device id
and a state, never a composition, formula or stored value, and the per-device
scope check still covers `deviceId`. `getCustomization` and the composition
writes stay `admin`. While the read is unanswered the card keeps the system's
own heat pump branch (D315, D224: the two meters are never summed).

## Consequences

`CUSTOMIZE_CARDINALITIES` gains `'link'`, so admin-ui needs a renderer. A cap
change: force-publish `@dominevo/server`. `sourceGroups` is gone (phase 4); the `power-meter`
scalar targets are removed in a later step, after the dry run shows no mixed
group on any hub.

## Enforcement

`check-customize-declaration` (source cap exists, a slot is a nullable
top-level object, a map's paths and quantities agree, a project link without a
map is same-cap), `check-customize-apply-add` (a link's `apply` is `add`),
`check-customize-coverage` (the `link` renderer exists), and the planner's
named refusals `link-undeclared`, `link-source-cap-missing`, `link-native`,
`link-overlaps-fields`.
