---
id: D855
title: Device certificates are a login method, a signed-in device enrolls itself only after a step-up, and a credential dies only on a definitive answer
status: accepted
date: 2026-10-15
supersedes:
applies-to:
  - packages/system/src/auth/device-ca.ts
  - packages/system/src/auth/device-ca-store.ts
  - packages/system/src/auth/device-credential-manager.ts
  - packages/system/src/builtins/local-auth/local-auth.addon.ts
  - packages/types/src/auth/device-certificate.ts
  - packages/types/src/capabilities/device-credentials.cap.ts
  - server/backend/src/api/core/auth-device-cert.procedures.ts
  - server/backend/src/api/core/certificates.router.ts
  - server/backend/src/auth/session-mint.ts
  - server/backend/src/auth/device-enroll-proofs.ts
  - server/backend/src/core/auth/handoff-code.service.ts
---

## Context

The operator's wife's iPhone runs the viewer and has to stay signed in for good
without a periodic login, and the operator has to be able to cut it off. Every
session today dies with the session lifetime (30 days sliding) and a refresh
token that has to be stored in the platform secure store; a stolen or lost
phone is revoked only by ending its sessions, and a new session needs the full
login again (password, OIDC, passkey with its per-domain entitlements).

Two things were weighed and rejected. A long-lived opaque API token per phone
is a bearer secret in the keychain: whoever copies it is the phone, and it
cannot prove possession. Native OIDC / passkey inside the viewer would need
the hub's domain in every shipped app's entitlements; the existing browser
handoff (`createHandoffCode` + `redeemHandoffCode`, D801) already lets the
system browser run ANY web login and bounce back to the app.

## Decision

1. **A device is a P-256 key pair it generates itself, and the hub signs the
   public key.** The private key never travels (Secure Enclave / Android
   Keystore / non-extractable WebCrypto). A third CA signs the leaf: the
   **device CA**, EC P-256, distinct from the HTTPS local CA (RSA) and the mesh
   CA. Its key is the keychain secret `secret://system/global/deviceCaKey`
   (owner `system`), its certificate is `cluster.deviceCa`, created lazily on
   the first enrollment and never rotated on boot. The leaf: CN = credential
   id, SAN URIs `camstack:credential:<id>` and `camstack:user:<userId>`, EKU
   clientAuth, 365 days.
2. **Two ways to enroll, one registry.**
   - *QR / admin*: `device-credentials.startEnrollment` (admin) makes a
     one-shot code (192-bit, 10 min, single use, kept only as a SHA-256 hash,
     burned by the first attempt whatever its outcome) and a
     `camstack://enroll?hub=<origin>&code=<code>` link; the device calls the
     public `auth.completeEnrollment`.
   - *Self*: `auth.enrollSelf` for the caller's OWN user only. It needs the
     session AND a **step-up proof**: purpose `device-enroll`, bound to the
     same user, 5 minutes, single use, hashed (`device-enroll-proofs.ts`). The
     proof comes from signing in again at that moment — a password / passkey
     `reauthenticate` (`deviceEnrollProofFromReauth`) or the app login handoff
     run in `step-up` purpose for any web method
     (`deviceEnrollProofFromHandoff`). It replaces and rotates no session.
     **Who may start a step-up** (security review): a `step-up` handoff code
     is minted only by a leg that JUST authenticated - either a single-use
     `reauthToken` (consumed), or a session OPENED by a primary login
     (`password`, `passkey`, `sso`) at most 120 s ago, once per session. A
     session born of a handoff, a cookie exchange or a device certificate is
     not an authentication, so a stolen or old session cannot launder one into
     a proof. The "once per sign-in" memory is in process, so after a restart a sign-in
     that predates the process is refused (it signs in again): the 120 s window plus
     this rule keeps the claim from being replayed across a restart. A device challenge
     is refused when the client address cannot be resolved, so unresolvable requests do
     not share one nonce partition. A reauth token feeds one proof or one step-up code, never two. No
     "authenticated ≤ N minutes ago" window exists: a session refreshed for
     hours, or authenticated a second ago, mints nothing without the proof.
     The hub-wide setting `deviceCertificates.selfEnrollment`
     (`allowed` | `disabled`, admin; no per-role switch) turns it off.
   Both rows record `enrolledVia: 'qr' | 'self'`.
