---
id: D782
title: An OIDC identity signs in only the user who linked it, from their own session; an unlinked identity is refused and every SSO login owes the user's second factors
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/auth/sso-finish-deps.ts
  - server/backend/src/auth/external-link-intents.ts
  - server/backend/src/auth/second-factors.ts
  - server/backend/src/api/core/auth.router.ts
  - packages/system/src/auth/external-identity-manager.ts
  - packages/system/src/builtins/local-auth/local-auth.addon.ts
  - packages/types/src/capabilities/user-management.cap.ts
  - packages/types/src/capabilities/sso-bridge.cap.ts
  - packages/types/src/capabilities/login-method.cap.ts
  - packages/addon-auth/src/oidc/auth-oidc.addon.ts
  - packages/addon-admin-ui/src/components/users/LinkedSignInsSection.tsx
  - packages/addon-admin-ui/src/components/users/ExternalIdentitiesModal.tsx
  - packages/addon-admin-ui/src/pages/Login.tsx
---

## Context

An OIDC login named an identity `oidc:<instance>:<sub>` that had no user
record, and `/api/auth/sso/finish` minted a FEDERATED session for it (D712):
the instance's `defaultRole` decided whether it was admin, it carried no
scopes or device grants, and it never appeared in the user list. Anyone the
IdP would authenticate became a CamStack user with a role chosen per instance —
including, with `defaultRole: admin`, an administrator nobody had created.

The operator wants the opposite: an IdP account signs in only an existing
CamStack user, and only because that user said so. Auto-creation, email
matching and group → role mapping were explicitly declined.

Reading the finish also showed a second gap: a magic-link or OIDC login minted
a session straight away, skipping TOTP and an opted-in passkey, although every
other primary method (password, passkey-first) owes them.

## Decision

- **Linking.** A signed-in user links an OIDC identity from My access →
  Linked sign-in accounts. `auth.beginExternalLink` mints a hub-side intent
  for `ctx.user` (opaque, single-use, 10 min, in memory) and returns the
  provider's `/start?link=<handle>`. The OIDC addon keeps the handle in its
  server-side pending state and puts it in the bridge (`linkIntent`). The
  finish resolves it and links `(provider, sub)` → the intent's user, but only
  when the browser completing the flow holds a real session cookie OF THAT
  USER. A link never signs anyone in. The user id never travels through the
  browser.
- **Storage.** `user_external_identities` (local-auth): the row id IS the
  identity `(provider, subject)`, stored with the verified `iss` it was linked
  under — a `sub` is unique only per issuer, so a login whose issuer differs
  (the instance was repointed at another IdP) is NOT that identity. The row id IS the
  identity, so one `(provider, subject)` maps to one user by primary key; a
  user may hold several; deleting the user deletes its links. A link whose
  provider instance was renamed, removed or disabled stays listed as
  "provider unavailable" and is removable — it can no longer sign anyone in,
  because its provider id no longer reaches the finish.
- **Login.** An OIDC bridge signs in the linked user through
  `mintForRecord` — the record decides role, scopes and devices. An unlinked
  identity goes back to the login page (`#error=sso-not-linked`) with "This
  <provider> account is not linked to a CamStack user. Sign in normally and
  link it from your profile." The federated session and `defaultRole` are
  removed (`isAdmin` in an OIDC bridge is always false and ignored).
- **Admins** see and remove a user's links (Users → Sign-in links); they
  cannot create one. `user-management.linkExternalIdentity` is admin on the
  wire for the hub's own use; a UI that creates links for someone else is a
  violation of this record.
- **Second factor (conservative).** An SSO login — linked OIDC or magic link —
  is a PRIMARY factor only. If the user has TOTP enrolled, or an enrolled
  passkey opted in as second factor, the finish returns a challenge
  (`#challenge=…&factors=…`) and the login page resumes at the factor step;
  only then is a session minted. The IdP's own MFA is not trusted to stand in
  for CamStack's, because CamStack cannot see whether it happened.

## Security review

- **CSRF / state.** The OIDC leg keeps its `state` + PKCE S256 + `nonce`; the
  link handle is not a credential — it names nothing without the server-side
  intent, and the intent is useless without the same user's session cookie.
- **Linking someone else's session (link-CSRF).** An attacker who starts a
  link in their own account and lures a victim through the IdP leg fails the
  cookie check (the victim's browser does not hold the attacker's session).
  The reverse — a victim's link completed with the attacker's IdP account —
  needs the attacker to finish in the victim's browser session, which the
  same check refuses.
- **Replay.** Intents are single-use; a replayed bridge carrying a consumed
  handle links nothing (`linkError=expired`). Bridges live 5 minutes, and the
  OIDC `state` is consumed at the callback.
