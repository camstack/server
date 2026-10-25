---
title: Authentication
last-verified: 2026-10-21
applies-to:
  - server/backend/src/auth/*.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/api/core/auth-*.ts
  - server/backend/src/core/auth/auth.service.ts
  - packages/system/src/auth/login-session-manager.ts
  - packages/system/src/auth/session-revocation-bus.ts
  - server/backend/src/auth/session-connections.ts
  - packages/system/src/auth/legacy-token-tables.ts
  - server/backend/src/core/auth/credential-token.service.ts
  - packages/system/src/auth/auth-audit-log.ts
  - packages/system/src/auth/user-management-internal.ts
  - packages/sdk/src/session-keeper.ts
  - packages/addon-admin-ui/src/lib/admin-session.ts
  - packages/system/src/builtins/local-auth/*.ts
  - packages/system/src/auth/external-identity-manager.ts
  - packages/addon-auth/src/**/*.ts
  - packages/addon-admin-ui/src/pages/system/Authentication.tsx
  - packages/addon-admin-ui/src/pages/system/OidcSettingsConnections.tsx
  - packages/addon-admin-ui/src/lib/sso-popup.ts
  - packages/addon-admin-ui/src/pages/SsoComplete.tsx
  - packages/types/src/capabilities/oidc-connections.cap.ts
  - packages/system/src/auth/device-credential-manager.ts
  - server/backend/src/api/core/auth-device-cert.procedures.ts
---

# Authentication

How a browser becomes a session, and what decides each step. Decisions:
[D712](../decisions/adr-0712-a-session-jwt-is-minted-in-one-place-from-the-user-record-as-it-is-now.md)
(one session mint),
[D777](../decisions/adr-0777-an-auth-providers-only-enable-is-its-capability-toggle-on-identity-authentication.md)
(one enable per provider),
[D782](../decisions/adr-0782-an-oidc-identity-signs-in-only-the-user-who-linked-it-from-their-own-session.md)
(OIDC by explicit linking),
[D791](../decisions/adr-0791-an-sso-sign-in-returns-to-the-origin-it-started-at-and-runs-in-a-popup.md)
(same-origin return, popup),
[D809](../decisions/adr-0809-the-client-address-comes-from-forwarding-headers-only-through-a-trusted-proxy-and-every-auth-limit-keys-on-it.md)
(real client address, rate limits),
[D810](../decisions/adr-0810-an-sso-login-bridge-is-single-use-and-bound-to-the-browser-that-started-the-sign-in.md)
(single-use, browser-bound bridge),
[D811](../decisions/adr-0811-creating-an-external-identity-link-is-hub-internal-and-on-no-wire.md)
(hub-internal surface),
[D812](../decisions/adr-0812-every-session-token-belongs-to-a-server-side-login-session-checked-on-every-verify.md)
(login sessions),
[D813](../decisions/adr-0813-sensitive-self-service-actions-need-a-fresh-re-authentication-not-just-a-session.md)
(re-authentication),
[D814](../decisions/adr-0814-a-direct-login-from-an-operator-listed-trusted-network-may-skip-the-second-factor-never-through-a-proxy.md)
(trusted networks),
[D815](../decisions/adr-0815-there-is-no-email-login-the-magic-link-method-is-removed.md)
(no magic link),
[D816](../decisions/adr-0816-an-ops-script-acts-as-admin-only-through-an-admin-token-created-with-re-authentication-expiring-within-90-days-and-audited-on-every-use.md)
(admin tokens, superseded by D892),
[D817](../decisions/adr-0817-a-credential-mint-with-no-caller-is-deleted-not-kept.md)
(no dead credential mints),
[D855](../decisions/adr-0855-device-certificates-as-a-login-method-and-the-app-login-handoff.md)
(device certificates, step-up enrollment, typed refusals),
[D892](../decisions/adr-0892-one-token-format-permissions-are-scopes-and-one-verifier-and-one-matcher-decide-every-request.md)
(one token format, permissions as scopes; superseded by D895),
[D895](../decisions/adr-0895-there-is-one-token-and-no-other-bearer-format-a-share-link-is-a-token-and-only-a-login-session-becomes-a-session.md)
(one token and no other bearer; a share link is a token; only a login session becomes a session).

## The pieces

