---
id: D1063
title: Two devices are linked only on identifiers their providers declared; a link adds ordinary Customize features the operator can switch off
status: accepted
date: 2026-11-18
supersedes:
applies-to:
  - packages/types/src/device/identity-links.ts
  - packages/system/src/builtins/device-manager/device-identity-index.ts
  - packages/system/src/builtins/device-manager/identity-link-reconciler.ts
  - packages/system/src/builtins/device-manager/identity-links-store.ts
  - packages/system/src/builtins/core-blocks/link-contributions.ts
  - packages/addon-provider-unifi/src/devices/unifi-feature-device.ts
  - packages/addon-admin-ui/src/components/device/overview-adapters/IdentityLinksBlock.tsx
---

## Context

A camera powered by a UniFi PoE port appears twice in CamStack: as the camera
(from its own integration) and as the port (from the UniFi integration). The
port can power-cycle the camera, but nothing connects the two, so the camera's
"restart" can never reach the port. D356 forbade linking on a guess — the
same-location heuristic had linked devices that had nothing to do with each
other — and left the operator to pick every link by hand.

D1059 gave each device typed identifiers its own provider declares (MAC,
serial, IP …). That makes a match on evidence possible, but D1059's identifiers
describe the device ITSELF. A PoE port has no MAC of its own worth matching;
what it knows is the MAC of the client wired to it. Writing that client MAC
into the port's `identifiers` would make the port "the same device" as the
camera, which it is not.

The earlier link mechanism (`deviceLinks`, the wiring) was deleted because it
kept a second authority beside Customize; `scripts/check-no-device-links.ts`
keeps it deleted.

## Decision

A device may declare, beside its own identifiers, the identifiers of what is
ATTACHED to it — `setAttachedIdentifiers` (`BaseDevice.declareAttachedIdentifiers`),
stored in its own column, merged with D1059's rules (one writer, `unread`
keeps the stored value, D49). A UniFi PoE port declares its last wired client's
MAC and IP this way.

The device-manager's identity index pairs devices of DIFFERENT integrations
into link candidates of two kinds: `same-device` (own identifiers match) and
`poe-power` (a port's attached identifiers match another device's own; the port
is side `a` and must carry the `poe-port` role). A strong match on several keys
is `auto`; anything ambiguous — one key, a port reaching two devices, a device
reached by two ports — is only a `proposal`.

`IdentityLinkReconciler` turns candidates into `identity-links` records with a
state (`proposed`, `linked`, `dismissed`) and an origin (`auto`, `operator`):
an `auto` candidate links and emits `identity-link.created`; a proposal waits
for the operator's Confirm or Dismiss on the device's Hardware tab; a dismissed
pair is never proposed again; Unlink dismisses. An `auto` link whose evidence
is gone is lost (`identity-link.lost`); an operator-confirmed one is kept and
flagged `evidenceGone`. A link is never re-judged on a side that has no row
right now — removal is the `identity-links` removal step's.

A `linked` link CONTRIBUTES ordinary Customize features (D663) on its host,
declared by its kind (`IDENTITY_LINK_KINDS[kind].contributions`): a `poe-power`
link adds `power-source` on the camera, sourced from the port's `switch.on`.
The feature is stamped `contributedBy: { linkId }`. It is skipped when the host
serves the cap natively (D944) or the operator already set that target; its
`enabled` toggle is the operator's (D62) and survives every pass; when the link
goes, only stamped features are taken back. Customize stays the one authority
(D676) — a link is a way of filling it, not a second store.

This amends D356: devices are still never linked on a guess, but a match on
declared identifiers IS evidence, and a strong one links on its own. It amends
D1059: a device may also declare attached identifiers, which never count as its
own identity.

## Consequences

- No manual "link these two" path: a link comes only from declared identifiers.
  A pair whose identifiers cannot be read (an Unraid VM's MAC, a Homematic CCU's
  MAC were not readable at the time) is not linked at all; `hosted-on` is not
  built for that reason.
- A port whose client changes loses its old link (evidence gone) and may gain a
  new one; a poll that saw no client keeps the last MAC (absence is not a
  different client).
- When the last stamped feature on a host is taken back, the host's
  composition block is left with no features rather than deleted.
- `listIdentityLinks` answers `not-loaded` until the store is read (D315); the
  UI never shows "none" for a read it does not have.

## Enforcement

- `scripts/check-no-device-links.ts`: no `DeviceLink*` / `deviceLinks` names
  come back.
- Specs: `device-identity-index.spec.ts` (attached pairs, downgrades),
  `identity-link-reconciler.spec.ts` (states, evidence gone, dismissed stays),
  `link-contributions.spec.ts` (native skip, operator wins, `enabled` survives,
  only stamps are taken back), `unifi-identifiers.spec.ts` and
  `integration-gateway.spec.ts` (the port's declaration, deduped per tick),
  `IdentityLinksBlock.spec.tsx` (pending is not "none", decisions).
