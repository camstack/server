# Plan — Google Home export (WebRTC)

> **For the implementer:** REQUIRED SKILL — `add-addon` for the wiring of the
> package (the points are silent when forgotten), then
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> for the execution. The steps use checkboxes (`- [ ]`) for tracking.

**Goal:** export cameras to Google Home as a **Cloud-to-cloud** integration
with the trait `action.devices.traits.CameraStream`, protocol
`webrtc`, terminating the session **in the broker that already exists** and not in a
new peer. The addon does not touch a single RTP packet: it translates JSON envelopes
and calls `webrtcSession.handleOffer`.

**Architecture:** three tracks. **A** teaches the addon to speak Google —
all pure logic, testable without network, without media, without Google. **B** is the
video plane: a single call to a cap that exists, plus the choice of the source
stream that avoids re-encoding when the camera already publishes H.264. **C** is
what the operator sees and types. **A and B are independent and can start
in parallel; C depends on A.**

**Stack:** TypeScript 5.7+, Zod 4, vitest, npm workspaces + nx. No new
runtime dependency — not even a WebRTC library (see *What NOT to do*, §1).

---

## Global constraints

The rules of `CLAUDE.md` apply. In addition, verbatim:

- **No casts.** No `as any`, `as unknown as X`, `as never`. Exceptions: `as
  const` and a documented type boundary. Discriminated unions and type guards.
- **`z.infer<>` for Zod schemas** — never duplicate a shape by hand.
- **Named types**: no inline types on signatures or return values.
- **Every log line about a device carries `tags: { deviceId }`** with the numeric id.
  Always the same key, never only in the message text.
- **A branch that silently throws work away logs it.** Here it counts double: Google
  answers `200` to almost everything and simply shows a black screen.
- **Addons do not import each other.** `ctx.api` is the only layer.
- **`npm run codegen` after every touch to a `*.cap.ts`.** This plan **touches
  no `*.cap.ts`** — if you find yourself modifying one, stop: you are almost certainly
  duplicating something that already exists.
- **A green test is not proof.** After every fix, DISARM the fix and confirm the
  test turns red. Report that you did.
- **Never `git --no-verify`, never `git add -A`, never `git stash`.** Explicit
  pathspecs. The tree is shared.
- **No secrets in code.** See §"Secrets" — there is a precedent in this
  repo that **must not be copied**.
- No task here touches the production hub until Track C.

---

## Part 0 — What it shares with HAP and Alexa, and what it does not

### The short answer: **Google resembles Alexa in control, HomeKit in media.**

It is this double nature that must be understood before writing a line.

| Dimension | HomeKit (`addon-export-hap`) | Alexa (`addon-export-alexa`) | **Google Home (this plan)** |
| --- | --- | --- | --- |
| **Control** plane | Local (mDNS/HAP on the LAN) | **Cloud** — inbound HTTPS directive from Amazon | **Cloud** — inbound HTTPS POST from Google. **Like Alexa.** |
| Does it need a public URL? | No | **Yes** (tunnel) | **Yes** (tunnel). **Like Alexa.** |
| Account linking | 8-digit pairing code | **OAuth2 authorization-code** hosted by the hub | **OAuth2 authorization-code** hosted by the hub. **Like Alexa, identical cap.** |
| Who is the **media peer** | iPhone/HomePod **on the LAN** | AWS media gateway, **public on the Internet** | **Nest Hub Max / Chromecast, on the user's LAN.** **Like HomeKit.** |
| Does the media cross the cloud? | No | No (direct hub→AWS) | **No** — peer-to-peer hub→Nest Hub. No Google relay. |
| Media transport | "By hand" SRTP (ffmpeg → RTP loopback → encryption in JS) | **WebRTC via `webrtcSession.handleOffer`** | **WebRTC via `webrtcSession.handleOffer`.** **Like Alexa, identical.** |
| Who originates the SDP offer | iOS | Alexa | **Google** (see §1). **Like Alexa.** |
| Trickle ICE | n/a | **No** (`nonTrickle: true`) | **No, forbidden by the documentation.** **Like Alexa.** |
| Video codec | H.264 (H.265 transcoding) | H.264 | **H.264 or VP8** (never H.265) |
| Audio | Opus, optional 2-way | Opus, full-duplex if `intercom` is there | **Out of scope in v1** (see §3) |
| Needs a cloud shim (Lambda/Function) | No | **Yes** (one public skill, N hubs) | **No in v1** — the operator's own Google project, fulfillment direct on the tunnel |
| Drift of the remote copy | n/a | `endpoint-signature.ts` + `AddOrUpdateReport` | Same problem, solved by `RequestSync` (Track B2, deferred) |

### The three architectural consequences

1. **The template is `addon-export-alexa`, not `addon-export-hap`.** Same triple of
   capabilities (`device-export` + `addon-routes` + `oauth-integration`), same
   `placement: hub-only`, same auto-detection of `publicHubUrl` from the cap
   `network-access`, same discipline "the 2xx is not delivery".

2. **But the media plane is *easier* than Alexa's**, because the peer is on the LAN.
   Alexa must reach a public AWS gateway and to do so it *removes* TURN and
   *removes* IPv6 to stay within a budget of 5-8 seconds. The Nest Hub Max is
   in the same house: the **host** candidates almost always suffice, and Google asks
   explicitly to include IPv4 and IPv6, UDP and TCP.

3. **No cloud shim is needed.** Alexa's Lambda exists because there is **one** public
   skill published by us and **N** self-hosted hubs to route: the Lambda
   decodes `hubUrl` from the bearer and acts as a switchboard. For Google's v1
   the operator creates **their own** project in the Google Home Developer Console,
   so the fulfillment URL can point **directly** to their tunnel. This is
   the single biggest scope cut of the plan and it is what makes "testable
   tomorrow" a true sentence instead of a wish.

---

## Part 1 — The video plane

Every statement below is read from Google's official JSON schema or from the
code of this repo. Where Google **does not document**, it is written NOT DOCUMENTED —
nothing has been invented.

### 1. What shape of WebRTC Google wants

**Source:** <https://developers.home.google.com/cloud-to-cloud/traits/camerastream>
and the schema `getcamerastream.results.schema.json` in
<https://github.com/google-home/smart-home-schema>.

The flow has **two separate phases**, and this is where mistakes are made:

**Phase 1 — `EXECUTE` / `GetCameraStream`.** Google POSTs to our fulfillment
URL. The payload contains **only** two parameters: `StreamToChromecast` (boolean)
and `SupportedStreamProtocols` (array). **No SDP arrives in the EXECUTE.**
We answer with:

```json
{
  "cameraStreamProtocol": "webrtc",
  "cameraStreamSignalingUrl": "https://hub.example/addon/google-home-export/rtc/102?exp=...&sig=...",
  "cameraStreamAuthToken": "<the same signature>"
}
```

`cameraStreamOffer` and `cameraStreamIceServers` are **optional and we omit them**
(§4). Omitting `cameraStreamOffer` means: **Google makes the offer.**
Verbatim from the trait's page:

> *"`cameraStreamOffer`: Offer SDP. If included, Google provides Answer SDP at
> signaling endpoint. If omitted, Google generates Offer SDP and expects Answer
> SDP response."*

All three real implementations I found omit it (the official sample
`google-home/smarthome-camerastream-webrtc`, `koush/the reference NVR`, and the
UniFi bridge in Go). **It is also the direction that suits us**, because it is
exactly the one that `webrtcSession.handleOffer` already serves for Alexa.