| Piece | Where | Role |
|---|---|---|
| `local-auth` | `packages/system/src/builtins/local-auth/` | Users, passwords, TOTP, linked external identities, login sessions, the auth audit (tokens are the hub's `core-auth` `credential-tokens`). Owns `user-management`; the operations no wire may reach are its hub-internal surface (`UserManagementInternal`, D811). |
| `auth-oidc` | `packages/addon-auth/src/oidc/` | One OIDC flow per IdP connection (`/<id>/start`, `/<id>/callback`). Connections are managed in Settings as a DataTable + dialog via `oidc-connections` (D830) — not an editable-array. |
| `auth-webauthn` | `packages/addon-auth/src/webauthn/` | Passkeys: passkey-first sign-in, or an opted-in second factor. |
| Session mint | `server/backend/src/auth/session-mint.ts` | The only place a session JWT is signed — always from the user record as it is now, always for a login session (`sid`). |
| Session check | `server/backend/src/auth/hub-sessions.ts`, `core/auth/auth.service.ts` | `AuthService.verifyToken` asks the login session behind every session-grade token. |
| Client address | `server/backend/src/auth/client-address.ts`, `auth-network-policy.ts` | The real client behind a trusted proxy; trusted networks. |
| Limits | `server/backend/src/api/core/auth-limits.ts` | Per address, per account, per user. |
| SSO finish | `server/backend/src/auth/sso-finish.ts` | `/api/auth/sso/finish`: a verified bridge → session, challenge, refusal or link. |
| Provider gate | `server/backend/src/auth/auth-provider-gate.ts` | Is this auth addon disabled on Identity → Authentication? |

## Enabling a provider

Identity → Authentication lists every provider of `auth-provider` (login
providers) and `user-passkeys` (passkeys) with ONE Enable/Disable toggle. That
toggle is the provider's only enable; addons carry no private `enabled`
setting. The hub asks it (`isAuthAddonDisabled`) wherever a login is offered or
completed: `auth.listLoginMethods` drops the methods of a disabled addon, and
the SSO finish refuses its bridges.

## Signing in

1. **Password** — `auth.login` validates through `user-management`.
2. **Passkey first** — `auth.passkeyLoginBegin` / `passkeyLoginFinish`.
3. **OIDC** — the addon mints a bridge through `sso-bridge` and redirects to
   `/api/auth/sso/finish`. The bridge names an identity
   `oidc:<instance>:<sub>`; the finish looks up the user it is LINKED to
   (`findUserByExternalIdentity`) and refuses an unlinked one with
   `/login#error=sso-not-linked`. (Magic link is gone, D815: a bridge naming
   it is not a login bridge.)

After any primary method the user owes their enrolled second factors
(`auth/second-factors.ts`): TOTP when enrolled, a passkey when enrolled and
opted in (never after passkey-first). A password login answers with a
challenge token; the SSO finish puts the same challenge in the login page's
fragment (`#challenge=…&factors=…`) and the page resumes at the factor step.

**Trusted networks (D814, opt-in).** When `auth.trustedNetworks` lists CIDRs, a
login whose real client address is inside one AND whose socket peer is not a
proxy skips the factors it would owe — password, passkey-first and the SSO
finish alike. Through the tunnel, the public origin or any trusted proxy
(loopback included) it never skips. Each skip is an `auth_audit` row
(`second-factor-skipped`); a skip that cannot be audited does not happen.

## The client address and the limits

The tunnel connector dials the hub on loopback, so the socket peer of every
internet request is `127.0.0.1`. `resolveClientAddress` reads
`CF-Connecting-IP`, then the right-most `X-Forwarded-For` hop that is not
itself trusted — ONLY when the peer is a trusted proxy (loopback, plus
`auth.trustedProxies`). From anyone else, the LAN included, the peer is the
client. Limits key on that address (D809):

| Bucket | What | Limit |
|---|---|---|
| per address, credential | `login`, `loginVerifyTotp`, `loginVerifyPasskey`, `passkeyLoginFinish`, `exchangeSession`, `redeemHandoffCode`, `refreshSession` | 10/min |
| per address, ceremony | `loginBeginPasskey`, `passkeyLoginBegin`, `beginExternalLink` | 30/min |
| per address, routes | `/api/auth/sso/finish`; addon routes with `rateLimit: 'auth'` (OIDC `/start`, `/callback`) | 30/min |
| per account, failures | wrong password / TOTP / passkey / re-authentication | 20 per 15 min, checked before the secret |
| per user | `beginExternalLink` 5/min; `reauthenticate` 10/min | |

## Sessions (D812)

Every login opens a row in `login_sessions` (local-auth) and the session JWT
carries its id as `sid`. `AuthService.verifyToken` asks the row on every
verify of a session-grade token; an open WebSocket re-checks it on every call
(`ctx.sessionLive`).

| | Refreshing client (`refreshable: true`) | Legacy client (one release) |
|---|---|---|
| Access token | `auth.accessTokenExpiry`, default 2 h | the whole session |
| Renewal | `auth.refreshSession({ refreshToken })` — rotates the `csr_` token, slides the session | `createHandoffCode` + `redeemHandoffCode` (`purpose: 'renew'`) — same session, slides |
| Session lifetime | `auth.tokenExpiry` ("Session lifetime", default 30 d), sliding | same |

- A rotated-out refresh token presented after a 30 s grace (two tabs) revokes
  the session (theft).
- `auth.logout` revokes this session; `{ everywhere: true }` all of the user's.
  `listOwnSessions` / `revokeOwnSession`; admins `listSessions` /
  `revokeSessions`.
- `changeOwnPassword` keeps this session and ends the others
  (`UserManagementInternal.setPassword`); an admin password reset ends all;
  deleting a user ends sessions, OAuth links, the TOTP row and sign-in links in
  one call; a token whose subject is gone is refused at its next verify.
- **Revoking ends what the session holds.** Every revoke path of the table
  (`revoke`, `revokeAllForUser`, `revokeByCredential` — logout, sign out
  everywhere, admin revoke, password change or reset, user deletion,
  credential revoke) announces the ended ids on the session-revocation bus
  (`packages/system/src/auth/session-revocation-bus.ts`). The hub's
  `SessionConnections` (`server/backend/src/auth/session-connections.ts`)
  closes exactly those sessions' tRPC WebSockets with **close code 4401, reason
  `session-ended`**, and closes the WebRTC sessions (live and recorded
  playback ride `webrtc-session`) their calls opened, logging the counts and a
  `tags: { deviceId }` line per media session. A socket whose bearer resolves to
  nobody (revoked, expired) is closed the same way at connect rather than left
  open as an anonymous principal. Other sessions, even of the same user, are
  untouched.
- A token without `sid` (minted before sessions) is accepted until the user's
  cutoff — any revoke-all moves it.
- Clients: the SDK's `SessionKeeper` refreshes before expiry and reports only a
  hub refusal as sign-out; admin-ui keeps the refresh token beside the access
  token (`camstack_admin_refresh`) and re-mirrors the cookie on each refresh.
  The viewer app (`camstack/src/auth/refresh-session.ts`) keeps the refresh
  token per server in the platform secure store and renews before expiry, on
  resume and on UNAUTHORIZED. A viewer session without a refresh token moves
  itself to a refreshing one (a `new-session` handoff redeemed with
  `refreshable: true`) and logs the old one out, so retiring the legacy
  `renew` path signs out only installs that have not run the new viewer.
- Handoff codes: `purpose: 'renew'` (default) continues the minting session;
  `'new-session'` (native sign-in, browser handoff) opens a separate one.
- Refresh tokens are opaque: a signing-key rotation no longer ends refreshing
  sessions. Ending sessions is revocation.

## Device certificates (D855)

A phone can stay signed in through a certificate whose private key never
leaves it. The hub signs the device's public key under a third CA (EC P-256,
key `secret://system/global/deviceCaKey`, certificate `cluster.deviceCa`),
registers it in `device_credentials` (local-auth) and accepts, as a login,
an ECDSA signature over `camstack-device-cert-v1 / login / <origin> / <nonce>`
(`auth.getDeviceChallenge`, `auth.loginWithDeviceCertificate`). The session is
the normal one, with `method: device-certificate`, the credential id on the
session row and in the JWT (`cid`).