- **Takeover by re-link.** An identity linked to user A cannot be re-linked
  to B (`linkError=conflict`); A must unlink first.
- **Issuer.** The bridge carries the id_token's verified `iss`; a link only
  matches the same issuer, and an OIDC bridge without one is refused. Instance
  ids are slugs (`[a-z0-9-]`), so `oidc:<id>:<sub>` cannot be read two ways,
  and a callback must finish at the instance its pending state started at.
- **Bounded state.** The OIDC addon's pending logins (public `/start`) are
  capped at 1 000, oldest evicted; hub link intents likewise.
- **Disabled provider.** D777 still applies first: a bridge from a disabled
  provider is refused before any link or login.
- **Errors.** A 500 from the finish carries no detail; it is logged
  server-side (`sso-finish` logger).
- **Open, not fixed here.** (a) A login bridge is a 5-minute bearer in a
  query string, redeemable more than once and not bound to the browser that
  started `/start` (pre-existing, D712) — a `jti` single-use set plus a
  state cookie would close it. (b) `user-management.linkExternalIdentity` is
  admin over tRPC, so an admin could plant a link; admins can already mint an
  arbitrary bridge, so it adds no power, but it should become hub-internal.
  (c) A hijacked session can link the attacker's IdP account; TOTP still
  applies at login. Re-authentication on `beginExternalLink` would close it.
  (d) `beginExternalLink` is not rate-limited per user.
- **Residual.** Sessions already minted as federated before this change stay
  valid until they expire (the token lifetime); rotating the JWT secret ends
  them at once. Intents are per hub process: a restart mid-link costs one click.

## Consequences

- Every OIDC user must be created locally and link their IdP account once.
  An OIDC login that worked as a federated session before now lands on the
  "not linked" message.
- Magic-link and OIDC logins of a user with 2FA now ask for it.
- The deploy set crosses packages: `@camstack/types` (cap + bridge claim),
  `@camstack/system` (local-auth store, bridge claim carry-through), server,
  addon-auth and admin-ui. An addon-auth ahead of the hub loses `linkIntent`
  (the hub's bridge signer drops unknown claims), so the link fails closed.

## Enforcement

`sso-finish.spec.ts` (linked / unlinked / other instance / malformed /
2FA challenge / link bound to the session / single-use / provider mismatch /
conflict / magic-link cannot link), `external-link-intents.spec.ts`,
`sso-finish-deps.spec.ts` (only a real session cookie names the user),
`auth-router-external-identities.spec.ts`, `external-identity-manager.spec.ts`
and `local-auth/__tests__/external-identities.spec.ts` (one identity → one
user; delete cascades), `auth-manager-sso-bridge.spec.ts` (the handle survives
the bridge), the D782 cases in `auth-oidc.addon.spec.ts`, and
`LinkedSignIns.spec.tsx` / `Login.spec.tsx` / `sso-return.spec.ts` in admin-ui.

## Amendment, 2026-10-08 — what is linkable is a contract flag, not an id prefix

The profile offered for linking every `redirect` login method whose id began
with `auth-oidc/`: the hub recognised an OIDC provider by the shape of a string
another addon chose. A `redirect` login method now declares
`linkable: true` (`login-method` cap, `RedirectLoginMethodSchema`);
`auth-oidc` sets it on every instance, and `auth.listLinkableProviders` /
`beginExternalLink` / `listOwnExternalIdentities` read the flag alone. A
redirect without it — magic-link, or any other button — is a login only,
whatever its id.

The flag is harmless public metadata, so the public `listLoginMethods` carries
it unchanged (its output reuses the cap schema; no second shape).

The finish keeps its `auth-oidc/` prefix, on purpose. There it does not choose
what is linkable — a link still needs an intent, and only
`beginExternalLink` mints one, for a provider the flag offers; the finish
then requires the bridge's provider to equal the intent's. The prefix is how
the finish READS a bridge: it is the allowlist that keeps the `oauth-*`
tokens of the same signer from being swapped for a session, and it tells an
identity-named bridge (`oidc:<instance>:<sub>`, signs in only a linked user)
from a magic-link bridge that names a user record. Widening it to "any
linkable provider" would let a bridge whose `userId` is a user record be read
as an identity, or the reverse. A future non-OIDC linkable provider is offered
the Link button and fails closed at the finish (400, nothing linked) until it
gets its own bridge format here.

Enforcement: `auth-router-external-identities.spec.ts` (a non-OIDC redirect
declaring `linkable` is offered and can begin a link; a redirect without it is
not, even under an `auth-oidc/` id) and the `linkable` assertion in
`auth-oidc.addon.spec.ts`.
