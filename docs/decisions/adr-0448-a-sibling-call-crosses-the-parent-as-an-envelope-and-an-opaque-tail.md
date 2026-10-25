---
id: D448
title: A sibling call crosses the parent as an envelope and an opaque tail, the parent counts what it did not read, and the audio plane is not given a shared-memory handle
status: accepted
date: 2026-09-11
applies-to:
  - packages/system/src/kernel/transport/frame-codec.ts
  - packages/system/src/kernel/transport/socket-channel.ts
  - packages/system/src/kernel/transport/local-transport.ts
  - packages/system/src/kernel/transport/local-child-client.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/cap-routing-hints.ts
  - packages/system/src/kernel/transport/child-cap-protocol.ts
  - packages/system/src/kernel/socket-plane-report.ts
  - scripts/bench-uds-relay.mts
last-verified: 2026-10-02
---

## Context

hub-main routes every call between two of its runners. Until this record it
decoded the whole request — args included — built a new message, re-encoded
it, and did the same to the answer, on the one thread that serves every tRPC
request. `transport.md` had called raw-forwarding "the next real win, not
built" since the `FrameDecoder` rewrite; D441 measured the plane at ~600
req/s with msgpack decode at ~27 % of hub-main's busy time and encode at
~6 %, feeding a 29.5 % GC share; D446 priced the decoded-audio plane alone
(broker → hub → orchestrator → hub → analyzer) at 340 of ~470 MB/min, every
byte decoded and re-encoded twice.

**What the current hub looks like before the change, measured this morning
on 1.2.269 at 3.5 h of age** (08:33–08:58 CEST, quiet): `loopP50=0ms`,
`loopP99=11–21ms`, `loopMax=62–152ms`, `heapUsed` 775–959 MB. Per peer per
minute: stream-broker → hub 87 MB, hub → orchestrator 90, orchestrator → hub
88, hub → analyzer ~84 (the audio plane, four legs); hub → pipeline-analytics
72–153 MB of responses to its `settings-store` / `device-state` reads, which
are hub-in-process providers and not this record's business; decoder-nodeav →
hub 15 MB. A 30 s V8 CPU profile over the inspector (the D441 method; the
`Profiler.start` stall on an 800 MB heap was not visible on the `[mem]`
line): busy 39.2 %; of busy, **GC 17.5 %**, msgpack encode 13.7 %, the
inbound frame path (reassembly + decode + dispatch) 39 %, `(program)` 13.9 %,
synchronous `spawn` 3.8 %; by self time, `Buffer.concat` 10.9 %, `FastBuffer`
11.6 % and `createUnsafeBuffer` 2.7 % — a quarter of the busy time is buffer
churn. The cap-usage graph says **16 965 of 21 415 child requests per minute
(79 %) are sibling-routed** — the calls a raw forward can serve; the rest are
parent-routed (in-process providers) and must be decoded.

**The D441 profile was taken inside the D440 burst.** Its 21:23:56 window sits
in the 20:32–21:52 stretch D446 attributed to `addon-device-settings` range
walks at 2.25 M rows/min. Those rows were decoded by hub-main as the CALLER
of the sqlite child, which no forwarding can help; the "27 % decode" of that
profile is not the number raw-forward is measured against. This record's
baseline is the profile above.

**On the audio plane, two facts decided the second half of this record.**
`AudioRtpDecoder` upsamples the fleet's G.711 (8 kHz, 8 KB/s per camera) to
**16 kHz f32le — 64 KB/s, eight times the source** — before it reaches the
chunk plane, which is why 22 cameras cost 84 MB/min per leg. And the
analyzer's classifier is single-flight with a 500 ms per-camera floor:
`classifyCount` on its pool-memory line advances **700–860/min against
1 306/min `analyseChunk` calls** — 55–66 % of windows are classified, the
rest are level-only. A plane fetched on demand by handle would therefore save
at most ~40 % of the analyzer leg's bytes, not an order of magnitude.

## Decision

1. **A sibling↔sibling cap call crosses the parent as an envelope and an
   opaque tail.** The sender packs `args` once into msgpack bytes and sends
   them as the frame's LAST key, `pl`, a `bin` appended after the envelope
   (`encodeFrameHead`, the one hand-written msgpack in the repository: the
   `fixmap` count is bumped by one and the key and `bin 32` header appended;
   anything that is not a small map is refused, never patched). The wire
   stays plain msgpack — a peer that never heard of payloads decodes
   `{ …frame, pl: <bytes> }`. The receiver's ordinary decode yields `pl` as a
   zero-copy view; the parent reads the envelope, and forwards the view
   behind a fresh `cap-call` head under `cork()` — two writes, one `writev`,
   no copy of the payload. The answer comes back the same way
   (`PayloadReply`, a CLASS so a provider's ordinary `{ body, payload }`
   return value is never mistaken for one). The provider unpacks in its own
   process; a `z.void()` result stays an omitted body, because packing
   `undefined` would read back as `null`.

2. **The parent routes on hints it did not have to decode, in one shape for
   both modes.** The facts the parent reads out of `args` are lifted by the
   sender into `CapCallOutMessage.hints` (`cap-routing-hints.ts`), and for a
   legacy inline frame the parent lifts them itself. The predicates
   (`isAddonPinnedCall`) receive the hints in both modes.

   When this record was written that was two facts: an inline `nodeId` pin and
   an `{ addonId }` selector on a global collection. **D595 added the other
   two** — the `provider` pin of a DEVICE collection and the `deviceId` it
   applies to — because a field this envelope does not carry is a field the
   routing decision cannot see, and that decision runs before `onUnownedCall`.
   Leaving them out cost four consecutive fixes to one bug: the handlers were
   correct and the predicate that gates them was handed `{}`. A call that leaves
   the sibling path — an `onUnownedCall`, a `native: true` lookup, a target
   that cannot take a payload — materialises the args at that branch and
   pays what it always paid.

