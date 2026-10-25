---
id: D768
title: An Alexa export status read carries no secret, the ingress token is revealed only by an admin action, and every Alexa action is admin-only
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/setup-block.ts
  - packages/addon-export-alexa/src/custom-actions.ts
  - packages/addon-export-alexa/src/ingress-token.ts
---

## Context

`deviceExport.getStatus` is polled by every open admin page. Its `setup` block
carried the Lambda ingress token verbatim in a row flagged `secret: true`, and
that flag only masks in the browser — the value travelled on every poll. The
transport boundary already strips `setup` for non-admin principals (D634), so
the remaining exposure was every admin session, its browser cache and anything
that logs a status response.

Checking the rest of the surface found a worse hole: every custom action of the
addon was registered at the framework default, `protected`, so ANY
authenticated user could call `regenerateIngressToken` (and read the new token
in the response), `unlinkAlexaAccounts`, `purgeStaleEndpoints`,
`resyncDiscovery` or `rotateBrokerCredential`.

The generic settings read (`addonSettings.getGlobalSettings` and friends) was
checked too: non-admins already receive every `password` / `secret: true` field
as `***` (D634); admins receive the stored value by design, because the settings
form is hydrated from it. The Alexa settings form declares no secret field — the
ingress token, the broker credential and the push grants are hidden config.

## Decision

A status read of the Alexa export carries a mask (`••••••••` plus the last four
characters), never a secret. The ingress token is returned in clear by exactly
one surface: the admin-only `revealIngressToken` action, behind a "Show ingress
token" button, plus the response of the admin-only rotation. Every custom action
of this addon declares `auth: 'admin'`.

## Consequences

- The operator copies the token from the settings page ("Show ingress token"),
  not from the Exported devices panel.
- A new custom action on this addon must declare its auth; the spec fails on a
  missing one.

## Enforcement

`no-secret-on-read.spec.ts`: every action is admin-only, the setup block never
contains the token, and the mask never contains more than the last four
characters.
