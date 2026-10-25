---
id: D861
title: The hub has a human name in one setting; an unset name reads as the hostname and is never written by the hub
status: accepted
date: 2026-10-16
supersedes:
applies-to:
  - packages/types/src/system/server-name.ts
  - packages/system/src/builtins/system-config/system-config.addon.ts
  - packages/system/src/kernel/system-settings-policy.ts
  - server/backend/src/api/core/server-name.ts
  - server/backend/src/api/core/auth.router.ts
  - packages/addon-admin-ui/src/components/system/ServerNamePrompt.tsx
---

## Context

The hub had no human name: its node id is literally `hub`, while agents carry
names. The apps' sign-in screen, the admin UI and the Nodes page therefore had
nothing to call it. Three choices had to be made, and the obvious answer to each
was wrong.

- **A default written at boot.** Seeding `server.name` with the hostname would be
  a seed that overwrites on the next boot of a hub that was renamed by hand, and
  would make "never named" indistinguishable from "named like the machine".
- **Wrapping `auth.listLoginMethods` to carry the name.** It is a bare array that
  every installed viewer parses; changing its shape removes their sign-in buttons
  until they update.
- **A second writer for the first-login dialog.** A dedicated `system.setServerName`
  would be a write path next to the System -> Settings form, with its own
  validation, and the two would disagree.

## Decision

The name is ONE `system-settings` row, `server.name`, written only through the
`system-config` addon (System -> Settings form, and the first-login dialog calling
the same `addonSettings.updateGlobalSettings`). It is validated once, by
`ServerNameSchema` (trimmed, 1-48 characters, no control characters), on every
write. Nothing writes it by itself, at boot or on a read. Every reader goes
through `resolveServerName`: an unset, cleared or damaged value reads as the
machine hostname without its domain, flagged `isDefault: true`, so a consumer can
tell a chosen name from the fallback.

It is exposed twice, both as `{ name, isDefault }`: authenticated in `system.info`
(next to the feature flags - the call the admin UI already makes once signed in),
and public as `auth.getServerName`, a new method beside `listLoginMethods`
(which keeps its bare-array shape). It answers only `{ name, isDefault }`. A read that fails answers the default (a title is never worth a
failed page) and logs it; the first-login dialog only ever opens on an ANSWERED
`isDefault: true`, never on an unanswered query.

## Consequences

- Viewers that want "Sign in to <name>" call `auth.getServerName`; older ones
  are unaffected.
- When nobody named the hub, a signed-out visitor can read the machine hostname
  from `auth.getServerName`. Clients that do not want to announce it show the name
  only when `isDefault` is `false` (the admin login does).
- `server.name` is the one key of the bootstrap-owned `server` section the store
  may answer (`STORE_READABLE_BOOTSTRAP_KEYS`); `server.port|host|dataPath` stay
  config.yaml-only.
- A cleared name stores `''`, which readers treat as unset; an untouched empty
  field on a never-named hub writes nothing.

## Enforcement

Specs: `system-config-server-name.spec.ts` (never written by the addon, trimmed
save, refusals, no-op when unset, clear), `server-name.spec.ts` (fallback,
`isDefault`, damaged row, `auth.getServerName` exposes exactly name and
isDefault, and `listLoginMethods` still parses with the old array schema), `system-info-server-name.spec.ts`, `server-name-prompt.spec.tsx`
(the `isDefault` gate, admin only, session-only dismissal). Each was disarmed
once: removing the gate, the field or the no-op branch fails its spec.
