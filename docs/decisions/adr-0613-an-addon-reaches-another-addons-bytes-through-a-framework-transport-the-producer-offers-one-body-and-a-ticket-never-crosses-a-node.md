---
id: D613
title: An addon reaches another addon's bytes through a FRAMEWORK transport — the producer offers ONE body behind a one-shot ticket, and a ticket never crosses a node boundary
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/types/src/interfaces/addon-peer-bytes.ts
  - packages/system/src/kernel/moleculer/addon-peer-bytes-facility.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-pipeline/src/recorder/addon/export-engine.ts
---

## Context

A clip export pulled the camera's bytes with `videoclips.readClipBytes`: a
UNARY cap call carrying base64, bounded at 50 MiB
(`VIDEOCLIPS_MAX_READ_BYTES`), because a unary envelope holds the payload whole
(~1.33×) in the provider AND again in the caller, on a hub this repo has
already OOM'd (D9/D18). Above the bound the provider refuses BY NAME — a long
`high` twin was simply not exportable. The bound's own docblock named a chunked
read as the clean follow-on.

**The bound is a property of the envelope, not of clips**, and the reason the
envelope was the only way across was traced in
[D597](./adr-0597-a-clip-plays-from-a-stream-forward-only-and-the-broker-dials-the-providers-listener-because-the-framework-has-no-addon-to-addon-byte-transport.md)
and re-verified here. An addon cannot reach another addon's bytes through
either door the framework has:

- the data-plane listener binds `127.0.0.1` behind a per-listener secret that
  **only the hub** presents (`addon-data-plane-facility.ts`, the
  `DATAPLANE_SECRET_HEADER` check);
- the hub's `/addon/<id>/…` proxy in front of it takes a session cookie, a
  `cst_` token scoped `{type:'addon'}` or a JWT (`server/backend/src/main.ts`),
  and an addon holds none of those — minting a scoped token from inside an
  addon would be a user action performed by a process;
- `ctx.api.<cap>.subscribe` is refused on an addon caller by design
  (`addon-api-factory.ts`), so a streaming cap method is not available either.

The repo worked around that gap **twice, identically**: a cap call mints a URL
carrying a token and the consumer dials it directly — the broker's restreams
(`getStreamWithCodec`, dialled by the recorder and HomeKit) and the clip dial
(`videoclips.dialClipStream`, D597, which spells the missing facility in its
own title). Each pair rebuilt an `http.createServer`, a token map, a TTL, a
sweep, a one-shot rule, an outstanding bound, a backpressure gate and a
consumer-side opener. D597 named the facility as the open question for the
operator; he chose it over the chunked read, without hedging.

**What was tried first, in the thinking, and rejected.** The obvious framework
shape is `ctx.dataPlane.dial(addonId, prefix)`: the hub, which already holds
every addon's `{baseUrl, secret}` in its `DataPlaneRegistry`, hands the
consumer what it needs. It is rejected on authority. The hub cannot identify
an addon CALLER on that path — a core router reached from an addon arrives
with a synthetic admin principal (`createMeshTrpcContext`), and
`docs/architecture/transport.md` states the consequence outright: *tRPC auth is
not a boundary between addons*. So the hub would be minting on an unauthenticated
ask. And what it would hand over is a standing credential good for **every
prefix that addon serves**, in place of the per-request consent the two
precedents already have. A hub-minted path-scoped HMAC ticket fixes the second
problem and not the first.

## Decision

**`ctx.peerBytes` is the addon→addon byte transport, and the mechanism is the
framework's while the CONSENT stays the producer's.**

1. **Nothing is reachable that was not OFFERED.** There is no
   `dial(addonId, path)` and a consumer cannot address a producer at all. A
   producer calls `peerBytes.offer(...)` — from inside a cap method it already
   gates — and gets a `PeerBytesTicket` it may hand back as that method's
   answer. That is the whole authority model. It is the model both precedents
   already use; what this record changes is that they stop each writing it.
   The hub's data-plane secret is **not touched**: this is a second listener
   with its own per-offer tokens, so "only the hub presents the data-plane
   secret" is preserved by leaving it alone rather than by widening it.

2. **One offer is ONE body and ONE take.** 24 random bytes, base64url, on a
   lazily-bound loopback listener in the producer's own process. The first
   `GET` takes it; a second is `offer-used` (410) for as long as the original
   ticket would have lived, so a replay is told what happened rather than "no
   such thing". `HEAD` answers the headers and consumes nothing. Outstanding
   offers are swept on every mint and bounded at 64 (`offer-exhausted`).

