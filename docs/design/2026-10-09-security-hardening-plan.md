---
title: Security hardening plan (2026-10-09)
last-verified: 2026-10-09
---

# Security hardening plan (2026-10-09)

Status: **plan only — no code in this record.** §1 P1 (mesh containment) and
the mandatory cluster secret are implemented: D802, D803, D804 (2026-10-09);
the mTLS step is planned in [2026-10-09-mesh-mtls-plan.md](2026-10-09-mesh-mtls-plan.md). Every finding below was read
against `main` on 2026-10-09; `file:line` references are to that tree.
Context read: [architecture/authentication.md](../architecture/authentication.md),
[design/2026-10-08-secrets-keychain.md](2026-10-08-secrets-keychain.md),
D634, D782, D787–D789, D794, D797.

## 0. Threat model and scoring

CamStack is homelab-first: one hub, a few agents, a LAN full of IoT devices
(cameras are the classic compromised LAN host), and — for most operators — the
admin UI published to the internet through a Cloudflare tunnel (`cloudflared`
dials `https://127.0.0.1:<port>`,
`packages/addon-cloudflare/src/tunnel/cloudflared-invocation.ts:60`).

Two attacker positions matter:

- **Internet** — reaches only what the tunnel publishes: the HTTPS origin
  (admin UI, `/trpc`, `/api/*`, `/addon/*`). Never the mesh ports.
- **LAN** — any host on the hub's network: a compromised camera, a guest
  device, a container on the same Docker network. Reaches everything,
  including the mesh (TCP 6000, UDP 4445, agent listen ports, agent 4444).

Risk = **likelihood × impact**, each 1–5 (25 = worst). Effort: **S** ≤ 1 day,
**M** 2–5 days, **L** > 1 week, including specs.

## 1. The Moleculer mesh is unauthenticated — risk 4 × 5 = **20**

### Verified

- **Any mesh call is a trusted admin.** `createMeshTrpcContext` returns a
  synthetic `{ id: 'mesh', isAdmin: true, allowedProviders: '*' }`
  (`server/backend/src/api/trpc/trpc.context.ts`). The `$core-caps`
  service binds every core namespace to a caller built from it
  (`server/backend/src/api/trpc/core-cap-bridge.ts:195`) and the hub registers
  it on its **TCP** broker (`server/backend/src/core/moleculer/moleculer.service.ts:924`,
  `server/backend/src/main.ts:692`).
- **`repl` is one of those namespaces**
  (`server/backend/src/api/trpc/core-cap-bridge.ts:54`). `repl.execute` runs
  arbitrary code in a `vm` context inside the hub process
  (`server/backend/src/api/core/repl.router.ts:27`,
  `packages/system/src/repl/repl-engine.ts:21`); `vm` is not a security
  boundary. `addonSettingsRaw` and `logs` are also there (`:50`, `:55`).
  **A LAN host that speaks Moleculer TCP can therefore execute code in the
  hub.** This is the single worst finding in this plan.
- **The TCP transport authenticates no peer and encrypts nothing.** Hub:
  `port: 6000`, `udpDiscovery: true`, `udpPeriod: 5`, no TLS, no
  middleware (`packages/system/src/kernel/moleculer/broker-factory.ts:32`,
  `packages/system/src/kernel/moleculer/broker-factory.ts:130`). Moleculer's TCP transporter has no TLS option; the sender
  `nodeID` in every packet is self-declared.
- **The cluster secret gates `$hub.registerNode` only**
  (`packages/system/src/kernel/moleculer/hub-service.ts:88`). Nothing
  checks that a caller of `$core-caps.*`, `$hub-cap-fwd.forward` or
  `$hub.setLogLevel` / `$hub.unregisterNode` (`:82-87`, `:118-123`, no gate)
  ever registered. The secret is optional and starts empty (gate `off`, D797).
- **The registration proof is replayable.** A node presents
  `sha256(secret)` (`packages/system/src/kernel/moleculer/cluster-secret.ts:36`, removed by D857) <!-- drift-ok -->
  over the clear-text transport; the hash is a password equivalent.
