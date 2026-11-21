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
such sets (dryer, washer, dishwasher), one of them partial. The operator asked
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
  and history through `core-blocks.getCapLinks` (non-admin; `not-loaded` until
  read, D315). The two meters are never mixed or copied (D224).

`core-blocks.migrateCapLinks({ dryRun })` converts plain identity `from` groups
from one source device and cap into one `capLink`, reports the mixed groups and
leaves them untouched, skips stamped features (`contributedBy`) and is
idempotent (D345).

## Consequences

`CUSTOMIZE_CARDINALITIES` gains `'link'`, so admin-ui needs a renderer. A cap
change: force-publish `@camstack/server`. `sourceGroups` and the `power-meter`
scalar targets are removed in a later step, after the dry run shows no mixed
group on any hub.

## Enforcement

`check-customize-declaration` (source cap exists, a slot is a nullable
top-level object, a map's paths and quantities agree, a project link without a
map is same-cap), `check-customize-apply-add` (a link's `apply` is `add`),
`check-customize-coverage` (the `link` renderer exists), and the planner's
named refusals `link-undeclared`, `link-source-cap-missing`, `link-native`,
`link-overlaps-fields`.
