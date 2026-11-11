---
id: D1047
title: An OAuth link names its instance, and no instance means the default one
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/system/src/builtins/local-auth/oauth-grants.ts
  - packages/system/src/builtins/local-auth/oauth-session-manager.ts
  - packages/types/src/addon/addon-instance.ts
  - server/backend/src/api/oauth2/oauth2-routes.ts
---

## Context

An account is linked to an integration (`/api/oauth2/authorize?integration=`),
and an integration belonged to one addon with one configuration. With routes
addressed per instance (D1046) a link must say WHICH instance of the
integration the account was linked to, and a route must be able to refuse a
token that was made for another one (planning#415).

## Decision

- **`instance=` beside `integration=`**, on the same authorize route. The
  integration's descriptor lists the instances an account can be linked to
  (`instances`); an id it did not list is refused before the consent page.
- **No instance = the default instance, and that is the only spelling.**
  A request without `instance=`, with an empty one, or with the addon id
  makes a link that stores no instance. Every link made before instances
  existed is therefore already a link to the default instance: no session
  row is rewritten.
- **The session is the authority.** The instance is written on the
  `oauth-sessions` record at the code exchange. `oauthVerifyAccessToken`
  answers it from the session it re-reads anyway, and a refresh re-mints from
  the session.
- **The tokens carry it as a claim** (`instanceId`) for a relay outside the
  hub that routes on the access token without being able to call the hub.
  The hub does not trust that claim for anything.
- **One comparison**, `oauthLinkServesInstance(link, request.instanceId,
  addonId)` in `@camstack/types`: a per-instance route calls it and refuses
  a link made for another instance. Nothing compares an absent instance with
  an id by hand.

## Alternatives rejected

- **Stamping the default instance on every existing session** (a
  migration): it needs integration → addon at migration time, before forked
  addons have registered their descriptor, and it would leave two spellings
  of "default" for as long as one unmigrated row or token exists.
- **A second authorize route per instance**: every refusal, log line and
  rate limit of the first one to keep equal.
- **Reading the instance from the token claim at verify**: the claim cannot
  be revoked or corrected; the session can.

## Consequences

- A descriptor that declares no `instances` accepts only the default one.
- The consent page does not offer a choice of instance yet: the caller names
  it. The picker for a link started without one belongs to the exporter
  steps of planning#415.
- Nothing calls `oauthLinkServesInstance` yet; the exporters adopt it when
  their routes become per-instance. Until then a link to an instance is
  accepted wherever a link to the default one is.
- The linked-sessions list returns `instanceId` but the admin page does not
  show it yet.
