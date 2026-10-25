---
id: D246
title: Every counted call declares its transport plane, and an undecidable plane is a named bucket
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - server/backend/src/api/trpc/http-request-census.ts
  - server/backend/src/api/trpc/ws-request-census.ts
  - server/backend/src/api/trpc/core-cap-bridge.ts
  - packages/types/src/capabilities/system.cap.ts
---

## Context

Half a day was burned hunting `deviceManager.listAll` — **4 960 calls in a
two-minute hub boot**, ~1 017 rows each — for one reason: *we knew what was
called and not from which PLANE it arrived.*

ADR-0244 shipped a census that counts tRPC calls per procedure and per caller,
and hooked it at the tRPC context factory. That is exactly right on HTTP, where
`@trpc/server` runs the factory once per request. On the WebSocket it is exactly
wrong: `applyWSSHandler` builds ONE context per CONNECTION and reuses it for
every frame the socket ever sends, so the hook fired **once every 37
connections instead of once every call**. And `main.ts` states — in the comment
that names `deviceManager.listAll` — that the viewer talks to the hub over
`wsLink` EXCLUSIVELY. The expected HTTP result was therefore ~zero, and the
culprit was invisible to the only instrument pointed at it.

The in-process mesh was worse: `$core-caps` reaches the same router through
`createCaller`, touches no socket, and so could not appear in any transport
count at all — not even as a zero.

The demonstrated cost of that ignorance: two client-side fixes (admin-ui
`GlobalSearch`, embed `EmbedGridPage`) shipped against a wrong hypothesis, with
the number unmoved at 4 960 against 4 888.

Rejected alternatives, both of which look cheaper:

- **A tRPC middleware on the base procedure.** It fires per operation on every
  plane, which is attractive, but it double-counts against the HTTP hook,
  changes the router for every caller, and pays an allocation per call whether
  or not the census is armed.
- **Counting WS connections harder** — connection duration, frames per socket.
  A proxy for the number, not the number. This repo has already paid twice for
  attributing by plausibility instead of by measurement.

## Decision

Every call the transport census counts carries **exactly one
`TransportPlane`** — `http`, `ws`, `mesh`, or `unknown` — and the four counters
**sum to `procedureCalls`**, a property the snapshot reports as
`planesExplainTotal` rather than asserting in prose. A plane that cannot
attribute a call declares it: the call lands in the `unknown` bucket, never
dropped and never silently absent. A plane that measured nothing reports `0`;
omitting the key is forbidden, because an absent key reads as "not
instrumented".

The hook for a plane goes wherever ONE OPERATION is observable, not wherever a
context is built. On the WebSocket that is the client frame
(`ws-request-census.ts`), because the adapter exposes no per-operation seam;
identity is the CONNECTION's, derived once with `describeTrpcPrincipal` and
reused. **A subscription is not a call**: subscription starts are counted apart
and never enter `procedureCalls`, or one stream held for six hours wears the
costume of a storm.

The census and `FleetReadCensus` count **different things and are never added
up**: this one counts entries into the hub's tRPC router; the fleet census
counts reads of the device row store. The reconciliation that is meaningful is
`fleet.totalCalls − Σ addon:* rows == transport.procedures['deviceManager.listAll'].calls`
over the same window, and when it does not balance a plane is missing — which
is the result, not a failure.

## Consequences

- **The armament does not change.** One window, armed through
  `system.setLoggingSettings { diagnostics: [{ id: 'request-census', … }] }`
  (D245), read through `system.getRequestCensus`. Every new plane hangs off
  that window. A second arming mechanism for the WS plane would have
  reintroduced, on the cure's side, the exact defect the logging plan denounces.
- **The disarmed cost stays a boolean read on the hot path.** The WS message
  listener's first statement is `census.armed`; nothing is decoded, parsed or
  allocated below it. What is newly paid while disarmed is one small session
  object per CONNECTION — not per call — because the window can open mid-
  connection and a socket opened before the arm would otherwise be blind for
  its whole life.
- **The wire shape grew, the method count did not.** `planes`,
  `planesExplainTotal`, `subscriptions`, `subscriptionStops`, `wsMessages` and a
  per-procedure plane split are fields of the existing `RequestCensusSnapshot`.
  Adding a plane is a value in one enum plus a counter the compiler demands.
- **The file and the persisted key keep their HTTP names.**
  `http-request-census.ts` and the `http-request-census` settings row are
  identifiers, not descriptions; renaming a persisted key to improve a noun is
  how a diagnostic silently stops restoring across the release that renamed it.
  The public vocabulary is honest: the log line says `transport census`.
- **`CoreCapAction.invoke` now receives a `CoreCapCallOrigin`.** It is
  diagnostics only — no implementation may gate on it — and it exists because
  an in-process call has no request and therefore no other identity.
- Grepping Loki for `http request census` now finds only windows measured
  before 2026-08-27. That is the honest outcome: those windows really did
  measure one plane.

## Enforcement

`server/backend/src/api/trpc/__tests__/http-request-census.spec.ts` — ONE spec,
extended rather than split, because the invariant is that the planes sum and an
invariant spread over two files is stated by neither. Each load-bearing test
names its neutralisation in the file header; every one was removed and confirmed
RED before being restored:

- per-operation WS counting (drop the frame listener → 4 queries report 1),
- subscriptions counted apart (fold them into calls → `procedureCalls` inflates),
- the disarmed WS cost (move the guard below the decode → a frame whose
  `toString` throws, which a second test proves is genuinely hostile when armed,
  so the guarantee cannot rot into a tautology),
- plane attribution (stop incrementing the plane → `planesExplainTotal` goes
  false, which is the acceptance criterion failing out loud).

`server/backend/src/__tests__/core-cap-bridge.spec.ts` pins the mesh plane and,
with it, the non-overlap with the fleet census: `deviceManager` is not a core
namespace, so no `$core-caps` action exists for it and a cap-channel `listAll`
counted there as `addon:<id>` can never also appear on this plane.

No guard script. The rule is a shape, and the exhaustiveness that matters is
enforced by the compiler: `zeroPlaneCounts()` is a record literal over
`TransportPlane`, so a plane added to the wire enum fails to build until it has
a counter.