**Phase 2 — the signalling POST.** Google POSTs to the
`cameraStreamSignalingUrl`, with `Authorization: Bearer <cameraStreamAuthToken>`:

```json
{ "action": "offer", "deviceId": "102", "sdp": "v=0\r\no=- ..." }
```

and we must answer `200` with:

```json
{ "action": "answer", "sdp": "v=0\r\no=- ..." }
```

Three hard constraints on this response:

- **It is synchronous.** The answer must be in the body of the *same* HTTP response.
- **Trickle ICE is forbidden.** Verbatim: *"Trickle ICE is not supported. All ICE
  candidates must be gathered first before sending the SDP."* So the ICE gathering
  must complete **inside** that HTTP response. In our code this is
  `nonTrickle: true`, which takes `session.ts` onto `waitForIceGatheringComplete(capMs = 5000)`.
- **CORS is mandatory.** The signalling host must answer
  `Access-Control-Allow-Origin: https://www.gstatic.com`. This hub already answers
  `access-control-allow-origin: *` on every response (`manual-boot.ts:456`), which
  satisfies the requirement with no work.

**Closing:** `{ "action": "end", "deviceId": "102" }` on the same URL. There is
no renewal, no token refresh, no documented session TTL.

### 2. Codec: passthrough or transcoding

