---
id: D815
title: There is no email login — the magic-link method is removed, and a bridge naming it is not a login bridge
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/addon-auth/package.json
  - server/backend/src/auth/sso-finish.ts
---

## Context

A self-hosted hub has no email provider; the magic-link addon could only log
its links, was disabled on the operator's hub (D777's carry-over), and still
shipped routes, settings, a bridge format the SSO finish read as a user record,
and a one-off migration.

## Decision

The `auth-magic-link` manifest entry, its routes, settings, icon, specs and
the D777 enabled-flag carry-over that only it used are deleted. The SSO finish
accepts only OIDC bridges (`auth-oidc/<instance>`); a bridge naming
`auth-magic-link` is "Not a login bridge token". D777's rule — one enable per
auth provider — is unchanged for the providers that remain.

## Consequences

- After addon-auth is updated, a hub keeps two inert leftovers: the provider's
  rows in `addon-settings` (`auth-magic-link.*`) and its id in the
  `capabilities.collection.auth-provider` disabled list. Nothing reads either.
- A future email login is a new addon with its own bridge format at the
  finish, not a revival of this one.

## Enforcement

The magic-link case in `sso-finish.spec.ts`; review only for the rest.
