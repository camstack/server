---
id: D325
title: "A server-update button stages the named node's reboot, freezes WHERE never a version, and speaks before the process can die"
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/server-update-buttons.ts
  - packages/addon-post-analysis/src/notification-center/action-token.ts
  - packages/addon-post-analysis/src/notification-center/action-plane.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
---

## Context

The operator asked (2026-08-31) for a **button** on the
`server-update-available` notification that applies the server update on the
node the notification names. [D324](adr-0324-a-button-that-mutates-the-fleet-freezes-what-and-where-never-a-version-and-asks-the-authority-before-it-acts.md)
shipped the same shape for addons the same morning, and **deliberately** minted
no button for this kind: "that is a node reboot; D305 already sends it to the
Cluster page". The tap TARGET stays `/system/cluster?node=`
([D305](adr-0305-a-notification-action-names-the-page-that-can-act-and-the-target-parses-what-it-is-given.md)).
This is the other half: the same work, without the page.

Overloading `NcAddonUpdateGrant` would have been the shorter patch and the
wrong one. An addon apply restarts packages; a server apply stages a closure
and reboots the node. Mixing them would apply a reboot through a grant written
to restart addons, or the reverse. A fifth grant family is the union doing its
job — `describeGrant`, `grantMeta`, `actionTtlMs` and `runGrantedAction` each
have to handle it before this compiles.

The one extra constraint D324 did not have: **applying the hub kills this
process**. A tap that went into silence because the process died mid-apply is
worse than no button. The start announcement must leave *before* apply. The
reboot itself is confirmed by the existing `server-updated` event on reconnect
(intake already emits it); this button does not wait for it, and does not
restate a version while it waits
([D313](adr-0313-a-version-is-read-back-never-restated-and-unknown-is-an-absent-field.md)).

## Decision

**D324's "server-update-available gets none" is reversed for the named node, on
the same terms: freeze WHERE, never a version, ask the authority what is still
true before acting, and say it started before the process can die.**

1. **A sibling family, not an overload.** `NcServerUpdateGrant` is
   `{ kind: 'server-update', nodeId }`. It carries no packages and no version.
   The button id is `server-update-apply`. The addon-update button still
   refuses this kind — applying addons is not applying a node reboot.
2. **No version, in either direction.** `checkServerUpdate` is asked first and
   only its `updateAvailable` boolean is used. A registry `error` is a throw,
   never "already current". `applyServerUpdate` omits `version` so the provider
   resolves latest at apply time. Announcements name the node and never a
   version, never `latest`.
3. **The cheap question first.** If the check says the node is current, nothing
   is applied and the operator hears "already up to date". If the check throws,
   nothing is applied and the operator hears that nothing was changed. One
   spent token is recoverable from the Cluster page; a node reboot that was
   not needed is not.
4. **Started before apply.** The start announcement
   ("Updating server on hub…") is delivered *before*
   `serverManagement.applyServerUpdate`. Applying the hub kills this process;
   that sentence must already have left. If the process is still alive after
   apply (an agent, or a hub whose staging returns before restart) a second
   announcement says the node is restarting. The done signal is the existing
   `server-updated` event on reconnect — this path does not wait for the
   reboot, and does not invent a confirmation of its own.
5. **One node, named in the label.** `Aggiorna server su agent-a`. A row
   whose packages span several nodes carries `nodeId: undefined` and mints
   **no button**, logged. An unowned destination gets none — it still gets the
   Cluster page. A loopback-only install loses the button, never the
   notification.
6. **Fifteen minutes, not sixty.** Same window as the addon-update family. Past
   it the plane says "expired — open CamStack", which is the D305 tap target
   the same notification already carries.
7. **Authorisation is the signature, narrowed to OWNED targets.** Same
   blast-radius reasoning as D324: this button appears on EVERY
   `server-update-available` notification of every rule, so the operator never
   chose it per button. A shared family channel gets the page. `destructive:
   true` is a rendering hint so it does not look like "Silenzia 10 min". No
   icon — the closed train-bound vocabulary has no member meaning "update".

## Consequences

- `NcActionGrant` has a fifth member. The exhaustive switches are the compiler
  forcing the next family to be handled, the same way D324 forced the fourth.
- D324's test "a NODE's own server update gets no button" is now "does not
  carry the addon-update button". The server family is asserted in
  `server-update-action.spec.ts`.
- The button costs one `serverManagement.checkServerUpdate` per tap. Accepted:
  it is the difference between rebooting a node that still needs it and
  rebooting one that does not.
- **What this forbids**: a button that restates a version it observed; a
  button that applies without asking whether an update is still available; a
  fleet-mutating button whose label cannot say where; a tap that goes into
  silence because the hub died mid-apply; waiting for the reboot (the
  `server-updated` event already exists).
- The notification's own tap URL is unchanged: `/system/cluster?node=`. Unowned
  destinations still get that page and no button.

## Enforcement

`packages/addon-post-analysis/src/notification-center/__tests__/server-update-action.spec.ts`
— asserted on what LEAVES the process: the `notification-output.send` payload
and the `applyServerUpdate` seam. Each case walks the real chain (raw
`update.available` with `target: 'server'` → intake → durable outbox → drain →
the minted URL → the real `NcActionPlane` handler), and the harness late-binds
`buildActions` exactly as the addon does.

| removed | fails |
| --- | --- |
| the button joining the notification's `actions` | "names the node, and is a background call" |
| applying on the frozen node | "applies on the node the row named" |
| started-before-apply | "tells the operator it started, then that the node is restarting" |
| the freshness check | "asks whether an update is STILL available" |
| the throw on a failed check | "changes nothing when it cannot read whether an update is still needed" |
| the several-nodes refusal | "a row that spans several nodes gets no button" |
| the owned-target refusal | "a destination nobody owns gets no button" |
| `claim()`'s spent check | "spends the button once" |

The version rule is pinned negatively — the announcement text is asserted to
contain neither the row's versions nor the string `latest`.