**What Google accepts** (verbatim from the trait's page):

> Video codecs: **VP8, H.264** · Audio codecs: **Opus (preferred), G.711/PCMU,
> G.722** · Resolutions: **Minimum 480p, Maximum 1080p** · *"You must support
> bundling and rtcp-mux."* · *"You must use (D)TLS 1.2 or later."*

**H.265/HEVC: NO.** It does not appear anywhere in the cloud-to-cloud
documentation nor in the schema. It must be said without beating around the bush: **HEVC
cameras cannot do passthrough towards Google.** This is the limit of the protocol,
not ours.

The repo already has **three** answers, in order of increasing cost. A
fourth is not needed:

| Source | What happens | Cost |
| --- | --- | --- |
| H.264 camera | **Pure passthrough.** `session.ts` forwards the source RTP through `H264Repacketizer` — no re-encoding, SSRC/seq/timestamp preserved. | ~0 |
| H.265 camera **with an H.264 sibling** (battery Reolink: `native:main` HEVC + `native:sub` H.264) | **Passthrough on the sibling.** `cameraStreams.pickStream({ requirements: { acceptCodecs: ['h264'] } })` returns the right stream, and we pass `target: { kind: 'cam-stream', camStreamId }`. | ~0, but lower resolution |
| **H.265-only** camera | **Re-encoding.** Automatic: `detectNegotiatedVideoCodec` reads H264 from Google's offer, `resolveVideoTranscode` returns `true`, and the session does `prewarmTranscodeEgress()` on the D67 primitive with `WEBRTC_EGRESS_PROFILE`. | **~1 core per session**, `ultrafast` 720p/3000 kbps |

The important point: **re-encoding is already implemented and starts by itself.** This
plan does not add a `GOOGLE_EGRESS_PROFILE`. Alexa has one only because it
needs in-band Opus on the audio sidecar; we in v1 have no audio, so
`WEBRTC_EGRESS_PROFILE` (which is already `audio: 'passthrough'`) is exactly right.

What this plan **adds** is only the middle step: calling
`pickStream` *before* opening the session, so as not to pay a core when the
camera already publishes an H.264. It is the same trick that Alexa's `rtc-session.ts`
describes as "FAST PATH (reference-NVR style)", but since then it has been generalised
on the `camera-streams` cap precisely because every consumer has the same problem.

**The 1080p ceiling must be actively respected.** A 4K camera in passthrough
would send 4K to a device that declares a maximum of 1080p. The
behaviour is not documented (probably a black screen). Track B1
decides this explicitly.

### 3. Who terminates the WebRTC session

**The existing broker. No new peer.** The addon does not import werift, does not
build an `RTCPeerConnection`, does not see an RTP packet.

```
addon-export-google-home  (the addon's process)
   │  POST /addon/google-home-export/rtc/:deviceId   { action:'offer', sdp }
   ▼
   ctx.api.webrtcSession.handleOffer.mutate({ deviceId, sdpOffer, target,
       nonTrickle: true, consumerAttribution: { kind: 'google-home', sessionId } })
   ▼ (tRPC / UDS — passes an SDP STRING, not media)
WebrtcSessionProvider → BrokerWebrtcServer.handleOffer → AdaptiveSession (werift)
   ▼
StreamBroker.onVideoRtp / getRtpPreBuffer   (same process as the broker)
   ▼ direct SRTP
Nest Hub Max on the LAN
```

This **is** the respect of D9/D18, not an exception: what crosses the process
boundary is an SDP string of a few kilobytes, once per session. Frames never
cross it — they are born and die inside the broker's process.

Three reasons why a new peer in the addon would be wrong, besides D9:

- werift here is **provided by the host and patched** (`patches/werift+0.22.9.patch`, the
  candidate leak under `forceTurn`). It is resolved only via
  `CAMSTACK_FRAMEWORK_DIR` with the loader `Function('m','return import(m)')` in
  `session.ts:59`. A normal `import('werift')` **fails**.
- The two repacketizers (`h264-repacketizer.ts`, `h265-repacketizer.ts`) are
  the outcome of real and costly bugs. Rewriting them is guaranteed to lose.
- A second peer would mean a **second pull from the camera**, and cameras have a limit
  of concurrent sessions.

**The obligation that follows:** the refcount of the D67 primitive **has no TTL lease**.
Whoever opens must close on their *own* error paths. `closeSession` is
mandatory on `action: 'end'`, on timeout, and on offer failure.
Track B2 tests it explicitly.

### 4. ICE / TURN

**Google does not give us TURN.** Verbatim:

> *"If you do not specify STUN servers, the platform defaults to Google's public
> STUN servers. TURN servers are only required if you cannot guarantee the IPs /
> ICE candidates provided will be publicly accessible."*

The format of `cameraStreamIceServers` is, and this is a trap, **a JSON-encoded
string**, not an object:

```
"[{\"urls\":\"stun:stun.l.google.com:19302\"},{\"urls\":\"turn:...\",\"username\":\"...\",\"credential\":\"...\"}]"
```

**The decision for v1: omit `cameraStreamIceServers` and pass
`disableTurn: true`.** The reason is topological, not laziness:

- The peer is the **Nest Hub Max in the same house**. Hub and Nest Hub are almost
  always on the same LAN. The **host** candidates pair directly.
- The ICE gathering must complete inside the synchronous POST. A TURN allocation
  costs ~1 second, and the health target published by Google is *"Query/Execute
  Latency (p90) <= 1000ms"*.
- If the operator has `addon-static-turn` or `addon-cloudflare` configured, the ICE
  list aggregated by the `turn-provider` cap already exists and is one boolean
  away.

**When it is missing:** if Nest Hub and hub are on **different VLANs without routing**, or
the hub is behind a NAT that the Nest Hub does not traverse, there is no valid pair and
the user sees black. The diagnosis is invisible on Google's side. For this Track C
provides an `iceMode` switch (`lan-only` | `with-turn`) and a log of the chosen
pair — **not a silent default.**

Two differences from Alexa that must be respected and not copied from memory:

- **`disableIpv6: false`.** Alexa sets `true` because the AWS gateway is documented
  as IPv4-only and IPv6 candidates consume its budget. Google asks for the opposite:
  *"It is strongly recommended that you include UDP/IPv4, TCP/IPv4, UDP/IPv6 and
  TCP/IPv6 ICE candidates."*
- **`relayOnly: false`**, like Alexa, but for the opposite reason: there because the peer
  is public, here because the peer is local. In both cases forcing the relay
  would kill the path that is needed.

**`addon-cloudflare` in tunnel mode does not help the media.** Its endpoint is
`protocol: 'http' | 'https'`: it carries the *signalling*, not the ICE/DTLS/SRTP. This must be
said in the interface copy, because it is exactly the wrong assumption an
operator makes.

### 5. Authentication and account linking

Google identifies the hub with an **OAuth2 access token** that the hub itself
issued. The OAuth server already exists and is core:

- `GET|POST /api/oauth2/authorize` and `POST /api/oauth2/token`
  (`server/backend/src/api/oauth2/oauth2-routes.ts`), grants `authorization_code` and
  `refresh_token` — exactly the two Google requires.
- The addon declares **one static descriptor** and nothing else. Per D101 there is
  no allow-list, no registration, no per-integration branch.
- `client_id` / `client_secret` are **not verified by the hub** by choice
  (ADR-0092): what binds the code to the requester is the `redirect_uri` compared
  with `allowedRedirectPrefixes`.

Google's redirect is fixed and per project:
`https://oauth-redirect.googleusercontent.com/r/<project-id>`.

**Secrets — and the precedent NOT to copy.**
`packages/addon-export-alexa/src/public-skill.ts` contains a **real LWA client secret,
in clear, committed**. The file explains why and for Alexa the reasoning
holds: a published skill has a single set of credentials, and the real gate is the
per-user OAuth grant.

**For Google this reasoning does not hold and must not be replicated.** The JSON key
of the HomeGraph service account is a **full write credential on the Google
project**, not a client identifier. Rule for this plan:

- **No Google credential committed.** No `public-project.ts`.
- The OAuth `client_id` / `client_secret` are **invented by the operator** and pasted
  into the Google Home Developer Console; the hub does not verify them (ADR-0092), so it
  **does not need to store them**. Zero secrets to keep for v1.
- The HomeGraph service account key is needed **only** by `RequestSync` /
  `ReportState`, which Track B2 **defers**. When it arrives: a
  `type: 'password'` field in the settings, and **a decision record** that says out
  loud that the settings are SQLite **in clear** and that the `password` field is only
  an interface mask (`config-ui.ts:1351`) — the value travels in
  clear to the admin UI at every read.

---

## Part 2 — What NOT to do, and why

1. **Do not import werift, do not build an `RTCPeerConnection`, do not touch
   RTP.** Reason: D9, the patched host-provided loader, and the two repacketizers
   that are scars. The seam is **a tRPC mutation**.
2. **Do not write a `GOOGLE_EGRESS_PROFILE`.** The H.265→H.264 re-encoding already starts
   by itself with `WEBRTC_EGRESS_PROFILE`. If a profile were really needed, it goes in
   `packages/types/src/ffmpeg/encode-defaults.ts`, **never** a local copy.
3. **Do not use `cameraStreams.getRtspEntries`.** It is declared LIVE-VIEW ONLY: two
   consumers on the raw variants end up on two different physical pulls and
   trigger the camera's session limit. For us in any case the road is
   `pickStream` + `webrtcSession`, not an RTSP URL.
4. **Do not write a cloud shim (Cloud Function/Cloud Run) in v1.** It is needed only
   when there is **one** published Google project for N hubs. As long as the operator
   uses their own project, it is pure complexity. It is to be designed when aiming at
   certification, not before.
5. **Do not `await` the public URL detection inside `onInitialize`.**
   Measured precedent (`export-alexa.addon.ts:272`): it blocked the return of
   `onInitialize`, so `device-export` and `addon-routes` were never
   registered and the addon stayed in "Still waiting for capability" forever.
   Detect **after** the return, and retry on `EventCategory.NetworkTunnelStarted`.
6. **Do not use generic per-device setting keys.** The aggregated form
   flattens by `key` across sections: `enabled` collides with HAP's and Alexa's,
   last writer wins. **Always `gh:${deviceId}:…`.**
7. **Do not declare `hls` or `progressive_mp4` in `cameraStreamSupportedProtocols`.**
   This repo **has no HLS path** — verified, zero occurrences of
   `m3u8` in `stream-broker/`. Declaring a protocol we do not serve produces
   `streamUnplayable` on the phone instead of a clean degradation.
8. **Do not treat a Google `200` as delivery.** Same lesson as Alexa,
   measured: the envelope is accepted, the content silently discarded. The real
   acknowledgement is that the video appears.
9. **Do not add a new capability nor touch a `*.cap.ts`.** Everything
   needed exists: `device-export`, `addon-routes`, `oauth-integration`,
   `network-access`, `webrtc-session`, `camera-streams`, `turn-provider`.

---

## File structure

| File | Responsibility | Track |
| --- | --- | --- |
| `packages/addon-export-google-home/package.json` | **NEW** — manifest in `camstack.addons[0]`, three capabilities | A5 | <!-- drift-ok: this plan creates it -->
| `packages/addon-export-google-home/vite.config.ts` | **NEW** — `buildLibPreset`, `externals: 'self-contained'`, TWO entries | A5 | <!-- drift-ok: this plan creates it -->
| `src/intents.ts` | **NEW** — pure parse of the SYNC/QUERY/EXECUTE/DISCONNECT envelope | A1 | <!-- drift-ok: this plan creates it -->
| `src/sync-payload.ts` | **NEW** — builds the SYNC devices from the exposed ones | A2 | <!-- drift-ok: this plan creates it -->
| `src/signaling-url.ts` | **NEW** — HMAC-signed signalling URL with TTL | A3 | <!-- drift-ok: this plan creates it -->
| `src/protocol-select.ts` | **NEW** — `SupportedStreamProtocols` → `webrtc` or a motivated refusal | A4 | <!-- drift-ok: this plan creates it -->
| `src/oauth-integration.ts` | **NEW** — `OauthIntegrationDescriptor` (trace of Alexa) | A5 | <!-- drift-ok: this plan creates it -->
| `src/http-server.ts` | **NEW** — the two `addon-routes` routes + bearer guard | A5 | <!-- drift-ok: this plan creates it -->
| `src/google-home-export.addon.ts` | **NEW** — the `BaseAddon` class, settings, wiring | A5, C1 | <!-- drift-ok: this plan creates it -->
| `src/stream-target.ts` | **NEW** — `pickStream` + Google constraints → `WebrtcStreamTarget` | B1 | <!-- drift-ok: this plan creates it -->
| `src/rtc-signaling.ts` | **NEW** — offer→answer→end, session map, teardown | B2 | <!-- drift-ok: this plan creates it -->
| `src/index.ts` | **NEW** — barrel | A5 | <!-- drift-ok: this plan creates it -->
| (planning repo: sessions/sessions.md) | append: what was learned, where the first hypothesis was wrong | end | <!-- drift-ok: moved to the private planning repo -->
| `docs/decisions/adr-XXXX.md` | record: why no cloud shim, why no committed secret | end | <!-- drift-ok: this plan creates it -->

All the `src/` are under `packages/addon-export-google-home/`. <!-- drift-ok: this plan creates it -->

---

## Track A — the addon speaks Google (no media)

This whole track is **pure logic**. No network, no Google, no
broker. It must be able to run offline and must be finished before touching the hub.

### Task A1: the fulfillment envelope, parsed only once

Google sends four intents on **a single** endpoint. Getting the parsing wrong
means answering `200` with a body that Google silently discards — the most
expensive failure of this integration.

**Files:**
- Create: `packages/addon-export-google-home/src/intents.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-export-google-home/src/__tests__/intents.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `parseFulfillmentRequest(body: unknown): ParsedFulfillment`
- `ParsedFulfillment` is a **discriminated union** on `kind`, with an
  `'unsupported'` branch that carries the reason — never a throw, never a mute `null`.

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { parseFulfillmentRequest } from '../intents.js'

describe('parseFulfillmentRequest', () => {
  it('recognises SYNC', () => {
    const parsed = parseFulfillmentRequest({
      requestId: 'req-1',
      inputs: [{ intent: 'action.devices.SYNC' }],
    })
    expect(parsed).toEqual({ kind: 'sync', requestId: 'req-1' })
  })

  it('extracts the deviceIds from QUERY', () => {
    const parsed = parseFulfillmentRequest({
      requestId: 'req-2',
      inputs: [{ intent: 'action.devices.QUERY', payload: { devices: [{ id: '102' }, { id: '101' }] } }],
    })
    expect(parsed).toEqual({ kind: 'query', requestId: 'req-2', deviceIds: [102, 101] })
  })

  it('extracts deviceId + requested protocols from GetCameraStream', () => {
    const parsed = parseFulfillmentRequest({
      requestId: 'req-3',
      inputs: [{
        intent: 'action.devices.EXECUTE',
        payload: {
          commands: [{
            devices: [{ id: '102' }],
            execution: [{
              command: 'action.devices.commands.GetCameraStream',
              params: { StreamToChromecast: true, SupportedStreamProtocols: ['webrtc'] },
            }],
          }],
        },
      }],
    })
    expect(parsed).toEqual({
      kind: 'get-camera-stream',
      requestId: 'req-3',
      deviceIds: [102],
      supportedProtocols: ['webrtc'],
    })
  })

  it('recognises DISCONNECT', () => {
    expect(parseFulfillmentRequest({ requestId: 'r', inputs: [{ intent: 'action.devices.DISCONNECT' }] }))
      .toEqual({ kind: 'disconnect', requestId: 'r' })
  })

  it('NAMES the reason instead of throwing — an intent we do not serve', () => {
    // A throw here would become a 500, and Google retries. An explicit branch
    // makes us answer 200 with an error the operator reads in the log.
    const parsed = parseFulfillmentRequest({
      requestId: 'r',
      inputs: [{ intent: 'action.devices.EXECUTE', payload: { commands: [{
        devices: [{ id: '1' }],
        execution: [{ command: 'action.devices.commands.OnOff', params: { on: true } }],
      }] } }],
    })
    expect(parsed).toEqual({ kind: 'unsupported', requestId: 'r', reason: 'command:action.devices.commands.OnOff' })
  })

  it('a non-conforming body does not throw', () => {
    expect(parseFulfillmentRequest({ nope: true })).toEqual({
      kind: 'unsupported', requestId: '', reason: 'malformed-body',
    })
  })

  it('a non-numeric id is discarded, it does not fail the whole request', () => {
    const parsed = parseFulfillmentRequest({
      requestId: 'r',
      inputs: [{ intent: 'action.devices.QUERY', payload: { devices: [{ id: 'foo' }, { id: '102' }] } }],
    })
    expect(parsed).toEqual({ kind: 'query', requestId: 'r', deviceIds: [102] })
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-export-google-home intents`
      Expected: `Cannot find module '../intents.js'`.

- [ ] **Step 3 — implement.** A Zod schema for the envelope, `safeParse`, and a
      discriminated union on output. `z.infer<>` for the types — never rewrite the
      shape by hand. No `throw` on the parsing path.

- [ ] **Step 4 — green, then DISARM.** Break the `get-camera-stream` branch
      (return `unsupported`) and confirm the test turns red. Report.

---

### Task A2: the SYNC payload

Google keeps **its own copy** of the cameras, updated only by a SYNC. Every
wrong field here is a device that does not appear, or appears without the
CameraStream trait.

**Files:**
- Create: `packages/addon-export-google-home/src/sync-payload.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-export-google-home/src/__tests__/sync-payload.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `buildSyncDevices(entries: readonly ExposedCameraEntry[]): GoogleSyncDevice[]`
- Consumes: the list exposed by the addon (same `exposed[]` shape as HAP/Alexa)

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { buildSyncDevices, type ExposedCameraEntry } from '../sync-payload.js'

const entry = (over: Partial<ExposedCameraEntry> = {}): ExposedCameraEntry => ({
  deviceId: 102, displayName: 'Entrance', ...over,
})

describe('buildSyncDevices', () => {
  it('declares ONLY webrtc — this repo has no HLS path', () => {
    // Declaring 'hls' without serving it produces streamUnplayable on the phone
    // instead of a clean degradation. Verified: zero m3u8 in the broker.
    const [dev] = buildSyncDevices([entry()])
    expect(dev?.attributes.cameraStreamSupportedProtocols).toEqual(['webrtc'])
  })

  it('uses the deviceId as a string id and the type CAMERA', () => {
    const [dev] = buildSyncDevices([entry()])
    expect(dev?.id).toBe('102')
    expect(dev?.type).toBe('action.devices.types.CAMERA')
    expect(dev?.traits).toEqual(['action.devices.traits.CameraStream'])
  })

  it('asks for an auth token and does NOT ask for DRM', () => {
    const [dev] = buildSyncDevices([entry()])
    expect(dev?.attributes.cameraStreamNeedAuthToken).toBe(true)
    expect(dev?.attributes.cameraStreamNeedDrmEncryption).toBe(false)
  })

  it('an empty name does NOT become an empty string in the app', () => {
    const [dev] = buildSyncDevices([entry({ displayName: '' })])
    expect(dev?.name.name).toBe('Camera 102')
  })

  it('willReportState is false until ReportState exists', () => {
    // Declaring it true without implementing it makes Google wait for updates
    // that never arrive.
    const [dev] = buildSyncDevices([entry()])
    expect(dev?.willReportState).toBe(false)
  })

  it('empty list → empty array, not a throw', () => {
    expect(buildSyncDevices([])).toEqual([])
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement.**
- [ ] **Step 4 — green, then DISARM** (put `'hls'` back in the protocols and confirm
      red). Report.

---

### Task A3: the signed signalling URL

Google keeps the `cameraStreamSignalingUrl` and POSTs on it. It must be
authenticated **statelessly**: an in-memory token map does not survive an
addon restart, and the operator would see black after every deploy.

The UniFi bridge in Go uses exactly this scheme with a TTL of 2 minutes. We
reuse `timingSafeEqualStr` — the same primitive as
`addon-export-alexa/src/ingress-token.ts`.

**Files:**
- Create: `packages/addon-export-google-home/src/signaling-url.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-export-google-home/src/__tests__/signaling-url.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `signSignalingPath(input: SignInput): string` and
  `verifySignalingSignature(input: VerifyInput): SignalingVerdict`
- `SignalingVerdict` is a discriminated union: `{ ok: true }` | `{ ok: false, reason }`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { signSignalingPath, verifySignalingSignature } from '../signaling-url.js'

const SECRET = 'test-secret-32-bytes-worth-of-entropy'
const NOW = 1_800_000_000_000

describe('signaling url', () => {
  it('a freshly issued signature verifies', () => {
    const path = signSignalingPath({ deviceId: 102, secret: SECRET, now: NOW, ttlMs: 120_000 })
    const url = new URL(`https://hub.example${path}`)
    expect(
      verifySignalingSignature({
        deviceId: 102, secret: SECRET, now: NOW + 1_000,
        exp: url.searchParams.get('exp') ?? '', sig: url.searchParams.get('sig') ?? '',
      }),
    ).toEqual({ ok: true })
  })

  it('EXPIRES — an old URL does not open a session', () => {
    const path = signSignalingPath({ deviceId: 102, secret: SECRET, now: NOW, ttlMs: 120_000 })
    const url = new URL(`https://hub.example${path}`)
    expect(
      verifySignalingSignature({
        deviceId: 102, secret: SECRET, now: NOW + 120_001,
        exp: url.searchParams.get('exp') ?? '', sig: url.searchParams.get('sig') ?? '',
      }),
    ).toEqual({ ok: false, reason: 'expired' })
  })

  it('the signature is BOUND to the deviceId — it is not reused on another camera', () => {
    const path = signSignalingPath({ deviceId: 102, secret: SECRET, now: NOW, ttlMs: 120_000 })
    const url = new URL(`https://hub.example${path}`)
    expect(
      verifySignalingSignature({
        deviceId: 101, secret: SECRET, now: NOW,
        exp: url.searchParams.get('exp') ?? '', sig: url.searchParams.get('sig') ?? '',
      }),
    ).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('a tampered exp does not pass (the expiry is SIGNED, not just read)', () => {
    const path = signSignalingPath({ deviceId: 102, secret: SECRET, now: NOW, ttlMs: 120_000 })
    const url = new URL(`https://hub.example${path}`)
    expect(
      verifySignalingSignature({
        deviceId: 102, secret: SECRET, now: NOW,
        exp: String(NOW + 999_999_999), sig: url.searchParams.get('sig') ?? '',
      }),
    ).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('an empty secret REJECTS instead of accepting everything', () => {
    // Alexa's verifyIngressToken returns true on an empty expected (opt-in).
    // Here it is the opposite: this signature is the ONLY guard of the route,
    // so "not configured" must close, not open.
    expect(verifySignalingSignature({ deviceId: 102, secret: '', now: NOW, exp: '1', sig: 'x' }))
      .toEqual({ ok: false, reason: 'not-configured' })
  })

  it('missing sig or exp → motivated rejection, never a throw', () => {
    expect(verifySignalingSignature({ deviceId: 102, secret: SECRET, now: NOW, exp: '', sig: '' }))
      .toEqual({ ok: false, reason: 'missing' })
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement** with `crypto.createHmac('sha256', secret)` on
      `${deviceId}.${exp}`, output `base64url`, comparison with `timingSafeEqualStr`.
      The secret is generated with `crypto.randomBytes(32).toString('base64url')` at
      first start and persisted with `updateGlobalSettings`.
- [ ] **Step 4 — green, then DISARM** (remove `deviceId` from the signed material and
      confirm the "bound to the deviceId" test turns red). Report.

---

### Task A4: the protocol choice, with the reason

**Files:**
- Create: `packages/addon-export-google-home/src/protocol-select.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-export-google-home/src/__tests__/protocol-select.spec.ts` <!-- drift-ok: this plan creates it -->

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { selectStreamProtocol } from '../protocol-select.js'

describe('selectStreamProtocol', () => {
  it('chooses webrtc when it is offered', () => {
    expect(selectStreamProtocol(['webrtc'])).toEqual({ kind: 'webrtc' })
  })

  it('chooses webrtc even when it is among others', () => {
    expect(selectStreamProtocol(['hls', 'progressive_mp4', 'webrtc'])).toEqual({ kind: 'webrtc' })
  })

  it('REJECTS with the reason when the surface does not speak webrtc', () => {
    // The phone asks for hls. We have no HLS path: rejecting with
    // 'streamUnavailable' is honest, returning a URL we do not serve is not.
    expect(selectStreamProtocol(['hls'])).toEqual({
      kind: 'unsupported', requested: ['hls'], errorCode: 'streamUnavailable',
    })
  })

  it('an empty list is a rejection, not an implicit webrtc', () => {
    expect(selectStreamProtocol([])).toEqual({
      kind: 'unsupported', requested: [], errorCode: 'streamUnavailable',
    })
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement.**
- [ ] **Step 4 — green, then DISARM.** Report.

---

### Task A5: the package, the manifest, the routes, the OAuth

Here **the `add-addon` skill is invoked** instead of rebuilding the procedure. Wiring
point number 2 (the `entries` map in `vite.config.ts`) compiles
perfectly and blows up at runtime.

- [ ] **Step 1 — invoke the `add-addon` skill** and follow its four wiring
      points. Own package: `packages/addon-export-google-home/`. <!-- drift-ok: this plan creates it -->

- [ ] **Step 2 — the manifest**, in `package.json` → `camstack.addons[0]`,
      traced on `addon-export-alexa`:

```json
"camstack": {
  "displayName": "Google Home Export",
  "addons": [
    {
      "id": "google-home-export",
      "category": "exports",
      "name": "Google Home Export",
      "description": "Publishes exposed CamStack cameras to Google Home as a Cloud-to-cloud integration, streaming over WebRTC to Nest smart displays and Chromecast.",
      "entry": "./dist/google-home-export.addon.js",
      "execution": { "placement": "hub-only" },
      "capabilities": [
        { "name": "device-export" },
        { "name": "addon-routes" },
        { "name": "oauth-integration" }
      ],
      "icon": "assets/icon.svg",
      "color": "#4285F4"
    }
  ]
}
```

  **No `execution.group`** — D2: an addon without a group gets its own
  runner, and that is what we want. The group serves only those who pass live JS objects
  through the cap surface.

- [ ] **Step 3 — `vite.config.ts` with TWO entries**, or the addon does not start:

```ts
const base: UserConfig = buildLibPreset({
  entries: { index: 'src/index.ts', 'google-home-export.addon': 'src/google-home-export.addon.ts' },
  externals: 'self-contained',
})
```

  `externals: 'self-contained'` is mandatory: the addon's folder on a hub
  has no `node_modules`.

- [ ] **Step 4 — the OAuth descriptor**, in `src/oauth-integration.ts`. It is a
      trace of Alexa's, with Google's prefixes:

```ts
import type { OauthIntegrationDescriptor } from '@camstack/types'

/**
 * Google always redirects to a fixed URI per project. The `/r/` prefix is
 * the production one; `oauth-redirect-sandbox` is the one the console uses
 * during testing on one's own account — BOTH are needed or the link fails
 * exactly in the test scenario.
 */
const GOOGLE_REDIRECT_PREFIXES = [
  'https://oauth-redirect.googleusercontent.com/r/',
  'https://oauth-redirect-sandbox.googleusercontent.com/r/',
] as const

export function buildGoogleOauthIntegration(
  publicHubUrl: string | undefined,
): OauthIntegrationDescriptor {
  return {
    integrationId: 'google-home-export',
    displayName: 'Google Home',
    requestedScopes: [{ type: 'category', target: 'device', access: ['view'] }],
    allowedRedirectPrefixes: [...GOOGLE_REDIRECT_PREFIXES],
    // Google treats a link as permanent, exactly like Alexa.
    refreshTokenTtlSec: 'never',
    ...(publicHubUrl ? { hubUrl: publicHubUrl } : {}),
  }
}
```

  **Two things that bite:** the descriptor must be **synchronous** (it is read
  on the hot path of `/authorize`, and a provider goes live only when
  `onInitialize` RETURNS); and the scopes are **frozen at consent** — widening them
  afterwards changes only future links, not those already made.

- [ ] **Step 5 — the two routes**, in `src/http-server.ts`. Both
      `access: 'public'` and self-authenticating, exactly like Alexa's `/directive`.
      Public + self-authenticating means it is **not necessary** to declare
      an `addon:` scope (otherwise D103 gives a 403 on every call):

```ts
const routes: IAddonHttpRoute[] = [
  {
    method: 'POST', path: '/fulfillment', access: 'public',
    description: 'Google Cloud-to-cloud fulfillment (SYNC / QUERY / EXECUTE / DISCONNECT)',
    handler: (req, reply) => handleFulfillment(req, reply, deps),
  },
  {
    method: 'POST', path: '/rtc/:deviceId', access: 'public',
    description: 'WebRTC signalling (offer / answer / end), authenticated by a signed URL',
    handler: (req, reply) => handleSignaling(req, reply, deps),
  },
]
```

  `/fulfillment` verifies the bearer with
  `ctx.api.userManagement.oauthVerifyAccessToken.query({ token })`; `/rtc/:deviceId`
  verifies the signature of A3. **The arrival log goes BEFORE the OAuth verification and
  stays at `info`**: it must answer "did the request reach the addon?"
  regardless of the authentication outcome. It is the same rule that Alexa's
  file protects with a comment.

- [ ] **Step 6 — the public URL, without `await` in `onInitialize`.** Copy the
      pattern of `export-alexa.addon.ts:944-995`: `networkAccess.listEndpoints`,
      fallback on `getStatus`, and subscription to
      `EventCategory.NetworkTunnelStarted` for the boot race (the tunnel
      almost always connects **after** the addon).

- [ ] **Step 7 — verify the wiring:**

```bash
npx tsx scripts/check-addon-entries.ts
npm run typecheck && npm run test
npm run build -w packages/addon-export-google-home && ls packages/addon-export-google-home/dist/
```

  The last `ls` must show **`google-home-export.addon.js`**. If it is missing,
  step 3 was skipped and the addon will fail at runtime with everything green in CI.

---

## Track B — the video plane

Independent of A. Can start in parallel.

### Task B1: choose the source stream, and name the cost

This is the function that decides whether the operator pays a core or not. It must be
pure and must **say** what it chose and why.

**Files:**
- Create: `packages/addon-export-google-home/src/stream-target.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-export-google-home/src/__tests__/stream-target.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `resolveGoogleStreamTarget(picked: PickedCamStream | null): GoogleStreamPlan`
- `GoogleStreamPlan = { target: WebrtcStreamTarget; transcode: boolean; reason: string }`
- Consumes: the result of `ctx.api.cameraStreams.pickStream.query(...)`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { resolveGoogleStreamTarget, type PickedCamStream } from '../stream-target.js'

const picked = (over: Partial<PickedCamStream> = {}): PickedCamStream => ({
  camStreamId: 'native:main', codec: 'h264',
  resolution: { width: 1920, height: 1080 }, reason: 'match', ...over,
})

describe('resolveGoogleStreamTarget', () => {
  it('H.264 within 1080p → passthrough on the chosen cam-stream, no re-encoding', () => {
    const plan = resolveGoogleStreamTarget(picked())
    expect(plan.target).toEqual({ kind: 'cam-stream', camStreamId: 'native:main' })
    expect(plan.transcode).toBe(false)
  })

  it('H.264 in 4K → NOT passthrough: Google declares 1080p as the maximum', () => {
    // It is not documented what the Nest Hub does with a 4K. The ceiling is declared,
    // so we respect it instead of discovering it on a black screen.
    const plan = resolveGoogleStreamTarget(picked({ resolution: { width: 3840, height: 2160 } }))
    expect(plan.transcode).toBe(true)
    expect(plan.target).toEqual({ kind: 'adaptive' })
    expect(plan.reason).toContain('above-1080p')
  })

  it('no H.264 available (HEVC-only camera) → adaptive, and the cost is NAMED', () => {
    // pickStream returns null when no stream satisfies acceptCodecs.
    // The session re-encodes by itself via resolveVideoTranscode; here we just
    // declare it, because it is the log line that explains the CPU to the operator.
    const plan = resolveGoogleStreamTarget(null)
    expect(plan.target).toEqual({ kind: 'adaptive' })
    expect(plan.transcode).toBe(true)
    expect(plan.reason).toContain('no-h264-source')
  })

  it('the low-resolution H.264 sibling is preferred over a re-encode of the HEVC main', () => {
    const plan = resolveGoogleStreamTarget(picked({ camStreamId: 'native:sub', resolution: { width: 896, height: 512 } }))
    expect(plan.transcode).toBe(false)
    expect(plan.target).toEqual({ kind: 'cam-stream', camStreamId: 'native:sub' })
  })

  it('under 480p the plan says so — Google declares 480p as the minimum', () => {
    const plan = resolveGoogleStreamTarget(picked({ resolution: { width: 640, height: 360 } }))
    expect(plan.reason).toContain('below-480p')
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement.** The caller will use
      `pickStream({ deviceId, requirements: { acceptCodecs: ['h264'] } })`.
      `pickStream` **never classifies** a `derived:*` candidate as a match,
      so a `null` really means "no native H.264 source".
- [ ] **Step 4 — green, then DISARM** (remove the check on 1080p) and confirm
      red. Report.

---

### Task B2: offer → answer → end

The heart. One handler, three actions, and a release obligation that has no safety
net: **the refcount of the D67 primitive has no TTL lease.**

**Files:**
- Create: `packages/addon-export-google-home/src/rtc-signaling.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-export-google-home/src/__tests__/rtc-signaling.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `handleSignalingAction(input: SignalingActionInput): Promise<SignalingActionResult>`
- Consumes: `ctx.api.webrtcSession.handleOffer` / `.closeSession`, injected as a
  dependency (no network in the tests)

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleSignalingAction } from '../rtc-signaling.js'

const deps = () => {
  const handleOffer = vi.fn(async () => ({ sessionId: 'sess-1', sdpAnswer: 'v=0\r\nANSWER' }))
  const closeSession = vi.fn(async () => undefined)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withTags: vi.fn(() => logger) }
  return { handleOffer, closeSession, logger, sessions: new Map<string, string>() }
}

describe('handleSignalingAction', () => {
  it("an offer returns the answer in the SAME response", async () => {
    const d = deps()
    const res = await handleSignalingAction({
      action: 'offer', deviceId: 102, sdp: 'v=0\r\nOFFER',
      plan: { target: { kind: 'cam-stream', camStreamId: 'native:sub' }, transcode: false, reason: 'match' },
      ...d,
    })
    expect(res).toEqual({ status: 200, body: { action: 'answer', sdp: 'v=0\r\nANSWER' } })
  })

  it('forces nonTrickle — Google FORBIDS trickle ICE', async () => {
    const d = deps()
    await handleSignalingAction({
      action: 'offer', deviceId: 102, sdp: 'o',
      plan: { target: { kind: 'adaptive' }, transcode: true, reason: 'no-h264-source' }, ...d,
    })
    expect(d.handleOffer).toHaveBeenCalledWith(expect.objectContaining({ nonTrickle: true }))
  })

  it('does NOT disable IPv6 — unlike Alexa, Google recommends it', async () => {
    const d = deps()
    await handleSignalingAction({
      action: 'offer', deviceId: 102, sdp: 'o',
      plan: { target: { kind: 'adaptive' }, transcode: false, reason: 'match' }, ...d,
    })
    expect(d.handleOffer).toHaveBeenCalledWith(expect.objectContaining({ disableIpv6: false }))
  })

  it("attributes the session so that it shows up in the broker panel", async () => {
    const d = deps()
    await handleSignalingAction({
      action: 'offer', deviceId: 102, sdp: 'o',
      plan: { target: { kind: 'adaptive' }, transcode: false, reason: 'match' }, ...d,
    })
    expect(d.handleOffer).toHaveBeenCalledWith(
      expect.objectContaining({ consumerAttribution: expect.objectContaining({ kind: 'google-home' }) }),
    )
  })

  it("'end' CLOSES the session — without this the broker forwards forever", async () => {
    const d = deps()
    d.sessions.set('102', 'sess-1')
    const res = await handleSignalingAction({ action: 'end', deviceId: 102, sdp: '', plan: null, ...d })
    expect(d.closeSession).toHaveBeenCalledWith({ deviceId: 102, sessionId: 'sess-1' })
    expect(d.sessions.has('102')).toBe(false)
    expect(res.status).toBe(200)
  })

  it("a FAILED offer does not leave a hanging session", async () => {
    // No 'end' will ever arrive for a session that was not born: this is the
    // only point that can clean up. Without it, an ffmpeg stays until restart.
    const d = deps()
    d.handleOffer.mockRejectedValueOnce(new Error('no keyframe'))
    const res = await handleSignalingAction({
      action: 'offer', deviceId: 102, sdp: 'o',
      plan: { target: { kind: 'adaptive' }, transcode: true, reason: 'no-h264-source' }, ...d,
    })
    expect(res.status).toBe(500)
    expect(d.sessions.size).toBe(0)
    expect(d.logger.error).toHaveBeenCalled()
  })

  it("a second offer on the same camera CLOSES the previous one", async () => {
    const d = deps()
    d.sessions.set('102', 'sess-old')
    await handleSignalingAction({
      action: 'offer', deviceId: 102, sdp: 'o',
      plan: { target: { kind: 'adaptive' }, transcode: false, reason: 'match' }, ...d,
    })
    expect(d.closeSession).toHaveBeenCalledWith({ deviceId: 102, sessionId: 'sess-old' })
  })

  it("an 'end' on an unknown session answers 200 without throwing", async () => {
    const d = deps()
    const res = await handleSignalingAction({ action: 'end', deviceId: 999, sdp: '', plan: null, ...d })
    expect(res.status).toBe(200)
    expect(d.closeSession).not.toHaveBeenCalled()
  })

  it('every log line carries a numeric tags: { deviceId }', async () => {
    const d = deps()
    await handleSignalingAction({
      action: 'offer', deviceId: 102, sdp: 'o',
      plan: { target: { kind: 'adaptive' }, transcode: false, reason: 'match' }, ...d,
    })
    expect(d.logger.withTags).toHaveBeenCalledWith({ deviceId: 102 })
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**

- [ ] **Step 3 — implement.** The call, with every flag motivated:

```ts
const result = await deps.handleOffer({
  deviceId,
  sdpOffer: sdp,
  target: plan.target,
  // Google FORBIDS trickle: "All ICE candidates must be gathered first before
  // sending the SDP". nonTrickle takes the session onto
  // waitForIceGatheringComplete, which embeds the candidates in the answer.
  nonTrickle: true,
  // The peer is the Nest Hub on the user's LAN, not a public gateway:
  // forcing the relay would suppress exactly the host pair that is needed.
  relayOnly: false,
  // Unlike Alexa: Google explicitly recommends including
  // UDP/IPv4, TCP/IPv4, UDP/IPv6 and TCP/IPv6.
  disableIpv6: false,
  // v1: the peer is on the same LAN, the host candidates suffice, and
  // a TURN allocation costs ~1s inside a synchronous POST.
  disableTurn: iceMode === 'lan-only',
  consumerAttribution: { kind: 'google-home', sessionId },
})
```

  And, on failure, **the same diagnostic courtesy that Alexa had to build
  afterwards**: log a summary of the offer's m-sections (mid,
  kind, direction, codec) **and the full SDP**. If werift rejects a particular
  shape, the next failure must leave a reproducible case in the log
  instead of a generic line.

- [ ] **Step 4 — green, then DISARM.** Remove the close in the error branch and
      confirm that the test "a FAILED offer does not leave a hanging session"
      turns red. Report.

---

### Task B3 *(deferred — NOT for tomorrow)*: RequestSync and ReportState

It serves **certification**, not the trial. As long as the operator says "Sync
my devices" aloud or redoes the link, Google's copy updates.

When it is done, the problem to design is **the drift of the remote copy**: as
for Alexa, Google keeps its list of devices and nothing that changes
here reaches it by itself. The solution already written in this repo is
`endpoint-signature.ts` (signature of the declared shape, not a timestamp) plus a
reconcile with debounce on `DeviceBindingsChanged`. It must be **ported**, not
reinvented. The HomeGraph service account key enters only in this task,
with the decision record required in §5.

---

## Track C — what the operator sees

Depends on A. Small, but it is the difference between "it works" and "the operator manages
to make it work".

### Task C1: the setup block

- [ ] **Step 1** — In the `getStatus()` of the `device-export` provider, populate
      the `setup` block (schema `ExportSetupSchema`, rendered by the shared
      `DeviceExportPanel`) with **the three lines the operator must copy into the Google
      console**, each with the copy button:

  | Label | Value |
  | --- | --- |
  | Fulfillment URL | `<publicHubUrl>/addon/google-home-export/fulfillment` |
  | OAuth Authorization URL | `<publicHubUrl>/api/oauth2/authorize?integration=google-home-export` |
  | OAuth Token URL | `<publicHubUrl>/api/oauth2/token` |

- [ ] **Step 2** — When `publicHubUrl` is empty, the block's `note` **says
      what to do**, not "not configured". Text: turn on Cloudflare Tunnel in
      *custom* mode or Tailscale Funnel, then press "Detect addresses".
      **Cloudflare's *quick* mode is not good** — it generates a different
      `*.trycloudflare.com` at every start, and the fulfillment URL in the Google
      console is fixed: it would break at every hub restart.

- [ ] **Step 3** — `select` field `publicHubUrl` fed by
      `networkAccess.listEndpoints`, plus a "Detect addresses" button, plus an
      `iceMode` `select` with `lan-only` (default) and `with-turn`. The description of
      `iceMode` names the symptom: *"use `with-turn` if the Google display is on a
      different network or VLAN from the hub"*.

### Task C2: the per-camera switch

- [ ] **Step 1** — `getDeviceSettingsContribution` with an `export` tab, **namespaced**
      keys: `gh:${deviceId}:enabled`, `gh:${deviceId}:streamPreference`.
      Generic keys collide with those of HAP and Alexa in the aggregated form
      flattened by `key`, and the last writer wins (it really happened between HAP
      and Alexa).
- [ ] **Step 2** — `applyDeviceSettingsPatch` routes `enabled` onto
      `exposeDevice` / `unexposeDevice` reading the truth at runtime
      (`this.exposed.has(id)`), not the value sent by the form.

---

## What the operator needs for tomorrow's test

To be prepared **before** sitting down together. None of this is code.

**1. A stable public HTTPS URL.** Check which of the two already exists:
- `addon-cloudflare` in **custom** mode (named tunnel on a domain of
  one's own) — **not** *quick*.
- `addon-tailscale` in **funnel** mode (stable MagicDNS name, but exposes only
  443/8443/10000).

Concrete test before starting: from a network **outside the home**,
`curl -sS -o /dev/null -w '%{http_code}\n' https://<url>/api/oauth2/integrations`
must answer `200`. If it does not answer, the day ends here — everything else
depends on this.

**2. A project in the Google Home Developer Console** (`console.home.google.com`
— the Actions on Google console has been **deprecated** since 2024-11-20), with:
- a **Cloud-to-cloud** integration;
- the Google Cloud project linked with the **HomeGraph API enabled**;
- the **Fulfillment URL** = `<publicHubUrl>/addon/google-home-export/fulfillment`;
- **Account linking**: type *OAuth*, flow *Authorization code*;
  `client_id` and `client_secret` invented by the operator (the hub does **not**
  verify them, ADR-0092); Authorization URL and Token URL from the table of C1.

**3. One's own Google account as a tester.** Certification is not needed:
> *"You can test an integration that hasn't yet been submitted for certification
> within the same project you used to develop the integration."*
> — <https://developers.home.google.com/cloud-to-cloud/test>

Other testers are added as **Viewer/Editor on the Google Cloud project**.

**4. A device that speaks WebRTC.** This is the prerequisite that surprises:
**a Nest Hub Max or a Chromecast with Google TV.** A regular Nest Hub is not enough,
and **the Google Home app on a phone does not ask for `webrtc`** — it asks for `hls`, which we
do not serve. If there is neither in the house, the test cannot be run and
this must be known today, not tomorrow.

**5. At least one always-on H.264 camera**, on the same LAN as the display, with
a stream between 480p and 1080p. It is the case that must work first. HEVC-only
cameras and battery cameras: later (see limits).

**6. The official validator as a first step**, before involving a physical
device: <https://developers.home.google.com/cloud-to-cloud/tools/webrtc-validator>.
It isolates the signalling plane from the media one and narrows the diagnosis to a single
layer.

**7. To keep open during the test:**
- the hub logs filtered on `google-home-export` (the arrival line is at `info` and
  **precedes** the OAuth verification: it answers "did it arrive?" regardless of auth);
- the stream-broker panel, where an active session appears with the badge
  `google-home` and the session chip — if it does not appear, the problem is upstream
  of the media.

---

## What remains unknown

Declared in advance, because a plan that promises a parity the protocol
does not allow is worse than one that names the limit.

**Limits of the protocol, not ours — certain:**

1. **No H.265 towards Google.** The video codecs are VP8 and H.264, period. An
   HEVC-only camera costs **one ffmpeg re-encode, about one core per session**.
   Where an H.264 sibling exists (battery Reolink) it is free, but at a lower
   resolution.
2. **`webrtc` covers only Nest Smart Display and Chromecast with Google TV.**
   Verbatim: *"WebRTC is currently supported on the Google Nest Smart Display and
   Chromecast with Google TV devices."* **Live viewing from the phone will not
   work** and it is not a bug of this plan: it would require `hls`, and this repo
   has no HLS path. Buildable in the future on the `fragments` transport of the
   D67 primitive, but it is a project of its own.
3. **`CameraStream` is not supported by local fulfillment.** The control plane
   **always** goes through the cloud, even with the display in the next room.
   A public URL is always needed.
4. **Maximum 1080p, minimum 480p.**

**Risks of this plan — to be measured, not assumed:**

5. **The EXECUTE timeout is not documented.** The only published number is a
   health target (*"Query/Execute Latency (p90) <= 1000ms"*), not an enforced limit.
   To be measured at the first test: if the first frame is late, the budget is
   discovered there.
6. **It is not documented whether a mandatory audio m-line is needed.** Google's sample
   emits audio; the production UniFi bridge is **video-only** and works.
   We start video-only; if the Nest Hub rejects the answer, the first thing to try
   is adding a `sendonly` audio m-line with Opus — the infrastructure is already there
   (`opus-encode-session.ts`, in-process, without ffmpeg).
7. **"1-way talk" is not specified enough to program against.** There is no
   `SupportsTalkback` field in the cloud-to-cloud schema. Out of scope.
8. **Sleeping battery cameras are out of scope for v1.** The signalling POST is
   synchronous and the ICE gathering must complete inside it; a camera that
   wakes up takes 3-6 seconds to produce a keyframe. Most likely
   Google times out or shows black. To be tried **after** a fixed camera works,
   never as the first test.
9. **We do not know whether the Nest Hub accepts a `profile-level-id` other than
   `42e01f`.** The broker offers Constrained Baseline 3.1 for iOS Safari; in the client
   offer it is Google that proposes and we answer, so in theory it is not a
   problem. Not verified.
10. **The new road exists but is closed.** The Home APIs have a much richer camera
    model (`WebRtcLiveView`, `startLiveView` / `extendLiveView`,
    `startTalkback`, `changeLiveViewQuality`), but they are marked
    *"restricted and not available for general use"* and are an Android **client**
    SDK, not a road for providers. For "expose my cameras to Google
    Home", cloud-to-cloud is **the only** road, and it is not deprecated: the
    release notes have entries from August 2026.

**To be clarified with the operator before starting:**

- Do they have a **Nest Hub Max or a Chromecast with Google TV**? If not, the test
  cannot be run and a different plan is needed for tomorrow.
- Is the Cloudflare tunnel in **custom** or **quick** mode? If quick, it must be
  converted first, or the integration will break at every restart.
- How many of the cameras to expose are **HEVC-only**? It determines how many cores
  a simultaneous viewing will cost.

---

## Closing

- [ ] `npm run typecheck && npm run test && npm run lint`
- [ ] `npx tsx scripts/check-addon-entries.ts`
- [ ] `npm run docs:check`
- [ ] Append to (planning repo: sessions/sessions.md): what was learned, **and where the first <!-- drift-ok: moved to the private planning repo -->
      hypothesis was wrong** (candidate already known: "the SDP offer arrives
      in the EXECUTE" is **false** — it arrives on a separate POST to the
      `cameraStreamSignalingUrl`, and it is the mistake that a quick reading of the
      documentation produces).
- [ ] Decision record in `docs/decisions/` (copy `template.md`): why
      no cloud shim in v1, and why **no Google credential committed**
      despite the precedent of `public-skill.ts`.
- [ ] `camstack deploy packages/addon-export-google-home` — modifying `src/` and
      rebuilding `dist/` **has no effect at runtime** until a deploy is done.