- **Enrolling**: an admin's one-shot QR code (`deviceCredentials.startEnrollment`
  → `auth.completeEnrollment`), or the user's own device (`auth.enrollSelf`)
  with a single-use **step-up proof** minted by signing in again
  (`deviceEnrollProofFromReauth` / `deviceEnrollProofFromHandoff`); a hub-wide
  setting turns self-enrollment off.
- **Revoking** (admin, owner, or the device itself, signed) ends the
  credential's sessions and, independently, `SessionMinter.refresh` refuses
  any session whose credential is not active.
- **Refusals** are typed (`DeviceRefusalReason`); only `revoked`,
  `unknown-credential` and `user-gone` are definitive, and the app deletes its
  key after three consecutive definitive answers, never on a transport error.
- The app login handoff gained PKCE S256 and a bound `state` (mandatory for
  `new-session` and `step-up`); the `step-up` purpose yields a proof, never a
  session, and is minted only by a leg that just authenticated (a single-use
  re-authentication, or a sign-in at most 120 s old).
- A session minted from a credential session inherits the credential; an admin
  password reset revokes every credential of the user.
- The Identity -> Certificates inventory (`certificates.*`) shows the HTTPS leaf per
  node (agents serve a hub-issued leaf on their API port, D856), the mesh CA and each
  node's recorded mesh leaves, and renews or revokes them (`transport.md`).