3. **Login**: `getDeviceChallenge` answers a 60 s single-use nonce bound to the
   hub origin the request is entitled to (the claimed origin when the hub
   advertises it, else the public endpoint — the same rule as the OIDC return,
   D791; the shared helpers moved to `@camstack/types`). The device signs
   `camstack-device-cert-v1 \n <login|renew|revoke> \n <origin> \n <nonce>`
   with ECDSA P-256 / SHA-256 (raw `r||s` or DER). The purpose is inside the
   message, so a login signature is worthless as a renewal or a revoke.
   `loginWithDeviceCertificate` checks chain, validity and EKU, then the
   signature against the key IN THE PRESENTED LEAF, and only then the registry
   (row, revocation, public-key equality, current fingerprint) - a forger
   learns nothing about which credentials exist. It opens the SAME
   session a password login opens (`session-mint.ts`): method
   `device-certificate`, the credential id on the session row
   (`credentialId`) and in the JWT (`cid`). The certificate is the possession
   factor: no second factor is asked.
4. **Revocation cuts sessions at the next refresh.** Revoking sweeps the
   credential's sessions at once, and in addition `SessionMinter.refresh`
   re-checks the credential of any session that carries one; a revoked,
   expired, unknown or unverifiable (registry down) credential refuses the
   refresh and revokes the session. Who can revoke: an admin
   (`device-credentials.revokeDeviceCredential`), the owner by id from a
   session (`auth.revokeOwnDeviceCredential`), the device itself, signed
   (`auth.revokeOwnDeviceCertificate`, works with no session). `revokedBy` is
   `admin:<id>` | `user:<id>` | `device`. A revoked row is kept for audit and
   is deleted only by an admin and only once revoked. An admin PASSWORD RESET
   revokes ALL the user's device credentials (`revokedBy: password-reset`) and
   the sessions they opened. The user's OWN password change does the same
   (`revokedBy: password-changed`), on top of ending their other sessions as before; the
   session that made the change stays, unless it is itself a certificate session: a
   session whose credential was just revoked is not left alive (it could not refresh
   anyway), so a certificate session that changes the password ends with it. A session minted FROM a credential session (a
   `new-session` handoff, a browser handoff, a cookie exchange) inherits the
   credential id, so it dies with it; a refresh judges the credential BEFORE
   the refresh token is spent, so a transient registry outage cannot turn into
   a refresh-reuse revocation.
   (`deleteDeviceCredential`); after that the device's answer is
   `unknown-credential`.
5. **Renewal**: `renewDeviceCertificate` (valid, not revoked, `renew`
   signature) issues a new leaf for the SAME public key; the app renews when
   under 30 days remain. The registry holds the current fingerprint: the
   previous leaf keeps working for 24 h (a device that lost the answer), then
   answers `superseded` (non-definitive: the app holds only the newest one).
6. **Typed refusals.** Every device endpoint answers a discriminated
   `{ ok: false, reason, definitive }` (`DeviceRefusalReason` in
   `@camstack/types`): `revoked`, `unknown-credential`, `user-gone`
   (DEFINITIVE) and `expired`, `bad-signature`, `nonce-invalid`,
   `rate-limited`, `invalid-certificate`, `unavailable`, `code-invalid`,
   `self-enrollment-disabled`, `step-up-required`, `bad-public-key`. A refresh
   refused on the credential says the same reason in the `UNAUTHORIZED`
   message (`device-credential:<reason>`, `deviceRefusalFromMessage`).
   Transport failures and 5xx carry no reason and never mean "dead".
7. **Viewer contract (the viewer phase implements it).** The app deletes its
   key and certificate and treats the device as unlinked only after
   `DEVICE_DEFINITIVE_REFUSALS_BEFORE_DELETE` = 3 CONSECUTIVE definitive
   answers (`revoked` / `unknown-credential` / `user-gone`) — never on a
   network error, timeout, 5xx or a non-definitive reason (a single bad read
   must not destroy a credential, D49). On deleting it shows "This device was
   disconnected" and returns to the login screen. A device-side revoke deletes
   immediately once the hub confirms (`ok: true`).
