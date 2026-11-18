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
  - packages/system/src/builtins/core-blocks/composition-api.ts
  - packages/system/src/builtins/core-blocks/power-source-service.ts
  - packages/types/src/composition/customize/scalar-merge.ts
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
is gone is lost (`identity-link.lost`); an operator-confirmed one is kept,
flagged `evidenceGone`, and stops acting (`identity-link.lost`, reason
`evidence-gone`; `identity-link.created` again when the evidence returns). A link is never re-judged on a side that has no row
right now — removal is the `identity-links` removal step's.

A `linked` link CONTRIBUTES ordinary Customize features (D663) on its host,
declared by its kind (`IDENTITY_LINK_KINDS[kind].contributions`): a `poe-power`
link adds `power-source` on the camera, sourced from the port's `switch.on`.
The feature is stamped `contributedBy: { linkId }`. It is skipped when the host
serves the cap natively (D944) or the operator already set that target; its
`enabled` toggle is the operator's (D62) and survives every pass; when the link
goes, only stamped features are taken back. Customize stays the one authority
(D676) — a link is a way of filling it, not a second store.

The operator's off-switch for a stamped feature is `enabled: false` ONLY. The
Customize row of a stamped feature shows an Active toggle and no delete; an
API write that drops a stamped feature, or deletes a block that carries one,
is REFUSED with the problem code `link-contribution-removed` ("switch it off
instead; unlink the device to take it away"). So the reconciler re-adding an
absent stamped feature never undoes an operator's choice. Any operator edit
of a stamped feature's target (merge or remove, on any target of the cap)
drops the stamp in the Customize compile path: the edited feature is the
operator's from then on and is never taken back by the link.

A link is re-judged without timers: a pass runs when the identity links change
(`identity-link.*`), when the reconciler is armed, and whenever another writer
creates or updates a composition through the composition API. A write that
meets a stale `expectedUpdatedAt` re-reads the composition and retries, three
attempts per host, then logs a warn tagged with the host's `deviceId`.
Because an event may be dropped (D11), the link is also checked at the point
of use: before `power-source` cycles or switches a camera through a feature
stamped `contributedBy: { linkId }`, it reads the links over RPC. A link that
is not `linked`, is flagged `evidenceGone`, or names another port, is refused
as `link-lost` (logged,
and a pass of that host is requested); a read that fails or is `not-loaded`
is refused as `link-unknown` — destructive work never runs on an unread
link (D49).

Freshness of an attached identifier: a port whose client left keeps the last
MAC, but declares it `unread`, so the device-manager stores it as RETAINED
(`attachedRetained`), never as a fresh read. When one port FRESHLY reads a MAC
another port only retains, the retained side's pair is dropped and the fresh
side links (`auto` on a strong match); two FRESH reads of the same MAC stay a
proposal. Case: a camera moved from port 7 to port 9 — port 7 retains the MAC,
port 9 reads it, so port 7's auto link is lost and port 9 links.

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
  new one; a poll that saw no client keeps the last MAC, retained (absence is
  not a different client, but a fresh read elsewhere wins).
- An operator-confirmed link whose evidence is gone stays `linked`, flagged
  `evidenceGone`, and does NOT act. Its contribution is withdrawn, so a fresh
  link on another port can contribute, and `power-source` refuses through it
  as `link-lost` — the existing reason, because the danger is the same: the
  port may now feed another device (the operator confirmed port 7 → camera A;
  A moved to port 9 and camera B took port 7 — A's restart must never cycle
  port 7). A dedicated `link-evidence-gone` reason was rejected: a caller acts
  the same on both, and the message names the case. The Hardware tab shows it
  as "No longer matched", which is the re-confirmation request: the operator
  Unlinks it, or it acts again on its own once the same evidence returns (the
  confirmed pair, read fresh). A contradicting fresh report — the camera read
  on another port, or another device on that port — is exactly what clears the
  candidate, so it always lands here and never acts silently.
- The reconciler's own writes are recognised by an in-process caller object
  (`linkReconcilerCaller()`), never by the `identity-links` user id: a forked
  addon's `ctx.api` args reach the provider as sent, so a string could be
  forged. Only its writes may remove a stamp, and only a pure withdrawal (the
  composition otherwise unchanged, each kept remainder a subset of the
  stamped fields) skips the store judge, so a removed host's `target-missing`
  cannot pin a stamp.
- A withdrawn contribution is logged with the host's `deviceId`, resolved from
  the dismissed or lost link still listed, else from the device list.
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
  only stamps are taken back, stale-write retry bounded to three, an
  evidence-gone link yields to the port the camera moved to),
  `composition-api.spec.ts` (removal refused, last stamp withdrawn through the
  real API, an orphan's stamp is withdrawn although its host is gone while
  any other write to it — an operator's, a forged `identity-links` caller's,
  one adding a field or changing the helper — is judged, an
  operator write requests a pass),
  `power-source-service.spec.ts` (`link-lost` / `link-unknown` at the point of
  use, `evidenceGone` included), `power-extension.spec.ts` (an operator edit drops the stamp),
  `device-identifiers.spec.ts` (port 7 → 9: fresh beats retained), `unifi-identifiers.spec.ts` and
  `integration-gateway.spec.ts` (the port's declaration, deduped per tick),
  `IdentityLinksBlock.spec.tsx` (pending is not "none", decisions).