- The admin UI is `pages/system/Certificates.tsx` (cards under
  `components/certificates/`): paired devices with "Pair a device" (QR of the
  one-shot link), the device CA, HTTPS per node (Renew is off for an
  operator-uploaded hub certificate, with the reason) and mesh leaves (a failed
  renewal names its stage; revoke confirms the node must re-join). "My devices"
  on My access lists the caller's own. The login page keeps the
  `device-certificate` arm hidden: no web enrollment path exists, so the server
  still advertises `clients: ['native']` only.

## Re-authentication (D813)

`auth.reauthenticate({ password } | { passkeyResponse })` (passkey options from
`auth.reauthBeginPasskey`) answers a 5-minute proof (`kind: 'reauth'`, never a
bearer) bound to the user and the session. `beginExternalLink`,
`disableOwnTotp`, `removeOwnPasskey` and `auth.mintToken` of `'*'` take it as
`reauthToken` and refuse without it. Admin-ui: `useReauthPrompt`
(`components/auth/ReauthDialog.tsx`); the passkey widget confirms inline.

## Tokens: one format, permissions are scopes (D892, D895)

Every bearer — a session JWT, an account link, a token — is turned into ONE
principal by the verifier (`server/backend/src/auth/credential-verifier.ts`):
`{ subjectId, scopes, isAdmin, credentialId, auditTag }`, `isAdmin` meaning
`scopes` holds `'*'`. tRPC, addon routes and data planes, uploads and
`/api/auth/whoami` all authorize through the one matcher
(`principal-authorization.ts`) on those scopes; nothing reads the credential's
kind. There is no other bearer: the pre-D892 opaque admin, scoped and
share-view formats authenticate nobody (401 everywhere, D895), and the guard
`scripts/check-no-legacy-token-prefix.ts` keeps their prefixes out of the code.

| Credential | Scopes |
|---|---|
| session JWT, admin | `'*'` |
| session JWT, non-admin | the user's live scopes + `addon-routes` |
| `oauth-access` link (its user must exist) | its grant |
| token, admin subject | its row's scopes |
| token, non-admin subject | its row's scopes cut to what the subject holds now |

**Minting.** `auth.mintToken({ scopes, expiresIn, label, reauthToken?, subjectId? })`
— from a login session; never more than the caller holds; `'*'` needs an
admin and a fresh re-authentication (D813) and acts for the admin who mints it;
`addon-routes` is an admin's only; a share-view grant with talk-back needs
talk-back on every camera; an admin may name another `subjectId`. An account
link (Home Assistant) may mint only a lone share-view grant. At most 90 days;
`'never'` only for a lone share-view grant. The token is a JWT `{ kind:
'credential', sub, jti, scopes }` signed with the audience
`camstack:credential`, with a `core-auth` `credential-tokens` row (hashed
`jti`, label, scopes, the one expiry, last use, revoked) read on every verify,
so a revoke applies at once. The hub's raw session verify refuses that
audience: a token can never pass for a person's session (the session cookie,
the OAuth consent page, `/api/embed-auth`, health, backups).

**A share link is a token** whose only scope is a share-view grant
(`grid-view` or `events-view`, the cameras, optionally talk-back). There is no
share-link route: clients use `auth.mintToken`, find their token with
`auth.listTokens({ label })`, renew it in place with
`auth.extendToken({ id, expiresIn })` (owner or admin, the mint's lifetime
rules), and revoke it with `auth.revokeToken`. `auth.listTokens` lists label,
scopes, `createdAt`, `expiresAt`, `lastUsedAt`, `revokedAt`; an account link
sees, extends and revokes only share links. `auth.revokeCredentials` (no
`kind`) revokes by credential id in bulk. Every use of a `'*'` token is an
`admin-token-used` audit row (`listAuthAudit`).