8. **Login-method registry.** `auth.listLoginMethods` gains the arm
   `device-certificate` (paths, signature suite, message version, `clients`),
   offered while local-auth is up. A NATIVE app executes each arm so:
   `redirect` (OIDC, any IdP) — through the app login handoff below, never an
   embedded web view; `passkey` — through the same handoff in the system
   browser (the relying party stays the hub's domain, so no per-domain app
   entitlement); `widget` — handoff (it is a web ceremony); `device-certificate`
   — silently, with the stored key.
9. **App login handoff (hardened, not new).** The viewer opens the hub's web
   login in an `ASWebAuthenticationSession` / Custom Tab with
   `redirect=camstack://auth-callback` (the allowlist `APP_AUTH_CALLBACK_URLS`:
   `camstack://auth-callback` and `camstack.dev://auth-callback`, verified
   against the scheme in `camstack/app.config.ts`; no open redirect). After
   any login leg the web page mints a handoff code and bounces the browser to
   the app. D855 adds PKCE S256 (`codeChallenge` at `createHandoffCode`,
   `codeVerifier` at `redeemHandoffCode`) and an app `state` bound to the code;
   both are MANDATORY for `new-session` and `step-up` (an app-callback code),
   and a code redeems only with its verifier; every attempt burns the code.
   The admin-ui login reads `code_challenge`, `code_challenge_method`, `state`
   and `purpose` from its URL and forwards them. Only the legacy `renew` pair
   (installed viewers renewing their own session) may omit them; it ends with
   the retirement of the `renew` handoff announced in D812 (one release), and
   a viewer older than the PKCE release can no longer use the browser handoff
   login (its in-app password login is unaffected). A `renew` code with no session
   behind it is refused (it would open a brand-new session with no PKCE). The new purpose `step-up` is redeemable only at
   `deviceEnrollProofFromHandoff`, by the bearer of the SAME user, and yields a
   proof, never a session. Every refusal is logged with its reason.
10. **Inventory** (`certificates` router, admin): the HTTPS leaf per node and the
    mesh CA with every node's recorded leaves. The first cut reported per-node mesh
    leaves as not recorded and offered no renewal or revocation; that gap is closed
    by D856 (a registry of issued and observed leaves, a hand-over renewal, revoke,
    and hub-issued HTTPS on agents). Revoking or renewing never forgets a node
    (`clusterNodes.forgetNode`).

D613 (no base64 byte fields on cap methods) is about BULK bytes held whole on
both sides; a PEM certificate (~600 B), an SPKI (91 B) and a signature (64 B)
are small strings, which is what `ctx.peerBytes` exists to NOT carry.

## Consequences

- A stolen certificate is useless without the device key; a stolen phone with
  an unlocked Secure Enclave is cut by revoking, which also ends its sessions.
- The device CA key is a second key whose loss orphans every enrolled device;
  it is listed as process-held so the orphan sweep never offers it. `absent`
  means BOTH the key and `cluster.deviceCa` are missing; a missing key with the
  certificate present is an error state (logged, shown by `getDeviceCaStatus`)
  and never an automatic new CA. Creation writes the key first; a death before
  the certificate write is completed by the next lookup, which rebuilds the
  certificate from the same key (same subject and public key, so issued leaves
  still verify).
- A device certificate login skips the second factor on purpose.
- Self-enrollment makes a compromised password plus a compromised session
  insufficient: the attacker also needs the step-up, which is another
  authentication (password / passkey / any web method).
- New schema: `device_credentials`, `login_sessions.credentialId` (nullable),
  new audit actions, the `device-credentials` capability. Needs `types`,
  `system` and `server` published (a framework change), no addon redeploy.

## Enforcement

Specs: `packages/system/src/auth/__tests__/device-credential-manager.spec.ts`
(one-shot, TTL, hashed, SAN/EKU/validity, replay, wrong origin, purpose
replay, revoke, delete refuses a live row, renew keeps the key) and
`server/backend/src/api/core/__tests__/auth-router-device-certificate.spec.ts`
(typed reasons, revoke cuts refresh, device-signed revoke, step-up gate, PKCE
handoff, login-method arm). Disarmed: removing the refresh-time credential
check fails the two revocation specs; removing the proof check in `enrollSelf`
fails three enrollSelf specs. The tier baseline pins the admin cap methods.
