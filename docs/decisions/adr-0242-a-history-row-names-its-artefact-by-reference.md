---
id: D242
title: A delivery history row names its artefact by reference, minted fresh on demand
status: accepted
date: 2026-08-26
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/outbox.ts
  - packages/addon-post-analysis/src/notification-center/artifact-plane.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
---

## Context

`NcHistoryEntry` (`notificationRules.getHistory`) already froze a subject
summary (`className`, `label`, `confidence`, `zones`) at fire time, but
carried no link to the picture a trigger actually shipped. The dispatcher DID
index that picture — `withArtifactUrls` calls `indexArtifact` for every
still/gif/clip it resolves — but the resulting artefact id was used only to
wire a video's poster (`posterArtifactId`) and then discarded. A caller
wanting "the image of the last trigger" had nothing to read.

Two shapes were considered and rejected:

- **Freeze a URL on the row**, the way a timelapse's `payload.artifacts`
  does. Rejected: a signed artefact URL has a TTL (24h default); a history
  row is durable and read arbitrarily long after delivery. A frozen URL would
  silently go dead while the row still claimed to have a picture — the exact
  "broken link" failure the operator's constraint named.
- **Freeze the bytes.** Rejected outright — an artefact is often megabytes,
  the outbox row is durable JSON rewritten on every delivery attempt, and
  `NcOutboxPayload`'s own docblock already forbids this for exactly this
  reason (`artifacts` carries a URL, never bytes).

## Decision

A history row carries `artifactIds: string[]` — the ids the delivering
attempt's media resolve indexed, in order (still, then gif, then clip),
written back onto the outbox row's payload by `NcOutbox.attempt()` from the
`NcDeliverResult` the dispatcher returned, exactly like `confirmVerdict`. It
is a REFERENCE only. A caller resolves one to a fetchable URL through a
SEPARATE method, `notificationRules.resolveArtifactUrl(artifactId)`, which
calls `NcArtifactPlane.mintUrl` — the same signing/endpoint-ranking the
dispatcher itself uses to attach media to an outgoing notification, never
re-derived. `mintUrl` checks the artefact's `expiresAt` (derived from the
retained shelf's own age bound) and returns `null` on an id that is unknown,
expired, or when no externally-reachable base URL exists for this install —
three causes a caller must render identically ("no image right now"), never
as a broken link.

## Consequences

- A history reader (the Home Assistant export's `last_trigger_image`, the
  future viewer History screen) mints a URL PER READ, not once at delivery.
  This costs one extra round-trip per read but means a URL is never stale by
  construction — it is either freshly signed or explicitly absent.
- `artifactIds` is only written when the delivering attempt actually indexed
  something (`NcDispatcherDeps.indexArtifact` wired, and media resolved to
  attach). A wiring with no artefact index (or a text-only notification)
  produces a row with no `artifactIds` field, not an empty array — absence is
  the honest answer to "was anything indexed", matching every other optional
  field on this row.
- A row's `artifactIds` is frozen at the ATTEMPT that succeeded and never
  rewritten again — a retried delivery re-resolves and re-indexes media on
  every attempt (pre-existing behaviour, unchanged by this decision), but only
  the successful attempt's ids ever reach the row.

## Enforcement

`packages/addon-post-analysis/src/notification-center/__tests__/outbox.spec.ts`
(`artifact ids (history → artefact reference)`),
`packages/addon-post-analysis/src/notification-center/__tests__/dispatcher.spec.ts`
(`NcDispatcher artifact urls`), and
`packages/addon-post-analysis/src/notification-center/__tests__/artifact-plane.spec.ts`
(`NcArtifactPlane.mintUrl`) each pin one half of the chain — disarming any one
of the three writes (the dispatcher returning ids, the outbox persisting
them, or the plane's expiry check) turns its own test red. No guard script;
the three-way test coverage is the enforcement.