The admin UI has one Tokens list (Identity → Tokens & sessions → Tokens, and
"My tokens" on My access) showing each token's scopes, and one Create token
dialog: Scopes, View link (cameras, grid or events, talk-back) or All
permissions, a label, and an expiry preset.

**One credential for every tool.** There is ONE token format; only the set of
permissions differs (an admin session can do everything). Run
`camstack login <host>` once: it stores the login JWT, its refresh token (`csr_…`)
and `expiresAt` in `~/.camstack/<host>_<port>.json` (0600). The CLI, `scripts/hub/hub.mjs`,
the operator scripts (`scripts/hub/credentials.mjs`) and the MCP all resolve the
credential through `resolveCredentials` / `resolveFreshCredentials`
(`packages/develop/src/hub`): explicit `--token` / `--token-file`, then `$CAMSTACK_TOKEN`,
then that session. No tool looks for a token file of its own (guard
`check-no-token-file-lookup`): `--token-file` is an explicit override and names no
default path. A session with less than 60 s left is renewed over HTTP with
`auth.refreshSession` before use, and a 401 renews it once and retries once; a
refusal says `run camstack login`. The permission tier is read from the token's
CLAIMS (an admin JWT is admin); a token whose claims it cannot read is
classified by asking the hub (`GET /api/auth/whoami`), never by its shape. The MCP never mints or asks for a password: when the credential is not
admin its ops tools answer with the exact command to run (`camstack login`, or the
checkout-local form when the binary is not on PATH).

## A person is an admin or a viewer (D921)

A non-admin person holds ONE viewer row in their scopes:
`{ type: 'viewer', allow: '*' | ids, block: ids, features }`.
A set that holds it is decided by it alone:

- **What:** every cap method has a role for a viewer, `METHOD_ACCESS_MAP[path].role`:
  - `viewer`: the baseline, every protected device read and actuation plus the
    system methods the viewer app calls;
  - `feature:<id>`: granted per user from `VIEWER_FEATURES`
    (`packages/types/src/auth/viewer-access.ts`): `face-assignment`,
    `plate-assignment`, `retrain`, `scenes`;
  - `admin`: never.

  Names in events are shown to anyone who sees the event, so the reads that
  resolve a face or plate in an event are baseline.
- **Where:** the devices `allow` minus `block`. A device is admitted through
  itself or an ancestor, so a camera's children follow it. Unknown parentage
  fails closed.
- **How it is checked:** `checkScopeAccess` (`server/backend/src/api/trpc/scope-access.ts`)
  checks the role and every named device. `adminProcedure` lets a viewer pass
  only on a feature it holds. The enumeration projection, the event firehose
  and share-link minting ask the same matcher.

Grant sets without a viewer row are decided as before. That covers legacy
users, the HA, Alexa and Google links, share links and tokens.
`auth.me` reports `scope.role` (`admin | viewer | scoped`) and
`scope.features`. Adding a feature means one catalog entry, then
`role: { feature }` labels, then codegen; the guards are
`check-method-roles` and `check-viewer-calls-allowed`.

## Finding the hub for `camstack login` (D838)