3. **Same host only, refused BY NAME across a node boundary.** The listener is
   loopback, so a ticket minted on `agent-a` names a URL that means
   something else entirely on the hub — and device providers RUN ON AGENTS, so
   this is a live branch and not a hypothetical. Every ticket carries the
   `hostNodeId` it was minted on; `open()` compares it to its own and refuses
   `cross-node` **without dialling**, naming both nodes. A runner's node id is
   `<hostNode>/<runnerId>`, so the comparison is on the HOST part — comparing
   the whole id would refuse exactly the hub-runner-to-hub-runner case the
   facility exists for. Widening this means exposing an addon's listener on a
   routable interface, which is a security decision for the operator and not a
   refactor; it is NOT taken here.

4. **The producer writes no chunk the socket has not taken** (D447). `write()`'s
   return is honoured, `drain` is awaited, and a peer that has taken nothing
   for 15 s is CUT. Listeners are attached and removed per wait rather than
   raced, because a `Promise.race` of two `events.once` leaves the loser's
   listener on the response and a multi-megabyte body drains many times. Every
   exit — minted, taken, sent, cut, stalled, expired-untaken, refused, disposed
   — is one log line, carrying `tags: { deviceId }` when the offer named a
   device.

5. **The consumer's response is handed over PAUSED, and that is why `open()`
   lives in the framework.** Node flushes the body bytes it already holds on
   `process.nextTick` the moment a `data` listener attaches, and that tick runs
   BEFORE the promise continuation a consumer would use to get ready — which is
   how the broker's first dial threw away the head of every stream (`ftyp`,
   `moov`) while fourteen unit tests stayed green, because the fake opener only
   ever delivered after the `await` (D597). Nothing flows until the consumer
   reads. Every test in this record's suite drives REAL loopback sockets for
   that reason: a fake cannot reproduce the bug, a socket can.

6. **This is not a frame pipe.** One offer carries one body, taken once, with a
   seconds-long TTL and a bound on outstanding offers — so a caller minting an
   offer per frame exhausts the bound inside a second and is refused by name
   rather than working slowly. Media crosses a process boundary here the way
   D9/D18 already allow: on demand, compressed, by handle.

**`videoclips.offerClipBytes` is `readClipBytes` with the envelope removed** —
same gates, same order, same refusal vocabulary, same `served` contract, and a
`provider` pin that is still REQUIRED (D592/D593/D594 do not get relaxed by a
new transport). Hikvision's fetch already lands the clip in a scratch FILE and
offers THAT, so nothing is held on either side; Reolink's cmd-5 transfer is
collected in memory and offers the copy it already had. The clip export prefers
it, streams the body straight into the export file, and applies the plausible-
bytes floor to the result — removing the file if it fails, because half a video
is worse than an honest refusal.

## Consequences

- **The new bound is `VIDEOCLIPS_MAX_OFFER_BYTES = 500 MiB`, and it bounds a
  different thing.** 50 MiB of clip was ~133 MiB of heap across two processes;
  over `peerBytes` the consumer's contribution is one socket chunk whatever the
  clip weighs, so what is left is the PRODUCER's own copy — nothing on
  Hikvision, one plain copy on Reolink. The number therefore bounds the worst
  provider, not the transport, and it is a separate constant so that lifting it
  is a statement about a provider. It is ten times the inline bound and above
  every measured main twin (a 16 s main clip measured 455 KB; the largest
  Hikvision segment seen was 42.7 MB). A test asserts the two constants are not
  equal, because a later "unification" would silently restore the refusal this
  record exists to remove.
- **A provider that has not been redeployed answers `NOT_IMPLEMENTED`**, and the
  engine falls back to the inline read — NAMED, with `hint: camstack deploy
  <provider>` and the inline bound on the line. That fallback re-imposes 50 MiB,
  so an operator seeing `too-large-to-transfer` after this ships is looking at a
  stale addon rather than a clip that cannot be exported. With no inline read
  wired, it refuses by name instead; it never reads as "this clip has no bytes".