- **The caller stamp trusts registration.** `$hub-cap-fwd` believes a
  `callerAddonId` when the sender's registered manifest lists that runner
  (`server/backend/src/core/moleculer/moleculer.service.ts:540`,
  `packages/system/src/kernel/transport/hub-cap-forward.ts:125`). With the
  gate `off`, anyone can register a manifest naming any addon and then pass the
  keychain's owner check (`packages/system/src/builtins/keychain/keychain.addon.ts:116`).
- **`caller` is not stripped on the forward leg (to confirm with a spec).**
  `caller: 'required'` methods receive `caller` injected by the tRPC router,
  which discards a client value (`packages/system/src/kernel/cap-router-builder.ts:311`),
  but the mesh path passes `args` verbatim and only `callerAddonId` is
  rewritten (`packages/system/src/kernel/transport/cap-route-resolver.ts:254`).
  `keychain-admin.reveal` / `resetKeychain` read `input.caller.userId`
  (`keychain.addon.ts:126`). By reading, a mesh peer that supplies
  `caller` in `args` reaches them. Pin this with a spec before relying on it.
- **Discovery broadcasts.** UDP 4445 every 5 s; the namespace is now unset
  (D797), so any Moleculer process on the LAN with the default namespace —
  hostile or just another app — is discovered and joins.
- **Ports.** `Dockerfile:212` exposes `6000/tcp 4445/udp`; agents bind a
  derived listen port (`broker-factory.ts:72`) and port 4444 (bearer = the
  cluster secret, loopback trusted, unpaired = pairing surface open:
  `server/backend/src/agent/agent-http-auth.ts:1`).
- **Secrets cross the mesh in clear.** Agent-hosted addons resolve keychain
  values and camera credentials through `$hub-cap-fwd`; the TCP leg is
  plaintext, so a LAN sniffer collects them.

### Options

| Option | Authenticates peers | Per-node identity | Confidentiality | Effort | Notes |
|---|---|---|---|---|---|
| A. Make the cluster secret mandatory | registration only | no | no | S | Necessary, nowhere near sufficient: calls never need registration. |
| B. HMAC-authenticated transport (Moleculer `transporterSend`/`transporterReceive` middleware, per-packet MAC + nonce) | yes, with a shared key | only with per-node keys | no | M | UDP discovery and TCP gossip are outside the hook path (to verify); sender `nodeID` still needs binding to the key. Moleculer's built-in `Encryption` middleware is AES-CBC without a MAC — not authentication. |
| C. Signed join tokens | at join | yes (token names the node) | no | S–M | A bootstrap, not a transport control: it says who may join, then something else must hold that per packet. |
| D. Mutual TLS between nodes with a hub CA | yes, every connection | yes (cert CN = nodeID) | yes | L | Needs a TLS-wrapping subclass of the TCP transporter (reader + writer sockets) — `patches/` already patches deps; no first-party TLS in Moleculer TCP. |
| E. Per-node least privilege instead of blanket admin | n/a | uses D or C | n/a | M | Replace `createMeshTrpcContext`'s admin with a principal per node (`agent:<id>`), and a per-namespace allowlist. |

### Recommendation

**D + C + E, staged behind a P1 containment.** The target is mutual TLS with a
hub-owned CA, bootstrapped by a signed, single-use, short-lived join token,
with the TLS-verified node identity bound to every packet's sender and mapped
to a least-privilege mesh principal. Only TLS gives both authentication and
confidentiality (the mesh carries resolved secrets), and per-node certificates
are what make E enforceable — a shared HMAC key (B) proves "someone in the
cluster", not "which node".

