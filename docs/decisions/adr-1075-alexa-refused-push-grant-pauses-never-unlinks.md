---
id: D1075
title: A refused Alexa push grant pauses proactive pushes; it never removes the link
status: accepted
date: 2026-11-21
supersedes:
applies-to:
  - packages/addon-export-alexa/src/**
  - packages/addon-export-alexa/lambda-template/**
---

## Context

On 2026-11-21 Amazon revoked a Login With Amazon grant. The hub's pushes got 401,
and each 401 asked the broker for a token; the broker served its CACHED one (it only
refreshed near expiry), so the hub spent 14 minutes retrying a token Amazon had
already refused. When the broker finally refreshed it got `invalid_grant`, deleted
its DynamoDB row and answered 410; the hub then called `removeLinkedAccount`, which
also dropped the `linkedAccounts` record. The admin table derives its link state
from that record, so it read "Unlinked" while voice directives (the hub's own OAuth
path) kept working, and action scenes exposed afterwards were never pushed, silently.
The hub deleted the link the same way on a broker 401, a gateway 403 and a refused
migration.

## Decision

The voice link and the push grant are two things. A refusal on any broker, gateway
or LWA path PAUSES proactive pushes and never deletes anything: only the operator's
explicit unlink removes a link. The pause is a discriminated `push` state persisted
on the account's token entry (`paused` with reason `grant-revoked | unauthorized |
gateway-forbidden`, `since`, `attempts`, `nextCheckAt`). While paused the hub skips
pushes (logged once per transition) and re-checks the broker on the existing
60 s scan, honouring the persisted `nextCheckAt`: 1, 2, 5, 15, 30, then 60 minutes,
reset by a 200 or by a new broker link; persisting it means a restart does not
become a burst. A 200 stores the token, which clears the flag, and runs the full
push. A gateway 403 is the exception: the broker refresh succeeding proves nothing
about the gateway, so a `gateway-forbidden` pause lifted by a re-check keeps its
attempt count until a push succeeds, and the next 403 climbs the backoff instead
of restarting it at 1 minute. The broker follows the same rule: `invalid_grant` marks the row
`grant-revoked` and keeps it (still authenticating, answering 410); a later
AcceptGrant yields a new link and the hub retires the old row. `/broker/token`
takes `{ reason: 'rejected' | 'recheck' }` to bypass its cache; the hub sends it
once per rejected token. `getStatus` keeps `linkState: 'linked'` while the voice
link exists and adds `push: 'ok' | 'paused'`; a status that did not answer renders
"Unknown", never "Unlinked" (D315).

## Consequences

A dead grant costs one cheap broker call per backoff step forever, until the
operator re-links, instead of a lost link. Rows of dead grants stay in DynamoDB
until their idle TTL. Re-linking is the one action that resumes at once.

## Enforcement

`lwa-push-pause.spec.ts`, `broker-hub-side.spec.ts`, `lambda-broker.spec.ts` and
`device-export-panel-link-badge.test.tsx` fail on the old delete-on-refusal and
cache-served-on-401 behaviour. Nothing else checks it.