**Naming a hub.** `camstack login <host>` is `camstack login --server <host>`
and there is ONE login: `--admin` / `--admin-days` were removed (D895) and an old
invocation that still passes them prints a one-line warning ("one login, one token
— drop --admin") and logs in as usual; naming two different hubs is an error.
EVERY server input — the positional, `--server`/`-s`, `$CAMSTACK_SERVER`,
`$CAMSTACK_HUB_URL`, `scratchpad/.hub-url`, the "Enter an address…" prompt, and
`scripts/hub/hub.mjs --server` — goes through ONE parser,
`normalizeHubAddress` (`packages/develop/src/hub/hub-address.ts`), into
`https://<host>:<port>`: scheme defaults to https, port to 4443 (`192.0.2.50`,
`hub.local:4443`, `https://host`, `[fe80::1]:4443`). `http://` is refused with a
message — the hub API is https only. Never parse a server in a command.

**Not naming one.** `login` (and `camstack discover`) lists the hubs announced over
mDNS (`_camstack._tcp`, the hub's HTTPS endpoint) unioned with the hubs this
machine already knows (saved sessions, `$CAMSTACK_HUB_URL`,
`scratchpad/.hub-url`), reachable ones only. The picker is shown for one hub as
well as several — the found hub first (Enter accepts it), then "Enter an
address…" — because a hub that does not announce (an old build) would otherwise
be unreachable; a server given explicitly shows no prompt. None found is an
error pointing at `--server`. The mesh UDP channel is not consulted (D826
retired it). Details and the container requirement:
`docs/architecture/transport.md`.

**Which saved session a command uses.** With no server given: the session of
`$CAMSTACK_SERVER` if set and saved, else the most recently used one
(`lastUsedAt`, stamped when `deploy`/`dev`/`watch` use a cached session; a file
without it counts from `createdAt`). `camstack whoami` with several sessions and
no `--server` lists them all (server, user, admin role) and marks
that default with `*`.

## Linking an OIDC identity

Only the user links, from My access → Linked sign-in accounts. The providers
offered are the enabled `redirect` login methods that declare `linkable: true`
on the `login-method` cap — `auth-oidc` sets it on every instance; the id is
never inspected. (The SSO finish still reads an `auth-oidc/<instance>` bridge
by its provider: that is the bridge format, and the allowlist that keeps
`oauth-*` tokens out — see the D782 amendment.)

1. `auth.beginExternalLink({ provider, reauthToken })` — after re-authentication
   (D813), the hub mints a single-use intent
   for `ctx.user` (`external-link-intents.ts`) and returns
   `/addon/auth-oidc/<id>/start?link=<handle>`.
2. The OIDC addon keeps the handle in its pending state (keyed by `state`) and
   puts it in the bridge as `linkIntent`. Like every bridge it carries a `jti`
   and the hash of the browser's `camstack_sso_state` cookie (D810).
3. The finish resolves the intent, checks the provider matches, and requires
   the request's session COOKIE to name the intent's user; then it stores
   `(provider, sub)` → user in `user_external_identities` and redirects to
   `/system/my-access?linked=<provider>` (or `?linkError=`), under the hub
   mount. The link is written through the hub-internal
   `UserManagementInternal.linkExternalIdentity` — no wire can create one
   (D811).

**From the native app (D801).** The app's system browser holds no hub
session, so step 3's cookie check cannot hold. The app passes
`returnTo: 'camstack://auth-callback'` (allowlisted by `APP_AUTH_CALLBACK_URLS`
in `@camstack/types`, the same list the admin-ui login handoff reads). The
finish then PARKS the verified identity under a one-time `nlc_` code (60 s,
single-use, `native-link-completions.ts`) and 302s to
`camstack://auth-callback?link=<code>` (or `?linkError=`) — never under the hub
mount. The app claims it with `auth.completeExternalLink({ code })` over its own
bearer; the router links only when the caller IS the intent's user, through the
finish's own link step. Started on the LAN or the public address alike: the
return goes to the app, not to an origin.

**Opening the account page in a browser (D801).** `auth.createBrowserHandoff`
returns `/api/auth/browser-handoff?code=…` (one-time, 60 s). The route opens a
new refreshing session for the code's user and 302s to `/login#token=…&next=/system/my-access`
— the fragment admin-ui's auth boot consumes — so the native app can send the
operator to the passkey enrolment in the system browser, signed in. The route
takes no destination.

One identity maps to one user (the row id is the identity); a user may link
several providers; deleting the user deletes its links; a link whose provider
instance is gone stays listed as unavailable and removable. Admins see and
remove a user's links from Users → Sign-in links, and cannot create one.

## Where an SSO sign-in returns, and the popup

**Same origin (D791).** A sign-in returns to the origin it started at. `/start`
reads the request's origin (`X-Forwarded-Host` over `Host`,
`X-Forwarded-Proto`, the `X-Forwarded-Prefix` mount) and uses it only when the
hub ADVERTISES it — a Network-page row (detected or custom; never the app link
or loopback) or the `publicEndpoint` / `internal` / `appConnections` answer
(`packages/addon-auth/src/oidc/request-origin.ts`). A forged or unknown host
falls back to the public endpoint. The set of advertised origins also holds the
address book's `listenerOrigins` — where the hub's listeners really answer,
`https://<lan>:<httpsPort>` and, while LAN HTTP is on, `http://<lan>:<httpPort>`
(the rows show only the `http://` one then, so the https origin of the admin UI
would otherwise be refused and the D810 state cookie lost; D794 amendment).
Exact match only. The resulting `redirect_uri` is stored in
the pending state and repeated on the token leg; the callback 302s to the
ABSOLUTE `<origin><mount>/api/auth/sso/finish`, whose returns are relative and
so stay there.

| "Redirect URI override" | `redirect_uri` |
|---|---|
| empty (default) | `<advertised origin the sign-in started at>/addon/auth-oidc/<id>/callback`, else the public endpoint's |
| set | exactly the override — it pins ONE origin for every sign-in |

So register one callback per address users sign in from at the IdP, e.g.
`https://<lan-ip>:4443/addon/auth-oidc/<id>/callback` and
`https://<public-host>/addon/auth-oidc/<id>/callback`.

The IdP matches `redirect_uri` strictly: with LAN HTTP on, each LAN **https**
origin users open the admin UI at (`https://<lan-ip>:<httpsPort>`) must be
registered as a redirect URI too, not only the `http://` row the Network page
shows.

**OAuth completions share that page.** A broker sign-in or sign-out (Google), and a
refused account link (`/api/oauth2/authorize` asked by a browser), end on
`/sso-complete#return=oauth&status=success|error&addon=…&broker=…&reason=<code>`
(`oauthLandingUrl` / `parseOauthLandingFragment` in `@camstack/types`;
`pages/OauthLanding.tsx`). The fragment carries a status and a reason CODE from a
closed list — never a token, a code or an error message; the page words the
code (en/it). A popup posts `camstack:broker-oauth` to a same-origin opener and
closes; a full-page flow shows the result and returns by itself after a success.

**Popup.** The login page's redirect buttons and My access → Link run the flow
in a popup (`/start?popup=1`, then `/api/auth/sso/finish?popup=1`). The finish
lands the popup on `/sso-complete#return=login|profile&…` — the same fragment
(session / challenge / error) or link query the page return would carry. That
page (`pages/SsoComplete.tsx`, rendered by `main.tsx` without booting the app)
strips the fragment and `postMessage`s the outcome to `window.opener` with its
own origin as target; the opener (`lib/sso-popup.ts`) takes it only from the
window it opened, at its own origin, acks, and completes like the full-page
return (`finalizePasskeyLogin` + `goNext` for a session, the factor step for a
challenge, a refreshed list for a link). When that opener is unreachable
(D794 amendment) the popup falls through: a token-free "done" on the
same-origin `BroadcastChannel` `camstack-sso` (a login first keeps its session
at the popup's origin; the opener reads it from its own storage); an opener at
ANOTHER origin — the IdP returned to a different hub address — gets a closed
popup on a successful link (it polls `popup.closed` and refreshes the list) or
an error shown in the popup; nobody at all: the full-page flow, as before. A
blocked popup or the native-app handoff sheet runs the full-page flow too.
`auth-oidc` logs `OIDC: sign-in returns to` per `/start` (`source`,
`returnBase`, `claimed`, `advertised`) — the line that says why a flow left
the origin it started at.

## The bridge is single-use and browser-bound (D810)

`/start` sets `camstack_sso_state` (random, HttpOnly, Lax, path `/`, 10 min,
Secure over https) and keeps its SHA-256 in the pending state; the bridge
carries it as `browserBinding`, plus a `jti`. The finish requires the request's
cookie to match (constant-time), then records the `jti` (`used-bridge-ids.ts`,
10 min) and refuses a second use — so a stolen copy without the cookie is
refused without being burned. Refusals: `/login#error=sso-state`, or
`?linkError=state` for a link. Every finish clears the cookie and sends
`Referrer-Policy: no-referrer`; `bridge`, `code`, `state`, `challenge`, `link`
are masked in logged URLs.

## The native app signs in through its own hub flows (D858)

The viewer never opens the admin-ui login. Two hub flows end at the app's
custom scheme (`camstack://auth-callback`, or `camstack.dev://…` when the app
asks with the allow-listed `redirect`) with a one-shot handoff code, and set no
web session or cookie. The request is read by one function,
`parseAppFlowRequest` (`@camstack/types`): `code_challenge` (S256, 43
characters), `code_challenge_method=S256`, `state` (`[A-Za-z0-9._~-]{1,256}`),
`purpose` (`new-session` | `step-up`), `redirect` (allow-list only).

- **OIDC**: `/addon/auth-oidc/<id>/start?app=1&…`. The addon keeps the app
  parameters in its pending state (never sent to the IdP; the IdP `state` is
  prefixed `a.`), signs them into the bridge as `claims.app`, and the callback
  goes to `/api/auth/sso/finish-app` (`sso-finish-app.ts`): the same bridge
  rules as `/sso/finish` (login bridge, provider enabled, D810 cookie binding,
  `jti` single use, linked identity only), then the handoff code bound to the
  app's challenge, state and purpose. `/sso/finish` refuses an `app` bridge;
  `finish-app` refuses one without. Every refusal is a 302 to the app with
  `error=` (`sso-not-linked`, `sso-state`, `second-factor-required`,
  `idp-error`, `idp-failed`, `state-expired`, …).
- **Passkey**: `/auth/app/passkey?…` is a standalone page (no admin-ui bundle,
  CSP by script hash, same origin) driving `POST /auth/app/passkey/begin` and
  `/finish`; the finish verifies the assertion through `user-passkeys` and
  answers `{ location }` at the app.
- **Step-up** (`purpose=step-up`): the code redeems only at
  `auth.deviceEnrollProofFromHandoff` for the same user and yields a proof. The
  authentication is the IdP login or passkey assertion that just ran; neither
  leg reads a session cookie. A user who owes TOTP is refused
  (`second-factor-required`) and uses the in-app password login.
- **`auth.listLoginMethods`** carries `app` on every arm: `{ kind: 'native' }`,
  `{ kind: 'browser', startPath }` or `null` (the viewer hides the method).
  It stays a bare array: every installed viewer parses it as one. The hub's
  name is the separate public `auth.getServerName` (D861), below.

**Confirmation before the code (D858 amendment).** A custom scheme can be
claimed by any app, so neither browser leg hands the app a code directly: both
end at `/auth/app/confirm` ("Sign in the CamStack app as <user>?", CSP by hash).
The code is minted only when Continue POSTs the one-shot, cookie-bound token
(`app-confirmations.ts`, 120 s, burned by the first attempt); Cancel returns
`error=cancelled`. An OIDC step-up asks the IdP for `prompt=login&max_age=0` and
the callback refuses a missing or stale `auth_time` (`step-up-not-fresh`). The
OIDC pending states and WebAuthn challenges are bounded and refuse when full
(`too-many-requests`).

The hub pages of this flow (passkey, confirmation, refusals, and the OAuth2 consent screen) are all rendered by one shell, `server/backend/src/auth/app-page-shell.ts` (`renderAppPage`): theme tokens generated from `@camstack/ui-library/theme/tokens` for light and dark, the admin login card and button look, the inlined brand logo, safe areas. Its stylesheet is inline and pinned in the CSP by a hash computed from the served string (`appPageCsp`). The addon-owned OIDC start redirects a refused request to `/auth/app/refused?reason=<code>`, which the hub renders; add a page by calling the shell, never by writing a new `<style>`.

Those pages speak English and Italian (D858 amendment). All prose is in `app-page-strings.ts`; `resolveAppPageLang` picks the language: the app's optional `lang` query parameter (`en` | `it`, carried through the OIDC pending state, the bridge claim `app.lang` and the confirmation entry) wins, else `Accept-Language`, else English, and neither is ever echoed. Script-written texts reach the page as `data-s-*` attributes so the script, and its CSP hash, never vary by language. A page that needs a new sentence adds a key to BOTH locales.


## The hub's name (D861)

The hub's human name is one `system-settings` row, `server.name`, edited on
System -> Settings (the `system-config` addon's Server section) or by the
first-login dialog, which calls the same `addonSettings.updateGlobalSettings`.
`ServerNameSchema` validates every write (trimmed, 1-48 characters, no control
characters). Nothing writes it by itself: unset reads as the hostname without its
domain with `isDefault: true` (`resolveServerName`, `ServerNameReader`), and a
failed read answers that default and logs. It is served authenticated in
`system.info` (`serverName`) and public as `auth.getServerName`
(`{ name, isDefault }`, nothing else). In the admin
UI an ADMIN who signs in on an unnamed hub gets a "Name this server" dialog
(`ServerNamePrompt`): Save writes the name, Later dismisses it for the browser
session only.
