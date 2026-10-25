---
id: D259
title: A track's media listing covers its detail-crop owners, and renames the stored kind on the way out
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/track-media-scope.ts
  - packages/addon-post-analysis/src/pipeline-analytics/analytics-query-facade.ts
---

## Context

A track's media is not all under `ownerKind: 'track'`. The subject detail crops
have their own owners, keyed by a PREFIXED track id, and they are written with
the generic stored kind:

| owner | ownerId | stored kind | writer |
| --- | --- | --- | --- |
| `track` | `<trackId>` | `thumbnail`, `keyFrame`, … | `event-media-dispatcher.ts` |
| `face` | `face-<trackId>` | `crop` | `face-recognizer.ts:913` |
| `plate` | `plate-<trackId>` | `crop` | `plate-recognizer.ts:412` |

`getTrackMedia` / `listTrackMedia` read the first row of that table only, so a
track's own listings could never see its plate or face crop. Measured on three
live tracks: `listTrackMedia` answered 6-7 rows with no plate, while
`plateGallery.getPlateByTrack` returned the crop for all three.
`event-thumbnail-resolver.ts` had already walked all three owners for the event
thumbnail — the two listings were simply the ones that never caught up.

The viewer papered over the gap with a synthetic `plateCrop` tile built from the
plate gallery. That worked while the strip rendered tiles by URL. It stopped
working the moment the detail started loading the SELECTED entry's bytes
lazily (viewer `452b75e`, v1.0.405): the loader asked
`getTrackMedia({ kinds: ['plateCrop'] })` — wrong owner *and* wrong kind — got
`[]`, and `[]` for a key the tile vouched for is reported to the operator as a
FAILED read. A red triangle over a crop the hub was holding, while the
thumbnail beside it rendered fine. `faceCrop` sat in the same client-side kind
list, one merged tile away from the identical failure.

The tempting fix was to have the client ask for `crop`. It is wrong: `crop` is
already the track's own body crop, and a client cannot tell the two apart.

## Decision

`getTrackMedia` and `listTrackMedia` read every owner a track's media lives
under — `('track', id)`, `('face', 'face-'+id)`, `('plate', 'plate-'+id)` — and
a stored `crop` lifted from a detail owner is PUBLISHED as `faceCrop` /
`plateCrop`. The rename happens on the way out, in one place
(`track-media-scope.ts`), never in the caller's question: a wire `MediaFile`
carries no `ownerKind`, so the owner is the only thing that disambiguated the
stored `crop`, and once it is gone the kind has to carry the distinction.
`MediaFileKindEnum` already holds both names with exactly this meaning, and the
event-owned child crops already use them.

Only a stored `crop` is lifted from a detail owner. Anything else that ever
lands there is not the track's media and is left alone rather than renamed into
a crop it is not.

## Consequences

- The two listings agree by construction: every kind the manifest advertises can
  be fetched back. That agreement is the whole contract the viewer's per-entry
  loader rests on — a manifest key whose byte read comes back empty is, and must
  remain, an error.
- The face and plate crops become first-class tiles in every surface built from
  the manifest (the viewer detail strip, the admin-ui event panel).
- A `kinds`-filtered read that names neither detail kind does not open those two
  owners, so the common per-entry fetch costs exactly what it did. The track
  scope is never skipped — its kinds are open-ended, and guessing there is how a
  listing starts lying about what a track has.
- The viewer keeps its gallery fallback for older hubs, and marks that tile
  `offManifest` so it is rendered from its data-plane URL instead of being asked
  for over a cap that cannot answer.

## Enforcement

`packages/addon-post-analysis/src/pipeline-analytics/__tests__/track-media-detail-crops.spec.ts`
drives the real `MediaStore` through the real facade: it asserts both crops are
listed, that they are never published as `crop`, that every manifest kind can be
fetched back, and that a non-detail `kinds` request opens no extra owner. On the
client, `camstack/src/components/events/track/__tests__/track-detail-gallery-crop.spec.ts`
mounts the detail against a hub that does NOT cover the detail owners and
requires the hero to resolve rather than error.
