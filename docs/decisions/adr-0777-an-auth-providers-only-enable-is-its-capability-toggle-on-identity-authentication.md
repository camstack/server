---
id: D777
title: An auth provider's only enable is its capability toggle on Identity → Authentication, and the hub asks that toggle wherever a login is offered or completed
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - server/backend/src/auth/auth-provider-gate.ts
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/api/core/auth.router.ts
  - packages/addon-auth/src/**
---

## Context

Magic-link had two switches. The Identity → Authentication page showed it as
**enabled** — its `auth-provider` capability toggle — while its own
`enabled` setting (default `false`) kept the login button away. On the live hub
the row said "enabled" and the login page offered nothing.

The page's toggle was not even honest on its own. It toggles `auth-provider`
(login providers) and `user-passkeys` (passkeys), but the login page reads the
`login-method` collection, a cap the page never toggles, and
`/api/auth/sso/finish` read no toggle at all. Disabling OIDC or magic-link on
the page therefore removed nothing: the buttons stayed, and a bridge minted by
a disabled provider still became a session. The private flag hid that, because
it was the only switch that worked for magic-link.

## Decision

An auth addon has ONE enable: its provider toggle on Identity →
Authentication (`auth-provider`, or `user-passkeys` for passkeys). Addons carry
no private `enabled` setting. Every hub surface that offers or completes a
login asks `isAuthAddonDisabled` (`auth-provider-gate.ts`):

- `auth.listLoginMethods` drops every contribution of a disabled addon;
- `/api/auth/sso/finish` refuses a bridge whose provider addon is disabled —
  including a magic link mailed before the switch.

The retired magic-link flag is carried over ONCE (`retire-enabled-flag.ts`): a
flag stored `true` leaves the toggle alone; a flag stored `false`, or never
written (its default was off), disables the provider at `auth-provider`. The
dead key is stripped and a marker (`enabledFlagRetired`) written in the same
store write, so an operator who re-enables the provider is never switched off
again. Until the carry-over has landed the addon contributes no button, so an
upgrade never flashes on a method that was off.

## Consequences

- After upgrade, a hub whose magic-link was effectively off shows it
  **Disabled** on the Authentication page — the state it really had. A fresh
  install gets the same: magic-link starts disabled, as its old default did.
- The carry-over needs the provider registered (`writeCollectionToggle`
  refuses an unregistered one), so it runs in the background with backoff
  (1 s … 60 s); after the last attempt the next boot retries, and the button
  stays withheld meanwhile (fail closed).
- A login provider's routes (`/request`, `/start`, OIDC `/callback`) still
  answer while it is disabled; they mint nothing usable, because the finish
  refuses. Gating them at the route would need the addon to read its own
  toggle, a second reader of the same fact.
- The admin-ui `AUTH_CAPS` list and `AUTH_GOVERNING_CAPS` name the same caps
  and must move together.

## Enforcement

`auth-provider-gate.spec.ts`, `auth-router-login-methods.spec.ts` (fails
against the old aggregation), the D777 cases in `sso-finish.spec.ts`,
`retire-enabled-flag.spec.ts` (stored false / never written / stored true /
runs once / deferred paths) and `auth-magic-link.addon.spec.ts` (no `enabled`
field in the schema; the button is withheld until the carry-over lands).
