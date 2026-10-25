---
id: D461
title: The analyzer pulls its own audio, the orchestrator keeps only the policy, and the broker reaps a queue nobody drains
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - packages/types/src/capabilities/audio-analyzer.cap.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-device-attachments.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-chunk-poller.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-window-accumulator.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/audio-chunk-plane.ts
  - packages/addon-pipeline-orchestrator/src/audio-subscription-controller.ts
  - packages/addon-pipeline-orchestrator/src/orchestrator-subscriptions.ts
last-verified: 2026-10-01
---

## Context

The decoded audio-chunk plane crossed hub-main FOUR times for a fleet of 22
cameras: broker → hub-main → orchestrator, orchestrator → hub-main → analyzer.
The middle process neither produced nor consumed the audio. It BUFFERED it —
`AudioWindowAccumulator` turning 21–500 ms chunks into ~1 s windows for a
classifier living somewhere else entirely.

It was there by accident, and the accident is recorded in the code. The
windowing had been a closure INSIDE the broker's process, eight mutable
variables deep; when the `pipeline` co-location group was dissolved nobody
moved it, and `AudioChunkPoller`'s docblock wrote the consequence down as
though it were a reason: *"a live callback cannot cross a process boundary;
once the `pipeline` group is dissolved the orchestrator runs in a different
process from the broker, so audio delivery must go over tRPC."* True, and
beside the point — nothing said the orchestrator had to be the consumer.

**D455 settled which way it had to go, and said so in its own Consequences.**
It put the SOURCE bytes on the plane — one G.711 byte per sample instead of
four f32le ones — but only for a consumer that DECLARES it can read them,
because `AudioChunkInput` is f32le by contract and the analyzer runs on three
nodes from bundles that may predate the field. The declaring consumer was the
accumulator, and the accumulator sat in a third process that had to expand
before forwarding. So legs one and two went coded and legs three and four
stayed at ~49 MB/min each: *"the relay sta FRA il ruolo di sottoscrittore e
quello di decodificatore, quindi la negoziazione `accept` avrebbe bisogno di un
terzo interlocutore che non può avere."* [the relay sits between the role of subscriber and that of decoder, so the `accept` negotiation would need a third counterpart that it cannot have.] The relay was the PREMISE of the
remaining cost, not an alternative to paying it.

**Three things the design did not survive contact with.** D441 and D448 had
priced this move; neither had built it.

1. **The poll loop moves to the CONSUMER's side, and the consumer is not
   always on the broker's node.** The orchestrator dispatches each camera's
   audio to a balanced analyzer node. Its poller ran on the hub at 5 polls per
   second per camera over hub-main's UDS, and pushed ONE `analyseChunk` per
   second — over the mesh when the analyzer was remote. Moving the loop moves
   those 5/s onto whatever boundary separates analyzer from broker. For a
   dispatched camera that is the Moleculer mesh, so the bytes would collapse 8×
   while the REQUEST rate went up 5×. D448 measured envelope handling as a real
   cost; the poll rate is now a property of the boundary and has to say so.
2. **`AudioChunkPlane` has no abandoned-subscription reaper, and on this plane
   an orphan is not a leak.** `subscriberCount` is what `hasDemand()` reads.
   One subscription nobody drains pins the broker's source dial and its decode
   session open for the broker's whole life. While the one subscriber was a hub
   process restarted alongside the broker this was theoretical. Handing the
   subscription to a process the orchestrator does not supervise, possibly on
   another node, makes it reachable.
3. **The watchdog's `audio` tap sat on the CHUNK, inside the orchestrator's own
   poll loop.** After the move the orchestrator sees no chunk. A tap that was
   simply deleted would have left every camera's `audio` stage stale after 90 s
   and the watchdog recovering healthy cameras forever.

**Two stale guards found on the way, both re-anchored here.** D459 corrected
the μ-law table from the shipped quarter-scale magnitude to ITU-T G.711's, and
did not re-anchor two specs that pinned `8031 / 32768`
(`audio-window-coded.spec.ts`, `audio-chunk-format-negotiation.spec.ts`). Both
have been RED on `main` since. A red guard states nothing, and a guard nobody
re-anchors is how a quarter-scale table survived unnoticed for a release.

## Decision

**The analyzer PULLS its own audio. The orchestrator keeps the policy and
nothing else. The broker reaps a subscription nobody drains.**

1. **`audioAnalyzer.attachDevice` / `detachDevice`.** `attachDevice({ deviceId,
   brokerId, ingestNodeId, settings })`, pinned to the analyzer node, starts a
   poller + accumulator INSIDE `audio-analyzer` and returns as soon as the
   attachment exists — the first `subscribeAudioChunks` retries with backoff
   behind it, because the broker for a camStream may not be registered yet.
   That boot-race tolerance travels with the poller, unchanged. `detachDevice`
   releases it, idempotently.

