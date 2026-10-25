---
id: D767
title: An Alexa account link reaches only what the hub user who linked it may reach, read live from that user's grants
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/access/**
  - packages/addon-export-alexa/src/directive-router.ts
  - packages/addon-export-alexa/src/sync-engine.ts
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
---

## Context

Consent (`server/backend/src/api/oauth2/oauth2-routes.ts`) bakes the
integration's `requestedScopes` into the account-linking code, and for
`export-alexa` that is `category:device [view, create]` whatever the consenting
user may do. Nothing downstream asked who consented. On a hub with more than
one user, a viewer-only user who enabled the skill received every exposed
camera, its PTZ, its siren and floodlight switches and the alarm panel in their
Alexa app, and every motion and doorbell event for all of them.

Worse, the directive handlers trusted the endpoint id: `PowerController` on
`<any exposed id>__<any device id>` actuated that device whether or not it was
exposed or was an accessory of the camera at all, and `ReportState` answered for
any device id. The runbook (C.2-a) listed this as a blocker for publishing the
skill; images (SnapshotProvider) would have made it a privacy leak, not only an
authorization one.

The link already carried its identity: the token's `userId` claim is the
camstack user who consented and `oauthVerifyAccessToken` returns it. What was
missing was enforcement. Narrowing the token's scopes at consent was considered
and rejected: scopes are frozen at consent (the integration's AGENTS.md), so a
grant later revoked from the user would stay in the link forever.

## Decision

Every Alexa surface is intersected with the LINKING user's live grants, read
from the authority that owns them (`userManagement.listUsers`) and resolved with
the same selector engine as the tRPC middleware (`resolveViewableDeviceIds`):

- An admin user's link reaches every exposed device. A scoped user's link
  reaches what that user's `device` / `category:device` grants cover at the
  access the directive needs: `view` to discover, stream and read state,
  `create` to actuate (PTZ, privacy, autotrack, switches, lights, siren, the
  alarm panel, two-way audio). A deleted user's link reaches nothing and is
  answered `INVALID_AUTHORIZATION_CREDENTIAL`.
- Every endpoint directive passes one gate in the router before any handler:
  the endpoint must sit under an EXPOSED device, an accessory id must name a
  real child of that device, and the grant must cover the addressed device.
  `SessionDisconnected` is exempt; it only tears down.
- Discovery and every `AddOrUpdateReport` are cut per account. A camera the user
  may see but not drive is shown without its PTZ controllers and with
  `isFullDuplexAudioSupported: false`.
- Proactive events read a per-account visibility mirror (`accountVisibility`,
  refreshed every 60 s off the event path, D49). A gain is pushed to that
  user's Alexa account on the first read that shows it. A loss stops events at
  once but is deleted from the user's Alexa account only when two consecutive
  refreshes agree, and a device whose metadata cannot be read keeps its
  previous answer, because a `DeleteReport` destroys the user's routines.
- A link that predates this record is treated as having been sent everything,
  so its first two refreshes delete what a scoped user should never have had.

## Consequences

- A revoked grant stops directives within 30 s (the user-grant cache) and events
  within one refresh (60 s).
- An unreadable user store refuses directives (`INTERNAL_ERROR`) and leaves the
  mirror as it was. Nothing falls back to "allow".
- Endpoints a user may see but not drive that were pushed before this record
  stay in that user's Alexa app until a re-link; every directive on them is
  refused.
- The token still carries `category:device [view, create]`; the gate is what
  bounds it. The token cannot reach any other addon route (`addon:<id>` grants,
  D103).

## Enforcement

`alexa-access-gate.spec.ts`, `directive-user-scoping.spec.ts`,
`account-visibility.spec.ts`, the per-account cases in `sync-engine.spec.ts` and
the S1 case in `motion-event-gating.spec.ts`. Each was run against the code
with the gate removed and fails.