- **Join:** the hub's Cluster page mints a join token (signed by the hub,
  `nodeId`, expiry ≤ 1 h, single use, hub CA fingerprint pinned inside). The
  agent's first-run setup takes it (it replaces "Reveal the cluster secret",
  D797), generates a key pair, and gets a certificate over HTTPS 4443
  (the hub's TLS, pinned by the fingerprint in the token). The CA key lives in
  the keychain; certificates are short-lived (30 d) and renewed over the mesh.
- **Transport:** the TCP transporter subclass speaks TLS 1.3 with
  `requestCert: true`, `rejectUnauthorized: true`; a packet whose `sender` is
  not the certificate's CN is dropped. UDP discovery is turned **off** on the
  hub; agents connect to an explicit hub address (the join token carries it).
- **Privilege:** `$core-caps` drops `repl` (and any namespace an agent does
  not call — measure with the existing mesh-call census,
  `core-cap-bridge.ts:145`), and the remaining actions run under
  `agent:<nodeId>`, non-admin, with an explicit per-namespace grant.
- **Revocation:** removing a node on the Cluster page revokes its certificate
  (CRL held in memory on the hub, checked on handshake).

The cluster secret becomes legacy: accepted for one release as an alternative
join proof, then removed.

### P1 containment (before mTLS, days not weeks)

1. Remove `repl` from `CORE_NAMESPACES` (S). The admin UI's REPL reaches it
   over HTTP tRPC, not the mesh — confirm no worker calls it via the census.
2. A broker middleware refusing every remote action except
   `$hub.registerNode` from a `nodeID` that has not registered with a valid
   proof when the gate is `on` (S). Includes `$hub.setLogLevel` and
   `$hub.unregisterNode`.
3. Strip `caller` (and `callerAddonId`, already done) from `args` on
   `$hub-cap-fwd` before dispatch, with a spec that reaches
   `keychain-admin.reveal` over the forward leg and is refused (S).
4. Challenge–response registration: hub nonce, node answers
   `HMAC(secret, nonce ‖ nodeId)` (S). Ends the replayable hash.
5. Make the cluster secret mandatory once any agent is paired: the Cluster
   page refuses to pair without one and the hub warns while it is empty (S).
6. Operator guidance in the public docs: never forward 6000/4445; firewall
   them to the agents' addresses (S).

Residual after P1: a LAN attacker who sniffs a registration can still spoof
that node's `nodeID` on the clear-text transport. Agent inbound is gated
(hub after mutual join + own children via `$agent.registerNode`) the same way
as the hub — spoofing of those ids remains. Only P2 (mTLS) closes it.

**Dependencies:** none for P1. mTLS depends on the keychain (CA key), the
desktop agent setup window, and the agent's `agent.json` (D797).

## 2. A locked keychain cannot be reset from the UI — risk 2 × 4 = **8**

**Status (2026-10-09): implemented — D799.** Operator decision: the trigger
file, acting on its EXISTENCE (no typed content — it acts only on a locked
keychain, and the archive now keeps the old wrapped keys, so nothing is
destroyed). See [architecture/secrets-keychain.md](../architecture/secrets-keychain.md#a-lost-master-key-d799).

### Verified

The session signing key lives in the keychain (D797). Locked → no session can
be minted or verified (`packages/system/src/builtins/local-auth/jwt-signing-key-keeper.ts:21`,
retry every 30 s). Every admin credential is a signing-key JWT and a `cst_`
token is always non-admin (`server/backend/src/api/trpc/trpc.context.ts:249`),
so `keychainAdmin.resetKeychain` (`packages/types/src/capabilities/keychain-admin.cap.ts:191`,
`auth: 'admin'`) is unreachable. A lost key file means a hub nobody can
administer.

### Options

- **One-shot `RESET_KEYCHAIN` trigger file** in the data directory, the exact
  pattern of `RESET_ADMIN_PASSWORD`
  (`packages/system/src/builtins/local-auth/admin-account-boot.ts:1`).
  Works in a container with nothing but file access; deleted after acting.
- **Recovery CLI on the host** (`camstack keychain reset --data-dir …`).
  Needs a CLI that opens the database offline while the hub is stopped; adds a
  second writer of the keychain tables; awkward in Docker (exec into a stopped
  container is not possible).

### Recommendation

**Trigger file.** Same trust boundary as the key file itself (whoever can
write the data directory can already read the default master key), no new
binary. Behaviour:

- Acts **only when the keychain is locked** (`wrong-key`, `key-missing`,
  `key-file-unreadable`); on an unlocked keychain it logs a refusal and deletes
  the file, so it can never destroy a working store.
- The file must contain the typed confirmation (`KEYCHAIN_RESET_CONFIRMATION`),
  so an accidental `touch` does nothing.
- Runs `resetKeychain` (`packages/system/src/builtins/keychain/keychain-service.ts:623`):
  archives every value, starts a new data key, generates a new signing key
  (everyone logs out), writes an audit entry with actor `trigger-file`.
- **Clears the system-held markers** whose values are now archived — notably
  `cluster.clusterSecret`. Otherwise the cluster gate reads a marker with no
  value, answers `unknown`, and refuses every agent forever (D797 §2).
- Logs the list of fields that now read "not set", by owner, so the operator
  knows what to re-enter.

Effort **S**. Depends on nothing. Ordering: P2 (availability, not exposure),
but schedule it before any work that makes the keychain harder to recover.

## 3. SSO (D782 / D794) — risk 3 × 3 = **9** combined

### Verified

- **The login bridge is a 5-minute bearer, redeemable more than once.** It is
  signed with TTL 300 (`server/backend/src/main.ts:613`,
  `packages/system/src/auth/auth-manager.ts:184`) and travels in
  `?bridge=` to `/api/auth/sso/finish` (`server/backend/src/main.ts:998`).
  The claims carry an optional `jti` (`auth-manager.ts:197`, `:254`), but
  nothing records a used one: `finishSsoReturn` verifies and swaps
  (`server/backend/src/auth/sso-finish.ts:282`). Nothing binds the bridge
  to the browser that called `/start`. Query strings land in browser history,
  proxy and tunnel logs; the log redactor masks only `token`-like names and
  only in absolute URLs (`packages/types/src/utils/mask-url.ts:12`,
  `packages/system/src/logging/log-redactor.ts:49`), so `bridge=` is not
  masked.
- **`userManagement.linkExternalIdentity` is admin over tRPC**
  (`packages/types/src/capabilities/user-management.cap.ts`). D782
  forbids any UI from using it for someone else; the wire still allows it.
- **Linking asks for no re-authentication.** `auth.beginExternalLink` is a
  plain `protectedProcedure` (`server/backend/src/api/core/auth.router.ts:1097`).
  A hijacked session can link the attacker's IdP account and then sign in
  through the IdP (TOTP still applies, D782).
- **`beginExternalLink` has no rate limit.** The limiters exist only on the
  public login legs (`auth.router.ts:78`). Intents are capped at 1 000
  (`server/backend/src/auth/external-link-intents.ts:29`), so a flood evicts
  other users' pending links.

### Fixes

1. **Single-use bridge + state cookie (M).** `/start` sets a `__Host-`
   `camstack_sso_state` cookie (HttpOnly, Secure, SameSite=Lax, 10 min) holding
   a random value; the OIDC addon puts its hash in the bridge. The finish
   requires the cookie to match, records the `jti` in a bounded in-memory set
   until its `exp`, refuses a second use, and clears the cookie. Add `bridge`,
   `code`, `state` to the URL-credential names and mask relative URLs too.
   Popup flow (D794): the popup and the opener share the origin, so the cookie
   is present at the finish.
2. **`linkExternalIdentity` hub-internal (S).** Mark the method
   `internal: true` / not exposed on the tRPC router; the SSO finish already
   calls it in-process. Pin with the method-tier baseline
   (`scripts/check-method-tiers.ts`).
3. **Re-authentication before linking (M).** `beginExternalLink` requires a
   fresh proof: the password, a TOTP code, or a passkey assertion within the
   last 5 minutes (a `reauthAt` claim minted by a new `auth.reauthenticate`).
   A user with only SSO + passkey uses the passkey.
4. **Rate limit (S).** Per-user limiter on `beginExternalLink`
   (e.g. 5/min) and per-IP on OIDC `/start` and magic-link `/request`;
   per-user cap of intents.

Dependencies: 1 touches addon-auth + server + admin-ui (deploy set as D782).
Fix 4 depends on the client-IP fix in §5.2.

## 4. Secrets not yet in the keychain — risk 2 × 4 = **8**

### Verified (from the keychain design §11 and the code)

| Where | State | Exposure |
|---|---|---|
| Notifier targets (`notifiers:notification-targets`), LLM profiles | business collections, inline | DB copy, backup |
| HA / Homematic / Dreame broker connections (`brokers[].connection.*`) | not in a form schema the save path reads | DB copy, backup |
| JSON blobs holding secrets (D787: "stays inline") | inline | DB copy, backup |
| Addon per-device stores | no adopt path; a device created before registration persists its first config without declared paths | DB copy, backup |
| TOTP secrets (`user_totp`, `packages/system/src/builtins/local-auth/auth-schema.ts:84`) | inline; the row outlives a deleted user (`:80-82`) | DB copy, backup — a TOTP seed defeats 2FA |
| Library-owned files: HAP pairing (`packages/addon-export-hap/src/accessory-publisher.ts:36`), Matter fabric (`packages/addon-matter-broker/src/matter-controller-impl.ts:6`), tailscaled state (`packages/addon-tailscale/src/client/tailscaled-daemon.ts:145`), Alexa session | plaintext files under `addons-data` | every system backup |
| System backup archives | `addons-data`, `tls`, `config.yaml` included (`packages/system/src/builtins/system-backup/system-backup.service.ts:133`), not encrypted | S3 / SFTP destinations; also the legacy mqtt `.secret-key` until the D797 `mqtt` step deletes it |

### Fixes (in order)

1. **Backup archive encryption (M).** — **implemented (D800), operator
   decision: a separate backup key PAIR** — the hub holds the public key only,
   the operator keeps the secret key (shown once), so the hub cannot decrypt
   its own archives; consequently it is NOT in the keychain recovery download.
   See [architecture/backups.md](../architecture/backups.md). Original text:
   Encrypt each archive with a per-archive
   key wrapped by the keychain data key (or a dedicated backup key the
   operator can download, so a restore onto a fresh hub works). This covers
   the library-owned files, TOTP seeds and every inline value in one move, for
   the copies that leave the host. Restore needs the key: the Secrets page's
   recovery download must include it.
2. **TOTP into the keychain (S–M).** `secret://local-auth/row/user_totp/<userId>`;
   cascade on user delete.
3. **Notifier targets and LLM profiles (M).** A collection door: the
   collection declares its secret fields; `insert`/`update` go through
   `transformSecretWrite` with scope `row/<collection>/<id>`. D634's
   `mergeSecrets` keeps working on markers.
4. **Broker connections (M)** — move `brokers[].connection.*` into a schema
   the save path reads (array items addressed by id, D787).
5. **JSON blobs (M, per addon)** — split the secret out of the blob into a
   declared field; the blob keeps the rest.
6. **Addon per-device stores (M)** — an adopt path at device registration
   that rewrites declared paths to markers.
7. **Library-owned files (L).** Per library: an encrypted-at-rest directory
   is not offered by these libraries; the realistic first step is exclusion
   from backups plus a re-pair runbook, then a custom storage adapter where
   the library allows one (hap-nodejs `HAPStorage` does; tailscaled does not).

Dependencies: all depend on the keychain being unlocked at write time
(D787 strict mode). Fix 1 depends on the recovery-key UX (§2).

## 5. Other surfaces

### 5.1 API keys, sessions and revocation — risk 3 × 4 = **12**

Verified:

- A session JWT lives **30 days** by default
  (`packages/types/src/constants.ts:22`, `auth.tokenExpiry`). `auth.logout`
  does nothing server-side (`server/backend/src/api/core/auth.router.ts:1076`);
  nothing revokes a session on password change, user disable, or 2FA reset.
  Only rotating the signing key ends sessions — all of them.
- The legacy API keys are random hex hashed with SHA-256
  (`packages/system/src/auth/auth-manager.ts:130`, the since-deleted
  `ApiKeyManager`) and are **not accepted
  by the tRPC boundary** (no branch in `resolveUser`,
  `server/backend/src/api/trpc/trpc.context.ts:211`); the page kept them
  only to list and revoke (the since-deleted `LegacyApiKeysSection`).
  The `type: 'api_key'` JWT branch (`trpc.context.ts:338`) is minted by
  nothing.
- `createServiceToken` mints a 24 h **admin** JWT
  (`packages/system/src/auth/auth-manager.ts:146`) and has no production
  caller.
- `cst_` scoped tokens are hashed, revocable, may expire, and are always
  non-admin (`trpc.context.ts:249`).
- **A deleted user's `cst_` tokens keep working until the next hub restart.**
  `deleteUser` removes the user and its sign-in links but not its tokens
  (`packages/system/src/builtins/local-auth/local-auth.addon.ts:281`);
  `validate` never checks that the owner still exists
  (`packages/system/src/auth/scoped-token-manager.ts:49`, removed by D895); <!-- drift-ok: a plan records the code it was written against --> only the boot-time
  `cleanupOrphans` removes them (`local-auth.addon.ts:149`). Its TOTP row
  also survives (§4).
- Share links can be revoked through the API only; no UI lists them.
- `camstack login` sends only the password (`packages/cli/src/commands/auth.ts:445`),
  so it fails for any account with 2FA — the operator's own admin account
  included. Ops scripts fall back to UI-created scoped tokens.

Fixes:

1. **Session revocation (M).** A `sid` claim + a server-side session table
   (id, user, created, last seen, revoked). `logout` revokes; password change,
   disable, 2FA reset revoke all of a user's sessions; My access lists active
   sessions with "sign out everywhere". Verify is one indexed lookup, cached
   for a few seconds. Shorten the default lifetime to 7 d with sliding
   renewal.
2. **Revoke on delete (S).** `deleteUser` revokes the user's scoped tokens,
   OAuth sessions and TOTP row in the same call; `validate` also refuses a
   token whose owner is gone. A share-link list with Revoke on My access.
   `camstack login` gains the TOTP / passkey step.
3. **Delete dead credentials (S).** Remove `createServiceToken`, the
   `type: 'api_key'` branch, and — after one release of "list/revoke only" —
   the legacy API-key store.
4. **Admin-capable scoped token (S–M), see Q5.** Ops scripts today need a
   human login (D797 §ordering). Recommended: a `cst_` token may carry an
   explicit `admin` scope, creatable only by an admin after re-authentication,
   with a mandatory expiry ≤ 90 days, shown in red on the Tokens page, and
   audited on every use.

### 5.2 Rate limiting across public endpoints — risk 3 × 3 = **9**

Verified: limiters exist on login, TOTP, passkey and handoff legs
(`server/backend/src/api/core/auth.router.ts:78`) and the adaptive probe
(`server/backend/src/main.ts:751`). They key on `req.ip`
(`server/backend/src/auth/auth-rate-limit.ts:86`) and Fastify `trustProxy`
is not set anywhere — so every request through the tunnel arrives from
`127.0.0.1` and **shares one bucket**: ten wrong passwords a minute from
anywhere lock every tunnel user out of login. Not limited: OIDC `/start`,
magic-link `/request` (its own header lists per-email throttling as open,
`packages/addon-auth/src/magic-link/auth-magic-link.addon.ts:20`), <!-- drift-ok: the magic-link addon was removed by D815 -->
`/api/auth/sso/finish`, `/api/auth/session`, share-token redemption, the
OAuth endpoints, `beginExternalLink`.

Fix (S–M): one client-key function — `CF-Connecting-IP` only when the socket
peer is loopback/LAN (the logic exists in
`server/backend/src/api/trpc/client-ip.ts:57`), else the socket address —
used by every limiter; add limiters on the endpoints above; add a per-account
failure counter with backoff so distributed guessing against one user is
slowed too.

### 5.3 CSRF on cookie-auth routes — risk 2 × 3 = **6**

Verified: tRPC reads only `Authorization` or `?token=`
(`server/backend/src/api/trpc/trpc.context.ts:170`), so tRPC is not
cookie-CSRF-able. The cookie `camstack_session` (HttpOnly, `SameSite=Lax`,
`server/backend/src/auth/session-cookie.ts:24`) authenticates
`/addon/:addonId/*` for every method, data plane and control routes
(`server/backend/src/main.ts:1144`, `:1240-1257`), plus the OAuth
authorize leg. Lax blocks cross-site POST, but not **same-site** origins:
any other service under the same registrable domain (a typical homelab puts
many apps on `*.example.tld` behind the same tunnel) can POST with the cookie.

Fix (S): for non-GET cookie-authenticated requests, require `Origin` (or
`Sec-Fetch-Site: same-origin`) to match an advertised origin (the D794
allowlist); reject otherwise. Rename the cookie `__Host-camstack_session` when
served over HTTPS at `/` (not under an ingress prefix). Drop `?token=` from
tRPC except for the WebSocket upgrade, where browsers cannot send headers.

### 5.4 Security headers — risk 2 × 3 = **6**

Verified: the hub sets only `frame-ancestors 'self'`
(`server/backend/src/api/static/frame-policy.ts:36`). No CSP for scripts, no
`Strict-Transport-Security`, no `X-Content-Type-Options`, no
`Referrer-Policy`, no `Cross-Origin-Opener-Policy`.

Fix (M): `Referrer-Policy: no-referrer` (bridge and code URLs);
`X-Content-Type-Options: nosniff`; HSTS on a public origin only (never on a
LAN IP / self-signed origin); CSP in report-only first, then enforced, with
`script-src 'self'` and the WebRTC/media needs measured; COOP
`same-origin-allow-popups` on the admin UI so the SSO popup keeps its opener.
**Coordinate with the agent investigating the SSO popup:** an IdP that sends
`COOP: same-origin` severs `window.opener` and the D794 popup falls back to
the full-page flow; the hub's own header must not make that worse.

### 5.5 Addon sandboxing — risk 2 × 5 = **10**

Verified: hub-main and every runner run as the same OS user (uid 1001 in the
container, `packages/system/src/kernel/deps/system-package-broker.ts:22`);
D787 states the caller stamp is "identity against bugs, not against a
malicious addon" because any runner can read the master key file. An addon is
therefore fully trusted: it can read `camstack.db`, the key, and every other
addon's data.

Options: (a) a uid per addon runner + 0700 per-addon data dirs, with the key
and DB readable only by hub-main (L — the runners would lose direct DB access
they may rely on); (b) Node's permission model (`--permission`,
`--allow-fs-read`) per runner (M, Node ≥ 22; native addons and `child_process`
need explicit grants); (c) keep the trust model and make it explicit:
signed addon packages from the CamStack registry only, third-party addons
behind an "untrusted code" confirmation. Recommendation: **(c) now, (b)
next**, (a) only if third-party addons become a product.

### 5.6 Logs redaction coverage — risk 2 × 3 = **6**

Verified: the central redactor scrubs registered values ≥ 8 chars, URL
credentials in absolute URLs, `--token`-style flags and credential-named meta
keys (`packages/system/src/logging/log-redactor.ts:26`,
`packages/types/src/keychain/known-secrets.ts:20`). Gaps: inline secrets
(§4) are never registered as known values; relative URLs (`/api/auth/sso/finish?bridge=…`)
are not matched by `URL_IN_TEXT`; `bridge`, `code`, `state`, `link`, `key`
are not credential param names (`packages/types/src/utils/mask-url.ts:12`);
values < 8 chars (PINs) are never scrubbed by design.

Fix (S): extend the param list, match path-relative URLs, register inline
secrets at resolve time, and add a CI canary that logs every secret-typed
fixture value through each logger and asserts absence.

### 5.7 D634 non-admin redaction gaps — risk 2 × 3 = **6**

Verified open:

- Redaction is an **allowlist of method paths**
  (`NON_ADMIN_CONFIG_REDACTED_METHODS`,
  `server/backend/src/api/trpc/device-config-secret-redaction.ts:480`,
  applied at `server/backend/src/api/trpc/trpc.middleware.ts:176`): a new
  `protected` method that returns config is unredacted until someone adds it.
- `settingsStore` does not scope an addon to its own namespace
  (`packages/types/src/capabilities/settings-store.cap.ts:121`): any addon
  can read any collection.
- Some redaction decides by key **name** where no schema is at hand (D634
  round 1 fallback).

Fix (M): invert the default — every non-admin cap output passes the
schema-aware redactor unless the method declares `outputHasNoSecrets: true`,
with a CI check listing methods whose output schema contains a secret-typed
field; enforce the settings-store namespace for addon callers (stamped
`callerAddonId`), with an explicit cross-namespace grant list.

## 6. Ordering and phases

### P1 — urgent (this week)

| # | Item | Effort | Why first |
|---|---|---|---|
| 1 | Mesh containment: drop `repl` from `$core-caps`; refuse unregistered callers; strip `caller` on `$hub-cap-fwd`; challenge–response registration; cluster secret required once an agent is paired; firewall guidance (§1) | S × 6 | LAN → hub code execution today |
| 2 | Client IP behind the tunnel + limiters on every public auth endpoint (§5.2) | S–M | trivial lockout of every remote user; precondition for §3.4 |
| 3 | Single-use SSO bridge + state cookie; mask `bridge=` in logs (§3.1, §5.6 part) | M | replayable credential in URLs |
| 4 | `linkExternalIdentity` hub-internal; rate limit `beginExternalLink` (§3.2, §3.4) | S | closes D782's listed gaps cheaply |
| 5 | Delete `createServiceToken` and the dead `api_key` branch; revoke a deleted user's tokens (§5.1.2, §5.1.3) | S | unused admin mint; a deleted user keeps API access |

### P2 — next (2–6 weeks)

| # | Item | Effort |
|---|---|---|
| 6 | mTLS mesh with hub CA + signed join tokens + per-node least privilege (§1) | L |
| 7 | Session table: revocation, sign-out-everywhere, revoke on password/2FA change, 7 d sliding (§5.1.1) | M |
| 8 | `RESET_KEYCHAIN` trigger file (§2) | S |
| 9 | Backup archive encryption (§4.1) | M |
| 10 | CSRF Origin check + `__Host-` cookie; security headers incl. COOP (§5.3, §5.4) | S + M |
| 11 | Re-authentication before linking and before admin-scoped token creation (§3.3) | M |
| 12 | Addon trust posture made explicit; Node permission model spike (§5.5) | S + M |

### P3 — later

| # | Item | Effort |
|---|---|---|
| 13 | TOTP, notifier targets, LLM profiles, broker connections, JSON blobs, device stores into the keychain (§4.2–4.6) | M each |
| 14 | Library-owned files: backup exclusion + re-pair runbooks, then storage adapters (§4.7) | L |
| 15 | Default-redact for non-admin outputs; settings-store namespace enforcement (§5.7) | M |
| 16 | Admin-capable scoped token, if Q5 says yes (§5.1.4) | S–M |
| 17 | Log-redaction canary in CI (§5.6) | S |

## 7. Top risks, in one place

| Rank | Risk | L × I | Phase |
|---|---|---|---|
| 1 | Unauthenticated mesh: LAN host → `$core-caps` as admin → `repl.execute` in the hub | 4 × 5 = 20 | P1 contain, P2 fix |
| 2 | 30-day sessions with no server-side revocation, usable from the internet via the tunnel | 3 × 4 = 12 | P2 |
| 3 | Addons fully trusted (one OS user, key file readable) | 2 × 5 = 10 | P2 posture |
| 4 | Shared rate-limit bucket behind the tunnel (lockout DoS; no limits on SSO/magic-link starts) | 3 × 3 = 9 | P1 |
| 5 | SSO bridge replayable for 5 min, in URLs, unmasked in logs | 3 × 3 = 9 | P1 |
| 6 | Unencrypted backups carrying pairing state, TOTP seeds and inline secrets off-host | 2 × 4 = 8 | P2 |

## 8. Open questions for the operator

1. **Mesh target: mTLS with a hub CA, or a WireGuard/Tailscale-only mesh?**
   Recommendation: mTLS in-product; Tailscale stays an option for agents
   off-LAN, not the security boundary.
2. **May the P1 containment refuse agents until a cluster secret is set?**
   Every existing agent then needs the secret entered once.
   Recommendation: yes, with a one-release warning period and a banner.
3. **Turn UDP discovery off on the hub?** Agents would need an explicit hub
   address (the join token can carry it). Recommendation: yes, with P2.
4. **Lost-key recovery: trigger file or host CLI?** Recommendation: trigger
   file, containing the typed confirmation, acting only on a locked keychain.
5. **Do ops scripts get an admin-capable scoped token?** Recommendation: yes,
   explicit `admin` scope, ≤ 90-day expiry, re-auth to create, audited per use.
6. **Default session lifetime 30 d → 7 d sliding, once revocation exists?**
   The viewer app would refresh silently. Recommendation: yes.
7. **Backup encryption key: the keychain data key, or a separate backup key
   the operator downloads?** Recommendation: separate key, included in the
   recovery download — a restore onto a fresh hub must not depend on the old
   hub's master key.
8. **Third-party addons: allow with an "untrusted code" confirmation, or
   registry-signed only?** Recommendation: registry-signed by default, an
   explicit per-addon override for developers.