2. **Both remaining legs stay coded, because the subscriber IS the decoder.**
   The attachment declares `accept: ['pcmu','pcma']` and expands ONCE at the
   flush, in the process that feeds the model. `AudioChunkInput` is still
   f32le, so no analyzer on any node from any bundle is handed bytes it cannot
   read — D455's safety argument is untouched, it simply no longer needs a
   third interlocutor.

3. **An attach REPLACES a live one and reports that it did.** Two pollers on one
   camera would double the broker's fanout and each would flush its own
   half-windows. A re-attach is a rebalance, a settings change or a watchdog
   recovery, and all three must land on exactly one subscription.

4. **The poll rate is a property of the boundary it crosses.** 200 ms when the
   broker is on this node (what the orchestrator always used, unchanged on a
   hub-local analyzer), 500 ms when it is not. The attach line carries
   `remoteBroker` and `pollIntervalMs`, so which one a camera got is never
   inferred.

   !!! warning "The JUSTIFICATION for the remote 500 ms was wrong, and cost audio"

       This clause shipped reasoning "one poll per chunk, which loses nothing
       against a 64-deep FIFO". That assumed ~500 ms chunks — true of the G.711
       decoder, and false of `AudioCodecSession`, which emits one chunk per
       decoded AAC frame, ~42 ms. A remote AAC camera therefore lost roughly a
       third of its audio, permanently and silently.
       [D465](adr-0465-a-poll-cadence-is-a-property-of-the-consumer-and-the-drain-batch-never-of-the-boundary.md)
       corrects the principle: it is the BATCH that bounds a cadence, not the
       interval. `PULL_MAX_COUNT` is 32 (500 ms of a 21 ms-frame codec with
       margin), a pull that comes back FULL is read as a backlog and re-polled
       immediately under a bound, and the FIFO that overwrites now says so
       (`audio-chunk subscription OVERFLOW`, with a running `chunksDropped`) —
       it said nothing before, which is why the loss was invisible.
       The two intervals themselves stand.

5. **The broker holds an idle LEASE, because a process that died cannot clean
   up after itself.** A subscription not pulled for 120 s is released and NAMED
   (`audio-chunk subscription REAPED — nobody drained it`, with the tag, the
   idle time and what it was holding), and the broker re-evaluates demand —
   dropping the orphan while leaving the demand standing would have fixed
   nothing. The sweep rides `fanout` on a quarter-lease cadence: the plane has
   no clock of its own, and the moment a dead consumer costs anything is the
   moment there is a chunk to put in its queue. 120 s clears the longest
   LEGITIMATE gap (the poller awaits its consumer per chunk, and `classify`
   carries a 30 s timeout) and is well past the ~30 s of audio the FIFO holds,
   so a subscription this idle has already lost audio.

6. **The watchdog's `audio` stage is fed from
   `PipelineAudioInferenceResult`** (`orchestrator-subscriptions.ts`) — the
   analyzer saying it produced a window. What the tap proves is now strictly
   MORE than before: a chunk proved only that the broker was delivering, a
   window proves the whole path including the analyzer. The dead
   `watchdogNote` dep was REMOVED from the controller rather than left wired to
   nothing — a dep that reads "this controller still reports audio liveness"
   is the leftover that makes a live gap look covered.

7. **Every branch that drops a camera's audio names the camera.** An attach
   refused for shutdown or a missing api; a detach that failed against an
   offline node (and the lease that will reclaim it); and a broker that is
   still absent after a minute of retries — that last one was at `debug`, which
   the hub does not write (D438), so before this record a camera whose audio
   never attached produced one WARN at t+0 and nothing ever again. It mattered
   less while the orchestrator held the poller and tapped the chunk. It is now
   the only thing between "no audio" and a permanent silent gap (D427).

## Consequences

- **Not deployed.** Committed only; `main` merges and deploys. Three agents
  deploying `addon-pipeline` from three worktrees on 2026-09-11 each shipped
  their own view of the package and silently reverted the others.
- **What this buys, as a projection, stated as one.** D455 left legs three and
  four at ~49 MB/min each — ~98 MB/min, every byte of it f32le, for a process
  that only buffered. Both legs are gone outright. Composed with D455 the audio
  plane goes from ~196 MB/min to ~25. **I cannot measure it from here**: the
  number is `socketTx` per peer on the `[mem] hub-main` line over ten clean
  minutes on the live hub, the `pipeline-orchestrator` peer specifically, and
  this worktree is not deployed and must not be. The confirmation is that the
  orchestrator peer's audio share goes to zero, not that the total drops by a
  particular amount.
