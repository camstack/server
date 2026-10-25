---
id: D794
title: An SSO sign-in returns to the advertised origin it started at, and runs in a popup that hands its outcome only to its opener
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-auth/src/oidc/auth-oidc.addon.ts
  - packages/addon-auth/src/oidc/request-origin.ts
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/main.ts
  - packages/addon-admin-ui/src/lib/sso-popup.ts
  - packages/addon-admin-ui/src/pages/SsoComplete.tsx
  - packages/addon-admin-ui/src/main.tsx
  - packages/addon-admin-ui/src/pages/Login.tsx
  - packages/addon-admin-ui/src/components/login/PrimaryLoginMethods.tsx
  - packages/addon-admin-ui/src/components/users/LinkedSignInsSection.tsx
---

## Context

D782 made OIDC sign in only an explicitly linked identity. The first live link
(Authentik, server 1.2.481) was STARTED on the LAN address
`https://192.168.x.x:4443` and FINISHED on the public address
`https://camstack.example.com`. The `redirect_uri` was the hub's one
browser address (`hubBrowserOrigin` → `roles.publicEndpoint`), whatever
address the browser was on. A different origin has a different session
cookie and a different `localStorage`, so the link's session check could fail
and a login landed signed in on an address the operator was not using.

The redirect also navigated the whole page away, through the IdP and back,
losing whatever page the user was on.

Deriving the origin from the request is the obvious fix and, done naively, the
classic hole: `Host` / `X-Forwarded-Host` are client-controlled. A forged one
would choose where the IdP sends the authorization code (to a strict IdP, a
refused `redirect_uri`; to a lax one, a stolen code).

## Decision

**Same origin.** `/start` reads the origin the request was made at
(`X-Forwarded-Host` over `Host`, `X-Forwarded-Proto` or https-then-http, plus a
well-formed `X-Forwarded-Prefix`) and uses it ONLY when it equals exactly an
origin the hub advertises itself at: the Network page's rows (detected and
custom, never the app link or loopback) and its `publicEndpoint`, `internal`
and `appConnections` answers. Anything else falls back to the public endpoint,
as before. The `redirect_uri` built from it is kept in the server-side pending
state and repeated verbatim on the token leg; the callback then redirects to
the ABSOLUTE `<that origin + prefix>/api/auth/sso/finish`, whose relative
returns (`/login`, `/system/my-access`) stay on it. Precedence: a configured
per-instance "Redirect URI override" PINS its one origin and wins when set;
empty (the default) means "the advertised origin the sign-in started at".

**Popup.** The admin UI runs an OIDC login and a link in a popup window
(`window.open` with size, no toolbar; `/start?popup=1`). The pending state
carries `popup`; the finish (`?popup=1`) lands the popup on the admin-ui
`/sso-complete#return=login|profile&<the page return's fragment or query>`.
That page, rendered without booting the app, strips its fragment and
`postMessage`s the outcome to `window.opener` with its OWN origin as
`targetOrigin`; the opener accepts it only from the window it opened and at
its own origin, acks, and completes exactly like the full-page return (the
session through the same finalize + `next`/`redirect` handling; a challenge to
the factor step; a link refreshes the list). No ack within 1.5 s, no opener, a
blocked popup or the native-app handoff (`redirect` = app callback): the
full-page path, unchanged.

## Consequences

- Every address a user signs in from must be registered at the IdP as a
  redirect URI (`<origin>/addon/auth-oidc/<id>/callback`) — or the override
  pins one. An address the hub does not advertise (a proxy it cannot detect)
  is added on the Network page as a custom address before it can be a return.
- The session token travels by `postMessage` to one same-origin window and is
  never broadcast or stored by the popup; `BroadcastChannel` is not used.
- The popup is opened without `noopener` (it needs its opener): the IdP's
  pages could navigate the opener (reverse tabnabbing). The IdP is the
  operator's own; review if a public IdP with untrusted content is ever used.
- A popup sign-in whose opener left the login page completes in the popup as a
  full-page sign-in.

## Enforcement

- `packages/addon-auth/src/oidc/__tests__/request-origin.spec.ts` — a forged
  Host, another port or scheme, userinfo/path junk are refused.
- `packages/addon-auth/src/oidc/__tests__/auth-oidc.addon.spec.ts`
  ("same-origin return") — LAN and public round trips, the token leg repeats
  the authorize leg's `redirect_uri`, the override pins, the prefix is kept,
  `popup=1` reaches the finish.
- `server/backend/src/auth/__tests__/sso-finish.spec.ts` (popup) — the session
  stays in the fragment, the challenge never becomes a session.
- `packages/addon-admin-ui/src/lib/__tests__/sso-popup.spec.ts` — the opener
  refuses another origin or another window; the popup posts only to its own
  origin and falls back when nobody acks.

## Amendment — 2026-10-08: the popup reaches its opener over whatever path exists

**What happened.** The first live "Collega Authentik" from My access (server
1.2.484, addon-auth 1.2.132 — this decision deployed) opened the popup, the
Authentik login ran in it, and the popup **did not close**. Measured read-only
against the live hub the same evening:

- `GET https://192.168.x.x:4443/addon/auth-oidc/authentik/start?popup=1`
  (Host `192.168.x.x:4443`) still answers with
  `redirect_uri=https://camstack.example.com/addon/auth-oidc/authentik/callback`
  — and so does every `X-Forwarded-Host` tried. A flow started on the LAN
  address still FINISHES on the public one. No `OIDC: hub addresses
  unavailable` warning in the hub logs, so the address book answered: either
  the instance's "Redirect URI override" is set (it pins) or the LAN origin is
  not among the advertised ones.
