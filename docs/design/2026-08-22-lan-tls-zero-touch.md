---
title: Valid TLS on the LAN without the user doing anything — options, evidence, and a staged plan
covers:
  - packages/system/src/tls/**
---

# Valid TLS on the LAN, zero-touch

> **Status: DESIGN, except Phase 0 which shipped on 2026-08-22** ([D227](../decisions/adr-0227-the-hub-reissues-its-certificate-only-when-it-cannot-do-its-job.md)).
> Phases 1-3 are unimplemented and none of the infrastructure in §4 exists.
> The operator's request,
> verbatim: *"Intendo automatizzare lato server, un user installa server ed
> applicazione e generiamo certificati che poi l'applicazione auto installa,
> meccanismi simili."* [I mean automating on the server side: a user installs the server and the application and we generate certificates that the application then installs automatically, similar mechanisms.] A user installs CamStack and the app; the **local**
> connection is valid TLS with **no certificate to install, no warning to
> accept, and no domain of their own**.
>
> This is a product question, not an implementation of one. It ends with a plan
> and with five questions the code cannot answer.

---

## 0. The three things that decide everything

Read these first; the rest of the document is their consequences.

**(1) The current certificate is malformed in a way that pinning does not fix.**
Measured against the live hub on 2026-08-22:

```
subject = issuer = CN=camstack.local        RSA 2048 / sha256
NotBefore 2026-06-28   NotAfter 2028-09-30   → 825 days exactly
SAN: DNS:localhost, DNS:camstack.local, DNS:<hostname>,
     IP:127.0.0.1, IP:::1, IP:<hub-ip>, + 2 IPv6, + fe80::/10
BasicConstraints critical CA:TRUE
extendedKeyUsage:  ABSENT
```

The SANs are right — the operator's diagnosis was correct as far as it went. But
Apple's `trustd` requires `id-kp-serverAuth` in the leaf EKU **for app-supplied
trust anchors**, with a carve-out only for `kSecUserAnchorSource` (a profile the
human installed by hand). Apple ships the regression test for exactly our
topology — cert list `[leaf]`, anchors `[leaf]`, via `SecTrustSetAnchorCertificates`:
`testAppTrustLeaf_MissingEKU_AfterJul2019` asserts **failure**, while
`testUserTrustLeaf_MissingEKU_AfterJul2019` asserts success.

So: **an app that pins this certificate today still gets a rejected handshake on
iOS.** Family 1 as described in the brief cannot work at all until
`packages/system/src/tls/cert-manager.ts` emits a compliant leaf. Nobody would
have found this by reading the pinning code — it would have looked like a
pinning bug forever. The 825 days are separately at Apple's "other anchors"
ceiling with **one hour of margin** (`SecPolicyCheckOtherTrustValidityPeriod`,
825 days + 3600 s slip).

**(2) Off the LAN, valid TLS already works.** The Cloudflare tunnel
(`packages/addon-cloudflare/src/tunnel/`) and the Tailscale mesh provider
(`packages/addon-tailscale/`, surfaced through `mesh-network` and already
consumed by `packages/system/src/builtins/local-network/local-network.addon.ts`)
both terminate a publicly-valid certificate. The problem is **exclusively** "the
phone is on the same WiFi as the hub and we want the fast path". Every option
below is judged only on that.

**(3) One choice removes the LAN IP from the certificate entirely.** If the
name is `192-168-1-9.<hash>.camstack.direct` and the certificate is the wildcard
`*.<hash>.camstack.direct`, then the address lives in a label the wildcard
covers. The IP never appears in the certificate, never reaches Certificate
Transparency, and **a DHCP move needs no reissuance**. This is the plex.direct
trick and it is what makes the public-CA family cheap to operate rather than
ruinous.

---

## 1. The four surfaces, and what actually terminates TLS

The brief asks for coverage per surface. The surfaces are not four, they are
nine — this is the number that decides between the two families.

| # | Surface | Stack that validates the certificate | Runtime trust override? |
| --- | --- | --- | --- |
| 1a | RN `fetch` → tRPC HTTP, `/health` race | iOS `NSURLSession` (RCTNetworking) · Android OkHttp via `OkHttpClientProvider` | yes, both |
| 1b | RN `WebSocket` → `wss://…/trpc` (the primary control plane) | iOS `NSURLSession` · Android **`WebSocketModule`, a separate OkHttp client** | yes, but a **second** install point on Android |
| 1c | `expo-image` (event media, artifacts, track crops — straight to hub `https://`) | iOS SDWebImage session · Android Glide/OkHttp | separate integration, both platforms |
| 1d | `expo-file-system` (snapshot file cache, exports) | its own native client | separate integration |
| 1e | `react-native-video` (artifact playback) | iOS **AVPlayer / AVURLAsset** · Android ExoPlayer `HttpDataSource` | AVPlayer is the hostile one — needs an `AVAssetResourceLoaderDelegate` shim |
| 2 | WebView embed (`camstack/src/live/LiveViewWebView.tsx` and the grid/events embeds — page is a local `file://` asset, but `createSystem()` inside it opens its own `wss://` + `https://` to the hub) | WKWebView (WebKit NetworkProcess) · Android WebView (Chromium → Conscrypt) | iOS **yes**; Android **no — see below** |
| 3 | Desktop browser / hub-served web viewer | Safari, Chrome, Firefox | **never** |
| 4a | WebRTC media (DTLS-SRTP) | nothing — self-signed by design, fingerprint in SDP | n/a, indifferent |
| 4b | WebRTC **signalling** (`turnProvider.getTurnServers`, `intercom.startSession`) | rides 1b / 2 | inherits |

Three findings inside that table matter more than the table:

- **WKWebView is not the blocker it is assumed to be.** `WKNavigationDelegate.webView(_:didReceive:completionHandler:)` receives server-trust challenges for **subresources**, not only main-frame navigation — `NetworkLoad.cpp` exempts TLS handshakes from the suppression gate (`!isTLSHandshake`), routing is page-scoped rather than frame-scoped, and WebKit's own `TLSDeprecation.mm` proves it for an `<iframe>`, a `fetch()`, and a WebSocket. Accepting `.useCredential` is taken verbatim — WebKit does not re-evaluate. The comment in `LiveViewWebView.tsx` that says the embed cannot be made to work is **too pessimistic** on iOS.
- **Android WebView is the blocker instead.** `network_security_config.xml` accepts only a build-time raw resource — there is no runtime API, and `KeyChain` refuses programmatic CA install since Android 11. A certificate the app learns at pairing time **cannot** become a WebView trust anchor. The only lever is `onReceivedSslError` + conditional `proceed()`, which is Google's own prescribed remediation but sits inside an active App Security Improvement campaign (support.google.com/faqs/answer/7071387) whose sanction escalates to blocked updates.
- **On Android, a self-signed cert placed in a KeyStore as an anchor makes Conscrypt skip validation entirely** — `TrustManagerImpl` short-circuits with *"The chain consists of only trust anchors, skip the validator"*, dropping even the expiry check. Anything we build must present a **CA → leaf** pair, not a self-signed leaf, or our only validation on Android is a code path that validates nothing.

---

## 2. Census of automatable options

Zero taps means zero taps. "The user pastes a fingerprint" is not zero.
One caveat applies to **every** row that uses the LAN and is stated once here:
iOS Local Network Privacy (TN3179) prompts on the first TCP connection to a
private address regardless of the certificate, and
`NSLocalNetworkUsageDescription` is **absent from `camstack/app.config.ts`
today**. That prompt is unavoidable and is not counted below.

| # | Option | 1 native | 2 WebView | 3 browser | User must | Project must | Offline |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Status quo self-signed | ✗ | ✗ | ✗ (warning) | — | — | works |
| B | Self-signed + app-decided trust (TOFU / pinning) | ✓ | iOS ✓ / Android ✗ | ✗ | nothing | ship ~9 native integrations | works |
| C | Local CA + guided manual install | ✓ | ✓ | ✓ | ~10-12 taps across 3 Settings screens (iOS), Settings walk (Android 11+) | docs | works |
| D | **Public name → private IP, project wildcard** | ✓ | ✓ | ✓ | **nothing** | domain + DNS + ACME broker, forever | **fails** |
| E | ACME DNS-01 on the *user's own* domain | ✓ | ✓ | ✓ | own a domain, paste an API token | an addon | fails |
| F | Tailscale / mesh (**already built**) | ✓ | ✓ | tailnet only | install Tailscale, sign in, accept VPN profile | nothing | fails |
| G | Always use the tunnel (**already built**) | ✓ | ✓ | ✓ | nothing | tunnel cost / video over Cloudflare | fails |
| H | mDNS `.local` + TLS | ✗ | ✗ | ✗ | — | — | — |
| I | Plain HTTP on the LAN | ✓ | partial | ✓ but no secure context | nothing | nothing | works |
| J | WebTransport `serverCertificateHashes` | ✗ (no RN support) | ✓ | ✓ | nothing | 14-day rotation | works |

Notes that the table cannot carry:

- **C is dead on arrival for a consumer product, and it is dead for a structural
  reason.** Apple: *"If you manually install a profile that contains a certificate
  payload… that certificate isn't automatically trusted for SSL… You must
  manually turn on trust"* (support.apple.com/en-us/102390). Automatic trust
  exists **only** via Configurator or MDM — i.e. enrolling the user's personal
  phone. This is the constraint that kills every "just install our CA" idea, and
  it is why it is listed and rejected rather than omitted.
- **H is impossible, not merely hard.** `.local` is an Internal Name under
  CA/Browser Forum BR §1.6.1 and issuance is banned by §4.2.2. No public CA will
  ever sign it. Same verdict for the `.internal` gTLD that ICANN permanently
  reserved in 2024 — permanently un-delegatable means permanently unvalidatable.
  Both are usable only with a private CA, which returns to C.
- **A certificate for a bare IP is also impossible here.** iOS and Android both
  honour `iPAddress` SANs correctly (Apple's `testIPAddressInSAN_Match` passes),
  but BR §7.1.4.2.1 forbids Reserved IP addresses, and Let's Encrypt's 2025 IP
  certificates are public IPs only, ~6-day, `http-01`/`tls-alpn-01` only. Every
  one of those three disqualifies a LAN address.
- **J is real but not applicable.** Safari 26.4 shipped WebTransport, so
  `serverCertificateHashes` is finally cross-browser; it lets a page reach a
  self-signed origin by SHA-256 with no CA, ≤14-day validity, ECDSA P-256 only.
  There is **no WebTransport in the React Native JS runtime**, and it is a data
  transport — it does not serve the origin, the tRPC API, or the images. Park it.
- **F and G already exist in this repo and already work.** The honest statement
  of today's product is: a user who installs Tailscale, or who runs the tunnel,
  has valid TLS on all surfaces. Neither is zero-touch, and F degrades silently
  to a bandwidth-limited DERP relay when NAT traversal fails — a catastrophic
  failure mode for video that is invisible in the UI.
- **IETF SETTLE** ("secure access to TLS local resources") is the standards
  answer to exactly this problem. It is **not yet chartered**, its document list
  is empty, and every feeder draft has expired. Do not architect around it.

---

## 3. Family 1 — trust decided by the app

### 3.1 What it would cost

Not "a native module". Per §1: on iOS, `NSURLSession` (covers 1a/1b), SDWebImage,
`expo-file-system`, an `AVAssetResourceLoaderDelegate` shim for AVPlayer, and the
`WKNavigationDelegate`. On Android, `OkHttpClientProvider`, **plus**
`WebSocketModule.setCustomClientBuilder` because RN's WebSocket bypasses the
provider entirely, plus Glide, plus `HttpDataSource`, plus an
`onReceivedSslError` handler for the WebView because NSC cannot take a runtime
anchor. Nine integration points, two of them hostile, one of them carrying Play
Store policy exposure.

And it ships as a **native build**: a store release on both platforms, users must
update, no OTA. Compare §4.3.

### 3.2 What it would still not cover

The desktop browser. Ever. No amount of app-side work reaches surface 3, and the
hub serves the web viewer and the iframe embed from `/viewer/…`. This is the
asymmetry the brief already identified and it is correct.

### 3.3 The ways it goes wrong, concretely

- **TOFU over the wrong channel.** If the fingerprint is learned on the first
  HTTPS connection to the LAN IP, an attacker present on that LAN at pairing time
  owns every later session, permanently, silently. The provisioning channel must
  be one that is *already* authenticated. This repo has one:
  `server/backend/src/core/auth/handoff-code.service.ts` — a one-time 60-second
  code redeemed through `auth.redeemHandoffCode`, obtained through a browser
  session. That, or the tunnel, or a QR from the admin UI. **Never the LAN
  itself.**
- **Pinning the leaf bricks the install.** Rotate the certificate — or reinstall
  the server, or lose the disk — and every paired client refuses the only route
  it has. Recovery requires re-pairing, which requires the LAN, which is pinned.
  Mitigation: pin a long-lived **CA**, rotate a short leaf beneath it, and hold
  open one unpinned recovery route (the tunnel) at all times.
- **Silent over-trust.** Per §1, on Android a self-signed leaf that is its own
  anchor makes Conscrypt skip the validator entirely. A pinning layer that
  "works" in that configuration is validating nothing at all, including expiry —
  and a green test suite would say it works. If we build this, the test must
  remove the anchor and confirm the connection fails.

### 3.4 Verdict

Family 1 is a **fallback, not the answer**. It is genuinely sound on iOS
including WKWebView, which is better than this repo currently assumes, and it is
the only thing that works with no internet. But nine native integration points,
a store release, an Android WebView hole, Play policy exposure, and a permanently
broken desktop browser is a large debt for a partial result.

---

## 4. Family 2 — a public name that encodes the private address

### 4.1 The shape

```
name    192-168-1-9.<hash>.camstack.direct      A → <hub-ip>
cert    *.<hash>.camstack.direct                 issued by a public CA
```

`<hash>` is a high-entropy random per install, generated once, never derived from
an account, email or serial. The wildcard covers one label, so it covers **every**
LAN address the hub will ever have, plus stable aliases (`wan.<hash>…` for the
tunnel) — all under one certificate, with no reissuance when DHCP moves.

Why this is legal, since it is the question everyone asks: the CA/B prohibition
binds the **name in the certificate**, never what DNS answers. BR §1.6.1 defines
an Internal Name as one that *"does not end with a Top-Level Domain registered in
IANA's Root Zone Database"*. `…​.camstack.direct` ends in a real TLD, is globally
unique, and validates under §3.2.2.4. There is no requirement anywhere in the BRs
conditioned on the resolved address. Let's Encrypt documents DNS-01 as the method
*"to validate domain names whose webservers aren't exposed to the public
internet"*. Plex, Synology and QNAP all ship this at scale.

### 4.2 What the project must run

Three pieces, and only three:

1. **A registered domain.** Note that `zentik.app` is already ours and already on
   Cloudflare NS. **Use a different, dedicated domain anyway** — see §4.4; the
   certificate budget is per *registered domain* and would otherwise be shared
   with the central-link redirector (`docs/design/2026-08-19-central-link-redirect.md`)
   and the tunnel hostnames.
2. **An authoritative nameserver for a delegated subzone**, doing two jobs:
   decode `192-168-1-9` → an A record (stateless; this is what `sslip.io`,
   Apache-2.0, already is), and serve dynamic `_acme-challenge.<hash>` TXT
   records (this is what `acme-dns`, MIT, already is). Both are small and both
   exist. A per-install credential scopes writes to that install's own record, so
   a compromised appliance can rewrite only its own challenge.
   *Unverified:* whether `sslip.io` decodes an IP label when a `<hash>` label
   follows it. Confirm before committing to reuse rather than reimplement.
3. **Nothing else.** No relay, no bandwidth, no media path. This is the whole
   difference from a vendor relay (`snitun`), where every byte transits the
   vendor.

### 4.3 What the hub does — and the deployment property that makes this cheap

The hub generates its **own keypair**, builds a CSR, runs ACME itself
(`acme-client`, MIT, pure JS) and writes the result where boot already
serves a non-generated certificate: `<dataDir>/tls` under the `uploaded` mode
marker, the same files the admin UI upload writes (the
`CAMSTACK_TLS_CERT`/`CAMSTACK_TLS_KEY` branch this originally named was removed
by D726). Renewal
is the hub's, coordinated by ARI. The private key never leaves the appliance and
the project never holds it.

Then `local-network.getConnectionEndpoints` advertises
`https://192-168-1-9.<hash>.camstack.direct:4443` as the LAN candidate, and:

> **The viewer needs no change.** `camstack/src/connection/endpoint-discovery.ts`
> and `candidate-probe.ts` race whatever the hub hands them. A named LAN endpoint
> is just a different string. **No native module, no store release, no OTA** —
> the fix ships entirely inside a server update.

That property is the single strongest argument for D over B, and it is worth more
than the table in §2. (It composes with, and depends on, the separate port fix
recorded in `docs/decisions/adr-0226-the-hub-declares-the-port-it-listens-on.md`
— a LAN candidate born with the wrong port cannot win regardless of its
certificate.)

### 4.4 The wall: issuance rate, not policy

Let's Encrypt: **50 new certificates per registered domain per 7 days**, global
across all accounts. Renewals coordinated by ARI are **exempt from all rate
limits**, and our identifier set is stable forever, so renewals are a non-event.
**Onboarding is not**: 50/week is ~7 signups/day, a hard ceiling.

This is not theoretical. Plex has been failing issuance with
`HTTP 429 / code="1003"` since November 2025, still unresolved in August 2026,
requiring manual per-server resets by staff. It is the most important cautionary
data point in this document.

Three ways through, in order of preference:

1. **Google Trust Services.** Free, EAB via `gcloud publicca external-account-keys create`,
   `newOrder` quota **100/hour** ≈ 16,800/week, no documented per-registered-domain
   cap — roughly 336× the headroom. Roots are in both Apple's and Chrome's stores.
   Mint a single-use EAB per install at pairing; the hub then owns its ACME
   account and renews independently forever. *Unverified: undocumented per-domain
   caps, and the commercial terms of depending on a free Google service at scale.
   Get this in writing before building.*
2. **Let's Encrypt rate-limit override** (isrg.formstack.com). The intended path.
   Apply **before** building, not after.
3. **Public Suffix List entry.** Mechanically effective — Boulder counts the PSL
   private section — and it is why `synology.me`, `duckdns.org`, `ui.nabu.casa`
   and `ts.net` are all listed. But the PSL guidelines state *"We do not accept
   entries whose sole purpose is to circumvent rate limits of third parties"*,
   require >2 years registration and a `_psl` record, and offer no SLA on
   timing. Treat as a slow third option with a genuine origin-isolation argument,
   not a shortcut.

Also size for the future, now: BR §6.3.2 caps validity at **200 days today**, 100
from March 2027, and **47 days with a 10-day domain-validation reuse window from
March 2029**. At 10,000 installs that is ~78,000 DNS-01 challenges a year, ~213 a
day, forever. Design the TXT service for that number.

### 4.5 The private key must be generated per install. This is not negotiable.

A shared wildcard with a distributed private key is permitted on paper and
catastrophic in practice: BR §6.1.2 obliges a CA to revoke **all** certificates
on learning the key reached an unauthorised person, on a 24-hour clock — blast
radius 100% of installs, triggered by any one user pasting a file into a repo.
Two real precedents: sslip.io (2015, revoked) and localhost.direct (GlobalSign,
October 2024). localhost.direct's own README now warns that the CA scans for
leaked keys and advises users back to self-signed.

### 4.6 The real security and privacy costs

- **The name discloses the private IP** to anyone who learns the name — and the
  name travels: notification attachment links, shared URLs, screenshots. The
  wildcard keeps it out of CT, but not out of a link.
- **Certificate Transparency publishes a census.** Install count, growth rate,
  install timestamps, and a real-time feed of every new install, permanently and
  undeletably, queryable by anyone at `crt.sh`. The per-install wildcard hides
  the IP and nothing else. **The `<hash>` is public, not a secret** — it must
  never be used as a bearer token anywhere.
- **The project becomes load-bearing for local operation.** If the domain lapses,
  or the DNS/ACME broker stops, every install's LAN TLS expires within one
  certificate lifetime — 200 days today, **47 days from 2029**. A local NVR that
  stops working locally because a company stopped paying a registrar bill is a
  serious product commitment, and it is the question in §7 the operator most
  needs to answer deliberately.
- **Offline is a genuine gap.** No internet means no issuance, no renewal, and no
  DNS resolution of the name. The two fail together, which is at least simple.
  An air-gapped install is a legitimate NVR deployment and this family does not
  serve it. See §6 Phase 3.

---

## 5. Recommendation

**Family 2 (option D), with option B narrowed to an offline fallback and
deliberately deferred.**

The reasoning, in order of weight:

1. **It is the only option that covers all three real surfaces with zero taps.**
   The desktop browser cannot be reached from inside an app, and the hub serves a
   web viewer.
2. **It ships without an app release** (§4.3). B needs a store build on two
   platforms and a user update; D needs a server update.
3. **Its cost is ~1.5 small services and a domain**, not nine native integration
   points across two OSes, one of which (Android WebView) has no clean solution
   and one of which (AVPlayer) is genuinely unpleasant.
4. **The prerequisites are already in the building.** A domain on programmable
   DNS, a working Cloudflare DNS API client with `createDnsRecord` /
   `findDnsRecord` / `updateDnsRecord` in `packages/addon-cloudflare/src/tunnel/cloudflare-api.ts`,
   an authenticated pairing channel in `handoff-code.service.ts`, an endpoint
   advertisement surface in `local-network.cap.ts`, and a cert-loading branch in
   `boot-config.ts`.
5. **Its failure modes are operational and visible** (a 429, an expired cert, a
   dead broker) rather than silent and security-relevant (a fingerprint learned
   from an attacker, a trust manager that validates nothing).

What is **not** recommended, explicitly: shipping B first "because it is
self-contained". It is the larger build, it produces the smaller result, and
every line of it is native code that must then be maintained through two OS
release cycles a year.

---

## 6. Plan

### Phase 0 — fix the certificate we already generate — **SHIPPED 2026-08-22**

Implemented as described below, in `packages/system/src/tls/`. The regeneration
rule turned out to need a record of its own — the naive "SAN set differs"
version reissues on every boot on any host with docker or SLAAC privacy
addresses. See [D227](../decisions/adr-0227-the-hub-reissues-its-certificate-only-when-it-cannot-do-its-job.md).
RSA-2048 was kept; ECDSA P-256 remains available and unclaimed.


Highest value per unit of debt in the whole document: it is a precondition for
B, for C, and for any manual-trust workaround an operator uses today, and it is
one file.

In `packages/system/src/tls/cert-manager.ts`:

- **Add `extendedKeyUsage = serverAuth`.** Not `anyExtendedKeyUsage` — Apple's
  `testAppTrustRoot_AnyEKU_AfterJul2019` asserts failure for that.
- **Emit a CA → leaf pair, not a self-signed leaf.** Avoids Conscrypt's
  skip-the-validator short-circuit and Chromium's leaf-anchor demotion path, and
  lets a leaf rotate without re-provisioning an anchor.
- **Leaf validity 397 days**, not 825. We are currently one hour inside Apple's
  ceiling.
- **Drop the `fe80::/10` SANs.** A link-local address needs a zone index that
  cannot be encoded in a SAN, so those entries can never match anything.
- **Regenerate on SAN drift, not only on expiry.** Today the function returns
  early whenever an unexpired cert exists — so a hub that moves under DHCP keeps
  a certificate that no longer names its address, and even a manually trusted CA
  stops working. This is a live bug independent of everything else here.
- Keep RSA-2048 or move to ECDSA P-256; both are accepted by all three
  validators, P-256 is cheaper.

Also, in the viewer (**owned by the viewer track — noted, not claimed**):
`NSLocalNetworkUsageDescription` is absent from `camstack/app.config.ts`, and
TN3179 warns that a local-network operation attempted **in the background with
undetermined permission is denied without showing the alert** — a plausible
failure mode for a reconnect on wake.

### Phase 1 — the named LAN endpoint (the phase that delivers the benefit)

1. **Settle the CA question before writing code** (§4.4, §7 Q2). GTS quota
   confirmation or an LE override, in writing. This gates everything.
2. Register a **dedicated** domain; delegate a subzone to a nameserver that
   decodes IP labels and serves per-install `_acme-challenge` TXT. Per-install
   credential, scoped to one record.
3. A hub addon that: generates a keypair, enrolls once over the **already
   authenticated** pairing channel to obtain `<hash>` + an EAB, runs ACME with
   `acme-client`, writes cert+key, renews on ARI, and reloads the listener. It
   holds no DNS credentials and no project secrets beyond its own scoped one.
4. `local-network` advertises the named LAN candidate ahead of the raw-IP one,
   with a distinct `label`, and keeps the raw-IP candidate as a lower-priority
   fallback. **No viewer change.**
5. Guard: a check that fails the build if `getConnectionEndpoints` can emit a
   named endpoint whose certificate does not cover it. Prefer a guard to a
   paragraph.

Log-line obligation, since this is a per-install diagnosis surface: every line
about issuance, renewal and endpoint selection carries the install `<hash>` and,
where a device is involved, `tags: { deviceId }`. A renewal that silently does
not happen must produce a line.

### Phase 2 — the operator who has a domain, and the reinstall story

- Option E as a first-class alternative: DNS-01 against the user's own zone. The
  Cloudflare API client already exists; the tunnel addon's `custom` mode already
  models "operator supplies token + zone". Strictly better than D for the users
  who can use it: no project dependency, no CT census, no shared budget.
- Reinstall / disk loss: the hub must be able to re-enroll and obtain a **new**
  `<hash>` without the old one, and clients must follow it — which they do for
  free, because they resolve endpoints from the hub rather than remembering a
  fingerprint. This is another quiet advantage of D over B.

### Phase 3 — offline, and only if measured

Only after Phases 0-2 are live and we know how many installs are actually
internet-less. If it is worth doing, the narrow version is: the trust override
for **1a and 1b only** (the tRPC control plane), anchored on the Phase-0 CA,
provisioned over the handoff channel. That keeps the control plane and WebRTC
media alive (4a is indifferent to all of this) while `expo-image`, video and the
WebView degrade. That is a defensible degraded mode; nine integration points to
make degraded mode pixel-perfect is not.

Do not start here. B first would be the expensive way to arrive at a partial
answer.

---

## 7. Questions for the operator

Five choices the code cannot make. Each carries a recommendation.

**Q1 — Is the project willing to run infrastructure that local operation depends
on, permanently?** A domain, a nameserver, and a certificate broker. If they
lapse, every install's LAN TLS expires within one certificate lifetime (200 days
today, 47 from 2029) and the product stops working *on the user's own network*.
*Recommendation: yes, and say so publicly, with option E (§Phase 2) as the
documented escape hatch for users who prefer not to depend on us. If the answer
is no, the honest product answer is F/G — Tailscale or the tunnel — and this
document ends here.*

**Q2 — Let's Encrypt or Google Trust Services?** LE is the default everyone
knows and is capped at ~7 new installs per day per domain; Plex is visibly stuck
against exactly this wall right now. GTS is free with ~336× the headroom and
makes us dependent on an undocumented Google quota. *Recommendation: GTS as
primary with LE as fallback, but only after obtaining the quota position in
writing — and file the LE override request in parallel, because it costs nothing
and takes weeks.*

**Q3 — Is publishing an install census acceptable?** Certificate Transparency
makes install count, growth rate and a real-time new-install feed permanently
public. The per-install wildcard hides the LAN IP; it hides nothing else.
*Recommendation: accept it. Every competitor in this category (Plex, Synology,
QNAP, Home Assistant) already lives with it, and the alternative — a private CA —
costs the user ten taps and the desktop browser.*

**Q4 — What is the web viewer worth relative to the app?** If the answer is
"very little", Family B becomes defensible and the plan changes shape. If the
hub-served web viewer and the iframe embed are part of the product, only D
serves them. *Recommendation: treat the browser as first-class — it is the
surface with the lowest install friction and the one an operator uses to set the
system up in the first place.*

**Q5 — Should the LAN-only, internet-less install be supported at all?** It is a
legitimate NVR deployment and D does not serve it. Supporting it properly means
Phase 3, ~2-3 native integration points, and a permanently second-class path.
*Recommendation: defer, and instrument first — Phase 1 can report how many hubs
ever fail to reach the ACME endpoint. Decide with that number, not before.*

---

## References

Evidence for the platform claims above was gathered from Apple's
`apple-oss-distributions/Security` sources and `TrustTests`, WebKit's
`NetworkLoad.cpp` / `NetworkSessionCocoa.mm` / `TLSDeprecation.mm`, Conscrypt's
`TrustManagerImpl`, Chromium's `net/cert` and `android_webview`, BoringSSL's
`pki/`, the CA/Browser Forum Baseline Requirements v2.2.9, Apple support articles
102028 / 102390 / 103769 / 103214, Apple TN2232 and TN3179, Google Play support
article 7071387, and Let's Encrypt's rate-limit and challenge-type
documentation, on 2026-08-22. Items this document could not confirm are marked
*Unverified* inline; they are §4.2 (sslip.io label handling) and §4.4 (GTS
undocumented caps and commercial terms).
