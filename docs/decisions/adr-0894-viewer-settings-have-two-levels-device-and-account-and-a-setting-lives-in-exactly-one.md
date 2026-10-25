---
id: D894
title: Viewer settings have two levels, device and account, and a setting lives in exactly one
status: accepted
date: 2026-10-21
supersedes: D585
applies-to:
  - packages/types/src/schemas/user-preferences.ts
  - packages/system/src/builtins/local-auth/user-preferences-store.ts
  - packages/system/src/builtins/local-auth/preferences-record-kinds.ts
  - server/backend/src/api/core/preferences.router.ts
---

## Context

D585 (no record file was ever written for it; the number is cited from the
code and (planning repo: sessions/sessions.md)) let a viewer user save a named SNAPSHOT of <!-- drift-ok: moved to the private planning repo -->
their local stores on the hub and let other devices FOLLOW it: a
producer/follower template layered over the phone's own settings. It rode
`addons.custom` in `pipeline-analytics` (`viewerSettings.list/save/get/delete`,
record kind `viewer-settings-snapshots`) only so it could ship with an addon
deploy.

Two things were wrong with it:

- **Privacy.** `viewerSettings.list` and `viewerSettings.get` answered EVERY
  user's snapshots to any signed-in caller — the store queried the whole kind
  and only marked `mine`; overwrite and delete were owner-only, reads were
  not. A user's layout, camera names and grids were readable by every other
  account on the hub.
- **Three places a setting could live** — the phone, the snapshot, and the
  follower's copy — with overrides between them. Nobody could say which value
  a device would show, and "sync" meant re-applying a template by hand.

## Decision

The viewer's settings collapse to TWO levels, and **a setting lives in exactly
ONE level; there are no overrides**:

- **DEVICE** — never leaves the phone.
- **ACCOUNT** — stored on the hub, per user, private to that user, synced
  automatically across every device signed in as that user, last write wins
  unless the writer sends the revision it based its edit on (then a stale
  write answers `conflict` with the current row). Each hub keeps its own
  account copy; copying from another hub is a one-shot, client-side action.

The hub side is the core's, not an addon's: `local-auth` owns the
`user-preferences` record kind (it owns the users, so deleting a user wipes
their rows in the same call), and the hub's `preferences.*` tRPC router is the
only door. No method takes a user id — every call acts on the principal's own
rows, admin included. The principal must hold the new `preferences-self`
scope: every person's session carries it, a unified token only when minted
with it, and `'*'` does not imply it (the hub's mesh principal holds `'*'` and
is nobody's account), so share links, view-only and legacy tokens, account
links and the mesh are refused. Sync is by polling `preferences.changedSince`:
there is no per-user push channel, and the event bus is fleet-wide telemetry
(D8).

The template / share mechanism is removed: the four `viewerSettings.*` actions
and the `viewer-settings-snapshots` kind registration are gone. Their rows stay
on disk until an operator drops them by hand
(`docs/design/plans/2026-10-20-records-migration-handover.md` §6.B).

## Consequences

- A setting the viewer wants on every device must be MOVED to the account
  level, not copied; one that should differ per device stays device-only.
  There is no "account default, device override".
- One row per `(user, namespace)`: namespace `^[a-z][a-z0-9.-]{0,63}$`, value
  a JSON object of at most 256 KiB, at most 32 namespaces per user. A client
  that needs more splits by namespace, not by a bigger blob.
- `revision` counts writes of one row; a delete ends the row and its count, so
  a client compares revisions for inequality, and `changedSince` names the
  namespaces that are gone.
- Snapshots saved under D585 are not migrated into account rows; they sit
  unread on disk until the hand drop.

## Enforcement

`server/backend/src/api/core/__tests__/preferences-router.spec.ts` drives the
router with principals from the REAL verifier and rows in the REAL records
engine: owner isolation, admin no exception, share / view-only / legacy /
`'*'`-only token / mesh refused, conflict, limits, `changedSince`.
`packages/system/src/builtins/local-auth/__tests__/user-preferences-store.spec.ts`
pins the store, and `credential-lifecycle.spec.ts` pins that `deleteUser`
wipes the rows. Each spec names the disarm it was checked against. The
two-level rule itself ("exactly one level") is the viewer's to keep: review
only.