- **A cross-node clip export is now a NAMED failure where it used to work.**
  The engine prefers the streamed path, and a provider on an agent mints a
  ticket the hub-resident recorder cannot open. It fails with `cross-node` and
  both node names on the record — it does not silently re-ask over the inline
  path, because a second attempt would spend a battery camera's one authorised
  wake twice (D558). **Today this does not bite: both clip providers are
  `hub-only`.** It will bite the day one is deployed to an agent, and the answer
  then is either a routable bind (the operator's call) or an explicit
  inline-on-cross-node rule. It is written down so that day is a decision
  rather than a surprise.
- **The two precedents are NOT migrated, and should not be.** The restreams and
  the clip dial are both LONG-LIVED streams whose URL is handed to a consumer
  that may reconnect, re-dial with different parameters and hold the socket for
  minutes; `peerBytes` is one body, one take, 30 s. The clip dial in particular
  resolves its target through `createClipStreamHandler` with the route's own
  gates and reason codes, which is a richer contract than a body. Migrating
  them would mean widening the facility until it is the thing it was shaped not
  to be. What they SHOULD give up, if anyone touches them, is their private
  copies of the token/TTL/sweep/bound machinery — that part is now the
  framework's and duplicating it a third time is the thing this record forbids.
- `packages/types` and `packages/system` ride inside the `@camstack/server`
  closure, so this needs a **publish + `applyServerUpdate`**, not a
  `camstack deploy`. After the server update, deploy `provider-hikvision`,
  `provider-reolink` and `addon-pipeline` — in that order, so the recorder's
  preference finds providers that can answer it and the named fallback is a
  short window rather than the steady state.
- `ClipBytes` and `readClipBytes` stay. A consumer that genuinely wants the
  bytes in hand has no reason to open a socket, and the method is the fallback
  for an un-redeployed provider. Its docblock now says it is superseded as the
  way an EXPORT gets its bytes, and why.

## Considered and not taken

**`ctx.dataPlane.dial(addonId, prefix)` — the hub hands the consumer the
producer's `{baseUrl, secret}`.** Cleaner-looking and the shape D597 named.
Rejected on authority, twice over: the hub cannot identify an addon caller on
the cap path (synthetic admin principal, and `transport.md` says tRPC auth is
not a boundary between addons), and the credential handed over would be good
for every prefix that addon serves, standing, in place of a per-request
consent.

**A hub-minted, path-scoped, one-shot HMAC ticket verified by the producer's
existing data-plane facility.** This is the shape that keeps "only the hub holds
the secret" AND scopes the grant, and it is genuinely attractive — no extra byte
hop, no new listener. It still mints on an ask the hub cannot attribute, and it
couples two facilities that currently share nothing but a header name. Named
here because it is the right answer IF a later slice gives the hub a real addon
caller identity (the principal D558 already asks for), and it would then replace
step 1 without changing anything else in this record.

**Proxying the bytes through hub-main's `/addon/<id>/…`.** It exists and it
authenticates. It also puts every byte of every transfer through hub-main's
event loop, which is the process D9/D18 were written about.

**A chunked `readClipBytes`.** The short path, offered and declined by the
operator: *"Cura vera assolutamente! Niente mezze misure non ha senso"*. It
would have moved the bound rather than removed it, and it would have left the
next pair of addons re-deriving the minting dance for the third time.

**`kind: 'subscription'` carrying base64 chunks.** Refused on the addon caller
by the framework, and it would put media on the cap channel through hub-main.

## Enforcement

Every gate below was reverted in turn by a script that patches the line, runs
the spec, restores the file and verifies its hash. **16 disarms, 15 red, 1
honestly green, 16 byte-identical restores.**

`packages/system/src/kernel/__tests__/moleculer/addon-peer-bytes-facility.spec.ts`
(11 tests, REAL loopback sockets, no fake opener anywhere):

| disarmed | failing |
| --- | --- |
| `response.pause()` removed | **0 — green, and recorded as such** |
| `response.pause()` → `response.resume()` (the D597 shape) | 3 |
| the `cross-node` check | 1 |
| ticket expiry in `open()` | 1 |
| the one-shot take | 1 |
| `HEAD` consumes nothing | 1 |
| the outstanding bound | 1 |
| `writeToFile`'s `maxBytes` abort | 1 |
| the stall cut | 1 |
| `hostNodeIdOf` keeping the runner suffix | 1 |

The green one is the point of writing this table. Removing `pause()` does not
fail, because a Node `IncomingMessage` is not flowing until something reads it
— so the call is defensive rather than load-bearing, and the invariant that
actually bites is **the facility attaches no reader before handing the body
over**, which the `resume()` variant proves with three failures. D597's own
enforcement note records a gate that behaved this way; smoothing it over is how
a suite starts lying.

`packages/addon-pipeline/src/recorder/addon/__tests__/export-engine-clip-peer-bytes.spec.ts`
(8 tests): the streamed path preferred (8 red when disarmed), the offer bound
asked for (1), the named fallback line with its deploy hint (1), `unsupported`
with no inline read refused by name (1), the plausible-bytes floor applied to
the streamed path (1).

`packages/types/src/__tests__/videoclips-read-clip-bytes.spec.ts` — the type
invariants are pinned **in `packages/types`, where the import IS the source**.
A gate written in an addon package resolves `@camstack/types` to the BUILT
package, so editing the source leaves it green and the gate is worthless. The
offer bound being its own number (1 red), a ticket naming its minting node (1),
`declaredBytes` required so unknown is `null` and never absent (1).

Not mechanised, review only: nothing stops a future addon pair from minting its
own listener and token map instead of using this facility. That is the
duplication this record exists to end, and a guard for it would have to
recognise `http.createServer` inside an addon — which the two legitimate
precedents still do.