- No `Cross-Origin-Opener-Policy` anywhere on the path: not on the hub's
  `/sso-complete` or admin-ui shell (both origins), not on Authentik's flow,
  `/flows/…` or `/application/o/authorize/` pages. The opener reference was
  NOT severed; the popup was not opened `noopener`.

So `/sso-complete` ran at `camstack.example.com` with its opener at
`192.168.x.x:4443`. Its `postMessage` (target = its own origin) was dropped by
the browser, no ack came, and after 1.5 s it did what this decision said: the
full-page return, `/system/my-access` — in the popup, which therefore stayed
open. `postMessage` to the opener only ever works when both ends share an
origin, and a pinned or mis-derived `redirect_uri` breaks exactly that.

**Decision.** The popup tries, in order (`deliverPopupCompletion`):

1. **`postMessage` to a SAME-ORIGIN opener** — checked first by reading
   `opener.location.origin` (it throws across origins), so a cross-origin
   opener costs no wait. Unchanged otherwise: completion to the own origin
   only, close on the ack.
2. **A same-origin `BroadcastChannel` (`camstack-sso`)** for an opener whose
   reference is gone (a future COOP on the IdP hop). It carries ONLY a "done"
   signal: `{target:'login'}` or `{target:'profile', query}` (the link query is
   `linked=<provider>` / `linkError=<code>`, no secret). A login first keeps
   its session at the popup's origin exactly as the full-page return would
   (`localStorage` + the cookie mirror); the opener, on "done", reads the
   token from its OWN storage and finalizes. A 2FA challenge never goes on the
   channel. The watcher acks on the channel; the popup closes on the ack. A
   signal carrying anything else (a `token` field) is refused by the opener.
3. **An opener that is alive but unreachable** (another origin): a
   successful link closes the popup — the link is already recorded hub-side —
   and the opener, which polls `popup.closed`, refreshes the list; the link
   appearing in it is the "Linked" notice. A failed link stays open and shows
   why, with a Close button (the page return on the other origin may not even
   have a session). A login on another origin cannot be handed over (its
   session belongs to the other origin): full-page return in the popup, as
   before.
4. **Nobody**: the full-page return, as before.

A `window.close()` the browser refuses turns the spinner into "Done — you can
close this window". The opener stops watching on unmount.

`auth-oidc` now logs, per `/start`, **`OIDC: sign-in returns to`** with
`source` (`override` | `request` | `public-endpoint` | `default`), the
`returnBase`, the origins the request `claimed` and the `advertised` set — the
line that tells "override pins it" from "LAN not advertised" without admin
access to the settings.

**Consequences.**

- The D794 Consequence "`BroadcastChannel` is not used" is replaced: it is
  used, for a token-free signal only. The token still travels by
  `postMessage` to one same-origin window, or not at all.
- A cross-origin finish still means the operator must sign in / link from the
  address the IdP returns to, or fix the return address: clear the
  "Redirect URI override" (and register a callback per address at the IdP),
  or make the LAN origin an advertised one on the Network page.

**Enforcement.** `packages/addon-admin-ui/src/lib/__tests__/sso-popup.spec.ts`
(cross-origin opener: nothing posted, a success closes, a failure shows why;
COOP: channel signal without the token, closes on the ack; challenge never on
the channel; the opener refuses a signal carrying a token, reports the popup
closing once), `components/users/__tests__/LinkedSignIns.spec.tsx` (the popup
closing refreshes the list and reports the new link),
`pages/__tests__/Login.spec.tsx` (a channel "done" signs in from the session
kept at this origin, acked), `pages/__tests__/SsoComplete.spec.tsx`,
`packages/addon-auth/src/oidc/__tests__/auth-oidc.addon.spec.ts` (the
return-address line for request / override / forged host).

## Amendment 2026-10-15 — the listener's own origin is advertised (`listenerOrigins`)

**What broke.** With the LAN HTTP listener on, `buildEndpoints` replaces each
LAN row with `http://<ip>:4480` (native clients skip the private certificate).
The `https://<ip>:4443` origin a browser really uses was then in no row and in
no role, so `/start` refused it, fell back to the public endpoint, and the
browser-bound state cookie (D810) set on the LAN origin was absent on the public
callback: `#error=sso-state`. Log: `source=public-endpoint`, `claimed` holding
`https://192.0.2.9:4443`, `advertised` without it.

**Decision.** `HubAddressBook` gains an optional `listenerOrigins`: for each
allowlisted non-loopback LAN interface (and the local hostname), `https://<host>:<httpsPort>`
and, while the HTTP listener is on, `http://<host>:<httpPort>`; plus custom and
public addresses. `advertisedHubOrigins` includes it; the match stays exact
(scheme + host + port, no wildcard), so a forged Host still falls back to the
public endpoint. Rows and roles are unchanged. A hub without the field behaves
as before. The design is untouched: same-origin return, browser-bound cookie,
single-use bridge; no server-side state handoff, no cross-origin `postMessage`.

**Operator note.** The `redirect_uri` is strict at the IdP: every LAN https
origin users sign in from (`https://<lan-ip>:4443/addon/auth-oidc/<id>/callback`)
must be registered there, as well as the public one.

**Enforcement.** `request-origin.spec.ts` (LAN HTTP on still lists the https
listener; an older hub without the field; exact match only),
`auth-oidc.addon.spec.ts` (Host `192.0.2.9:4443` with LAN HTTP on returns to
4443 with `source=request`; a forged Host falls back),
`local-network/__tests__/address-book.spec.ts` (both schemes while HTTP listens,
https only when off, never loopback or the app link). `sso-finish.spec.ts` still
refuses a bridge without the binding cookie.
