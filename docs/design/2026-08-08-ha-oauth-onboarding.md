# Home Assistant onboarding over OAuth — generalising the Alexa linking server

> Status: **implemented hub-side, TRAIN-BOUND**, 2026-08-08. Every hub change in
> this document is in `server/backend` + `@camstack/system` + `@camstack/types`,
> so none of it is live until a `@camstack/server` train ships. The Home
> Assistant component half lives in `camstack/homeassistant-component` and
> degrades to the existing username/password flow against a hub that predates
> the train. Read with
> `server/backend/src/api/oauth2/oauth2-routes.ts`,
> `packages/system/src/builtins/local-auth/oauth-grants.ts`,
> `packages/types/src/capabilities/oauth-integration.cap.ts`.

## What the operator asked for

Onboarding the Home Assistant component must be: paste the hub URL, click
through a login + consent page, done. No hand-minted token, no password stored
in `.storage`. Reuse the OAuth server already built for Alexa account linking
rather than growing a second one.

## What already existed

The hub is already an OAuth 2.0 authorization server. It was built for Alexa and
nothing about it is Alexa-specific except the one addon that declares itself a
client.

| Piece | Where | Ships how |
| --- | --- | --- |
| `GET/POST /api/oauth2/authorize`, `POST /api/oauth2/token` | `server/backend/src/api/oauth2/oauth2-routes.ts` | core backend — **train** |
| consent page | `server/backend/src/api/oauth2/consent-page.ts` | core backend — **train** |
| code / access / refresh grant logic | `packages/system/src/builtins/local-auth/oauth-grants.ts` | `@camstack/system` — **train** |
| session records (list + revoke, admin UI) | `packages/system/src/builtins/local-auth/oauth-session-manager.ts` | `@camstack/system` — **train** |
| `user-management.oauth*` cap methods | `packages/types/src/capabilities/user-management.cap.ts` | `@camstack/types` — **train** |
| "I am a linkable client" declaration | `oauth-integration` collection cap, provided by `addon-export-alexa` **and** `homeassistant-export` | addon — deployable |

Shape of the existing flow, unchanged by this work:

1. `GET /api/oauth2/authorize?response_type=code&integration=<id>&redirect_uri=…&state=…`
   requires a hub **session cookie**; without one it 302s to the hub login
   (passkey-first). It then renders an Allow/Deny consent page.
2. `POST /api/oauth2/authorize` with `consent=allow` calls
   `userManagement.oauthIssueCode` and 302s back to `redirect_uri?code=…&state=…`.
   The code is a **60 s HMAC-signed JWT** carrying `redirectUri`, `integrationId`
   and a `jti`; single use is enforced by a consumed-`jti` set.
3. `POST /api/oauth2/token` (no session gate) exchanges the code for an
   `oauth-access` JWT (1 h) + `oauth-refresh` JWT (30 d), both bound to an
   `oauth_sessions` row. Revoking that row kills both. `grant_type=refresh_token`
   re-mints the pair, rotating the refresh token.

`client_id` was never checked — for Alexa the client pair is verified at the
Lambda boundary. **`client_secret` was never checked either.** That is the fact
that makes a second, secret-less client cheap.

Two properties turned out to matter and both were already true:

- The access token is a JWT signed with the hub's `auth.jwtSecret`, carrying
  `userId` / `username` / `isAdmin: false` / `scopes`. `resolveUser` in
  `trpc.context.ts` therefore **already accepts it as a `Bearer` on `/trpc`**,
  gated by the scope matcher. No new token type is needed for the component to
  call the API.
- Issued links already appear in the admin UI (`listOauthSessions` /
  `revokeOauthSession`, `auth: 'admin'`), so a Home Assistant link is listable
  and revocable on day one with no new surface.

## The three gaps, and what closes each

### 1. A public client has no secret to protect the code with

The component is public source on GitHub. Shipping a `client_secret` would be
shipping a decoration. **PKCE (RFC 7636, S256) replaces it**, and the descriptor
opts in per integration so Alexa's behaviour does not change:

- `oauthIntegrationCapability` descriptor gains `requiresPkce?: boolean`.
- When set, `/authorize` **requires** `code_challenge` +
  `code_challenge_method=S256` and refuses without them; the challenge rides the
  consent form as a hidden field and is baked into the signed code.
- `/token` requires `code_verifier`; `oauthExchangeCode` recomputes
  `base64url(sha256(verifier))` and compares against the claim in constant time.
- A code that carries a challenge is **unusable without the verifier even when
  `requiresPkce` is off** — the check keys off the claim, not the descriptor, so
  an integration cannot be downgraded by flipping a flag after a code is issued.

### 2. The redirect URI of a self-hosted client cannot be pre-registered

`allowedRedirectPrefixes` is an exact-prefix allow-list. It fits Alexa (three
fixed Amazon origins). Home Assistant has two shapes and only one of them is
knowable:

- `https://my.home-assistant.io/redirect/oauth` — the My Home Assistant bounce,
  used when the `my` component is loaded. A fixed prefix. Fine as-is.
- `http://<whatever the operator's HA is>:8123/auth/external/callback` — the
  local callback. The host is *the operator's own LAN address* and the hub
  cannot know it in advance.

A wildcard prefix (`http://`) would be an open redirector on an endpoint that
mints tokens. Instead the descriptor gains:

```ts
/** Paths accepted as a redirect_uri when the host is PRIVATE. */
allowedPrivateHostPaths?: string[]
```

A `redirect_uri` is accepted if it prefix-matches as before, **or** if its URL
path is exactly one of `allowedPrivateHostPaths` *and* its host resolves as
private by literal inspection: loopback, RFC1918, CGNAT `100.64/10` (Tailscale),
link-local, IPv6 ULA/loopback, or an `.local` / `.internal` / `.ts.net` name. A
public hostname never satisfies this branch, so the worst an attacker can do is
aim a code at a host they already need LAN presence to read — and they still
need the operator's session cookie and an explicit Allow click to get one.

Belt and braces: **the consent page now shows where the code will be sent.**
Silence about the destination is what makes a consent screen theatre.

### 3. The component cannot tell a hub that supports this from one that does not

The whole hub half is train-bound. A component release that offers "Link with
OAuth" against a 1.2.72 hub would dead-end on a 400. So:

```
GET /api/oauth2/integrations  →  [{ integrationId, displayName, requiresPkce }]
```

Unauthenticated (the token endpoint is too), and it discloses only which
integrations are installed. The component probes it before offering the OAuth
option; `404`, a transport error, or a response without `homeassistant` all mean
"this hub is older" and the flow falls back to username/password with a spoken
reason. **This is what makes the component releasable before the hub train.**

### The client declaration itself

> **Amended 2026-08-09 ([D101](../decisions/adr-0101.md)).** As first shipped,
> the `homeassistant` descriptor was registered by the **`local-auth` builtin**
> inside `@camstack/system`, on the reasoning that Home Assistant had no addon
> of its own — the component being a client of the hub's tRPC API rather than an
> exporter. That premise expired when `homeassistant-export` shipped: the
> component IS that addon's counterpart, and pins
> `addonId: 'homeassistant-export'` on the cap calls it makes back. The kernel
> now declares no OAuth client at all.

Alexa declares itself from `addon-export-alexa`; Home Assistant declares itself
from `homeassistant-export`
(`packages/addon-provider-homeassistant/src/ha-export/oauth-integration.ts`).
Both do it the same way — the same collection cap, the same descriptor shape,
the same registration path out of `onInitialize` — and differ only by
configuration (`requiresPkce`, the redirect rules). `oauth-integration` joins
each addon's manifest `capabilities`. Rather than special-case a static
descriptor inside the route (the route would then compose backend state with
addon output), the route keeps seeing exactly one list.

