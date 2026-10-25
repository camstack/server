---
id: D773
title: Alexa snapshots are re-encoded stills behind signed, ten-minute, account-token-checked URLs, under one integration switch that is on by default
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/snapshots/**
  - packages/addon-export-alexa/src/handlers/snapshot-provider.ts
  - packages/addon-export-alexa/src/http-server.ts
  - packages/addon-export-alexa/src/endpoints/builder.ts
---

## Context

`Alexa.SmartVision.SnapshotProvider` is the one camera-image surface Amazon
offers in it-IT and en-GB (object detection and event history are en-US only).
It was declared once, behind a parked constant, with no `GetSnapshot` handler
and no image route. Amazon's rules for the image URI: HTTPS, about ten minutes
of validity, HTTP 410 once expired or invalid, no redirects, and NOT public —
Alexa sends the user's access token and the server must check it.

The notification centre's artifact plane was considered and rejected: it is
private to post-analysis, its links last 24 h and they authenticate by HMAC
only, which Amazon's "not public" rule does not satisfy. The snapshot
builtin's public link plane (`/addon/snapshot/link/…`) was rejected for the
same reason, and because its links live two minutes.

The operator decided the feature is ONE integration-level switch, enabled by
default, not a per-camera opt-in.

## Decision

- "Snapshots in the Alexa app" (default ON): every exposed camera declares
  SnapshotProvider v1.1 (`isAvailable: true`, `minRefreshIntervalInSeconds:
  180`). Off removes the capability (the signature changes and every camera is
  re-pushed) and invalidates every URL already handed out.
- `GetSnapshot` reads the `snapshot` cap — its cache, or a fresh capture when
  the cache is past the camera's own max age; never `force`, which wakes a
  battery camera — bounded at 5 s, re-encodes to a JPEG with a 480 px short side
  (raised to Amazon's 360 px minimum for a tiny frame; the original is never
  served), keeps it in memory for ten minutes and answers a `Snapshot` event
  with `${publicHubUrl}/addon/export-alexa/snapshot/<uuid>.jpg?exp=&sig=`
  (`authenticationType: ACCESS_TOKEN`). No public HTTPS address ⇒ an error, never
  a LAN or loopback URL.
- The route is `access: 'public'` at the hub and the handler is the gate: switch
  on, HMAC and expiry hold, image still held (else 410); a live account-link
  token (else 401); the token's user is the user the image was minted for and
  may still view the camera (S1, else 403). 200 with `image/jpeg`,
  `cache-control: private, no-store`, `content-encoding: identity`. Never a
  redirect.

## Consequences

- **Privacy.** With the default on, still images of the operator's cameras go
  to Amazon whenever the Alexa app or an Echo shows a camera tile. The privacy
  policy draft (the docs repo's unpushed `alexa-publish-legal` branch) says the
  skill carries no video or images; it must be changed before the skill is
  published, the console's "collects personal information" answer must be yes,
  and the listing must mention images. This record does not edit that branch.
- A hub restart forgets the images; Alexa gets 410 and asks again, which is
  Amazon's documented recovery.
- Memory is bounded (128 images, 24 MB).

## Enforcement

`snapshot-provider.spec.ts` (the event shape, the URL, the switch, no public
address, no frame; the route's 200 / 410 expired / 410 tampered / 410 switched
off / 401 / 403 cases; the re-encode sizes; the route wiring) and the R2
scenarios in `endpoint-shape-validation.spec.ts`.