3. **Negotiated at `register`, additive on both sides, one env to switch
   off.** A child declares `rawForward: true`; the parent acks
   `{ ok: true, rawForward: true }`. A child packs only after the ack; a parent
   forwards a payload only to a child that declared. A legacy peer on either
   side gets today's frames. `CAMSTACK_UDS_RAW_FORWARD=off` on a node makes
   its parent acknowledge nothing, and everything is decoded as before —
   without redeploying a runner.

4. **The parent counts what it did not read.** `LocalChildRegistry` keeps a
   `ForwardCensus` (`raw` forwards vs `decoded` cap-call-outs), and the
   `[mem] hub-main` line prints it per window as `socketFwd=<raw>/<decoded>`,
   appended LAST so every prefix written since 2026-08-29 still matches, and
   omitted (never zero) from a registry that keeps no census. A `raw=0` under
   load is a failed negotiation, and nothing else would show it.

5. **The audio plane gets no shared-memory handle, and the orchestrator
   relay leg is priced, not removed.** An `AudioHandle` on a shared-memory
   ring is the mechanism D18 removed from video — `@camstack/shm-ring` was
   the last native host-external, and "shared memory is not a data plane" is
   what `data-planes.md` says today. The video mechanism as it EXISTS is
   in-process co-location or an on-demand fetch of compressed media by handle
   THROUGH hub-main; a handle buys nothing for a plane consumed at full rate,
   and this plane is consumed at 55–66 %. What follows the video mechanism
   honestly is what this record builds: the bytes that must cross hub-main
   cross it as a memcpy. The relay leg (analyzer pulls from the broker;
   −2 legs, −178 MB/min, −136 req/s of envelopes) is addon-deployable and
   remains available; after raw-forward its remaining value is ~136 req/s of
   envelope handling, and it is not built here.

## Consequences

- **Measured, in a parent process of its own, over real UDS sockets**
  (`scripts/bench-uds-relay.mts`, 20 000 relayed calls, 8 in flight, A/B by
  the plane's own env switch, identical checksums): per 1 000 relayed calls
  the parent's CPU went 81.8 → 34.8 ms on the 13.5 KB PCM request shape
  (−57 %, GC time −89 %), 386 → 244 ms on the 8 × 13.5 KB PCM response shape
  (−37 %, GC −59 %), 81.6 → 24.2 ms on a 2 KB object graph (−70 %, GC −77 %).
  The response shape's floor is byte handling — the socket read, the
  exact-fit copy `FrameDecoder` keeps for pinning reasons, the write — not
  msgpack.
- **On the hub this rides a published `@camstack/server` (D16)**; nothing
  here ships with `camstack deploy`. The before-numbers are in Context; the
  after is read from the same `[mem]` line, the same profile, and
  `socketFwd=` at the same hour on the same hub. Projected from the bench and
  the 79 % sibling share, hub-main's busy time should drop by a quarter to a
  third and its GC share under 15 % of busy — a projection, stated as one.
- **What the parent no longer sees:** the content of a sibling call's args
  and result. Everything it used to observe is still observed — the cap-usage
  graph (caller, provider, cap, method), the per-peer byte and message census
  (head and tail both charged), the outbound queues (D446), the fan-out gate
  (events are not cap calls), the per-method timeout — because none of it ever
  needed the body. The one reader that did, the `{ addonId }` / inline
  `nodeId` routing, now reads hints the sender lifted; a sender that lies in
  its hints can only misroute its own call.
- A forwarded payload is a view into the frame it arrived on, held until the
  outbound write completes. Under a held queue (D446) the parent holds the
  original frame buffers in the write queue instead of re-encoded copies —
  the same bytes, no worse, and `socketQueued=` still says so.
- **Two audio levers this record measured and did not pull**, both
  addon-deployable and orthogonal to the transport: the plane could carry the
  source G.711 bytes (or 8 kHz s16) and let the analyzer upsample — 84 →
  10–21 MB/min per leg, on every leg, whoever relays; and the relay leg above.
  Either is a `stream-broker` + `audio-analyzer` (+ orchestrator) change with
  the hot-deploy risk `addon-pipeline` carries.

## Enforcement

`frame-codec-payload.spec.ts` (the head, the length, every envelope size, the
chunking, the refusal), `socket-channel-payload.spec.ts` (payload beside the
body, `PayloadReply`, the tail as its own write, head and tail both counted),
`raw-forward.spec.ts` (real `LocalChildClient`s through a real
`LocalChildRegistry` over UDS: values intact and the census says `raw`, the
cap-usage observer still fires, the lifted `addonId` and `nodeId` hints
bypass the sibling with decoded args, a legacy target and a legacy parent each
get inline args, void and thrown results, a payload reply to a payload
request, the env switch), `socket-plane-forward-census.spec.ts` (the field,
the delta, absent-never-zero, a respawned counter). Each guard disarmed and the
suite re-run:

| disarmed | red |
| --- | --- |
| the parent never takes the raw branch | 1: the census reads `decoded` |
| the parent stops lifting hints from inline args | 3: the node pin to another node, the legacy pin-to-self, the `{ addonId }` bypass |
| the sender stops lifting hints | 2: the `{ addonId }` bypass, the inline `nodeId` pin |
| the provider answers a payload request inline | 1: the reply is not a `PayloadReply` |
| the heartbeat prints the cumulative census | 2: the window delta, the respawned counter |