**Linking now requires `homeassistant-export` to be installed and up.** Between
hub start and the moment its runner registers, `/api/oauth2/authorize` answers
`503 temporarily_unavailable` with `Retry-After` and the pending addon id rather
than `400 unknown integration`, and `/api/oauth2/integrations` reports
`complete: false`. The component must treat an incomplete list as "ask again",
never as "this hub is too old" — that verdict is sticky, and it is what sent an
operator to the password fallback during a night of release restarts.

Scopes, chosen against `METHOD_ACCESS_MAP` for exactly the paths the component
calls (`deviceManager.listAll`, `deviceState.getAllSnapshots`,
`pipelineOrchestrator.getCameraSwitches`/`setCameraSwitch`,
`snapshot.getSnapshot`, `webrtcSession.*`, plus the ungated core routes
`auth.me` / `live.onEvent`):

| Scope | Why not broader |
| --- | --- |
| `category:device [view, create]` | device caps are per-camera by construction; new camera caps should reach the bridge without a re-link |
| `capability:device-manager [view]` | listing devices, nothing else |
| `capability:device-state [view]` | the snapshot bundle |
| `capability:pipeline-orchestrator [view, create]` | the per-camera switches |

`category:system [create]` was rejected: it would have granted
`addons.installPackage` to a home-automation bridge.

## What the component does

`config_flow.py` becomes a menu:

- **OAuth (recommended)** — host / port / `verify_ssl`, then a probe of
  `/api/oauth2/integrations`. On success the flow registers a per-hub
  `LocalOAuth2Implementation` subclass and hands off to Home Assistant's own
  `AbstractOAuth2FlowHandler`, which owns the browser round trip, the `state`
  JWT and the `/auth/external/callback` view. The entry stores
  `auth_implementation` + the token bundle; `OAuth2Session` refreshes it.
- **Manual** — the existing username/password form, untouched.

Two things the subclass must override, and both are load-bearing:

- **`_token_request`**: Home Assistant's default reaches for
  `async_get_clientsession(hass)`, which **verifies TLS**. The hub's certificate
  is self-signed by default and `verify_ssl` is already a per-entry setting used
  by every other call. The override uses
  `async_create_clientsession(hass, verify_ssl=…)`, the same mechanism `api.py`
  uses, so one setting governs the whole integration. Without this the token
  exchange fails on a stock hub while the rest of the integration works — the
  worst possible failure shape.
- **`extra_authorize_data` / `_token_request` body**: add `integration`,
  `code_challenge`, `code_challenge_method`, and `code_verifier`. No
  `client_secret` is sent.

`api.py`'s `CamStackClient` is generalised from "username + password" to an
injected `CamStackAuth`:

- `PasswordAuth` — `auth.login`, the existing behaviour, byte for byte.
- `OAuth2Auth` — `OAuth2Session.async_ensure_token_valid()` then the access
  token. `async_invalidate()` is a no-op: an expired access token is Home
  Assistant's problem to refresh, and re-logging-in is not available.

The client's one-retry-behind-a-fresh-login path is preserved for both.

## Decisions worth arguing with later

- **Access + refresh, not a long-lived `cst_`.** A `cst_` token would have been
  a second concept to mint, name, list and reap, and Home Assistant's
  `OAuth2Session` already does refresh properly. The cost is that a Home
  Assistant that stays off for more than 30 days needs re-linking — the refresh
  token's TTL. Accepted.
- **The link is revoked from the hub, not from Home Assistant.** Deleting the
  config entry leaves the `oauth_sessions` row active until an admin revokes it.
  A `POST /api/oauth2/revoke` is the obvious follow-up and is deliberately not in
  this change.
- **`oauth-access` tokens are not session-checked on the `/trpc` path.** They
  pass as ordinary JWTs; only `oauthVerifyAccessToken` consults
  `oauth_sessions`. This predates this work and is unchanged by it, but it now
  matters more: revoking a link stops *refresh* immediately and stops *API
  access* within the access token's remaining hour. Closing it means routing
  `provider: 'oauth-access'` JWTs through the session check in `resolveUser`,
  which is a hot-path store read on every request and wants its own decision.
