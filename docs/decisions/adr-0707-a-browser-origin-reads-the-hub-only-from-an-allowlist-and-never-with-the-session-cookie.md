---
id: D707
title: A browser origin reads the hub only from an allowlist, and never with the session cookie
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - server/backend/src/api/cors/cors-policy.ts
  - server/backend/src/api/cors/register-cors-policy.ts
  - packages/system/src/http/reverse-proxy.ts
  - packages/system/src/kernel/config-schema.ts
---

## Context

The operator decided (2026-10-06) that the viewer PWA is hosted at
`https://camstack.zentik.app` and talks directly to each user's own hub from
the browser: no proxy and no cloud relay. The hub must therefore answer
cross-origin calls from that origin. These calls are tRPC over HTTP and the
`/trpc` WebSocket, the login legs (`auth.login`, `auth.loginVerifyTotp`,
`auth.redeemHandoffCode`) and the data-plane media under `/addon/:id/*`
(snapshots, clip stills, event media, recorded byte ranges).

The hub already answered every request with `Access-Control-Allow-Origin: *`
from a blanket `onRequest` hook (`manual-boot.ts` `enableCors`). The data-plane
reverse proxy restamped `*` on its hijacked responses, because hijacking skips
Fastify's hooks. So the PWA would already have worked, and so would every
other page on the internet. Any site a user visited could read whatever hub
response its script could reach: unauthenticated probes of a LAN hub, and any
upstream that sent its own `*` (the authenticated file-server does). Nothing
checked the WebSocket `Origin`.

Restricting the policy has three known traps, and each one would have caused
an outage:

- The iOS app's live view is an OTA-bundled embed page loaded from `file://`
  inside a WKWebView. Its origin is opaque (`null`), and it calls the hub
  cross-origin.
- The Home Assistant panel relays the embed under HA's origin. It forwards the
  browser's `Origin` and sets `X-Forwarded-Host` to HA's host, so the hub sees
  a foreign origin on a WebSocket that is legitimate.
- React Native's WebSocket on iOS and Android sends `Origin` equal to the
  target's own origin.

## Decision

The hub grants CORS only to an allowlist, and it reflects the exact origin. The
allowlist contains:

- the hub's own origin, meaning an `Origin` whose host equals `Host` or
  `X-Forwarded-Host`;
- `VIEWER_PWA_ORIGIN` (`https://camstack.zentik.app`);
- `OPAQUE_ORIGIN` (`null`), for the native embed;
- the hub's public URL, when it is set (`CAMSTACK_PUBLIC_ORIGIN` at the time of this record; folded into `CAMSTACK_HUB_PUBLIC_URL` on 2026-10-06, see `docs/architecture/deploying.md`);
- the operator's extras in `server.corsOrigins`, set in config.yaml or through
  `CAMSTACK_CORS_ORIGINS` as a comma-separated list.

A denied origin gets no CORS header at all, and each denied origin is logged
once. The hub never sends `Access-Control-Allow-Credentials`. Cross-origin
callers authenticate with a bearer token, either in `Authorization` or in tRPC
`connectionParams`. The httpOnly session cookie therefore never authenticates a
cross-origin request. `auth.exchangeSession`, `/api/embed-auth` and the
admin-ui stay same-origin. The `/trpc` WebSocket upgrade is refused with a 403
when `Origin` is present and not on the list. The edge owns the policy: the
data-plane proxy drops any `access-control-*` header from upstream and keeps
the headers the hub stamped on the raw response.

The extras live in the bootstrap `server` section, not in the settings store.
The policy is live from the first request, before the store's addon boots.
Widening who may read hub responses is the same class of decision as `auth.*`,
and D675 keeps that class out of the store's reach.

## Consequences

- A new web host for the viewer needs a config entry and a restart. A dev
  server is a new web host too: Expo web on `http://localhost:8081` must be
  added to `CAMSTACK_CORS_ORIGINS`. The refusal is logged with that hint.
- `null` stays allowed. Any sandboxed iframe can claim the opaque origin, so for
  unauthenticated responses this entry is no stronger than the old `*`. It is
  the price of the native embed. Authenticated responses still need a bearer
  token, and no ambient credential ever crosses origins.
- Media routes that the PWA cannot use as they are:
  - **The data-plane gate (`/addon/:id/*`) accepts `Authorization` or the
    session cookie, never `?token=`.** The viewer already fetches cross-origin
    images with the bearer header and renders the blob (`snapshot-image-auth.ts`
    attaches it whenever the image is not same-origin), so this works with
    CORS. A bare `<img src>` or `<video src>` cross-origin will not
    authenticate.
  - **Web live view iframes `<hub>/viewer/camstack/embed/index.html`.**
    `frame-ancestors 'self'` (D425) forbids a cross-origin parent. The PWA
    must host the embed on its own origin. The embed already takes the hub URL
    and the token through `embed-config`, so it then reaches the hub
    cross-origin under this policy. D425 does not need widening.
  - **The node-direct authenticated file-server** (`createAuthenticatedFileServer`)
    keeps its own `*`. Auth there is a scoped token in the path, the URL is a
    capability, and the server is not behind this edge.
- The hub cannot verify the PWA's transport. An `https://` page calling an
  `http://` LAN hub is mixed content, and a self-signed hub certificate fails in
  `fetch` without a prompt. These are deployment concerns for the PWA, not
  CORS concerns.

## Enforcement

`server/backend/src/api/cors/__tests__/cors-policy.spec.ts` covers the cases
below. Removing the WebSocket refusal fails the WebSocket test.

- a preflight from the PWA is granted with the exact origin and no
  credentials;
- a denied origin gets no `access-control-*` header;
- the WebSocket upgrade is refused for a foreign origin and opened for the
  PWA, the hub itself and a client with no `Origin`;
- a hijacked 206 exposes `Content-Range` to the PWA and leaks no upstream `*`.

`cors-login-rate-limit.spec.ts` proves that a cross-origin `auth.login` still
hits the credential limiter. `reverse-proxy.spec.ts` pins the rule that the
edge owns CORS. No guard script stops a new route from setting its own
`Access-Control-Allow-Origin`; that is caught by review only.
