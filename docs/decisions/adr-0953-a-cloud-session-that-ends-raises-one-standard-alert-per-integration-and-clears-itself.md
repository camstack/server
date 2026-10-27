---
id: D953
title: A cloud session that ends raises ONE standard alert per integration, after a debounce, and clears itself
status: accepted
date: 2026-10-27
applies-to:
  - packages/types/src/addon/session-health.ts
  - packages/addon-provider-petkit/src/petkit-session.ts
  - packages/addon-provider-dreame/src/dreame-session.ts
  - packages/addon-provider-dreo/src/dreo-session.ts
---

## Context

PetKit keeps one cloud session per account. Signing the same account in on the
phone app kicks ours, every later call is refused, and the feeders sat on their
last values with nothing telling the operator. Only one addon (Google, its own
`google-broker:<id>` alert with a "Sign in again" action) raised anything, and
it did so with private code: its own id scheme, no debounce, its own resolve.
Copying that into every cloud addon would give ten dialects of the same alert.

Raising on the first failed call was rejected: a reconnect lasting seconds would
then page the operator. Raising per device was rejected too: one account with
three feeders is one lost session, not three.

## Decision

An addon that keeps a cloud session for an integration reports two facts to
`IntegrationSessionReporter` (`@camstack/types`) and nothing else: `failure(id,
err)` when a call fails and `ok(id)` when one succeeds. The addon supplies a
`classify(err)` that answers "is this the cloud ending OUR session?" with a
reason (`kicked`, `auth-rejected`, `token-expired`) or `null` — a network error
or an offline device is `null` and never alerts. `SessionHealthTracker` does the
rest: a debounce (2 min by default), one alert per `(provider, integrationId)`
named `session:<kind>:<integrationId>`, category `integration.session-lost`,
wording that names the provider, the integration and the reason, an
"Open integration" action (or the addon's own re-auth route), and an automatic
resolve on the next `ok`. A failed emit is retried by the next failure report;
the first `ok` of a process resolves an alert a previous run left active.

Every branch logs with `tags: { integrationId }`: debounce armed, alert pending,
alert already active, recovered inside the debounce, emitted, emit failed, alerts
capability missing, resolved.

## Consequences

A new cloud addon adopts the standard with a classifier, `bind()` in
`onInitialize`, `unbind()` in `onShutdown` and `forget()` for a vanished
integration. Detection is only as good as the classifier: Dreame and Dreo report
at sign-in (and Dreame on pushes and library errors) but do not yet detect a
mid-session kick, whose signal their libraries swallow. Google keeps its own
alert for now: its id is stored in existing alert records and its action is a
server-side OAuth route.

## Enforcement

`packages/types/src/addon/__tests__/session-health.spec.ts` pins the debounce,
the single alert, the resolve and the logging; each adopting addon has a spec
that pins its classifier and that its manager reports. Nothing forces a new
cloud addon to adopt: review only.
