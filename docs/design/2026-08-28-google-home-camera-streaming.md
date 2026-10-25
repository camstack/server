---
title: Can camstack cameras reach Google Home as live video? — CameraStream/WebRTC assessment
date: 2026-08-28
last-verified: 2026-08-28
status: assessed; NOT started. Verdict (b) — reachable, gated on the rendering surface
covers:
  - packages/addon-export-google/src/**
---

# Google Home camera streaming — what is true today

> The operator's question: *"Pare che Google abbia aggiunto supporto a WebRTC,
> invia un agente per analizzare lo stato corrente."* [It seems Google has added WebRTC support, send an agent to analyse the current state.]

**Short answer: Google did not add it — it has been there since 2021.** What
Google added recently is something else entirely (the Home APIs `WebRtcLiveView`
trait, §1.3), and that one is a *reader* API that cannot help us. The path that
can help us, cloud-to-cloud `CameraStream` with `cameraStreamProtocol: "webrtc"`,
predates this addon by four years and nothing about it changed.

Every external claim below was fetched from Google's own developer
documentation on 2026-08-28. Page dates are given because several of these pages
are years apart in freshness and it matters which.

---

## The verdict

**(b) — Reachable, but blocked on a specific gate.**

The gate is **not** certification, and **not** test mode. It is the **rendering
surface**:

> "WebRTC is currently supported on the Google Nest Smart Display and Chromecast
> with Google TV devices."
> — CameraStream trait reference, last updated **2026-06-09**

A cloud-to-cloud camera streamed over WebRTC plays on a **Nest smart display**
or a **Chromecast with Google TV**. It does **not** play in the Google Home app
on a phone. So:

- If the operator owns a Nest Hub / Nest Hub Max / Chromecast with Google TV →
  this is buildable now, test mode is sufficient, and §4 is the shape.
- If the goal is "my cameras in the Google Home app on my phone" → WebRTC does
  not deliver that, and the protocols that might (`hls`, `progressive_mp4`)
  require a packager camstack does not have (§3.5). That variant is **(c)**.

**This is a hardware question about the operator's house, and it decides
everything downstream. It must be answered before any code is planned.**

What is explicitly *not* the gate:

- **Test mode is fine.** No page in Google's cloud-to-cloud documentation gates
  `CameraStream`, cameras, or WebRTC behind certification, publishing, or an
  allowlist. The camera device-type guide (last updated **2026-08-12**) contains
  no certification or allowlisting language at all. Google's own
  "Implement CameraStream with WebRTC" codelab is performed end-to-end on an
  **unpublished** project against the developer's own Nest display — which is
  exactly our situation.
- **Certification is where cameras get hard, and we were never going there.**
  The Test Suite documentation (last updated **2022-07-13**) states that for
  `CameraStream`, `Locator`, `RunCycle` and command-only traits, *"we may
  require you to ship your smart home device to Google for manual testing"*, and
  that Test Suite results must pass 100% before submitting for certification.
  A self-hosted hub cannot ship itself to Google. But D269 already established
  that this integration lives in test mode permanently, so this requirement
  binds nothing new.

---

## 1. What Google actually supports, and under which programme

Three separate programmes get conflated. They are not interchangeable and only
the first is a path for camstack.

### 1.1 Cloud-to-cloud smart home — `CameraStream` trait — **this is our path**

The trait `action.devices.traits.CameraStream` on device type
`action.devices.types.CAMERA`. This is the same fulfillment endpoint the addon
already serves.

- Source: CameraStream trait reference, **last updated 2026-06-09**.
- `cameraStreamSupportedProtocols` accepted values: **`hls`, `dash`,
  `smooth_stream`, `progressive_mp4`, `webrtc`**.
- WebRTC is a first-class member of that list, with a dedicated section of the
  trait page and a dedicated response shape.
- Release notes carry only two camera entries ever: **2023-05-08** ("Implement
  CameraStream with WebRTC codelab published") and **2025-04-08** ("Updated
  security guidance for camera streaming OAuth tokens" — `cameraStreamAuthToken`
  mandatory when `cameraStreamNeedAuthToken` is true, and the token must be
  scoped to just the target device). **Nothing in 2026.**
- Google's WebRTC Validator Tool page is **last updated 2021-11-01**.

So the operator's premise — "Google added WebRTC support" — is **not supported by
the evidence**. WebRTC in cloud-to-cloud CameraStream is old and static. What is
new is §1.3, which is a different thing wearing a similar name.

Also relevant, quoted from the trait page: *"CameraStream is not currently
supported by local fulfillment."* Every stream request therefore round-trips
through Google's cloud to the hub's public fulfillment URL.

### 1.2 Nest / Smart Device Management (SDM) — **not a path**

`sdm.devices.traits.CameraLiveStream`, protocols `RTSP` and `WEB_RTC`, commands
`GenerateRtspStream` / `ExtendRtspStream` / `GenerateWebRtcStream`. Source: SDM
trait reference, **last updated 2026-06-29**.

This is an API for **reading** streams out of **Google/Nest-manufactured
hardware** (Nest Cam, Nest Hub Max, Nest Doorbell). There is no provision for a
third party to publish a camera *into* it. It is the wrong direction. Ignore it.

Two details worth stealing conceptually anyway: the client provides the SDP
offer, and the returned `answerSdp` *"must be used to generate the live stream
within 30 seconds of receiving the response"*.

### 1.3 Google Home APIs (Android/iOS SDK) — **the likely source of the rumour, and not a path**

This is almost certainly what the operator heard about. Camera device pages,
**last updated 2026-07-07**, list a `WebRtcLiveView` trait that *"controls
livestreams and two-way talkback"*, alongside `PushAvStreamTransport`,
`CameraSnapshot`, `CameraAvStreamManagement` and others. Release notes:

- **2025-09-26** (Public Beta 1.5.0) — *"Camera device type added to Device API
  (Livestream, Two-way talk, Start/stop recording)"*
- **2026-04-09**, **2026-05-29**, **2026-06-26** — successive camera/doorbell
  feature additions
- **2026-08-03** / **2026-08-28** — GA releases 1.10 and 1.10.1

Why it does not help:

1. It is a **consumer** SDK. An Android/iOS app uses it to view cameras that are
   *already in the user's Home graph*. It is not a mechanism for a third-party
   cloud to *publish* a camera.
2. The camera page states plainly: *"These traits are restricted and not
   available for general use."*
3. Access requires app registration and approval in the Developer Console for
   the device types you want to reach.

So: a genuinely new Google camera capability shipped in the last year, it is
real, and it is on the wrong side of the wire for us.

### 1.4 Matter cameras — **not a path today**

Google's Matter supported-devices page lists no camera device type and states
*"Device types other than the ones listed here are not officially supported in
the Google Home ecosystem."* **That page is last updated 2024-12-20** — it is
stale by twenty months and should not be treated as a current statement about
Matter's own spec. What it does establish is that Google has published no
commitment to Matter cameras. See §6.

---

## 2. What the protocol demands

All of this is from the CameraStream trait reference (**2026-06-09**) unless
noted. Field names are quoted exactly.

### 2.1 SYNC — what we would declare

```
type:   action.devices.types.CAMERA
traits: [ action.devices.traits.CameraStream ]
attributes:
  cameraStreamSupportedProtocols: ["webrtc"]
  cameraStreamNeedAuthToken:      true
```

Only two attributes are documented on that page.

**Order in `cameraStreamSupportedProtocols` is significant**, and the trait page
says so explicitly: *"The first protocol in this array that is compatible with
the target surface is requested."* Declaring `["webrtc"]` alone is therefore not
merely the minimum — it is the only declaration that cannot be silently
downgraded to a protocol we do not implement. If a second protocol is ever
added, it goes *after* `webrtc`, never before.

**`cameraStreamSupportsPreview` is not part of the contract — do not send it.**
Re-checked 2026-08-28 against both live pages: the key occurs **zero** times on
the CameraStream trait reference (2026-06-09) and **zero** times on the camera
device-type guide (2026-08-12). It appears once in the prose of Google's WebRTC
codelab, and — decisively — Google's own completed sample source for that same
codelab omits it, declaring only `cameraStreamSupportedProtocols` and
`cameraStreamNeedAuthToken`. So Google's own reference implementation does not
send the key its own tutorial text sets, and the integration works. Unknown SYNC
attributes are ignored; sending it buys nothing and asserts a capability whose
semantics are undocumented. *Confidence: high that it is not required; its
meaning remains unknown, which is now a fact about Google's docs rather than an
open question for us.*

### 2.2 EXECUTE — `action.devices.commands.GetCameraStream`

Params Google sends: `StreamToChromecast` (boolean), `SupportedStreamProtocols`
(array — the destination surface's own capability list).

Response fields we return, for the WebRTC case:

| Field | Required | Meaning |
| --- | --- | --- |
| `cameraStreamProtocol` | yes | must be one of `SupportedStreamProtocols` — `"webrtc"` |
| `cameraStreamSignalingUrl` | yes | *"URL endpoint for retrieving and exchanging camera and client session description protocols"* |
| `cameraStreamAuthToken` | yes (when `cameraStreamNeedAuthToken`) | must be scoped to just the target device |
| `cameraStreamOffer` | optional | our SDP offer, if we choose to offer |
| `cameraStreamIceServers` | — | an **encoded JSON string** describing `RTCIceServer` entries |

Documented error for a failure to produce a stream: `resourceUnavailable`.

Two things the first pass missed, both from the same page:

- **Omitting `cameraStreamIceServers` is safe and is probably what we want.**
  *"If you do not specify STUN servers, the platform defaults to Google's public
  STUN servers."* The peer gathers its own server-reflexive candidates with or
  without us. We only need this field if we intend to hand the peer a TURN
  relay, which §2.4 says we likely do not.
- **Google validates nothing about `cameraStreamAuthToken`.** The page makes it
  mandatory whenever `cameraStreamNeedAuthToken` is true, but Google's own
  reference implementation returns an **empty string** for it while declaring
  `cameraStreamNeedAuthToken: true`, and the integration works. "Required" means
  the key must be present, not that Google checks it. Every bit of security on
  the signalling endpoint is therefore ours — see §2.5 and §4.3.

### 2.3 Signalling — who offers, and on what channel

**The channel is a plain HTTPS POST from Google to our
`cameraStreamSignalingUrl`.** Not a WebSocket. Headers:

```
Authentication: Bearer <cameraStreamAuthToken>
Content-Type: application/json
```

**The `Authentication` spelling is confirmed against the live page (re-fetched
2026-08-28) — and you must not depend on it anyway.** The trait reference says
it twice, verbatim: *"Authentication: The authentication header should use the
auth token from the GetCameraStream return value for cameraStreamAuthToken with
token type Bearer"*, and again in the sample request block, `Authentication:
Bearer <cameraStreamAuthToken>`. So the addon's existing `readBearer`, which
matches `authorization` only
(`packages/addon-export-google/src/http-server.ts:68`), would return `null` for
every signalling POST. That warning stands.

But the counter-evidence is strong enough that flipping `readBearer` to
`authentication` would just buy the opposite bug:

- **Google's own reference signalling endpoint reads no auth header at all.** It
  takes the token from a query parameter on the signalling URL, and (see §2.2)
  returns an empty `cameraStreamAuthToken`. Google's reference implementation of
  its own documented header requirement does not implement it.
- **At least one independent integration that has served this trait in
  production for years reads `Authorization`, not `Authentication`**, and has not
  been fixed. Either Google sends both, or it sends `Authorization`, or that
  code path is reached rarely — all three readings say the same thing about how
  much weight the documented spelling will bear.

**So the design rule is: carry the device-scoped token in the
`cameraStreamSignalingUrl` itself.** That URL is ours to shape, it is the one
channel Google demonstrably preserves end-to-end, and it removes the header from
the critical path entirely. Then *additionally* accept a bearer under **either**
spelling, as defence in depth — never as the sole gate. *Confidence: high on the
documented spelling and on the recommendation; which spelling a real display
actually emits is still unresolved, and §6 keeps it.*

**Who offers is our choice, declared by whether we set `cameraStreamOffer`:**

- *"When camera offer SDP is not provided in execution response, Google
  generates and provides an offer SDP."* → Google POSTs
  `{ "action": "offer", "deviceId": "123", "sdp": "..." }`; we answer HTTP 200
  with `{ "action": "answer", "sdp": "..." }`.
- *"When camera offer SDP is provided in the execution response, Google provides
  an answer SDP."* → Google POSTs
  `{ "action": "answer", "deviceId": "123", "sdp": "..." }`; we answer HTTP 200
  with `{}`.

Teardown: `{ "action": "end", "deviceId": "123" }`. The page documents `end` as a
first-class inbound action — *"end: Close the current session"* — and adds that
*"If the action is `end`, this parameter [`sdp`] can be empty."*

**`end` exists; nothing says it arrives. Treat it as an optimisation, never as
the teardown mechanism.** Three observations, none of which Google contradicts:

1. The trait page documents no keep-alive, no session duration, no maximum
   stream length, and no delivery guarantee for `end`.
2. Google's own reference signalling endpoint acknowledges `end` with an empty
   `200` and releases nothing — no session state, no media resource. Its
   correctness does not depend on `end` ever arriving.
3. In Google's WebRTC codelab the only `end` message actually exercised is one
   the **provider's own page** posts to its **own** signalling endpoint when the
   user presses a terminate button. Google is never demonstrated sending `end`
   at all.

A camstack session leaks a broker consumer and an egress transcode for as long
as it lives, so this is not academic: **the teardown timeout in §4.3 is
mandatory from day one**, and `end` merely makes teardown prompt when it happens
to arrive. *Confidence: high that a timeout is required; whether Google reliably
sends `end` is still unresolved and only traffic can settle it — §6 keeps it.*

**Recommendation, and the reason: take the Google-offers mode.** If we supply
`cameraStreamOffer` in the EXECUTE response, we must gather ICE to completion
*before* answering EXECUTE (§2.4 forbids trickle), which puts a full ICE gather
inside Google's EXECUTE timeout budget. Letting Google offer moves the gather
into the signalling POST, and — decisively — it is byte-for-byte the shape
camstack's Alexa path already runs (§3.2).

### 2.4 Media constraints

- **Video codecs: VP8, H.264.** Nothing else. H.265/HEVC and VP9 are not
  mentioned anywhere on the page.
- **Audio codecs: Opus (preferred), G.711/PCMU, G.722.**
- **Resolution: 480p minimum, 1080p maximum.**
- **One-way:** *"Google currently supports 1-way (half duplex) communication."*
  No two-way talk.
- **BUNDLE and rtcp-mux are mandatory:** *"You must support bundling and
  rtcp-mux."*
- **DTLS:** *"You must use (D)TLS 1.2 or later."*
- **No trickle ICE:** *"Trickle ICE is not supported. All ICE candidates must be
  gathered first before sending the SDP."*
- **Candidate breadth is recommended:** *"It is strongly recommended that you
  include UDP/IPv4, TCP/IPv4, UDP/IPv6 and TCP/IPv6 ICE candidates."*
- **TURN is conditional:** *"TURN servers are only required if you cannot
  guarantee the IPs / ICE candidates provided will be publicly accessible."*
- **CORS:** *"The server hosting `cameraStreamSignalingUrl` should respond with
  the following header: Access-Control-Allow-Origin: https://www.gstatic.com"*

#### 2.4.1 The peer is a browser on the display — settled, and it changes the build

The first pass flagged this as a hypothesis drawn from one header. It is no
longer a hypothesis. Four independent pieces of Google's own evidence converge:

1. **The trait page requires `Access-Control-Allow-Origin: https://www.gstatic.com`.**
   CORS is enforced by browsers and by nothing else. A server-to-server POST
   from a Google datacentre would never consult the header, and asking providers
   to set it would be meaningless.
2. **Google's own reference signalling endpoint configures a CORS middleware
   with an origin allowlist of exactly `https://www.gstatic.com`, with
   credentials enabled.** Google implements the browser side of the contract it
   documents.
3. **The trait page restricts WebRTC to the Nest Smart Display and Chromecast
   with Google TV** — which is where a `gstatic.com`-hosted player page runs.
4. **The platform gathers its own STUN candidates** (§2.2): the peer is behind a
   NAT it must reflex through, consistent with sitting on a home LAN rather than
   in a datacentre with a public address.

**Conclusion: the signalling client — and therefore the WebRTC peer — is a web
page served from `https://www.gstatic.com`, executing on the display, on the
operator's LAN.** *Confidence: high.*

Two consequences, one of them a blocker the first pass did not see.

**(a) A CORS preflight is mandatory, and camstack cannot answer one today.**
The signalling POST carries `Content-Type: application/json` plus a bearer
header. Neither is CORS-simple, so per the Fetch standard the browser **must**
send an `OPTIONS` preflight and **must not** send the POST until it succeeds.
This is a property of the browser, not a Google choice, and it follows
inevitably from the paragraph above. But:

- The addon route contract has no `OPTIONS` method — the interface admits
  `GET | POST | PUT | DELETE` (`packages/types/src/interfaces/addon-routes.ts:47`)
  and the schema `GET | POST | PUT | DELETE | PATCH`
  (`packages/types/src/capabilities/addon-routes.cap.ts:5`).
- The registry dispatches on method
  (`packages/system/src/addon-routes/addon-route-registry.ts:33`), so an
  unmatched `OPTIONS` never reaches an addon.
- The hub runs no CORS middleware on the addon route plane.

So the preflight would fail, the POST would never be sent, and **the failure is
invisible**: no signalling request, no addon log line, no SDP — exactly the
silhouette the repo's logging rule exists to prevent. The fix is a member on a
closed enum in `@camstack/types`, which means it **rides the framework publish
train, not an addon deploy** — the same train as `BrokerConsumerKindSchema` in
§4.3, and worth batching with it. The handler shape already has a precedent in
this repo, including the reason preflight must run before auth:
`packages/system/src/http/authenticated-file-server.ts:197`.

**(b) ICE gets easier than Alexa, but only if display and hub share a subnet.**
With the peer on the LAN, host candidates should pair directly and `disableTurn:
true` is defensible; `disableIpv6` should be inverted, since Google recommends
IPv6 candidates and a LAN peer can use them. Note the tension: Google frames its
TURN guidance as *"if you cannot guarantee the IPs / ICE candidates provided
will be publicly accessible"*, which is written for cloud camera vendors whose
media server sits in a datacentre. camstack's media server is on the same LAN as
the peer, so the requirement is satisfied by a route that never leaves the
house. That is an inference about *our* topology, not a Google guarantee —
confirm it on the first candidate pair before removing TURN as an option.

#### 2.4.2 SDP direction and m-line handling — resolved, and already built

Google states half-duplex but never writes `sendonly` / `recvonly` / `sendrecv`.
It does not have to, because **Google offers first** (§2.3) and RFC 3264 settles
the rest:

- A player that only renders offers its transceivers `recvonly`, so the
  provider's answer is `sendonly`. Google's half-duplex sentence is the same
  statement in prose. Corroborating: an independent production integration
  explicitly rewrites its answer to `sendonly` before returning it, which means
  at least one stack produced `sendrecv` there and it was worth correcting.
- **camstack already does exactly this.** The client-offer answer path forces
  `sendonly` on the video transceiver
  (`packages/addon-pipeline/src/stream-broker/webrtc/session.ts:1803`), and the
  contract docblock records why
  (`packages/addon-pipeline/src/stream-broker/webrtc/werift-types.ts:157`):
  without it werift answers `inactive` with a port-0 m-line. **No new work.**
- **Audio is the wrong question in Google-offers mode.** The m-line set is
  Google's, and the answer must contain a section for every offered section, in
  order. A camera with no audio answers that section without a sending
  direction — it must **not** reject it to port 0, because BUNDLE is mandatory
  (§2.4) and zeroing a bundled m-line empties the `a=group:BUNDLE` line and gets
  the whole answer rejected. That failure is already recorded in this repo at
  `packages/addon-pipeline/src/stream-broker/webrtc/session.ts:1796`. Google's
  own reference camera always sources both audio and video, so whether its
  player tolerates an inactive audio section is **untested** — §6 keeps it.

*Confidence: high on `sendonly` and on the BUNDLE hazard; unresolved on how
Google's player reacts to an audio section we decline to fill.*

### 2.5 Auth model

Two distinct tokens, and conflating them is the security hole:

1. The **OAuth access token** the hub minted, presented on `/fulfillment`. The
   addon already verifies this
   (`packages/addon-export-google/src/http-server.ts:59` route,
   `oauthVerifyAccessToken` inside the handler).
2. The **`cameraStreamAuthToken`**, returned per-execution and presented on the
   signalling URL. Per the **2025-04-08** release note this must be **scoped to
   just the target device**. It is not the OAuth bearer and must not be.

**Validity duration: Google imposes none, and the choice is entirely ours.**
Neither the trait page nor the release notes state a lifetime for the signalling
URL or the stream auth token — and that silence is now corroborated rather than
merely noted. Google's own reference implementation puts a **long-lived
per-user** token in the signalling URL, never rotates it, and returns an empty
`cameraStreamAuthToken` (§2.2); it neither expires nor refreshes anything. There
is no refresh message in the signalling protocol, and no error code for an
expired stream token.

So nothing on Google's side will ever hand us a fresh token mid-session, and
nothing will reject a stale one. The TTL is a purely local trade:

- **Long enough** to outlive the gap between our EXECUTE response and the
  display's first signalling POST. That gap is human-paced — a user asking to
  see a camera — so seconds to tens of seconds, not milliseconds.
- **Short enough** that a token which is never used cannot be replayed later.
  It is device-scoped and single-session by construction (§4.3), so expiry is a
  replay bound, not a session bound: **expiry must not tear down a connected
  session**, or a long live view dies at the TTL.

*Confidence: high that Google enforces nothing. The concrete TTL is our
decision, not a discovered constant.*

---

## 3. What camstack already has

The hub owns a mature werift-based WebRTC plane. The fit is good, and better
than it looks, because Google's constraints overlap Alexa's almost exactly.

### 3.1 The WebRTC signalling plane — reusable as-is

`packages/types/src/capabilities/webrtc-session.cap.ts:87` defines the
`webrtc-session` capability, device-scoped, with both negotiation directions:

- **Client-offer / we-answer**: `handleOffer`
  (`packages/types/src/capabilities/webrtc-session.cap.ts:158`) → returns
  `{ sessionId, sdpAnswer }`. **This is exactly Google's default mode.**
- Server-offer: `createSession`
  (`packages/types/src/capabilities/webrtc-session.cap.ts:115`), plus
  `handleAnswer` / `addIceCandidate` / `getIceCandidates`.
- Teardown: `closeSession`
  (`packages/types/src/capabilities/webrtc-session.cap.ts:297`).

The provider is `WebrtcSessionProvider` in
`packages/addon-pipeline/src/stream-broker/device-scoped-providers.ts`, over
`BrokerWebrtcServer` in
`packages/addon-pipeline/src/stream-broker/webrtc/broker-webrtc-server.ts`.
Stack is **werift `^0.22.9`** (`package.json:110`) plus the local relay-only fix
in `patches/werift+0.22.9.patch`.

**The single best-fitting artifact in the repo:** the `nonTrickle` option on
`handleOffer` (`packages/types/src/capabilities/webrtc-session.cap.ts:194`). It
exists because Alexa does not trickle, and its docblock records the failure it
prevents — a bare answer with no candidates means no pair, DTLS never connects,
black screen. **Google's "Trickle ICE is not supported" is the identical
requirement.** This is already built, already debugged, already in production.

### 3.2 Alexa — the closest sibling, and a near-template

`packages/addon-export-alexa/src/handlers/rtc-session.ts` receives
`InitiateSessionWithOffer`, and its call into the broker at
`packages/addon-export-alexa/src/handlers/rtc-session.ts:245` sets exactly the
flags Google would want:

| Flag | Alexa | For Google |
| --- | --- | --- |
| `nonTrickle: true` (`…/rtc-session.ts:258`) | Echo does not trickle | **same — mandated** |
| `disableIpv6: true` (`…/rtc-session.ts:272`) | AWS gateway quirk | **probably invert** — Google recommends IPv6 candidates |
| `disableTurn: true` (`…/rtc-session.ts:264`) | Echo has public host candidates | **probably invert or leave on** — depends on §2.4's hypothesis |
| `relayOnly: false` (`…/rtc-session.ts:252`) | direct | same |
| `consumerAttribution` (`…/rtc-session.ts:279`) | `kind: 'alexa'` | needs a new enum member (§4.3) |

The codec-constraint glue is `acquireAlexaEgress`
(`packages/addon-export-alexa/src/egress/alexa-rtc-egress.ts:108`), which calls
`streamBroker.acquireEgressTranscode`
(`packages/addon-export-alexa/src/egress/alexa-rtc-egress.ts:112`) with
`ALEXA_EGRESS_PROFILE`. Release is `releaseAlexaEgress`
(`packages/addon-export-alexa/src/egress/alexa-rtc-egress.ts:181`), and the
teardown ORDER in `handleSessionDisconnected` — release egress first, then
`closeSession` — is a discipline to copy, not re-derive.

`ALEXA_EGRESS_PROFILE` (`packages/types/src/ffmpeg/encode-defaults.ts:106`)
spreads `BASE_LIVE_EGRESS_PROFILE`
(`packages/types/src/ffmpeg/encode-defaults.ts:46`): **H.264 baseline, level
3.1, 1280×720 @ 25fps, 2500 kbps**, with audio overridden to Opus. That lands
inside Google's 480p–1080p window and on Google's preferred audio codec. A
`GOOGLE_EGRESS_PROFILE` would be a near-copy.

There is also a fast path worth reusing: `cameraStreams.pickStream` at
`packages/addon-export-alexa/src/handlers/rtc-session.ts:184` asks for an
existing H.264 sibling stream and skips transcode entirely when the camera has
one.

### 3.3 Codecs the broker can emit — a clean match

Registered senders in
`packages/addon-pipeline/src/stream-broker/webrtc/session.ts`:

- H.264, payload type 96 —
  `packages/addon-pipeline/src/stream-broker/webrtc/session.ts:1256`
- H.265, payload type 97 —
  `packages/addon-pipeline/src/stream-broker/webrtc/session.ts:1278`
- Opus, payload type 111 —
  `packages/addon-pipeline/src/stream-broker/webrtc/session.ts:1301`
- PCMU (G.711 µ-law), payload type 0 —
  `packages/addon-pipeline/src/stream-broker/webrtc/session.ts:1308`

Google wants H.264 + Opus/PCMU/G.722. **Three of the four registered codecs are
directly usable.** H.265 must be suppressed for Google — it is not on Google's
list, and offering it to a peer that will not take it is how a stream ends up
negotiated-but-black. The broker already transcodes H.265→H.264 and
Main/High→Baseline; the client-offer decision function is
`resolveClientOfferTranscodeToBaseline` in
`packages/addon-pipeline/src/stream-broker/webrtc/broker-webrtc-server.ts`, which
passes through only when the offered profile covers the source. Since Google
offers first, that function does the right thing without modification.

No VP8 anywhere in the broker — irrelevant, since H.264 is equally accepted.

### 3.4 TURN

`packages/addon-static-turn/src/static-turn.addon.ts` is a **pointer, not a
server**: it hands operator-supplied coturn URLs to the `turn-provider`
capability (`packages/types/src/capabilities/turn-provider.cap.ts:28`). The
broker consumes it once, in `getIceServers` at
`packages/addon-pipeline/src/stream-broker/addon.ts:718`. The hub runs no TURN
listener of its own. Per §2.4, TURN is only needed if our candidates are not
publicly reachable — and per §2.4's hypothesis they may not need to be at all.

### 3.5 What is missing for the non-WebRTC protocols

No HLS packager, no DASH, no live progressive MP4. The broker emits RTSP
(`packages/addon-pipeline/src/stream-broker/rtsp/rtsp-listen-server.ts`) and
RTMP; the fMP4 fragment machinery exists only on the HomeKit Secure Video
recording path. So `hls` / `progressive_mp4` — the protocols that might reach a
phone — are **more** new work than WebRTC, not less. This is why the phone
variant is verdict (c).

### 3.6 HomeKit is not a template here

`packages/addon-export-hap/src/mappers/builders/camera-streams.ts` does **not**
use the broker's WebRTC server at all — it negotiates HAP SRTP and spawns its
own ffmpeg against the broker's RTSP restream URL. It touches
`webrtcSession.listStreams` only as a bitrate/fps telemetry source. Nothing in
it transfers to Google.

### 3.7 There is no generic "give me a WebRTC session for device N"

The signalling half is generic (`webrtcSession.*`). The codec-constraint half is
a generic primitive (`streamBroker.acquireEgressTranscode`). **But the glue that
binds them — constrain → acquire → resolve to a `camStreamId` → `handleOffer` →
hold the handle → release in the right order on teardown — exists in exactly one
place, and it is Alexa-specific**
(`packages/addon-export-alexa/src/egress/alexa-rtc-egress.ts`). Alexa is the only
non-broker caller of `acquireEgressTranscode`. HomeKit duplicates the concept
with its own ffmpeg.

A third exporter must either copy that file or lift it into `@camstack/types`
(addons may not import each other). **Copying it a second time is the moment to
lift it** — the repo already has a guard, `scripts/check-export-coverage.ts`,
that exists because three hand-copied mapping tables drifted.

---

## 4. What would be new work

### 4.1 The signalling route — new, small, and with two traps

A second route beside `/fulfillment` in
`packages/addon-export-google/src/http-server.ts:54`:

```
POST /addon/export-google/signaling
```

`access: 'public'`, bearer verified in the handler — the same pattern already
used at `packages/addon-export-google/src/http-server.ts:59`. Differences from
the existing route:

- **Takes its token from the URL, not from a header** (§2.3). The token is
  minted into `cameraStreamSignalingUrl` at EXECUTE time, so it arrives on the
  path or query where no CORS rule and no header-spelling ambiguity can eat it.
  A bearer under **either** `Authentication` or `Authorization` is accepted as a
  secondary credential — `readBearer`
  (`packages/addon-export-google/src/http-server.ts:68`) matches `authorization`
  only today, so it needs widening, but it must not become the sole gate.
- Verifies a **device-scoped stream token**, not an OAuth access token.
- Sets `Access-Control-Allow-Origin: https://www.gstatic.com` on the response.
- Handles three actions: `offer` → `webrtcSession.handleOffer` → return
  `{ action: 'answer', sdp }`; `answer` → return `{}`; `end` → release egress
  then `closeSession` — while never *depending* on `end` arriving (§2.3).

**And a second route, which is a hard prerequisite, not a detail:**

```
OPTIONS /addon/export-google/signaling
```

Per §2.4.1 the browser sends a CORS preflight before the POST and withholds the
POST until it succeeds. The response must carry
`Access-Control-Allow-Origin: https://www.gstatic.com`, the allowed methods, and
`Access-Control-Allow-Headers` covering whatever the client announced in
`Access-Control-Request-Headers` — echoing that request header is the robust
move, precisely because §2.3 leaves the auth header's spelling unsettled. It
must answer **before** any token check, since a preflight carries no credentials
(`packages/system/src/http/authenticated-file-server.ts:197` is the existing
precedent for that ordering).

**This cannot be written as an addon change.** `OPTIONS` is not a member of the
route method union (`packages/types/src/interfaces/addon-routes.ts:47`,
`packages/types/src/capabilities/addon-routes.cap.ts:5`) and the registry
dispatches on method. Widening that enum is a `@camstack/types` change on the
framework publish train — batch it with the `BrokerConsumerKindSchema` member in
§4.3, because shipping one without the other means two publish cycles.

### 4.2 The trait row does not fit the current `TraitDescriptor` — this is the real design work

D273 predicted *"no row can satisfy Google's camera-stream trait"*. **That
prediction is correct as the contract stands, and the reason is precise and
fixable.** Today:

- `TraitDescriptor.resolveCommand`
  (`packages/addon-export-google/src/google-home/trait-catalog.ts:142`) is PURE
  — it returns a `CapCall`
  (`packages/addon-export-google/src/google-home/trait-catalog.ts:49`), data
  only.
- `DeviceGateway.dispatch`
  (`packages/addon-export-google/src/device-gateway.ts:22`) returns
  `Promise<void>` — it throws away whatever the call produced.
- EXECUTE's response states come from `statesAfterCall(resolution.call)`
  (`packages/addon-export-google/src/intents/execute.ts:143`), a pure function of
  the *call* (`packages/addon-export-google/src/google-home/trait-catalog.ts:75`).

`GetCameraStream` breaks this because its response states are **produced by the
dispatch**, not derivable from the command: `cameraStreamSignalingUrl` and
`cameraStreamAuthToken` are minted when the session is created. There is no
input from which a pure function can compute them.

The minimal honest amendment, preserving D273's actual invariant (one row owns
declare/read/write) rather than its incidental signature:

- `DeviceGateway.dispatch` returns a typed `CapCallResult` union rather than
  `void`.
- `statesAfterCall` takes `(call, result)`, with the existing rows ignoring the
  result — their behaviour is unchanged and their tests stay pure.
- A `CapCall` variant `{ kind: 'cameraStream.getStream'; deviceId; supportedProtocols }`
  and its arm in `dispatchCapCall`
  (`packages/addon-export-google/src/google-home/cap-dispatch.ts:20`) — where the
  `never` binding already guarantees the arm cannot be forgotten.

This widens the contract for every row, so it is a change that wants its own ADR
before it is written. **It is the single largest piece of new thinking in this
feature** — larger than the signalling glue, which is mostly transcription from
Alexa.

Also required in the same package:

- `resolveGoogleDeviceType`
  (`packages/addon-export-google/src/google-home/device-model.ts:47`) returns
  `null` for anything without OnOff/Brightness/Lock/OpenClose; it needs a
  camera arm returning `action.devices.types.CAMERA`.
- `GoogleDeviceType` and `GoogleTraitName`
  (`packages/addon-export-google/src/google-home/protocol.ts:83` and
  `packages/addon-export-google/src/google-home/protocol.ts:90`) gain members.
- `SUPPORTED_DEVICE_KINDS`
  (`packages/addon-export-google/src/google-home/device-model.ts:107`) gains
  `DeviceType.Camera` — derived from the catalog, so it follows automatically.
- `trait-catalog.spec.ts` asserts every row is readable; a camera row has no
  QUERY state beyond `online`, so that invariant needs an explicit, documented
  exemption rather than a quietly weakened assertion.

### 4.3 Session and token lifecycle — genuinely new

- **A device-scoped stream token store**: minted per `GetCameraStream`, bound to
  one deviceId and one sessionId, expiring. Nothing in the addon holds
  per-session state today; it is currently stateless between requests.
- **A teardown timeout — now evidenced, not merely prudent.** §2.3 establishes
  that `end` is documented but carries no delivery guarantee, that Google's own
  reference implementation releases nothing on `end`, and that the only `end`
  Google ever demonstrates is provider-generated. A session that leaks holds a
  broker consumer and an egress transcode open indefinitely. Alexa has the same
  exposure and handles it; the timeout must exist here from day one, not be
  added after the first stuck encoder. Note the timeout is the *primary*
  mechanism and `end` the opportunistic one — not the reverse.
- **`BrokerConsumerKindSchema`
  (`packages/types/src/capabilities/stream-broker.cap.ts:158`) needs a `google`
  member.** It is a closed enum in `@camstack/types` — so this is **not an addon
  deploy**. It rides the framework publish train and is not live until a
  `@camstack/server` containing it is installed. Skipping it means Google
  sessions show as `unknown` in the broker panel, which is the diagnostic
  surface you will want first.

### 4.4 Effort shape

| Piece | Exists | New |
| --- | --- | --- |
| WebRTC peer, ICE, DTLS, SRTP | werift broker, in production | — |
| Non-trickle answer | `nonTrickle` flag, built for Alexa | — |
| H.264 baseline egress at 720p | `ALEXA_EGRESS_PROFILE` | a `GOOGLE_EGRESS_PROFILE` near-copy |
| Opus / PCMU audio | registered senders | — |
| Passthrough fast path | `cameraStreams.pickStream` | — |
| Acquire/release egress discipline | Alexa-only, copyable | lift to shared, or copy |
| Public HTTPS route, self-verified bearer | `/fulfillment` | `/signaling`, token-in-URL, CORS |
| `sendonly` answer to a `recvonly` offer | forced on the client-offer path | — |
| **CORS preflight (`OPTIONS`) on an addon route** | — | **all of it, and it is a framework-train enum widening — §4.1** |
| Account linking | hub OAuth, done | — |
| Per-session device-scoped token | — | **all of it** |
| `TraitDescriptor` result-carrying dispatch | — | **all of it, wants an ADR** |
| Consumer-kind enum member | — | small, framework train |
| Session leak timeout | — | all of it |

The honest read: **the media plane is done and the fulfillment plane is done.**
What is missing is a token store, two HTTP routes, and one contract widening in
the addon's core abstraction. That last item is the one that deserves design
attention; the rest is transcription.

**Two of these are not addon deploys.** The `OPTIONS` method (§4.1) and the
`google` consumer kind (§4.3) are both members of closed enums in
`@camstack/types`, so neither is live until a `@camstack/server` containing them
is installed. Plan them as one framework change, up front — discovering the
preflight blocker after the addon is written costs a publish cycle for a
one-line enum.

---

## 5. What would confirm this cheaply, before writing code

Google publishes a **WebRTC Validator Tool** at
`https://smarthome-webrtc-validator.withgoogle.com/` (documentation page last
updated **2021-11-01**), described as *"a web-based tool that aims to emulate the
WebRTC player available on Google Smart Displays with Google Assistant."* It
exchanges the same `{ "action": "offer" | "answer", "sdp": "..." }` payloads and
lets you supply STUN/TURN URIs.

**This means the whole signalling contract and the SDP/ICE/codec negotiation can
be validated from a browser without owning a Nest display and without touching
the Google console.** It does not answer the §0 gate — whether a real display
renders it — but it de-risks every protocol assumption in this document for
roughly the cost of the `/signaling` route alone. It is the right first
experiment.

It is worth more than the first pass credited, because §2.4.1 establishes the
real peer is *itself* a browser: a browser-based emulator is not a rough
approximation of the display's player, it is the same class of client. So it
should issue the **CORS preflight** of §2.4.1, and it will reveal which auth
header spelling its emulated player sends — strong evidence about the real
display, though not proof. **Run it before the framework enum change is
written**, so the `OPTIONS` requirement is confirmed by observation rather than
inferred from the Fetch standard.

---

## 6. Could not determine

Listed rather than guessed. A plausible-sounding protocol detail that is wrong is
worse than an admitted gap.

The original list held ten items. **Four are resolved outright and two are
resolved down to a narrow residue** — all six have moved into the body, and §6.2
records where each went. One item below is *new*: confirming the header spelling
the first pass had asserted as fact turned it into a genuine open question
(item 1). §6.3 records why the survivors survive.

### 6.1 Still open

1. **Which auth header a real display actually sends.** Google documents
   `Authentication` (confirmed verbatim, twice, §2.3). Google's own reference
   endpoint reads no header at all, and an independent production integration
   reads `Authorization`. Nothing short of a real signalling POST separates
   these. **Not load-bearing any more**: §2.3 moves the token into the
   signalling URL and accepts either spelling, so the design is correct under
   all three readings. It stays listed because a future session that "simplifies"
   the design back to a single header will reintroduce the risk.
2. **Whether Google reliably sends `action: "end"`, and when.** §2.3 establishes
   `end` is documented, carries no delivery guarantee, and is never demonstrated
   being sent *by Google*. The unknown is now narrow — it decides only how often
   the §4.3 timeout is the thing that fires, not whether the timeout is needed.
3. **Whether Google's player accepts an audio m-line we decline to fill.** §2.4.2
   settles the mechanics (answer every offered section; never zero a bundled
   m-line). What remains untested is tolerance: Google's reference camera always
   sources audio, so a video-only camstack camera answering an inactive audio
   section is unexercised territory. Cameras without audio exist in this fleet,
   so this will be met on day one.
4. **Whether a Nest display renders a cloud-to-cloud camera from an
   unpublished/test-mode integration without an extra step.** The evidence
   improved but did not close. **For:** Google's WebRTC codelab lists "A Google
   Nest display device" among its prerequisites and is performed end-to-end
   against one, on a project that is never submitted for certification or
   publishing — Google is instructing developers to do precisely this.
   **Against:** no policy sentence states it, and a tutorial's silence is not a
   guarantee. So: **probably yes, on the strength of Google's own tutorial.**
   *Confidence: medium-high.* **This is still the gate, and it is still settled
   by trying it, not by reading.**
5. **Whether cloud-to-cloud cameras are visible to the Home APIs (§1.3).** The
   camera page does not list them and the traits are restricted. Unchanged, and
   unreachable from any implementation — a production cloud-to-cloud integration
   sees only its own side of the wire and learns nothing about the reader API.
6. **Matter camera support in Google Home as of today.** The supported-devices
   page is stale (2024-12-20). Unchanged, and out of scope for any
   CameraStream implementation.
7. **Simulcast, RTX, NACK, FEC expectations.** Still unmentioned by Google —
   but §2.4.1 makes this **answerable at runtime rather than in advance**: the
   peer is a browser and Google offers first, so its offer will carry whatever
   `a=rtcp-fb` and RTX lines its stack emits (browsers default to NACK/PLI and
   RTX), and the answer can simply mirror what is offered. There is nothing to
   decide before seeing one offer. *Confidence: medium-high that this needs no
   design work.*

### 6.2 Resolved — where each went

| Was | Now | Confidence |
| --- | --- | --- |
| Token / URL validity duration | §2.5 — Google enforces none; the TTL is ours, and expiry must bound replay, not sessions | high |
| SDP media direction | §2.4.2 — answer is `sendonly`; camstack already forces it | high |
| `cameraStreamSupportsPreview` | §2.1 — not part of the contract; do not send it | high |
| Peer is the display or a Google relay | §2.4.1 — a browser page on the display, on the LAN | high |
| `Authentication` vs `Authorization` spelling | §2.3 — documented spelling confirmed; design no longer depends on it | high |
| Audio mandatory / m-line shape | §2.4.2 — mechanics settled; only Google's *tolerance* survives, as §6.1 item 3 | high / partial |

### 6.3 How the survivors were tested before being left open

Every item above was re-checked on 2026-08-28 against Google's live
documentation **and** against a long-running third-party cloud-to-cloud
integration that has served the `CameraStream` WebRTC path in production for
roughly four years. That implementation was read **only as evidence of how
Google behaves** — which header arrives, whether a teardown message is depended
upon, what an answer SDP has to look like. Nothing was copied from it: no code,
no comments, no identifier names, no structure, and no constant. Where a
question could only have been answered by adopting somebody's implementation
choice rather than by observing Google, it was **left open on purpose** — that
is why §6.1 items 1 and 3 survive despite a working implementation existing for
both.

The three survivors that matter share one property: **they are questions about
what a real Nest display does, and no amount of reading answers them.** Items 1,
3 and 4 are all settled by a single experiment — point one camera at one
display, or at the validator tool of §5 — and until that experiment runs, any
confident sentence about them would be invention. The design in §4 is
deliberately built so that items 1 and 3 cannot break it: the token does not
ride the disputed header, and the answer never rejects an offered m-line.

---

## 7. Incidental finding, unrelated to cameras

The addon's own CLAUDE.md and the docblock at the head of
`packages/addon-export-google/src/google-home/trait-catalog.ts` both cite the
one-capability-one-trait-row record under an adr-0268 filename. The record
actually shipped as D273; adr-0268 is a different record about provider settings
scope. There are also two files numbered adr-0269. Neither affects behaviour, but
the CLAUDE.md reference is a dead relative link — and per this repo's own working
style, a leftover that describes the right design reads as verification.

---

## Sources

All fetched or re-fetched 2026-08-28. The trait reference, the camera guide and
the codelab were re-read in raw form on that date specifically to settle §6;
where a claim rests on a quoted sentence, that sentence was read from the live
page, not from memory.

- [CameraStream trait reference](https://developers.home.google.com/cloud-to-cloud/traits/camerastream) — last updated 2026-06-09
- [Camera device type guide](https://developers.home.google.com/cloud-to-cloud/guides/camera) — last updated 2026-08-12
- [Cloud-to-cloud release notes](https://developers.home.google.com/cloud-to-cloud/release-notes)
- [Test a cloud-to-cloud integration](https://developers.home.google.com/cloud-to-cloud/test) — last updated 2023-08-01
- [Certification](https://developers.home.google.com/cloud-to-cloud/certification) — last updated 2023-08-01
- [Test Suite](https://developers.home.google.com/tools/test-suite) — last updated 2022-07-13
- [WebRTC Validator Tool](https://developers.home.google.com/tools/webrtc-validator) — last updated 2021-11-01
- [Implement CameraStream with WebRTC codelab](https://developers.home.google.com/codelabs/smarthome-webrtc)
- [Codelab reference implementation](https://github.com/google-home/smarthome-camerastream-webrtc) — Google's own sample, Apache-2.0. Load-bearing for §2.1 (`cameraStreamSupportsPreview` absent from the working sample), §2.2 (empty auth token), §2.3 (`end` acknowledged but nothing released; token carried in the URL) and §2.4.1 (gstatic-only CORS origin allowlist).
- [Fetch standard — CORS preflight](https://fetch.spec.whatwg.org/#cors-preflight-request) — why §2.4.1's `OPTIONS` request is mandatory rather than optional.
- [Home APIs — Camera device](https://developers.home.google.com/apis/android/device/camera) — last updated 2026-07-07
- [Home APIs release notes](https://developers.home.google.com/apis/release-notes)
- [SDM CameraLiveStream trait](https://developers.google.com/nest/device-access/traits/device/camera-live-stream) — last updated 2026-06-29
- [Matter supported devices](https://developers.home.google.com/matter/supported-devices) — last updated 2024-12-20
