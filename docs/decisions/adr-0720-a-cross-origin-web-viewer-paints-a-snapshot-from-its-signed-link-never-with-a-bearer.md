---
id: D720
title: A cross-origin web viewer paints a snapshot from its signed link, never with a Bearer
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - camstack/src/data/snapshot-image-auth.ts
  - camstack/src/data/use-snapshot.ts
  - packages/system/src/builtins/snapshot/snapshot-link-url.ts
---

## Context

The hosted viewer PWA (`https://camstack.zentik.app`, [D707](adr-0707-a-browser-origin-reads-the-hub-only-from-an-allowlist-and-never-with-the-session-cookie.md))
talks to each operator's hub on ANOTHER origin. A camera tile there was the
authenticated media URL (`/addon/snapshot/media/<id>.jpg`) with an
`Authorization: Bearer` header, because the hub's session cookie is never sent
cross-origin. That header cost twice per tile:

- the browser could not load the image as an `<img>`: `expo-image`'s web loader
  `fetch()`es a header-carrying source from JS into a blob and paints nothing
  until the object URL exists — no progressive decode, no browser priority;
- a cross-origin request with `Authorization` is not "simple", so every tile
  paid a CORS preflight first — measured 110–140 ms each through the tunnel,
  and a grid of 32 cameras queues them behind the per-origin connection limit.

The hub already had the right primitive. `snapshot.getSnapshotLinks` mints a
signed, expiring, width-scoped link on a PUBLIC plane
(`/addon/snapshot/link/<id>.jpg?w&v&exp&sig`, `snapshot-link-url.ts`): the HMAC
is the authority, as for notification buttons ([D47](adr-0047.md)), the TTL is
two minutes, the width is inside the signature, `force` is not honoured, and the
answer is the media handler's (`ETag`, `Cache-Control: private, max-age`). The
viewer asked for those links on every poll — as the demand signal ([D99](adr-0099.md))
— and then threw the URL away and painted the Bearer media URL, because on iOS a
link expires while the app is suspended and a cached frame vanished on resume.
That reason is native-only; it had been applied to every platform.

## Decision

A web page whose origin differs from its hub's paints the signed link the hub
minted, as a plain image with no header. A signed link never carries a Bearer,
whatever else is true. The authenticated media URL (with a Bearer) remains the
fallback for that tile when the link is missing, expired, or failed to load
once; a newly minted link is tried again. Native and a same-origin web page
(the hub-served `/viewer`, where the session cookie already makes the media URL
a plain `<img>`) keep the media URL.

No new server surface: the link plane is already token-only, short-lived,
device- and width-scoped, and cacheable.

## Consequences

- A cross-origin tile is one simple GET: no preflight, no JS blob, the
  browser's HTTP cache.
- The tile URL now also changes when the link's expiry bucket rolls (at most
  once per ~2 min per tile, `SNAPSHOT_LINK_EXP_BUCKET_MS` / renew margin),
  which is one extra fetch of an unchanged frame. Accepted: it replaces a
  preflight plus a blob on every paint.
- A tab that sleeps past the TTL wakes to an expired URL; the load fails once
  and the tile repaints from the media URL until the next poll mints a link.
- A leaked link from the hosted PWA grants exactly what the link plane already
  granted: one camera, one width, for at most the TTL.

## Enforcement

`camstack/src/data/__tests__/snapshot-image-auth.spec.ts`:
`shouldPaintSignedSnapshotLink` (web + cross-origin only; never native, never
same-origin, never an expired or failed link) and `shouldAttachSnapshotBearer`
refusing a signed link; plus a wiring assertion that `useSnapshot` hands the
link to the URL builder and falls back on failure.
