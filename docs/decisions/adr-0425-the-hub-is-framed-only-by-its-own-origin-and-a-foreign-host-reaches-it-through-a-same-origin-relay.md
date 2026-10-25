---
id: D425
title: The hub is framed only by its own origin, and a foreign host reaches it through a same-origin relay
status: accepted
date: 2026-09-09
supersedes:
applies-to:
  - server/backend/src/api/static/frame-policy.ts
  - packages/addon-admin-ui/src/lib/viewer-embed.ts
  - packages/addon-admin-ui/src/pages/Viewer.tsx
---

## Context

The operator asked for two things: the viewer shown inside Home Assistant,
with a link for the admin UI and one for the viewer; and the admin UI showing
the viewer inside itself. Both are `<iframe>`s of pages the hub serves, and
the hard part is authentication across an origin boundary. What was
verified before deciding, rather than assumed:

- **The hub sent no framing policy at all.** `curl -I` against the live hub
  (`/`, `/login`, `/viewer/camstack/`, the embed shell): no
  `X-Frame-Options`, no `Content-Security-Policy`. Any site could frame the
  login page. Nothing in the repo set one — `grep frame-ancestors` found
  only pipeline code about video frames.
- **A direct cross-origin frame never worked, and could not be made to
  without weakening the cookie.** The session cookie is `SameSite=Lax`
  (`server/backend/src/auth/session-cookie.ts`), so it is not sent by a
  cross-site frame: the viewer's `auth.exchangeSession` bootstrap answers
  401, bounces the frame to `/login`, the login sets a cookie the frame will
  never be allowed to send, and the loop guard falls back to a manual login
  whose bearer lives in partitioned storage while every cookie-only surface
  (`<img>` snapshots) stays 401. The only way through is `SameSite=None`,
  which puts the cookie on every cross-site request to every cookie-gated
  route — the surface the operator said not to widen.
- **Home Assistant already frames the hub, and does it same-origin.** The
  component (`camstack/homeassistant-component`, 0.5.12+) relays
  `https://<ha>/api/camstack/p/<grant>/…` → `https://<hub>:4443/…`: the
  sidebar panel frames the admin UI under a per-entry grant that injects
  nothing and carries the hub's own cookie upstream, and the two Lovelace
  cards frame the viewer's EMBED (`/viewer/camstack/embed/index.html?mode=…`)
  under a share-token grant limited to `viewer/`, `trpc`, the snapshot planes
  and event media. The admin UI survives the prefix because of D373. The
  browser sees one origin, so no cookie leaves its site and no certificate
  has to be trusted.
- **The full viewer cannot be relayed today, and the reason is not on the
  hub.** It is an Expo export with `baseUrl` baked in at build time
  (`EXPO_PUBLIC_WEB_BASE_PATH=/viewer`): its shell references
  `/viewer/camstack/_expo/…` root-absolute, `expo-router`'s `stripBaseUrl`
  is anchored (`^\/?<baseUrl>`, `getStateFromPath-forks.js:177`) so a relayed
  pathname never matches a route, and `HubSessionBootstrap` provisions
  `serverUrl` as the serving ORIGIN, which under the relay is Home
  Assistant's `/trpc`. Rewriting the shell on the hub fixes only the first of
  the three. Making the viewer mount-aware is the viewer's D373, in the
  viewer repository — a separate ship chain, deliberately not started here.
  The same fact means the admin UI's old "Viewer" link, which opened
  `hubPath('/viewer/camstack/')`, was a page of 404s inside the Home
  Assistant panel.

## Decision

**Every HTML document the hub serves declares `Content-Security-Policy:
frame-ancestors 'self'`, and that is the only shape in which the hub is
framed.** A cross-origin host embeds the hub by relaying it under its own
origin, never by being allowed as an ancestor and never by loosening the
cookie. The admin UI frames the hub-served viewer at `/live`, same-origin, at
the ROOT mount only; under a mount prefix it says why it cannot instead of
painting a white rectangle. For Home Assistant the two links are therefore:
the admin UI through the component's own sidebar panel (relay, nothing to
paste), and the viewer at the hub's own address, opened in a new tab, until
the viewer learns the mount.

## Consequences

- The policy is stamped in one `onSend` hook on the one Fastify instance, on
  every `text/html` reply that does not state its own CSP — not per
  shell-send site, because the cache policy once drifted exactly that way
  (`spa-shell-cache-headers.spec.ts`). Replies that bypass Fastify's pipeline
  (`reply.raw`, `reply.hijack()`) are not covered; none of them is a shell.
- The relay forwards the header and the browser evaluates `'self'` against
  the RELAY's origin, so the panel and the cards keep working unchanged. A
  top-level window — the desktop shell, a native WebView, a share link — has
  no ancestor and is unaffected.
- Pasting a direct hub URL into a Home Assistant "Webpage" dashboard now
  shows nothing, by policy, where before it showed a login loop. The
  component's own direct-frame fallback (taken only when its mount probe
  fails, e.g. the hub was down when the entry loaded) is blank the same way
  until the entry reloads; the component should re-probe on link-up, which
  is its change, not the hub's.
- `SameSite` stays `lax`. `/viewer` stays the hub's redirect; the admin route
  is `/live` because the SPA fallback excludes the `/viewer` tree.
- The `external` nav flag, which existed for the one new-tab link, is gone
  from the nav registry, the sidebar and the global search.

## Enforcement

- `server/backend/src/api/static/__tests__/frame-policy.spec.ts`: an HTML
  reply carries the directive, an asset and a JSON body do not, a route with
  its own CSP keeps it, and `main.ts` calls `registerFramePolicy(fastify)`
  (source assertion — removing the call fails the suite; verified).
- `packages/addon-admin-ui/src/lib/__tests__/viewer-embed.spec.ts` and
  `pages/__tests__/Viewer.spec.tsx`: frame at the root with the permissions a
  live view needs, no frame under a mount (removing the branch fails both;
  verified).
- `scripts/check-hub-paths-through-mount.ts` keeps the frame `src` composed
  through `hubPath`.
