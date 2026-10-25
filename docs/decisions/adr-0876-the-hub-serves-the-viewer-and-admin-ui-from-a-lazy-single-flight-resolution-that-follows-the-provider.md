---
id: D876
title: The hub serves the viewer and admin UI from a lazy, single-flight resolution that follows the provider
status: accepted
date: 2026-10-18
supersedes:
applies-to:
  - server/backend/src/ui-serving/lazy-ui-serving.ts
  - server/backend/src/main.ts
---

## Context

`resolveViewerUi()` ran once after listen, polled the `viewer-ui` singleton for
30 s, logged "viewer-ui capability not registered — viewer not served" and never
tried again. On a cold boot the pipeline-orchestrator runner registered later
than that, so `/viewer/*` answered `503 {"error":"Viewer UI is starting"}` for
hours: the browser viewer, the desktop shell and hub-hosted embeds were down
while everything else was healthy. `resolveAdminUi()` had the same shape with a
60 s window. A second flaw sat beside it: once resolved, the served directory
never followed a provider that re-registered (addon update or restart).

## Decision

Resolution of a forked UI provider is lazy and single-flight, in one module
(`ui-serving/lazy-ui-serving.ts`) shared by both UIs. A request that finds
nothing served triggers, or joins, ONE resolution attempt and answers 503 only
if that attempt finds no provider; the next request tries again, at most once
per 2 s. Once served, each request compares the hub-scoped provider's object
identity (and that the index file still exists): a changed identity re-resolves,
so the served directory follows the provider. The boot-time attempt after listen
is kept. No timers and no retry backoff (D3); log lines are emitted once per
state change, never per request.

## Consequences

A UI provider that registers at any time after boot is served from the next
request. A request during the gap pays one `getStaticDir` call at most every 2 s.
The `CapabilityRegistry` has no registration subscription, so identity
comparison on the request path is the follow mechanism.

## Enforcement

`server/backend/src/__tests__/lazy-ui-serving.spec.ts` (late registration,
burst = one attempt, re-registration with a new dir) and
`startup-listen-order.spec.ts` (the boot attempt stays after listen).