- **Deployable with `camstack deploy`, not a published server.** Routing is by
  `capName` + `deviceId` and the method name is opaque to the parent
  (`LocalChildRegistry.callCap`); `capRequestOpts` falls back to the default
  timeout for a method an older hub does not know. Both packages are
  `self-contained` and bundle the bare `@camstack/types`, so the schema
  travels. The tRPC edge route arrives at the next release and nothing needs
  it — this is an addon-to-addon pair.
- **Deploy order matters in ONE direction, and it is the safe one.** A new
  orchestrator against an old analyzer gets a rejected `attachDevice` and logs
  `audio subscription REFUSED by the analyzer` per camera — audio stops, loudly,
  and a redeploy of `addon-pipeline` fixes it. An old orchestrator against a new
  analyzer keeps relaying exactly as before; the new `attachDevice` is simply
  never called. Ship `addon-pipeline` first.
- **The result event now comes from wherever the analyzer runs**, with
  `source.addonId: 'audio-analyzer'` and the analyzer's real `nodeId` instead of
  a hard-coded `'hub'`. Its three consumers (the recorder's band decision,
  `pipeline-analytics`, the HA export) read `deviceId` and `frame` and nothing
  about the emitter, so this is invisible to them; for a dispatched camera the
  event reaches the hub over the `camstack.evt.*` broadcast like any agent-side
  event. `PipelineAudioInferenceResultPayload.nodeId`'s docblock claim that it
  is "always `'hub'` today" is no longer true.
- **The watchdog now depends on a droppable event (D8), and for a dispatched
  camera on one that crosses the mesh.** The margin is ninety, not one: 90 s of
  threshold against ~1 event/s, and the event fires for every window the
  analyzer flushes — a classify that throws still returns a level, so a merely
  silent camera keeps signalling. Ninety consecutive losses would fake a stall,
  and a stall costs a bounded re-attach (three fast attempts, then a slow
  retry), not a teardown.
- **What did NOT move**: the `audio-analysis` binding gate, the `audioMode`
  schedule, the on-motion window and its timers, the audio-track probe, the
  per-device node assignment and balancer, the settings read. All of it is
  WHETHER and WHERE, all of it stays in the orchestrator, and the per-device
  subscription lock still serialises attach/detach exactly as it serialised
  subscribe/teardown.
- **D9 is honoured, not skirted.** This removes a process boundary crossing
  rather than adding one, and the surviving crossing carries 8 KB/s per camera
  of coded G.711 instead of 64 KB/s of f32le.

## Enforcement

`audio-device-attachments.spec.ts` (the `accept` declaration and the node pin;
one window per ~1 s of coded chunks with the f32le flush; the `audio stream
delivering` line and its `format`; replacement rather than stacking; detach
releasing the broker FIFO and being idempotent; `detachAll` plus the refusal
after it; the remote poll interval; a refused attach naming its camera),
`audio-chunk-lease.spec.ts` (a drained subscription is never reaped; an idle one
is released and named; the broker is told; no callback when nothing was reaped;
the lease is seeded at subscribe), `audio-chunk-poller.spec.ts` (the
persistent-absence line, once, at a level the hub writes),
`watchdog-audio-tap.spec.ts` (the audio stage refreshed off the result window,
per-camera, and not after teardown). Each guard disarmed and the suite re-run:

| disarmed | red |
| --- | --- |
| the attachment stops declaring `accept` | 1 of 8 |
| an attach no longer replaces a live one | 1 of 8 |
| shutdown stops refusing late attaches | 1 of 8 |
| `detachAll` drops the map without releasing the FIFOs | 1 of 8 |
| the remote boundary no longer changes the poll rate | 1 of 8 |
| a refused attach stops saying REFUSED | 1 of 8 |
| the idle lease never fires | 3 of 5 |
| `pull` no longer refreshes the lease | 2 of 5 |
| the broker is never told it reaped | 1 of 5 |
| the persistent-absence line goes back to `debug` | 1 of 7 |
| the audio watchdog tap is removed | 2 of 3 |

What is NOT guarded: that the orchestrator keeps calling `attachDevice` at all.
Deleting it costs every camera its audio and breaks the attach assertions in the
orchestrator's e2e — but the failure mode it CANNOT catch is a deploy of the
orchestrator ahead of `addon-pipeline`, which no test can see. That is what the
per-camera `audio subscription REFUSED by the analyzer` line is for, and it is
review-only.
