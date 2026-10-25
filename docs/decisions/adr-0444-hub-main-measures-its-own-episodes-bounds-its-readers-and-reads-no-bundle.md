---
id: D444
title: hub-main measures its own ArrayBuffer episodes, disconnects a subscriber that stops reading, and never evaluates an addon's bundle to learn what it exports
status: accepted
date: 2026-09-11
supersedes:
  - D284
applies-to:
  - packages/system/src/kernel/array-buffer-census.ts
  - packages/system/src/kernel/heap-watch.ts
  - packages/system/src/kernel/custom-action-registry.ts
  - packages/system/src/kernel/moleculer/child-addon-call-dispatch.ts
  - packages/system/src/kernel/transport/child-cap-protocol.ts
  - packages/system/src/kernel/transport/local-child-client.ts
  - packages/types/src/capabilities/custom-actions.ts
  - server/backend/src/api/trpc/ws-slow-consumer-guard.ts
  - server/backend/src/core/addon/forked-custom-actions.ts
  - server/backend/src/main.ts
last-verified: 2026-09-28
---

## Context

hub-main died at 2026-09-10 23:32:41Z (01:32 CEST) on

    FATAL ERROR: Ineffective mark-compacts near heap limit
    Mark-Compact 2546.6 (2708.4) -> 2499.9 (2709.4) MB, average mu = 0.320

D443, written hours earlier, had named three things and left all three
unfixed. Reading the whole `docker logs` window (18:58–03:30 CEST, every
2-second `[mem] hub-main` sample plus every reclaim line) corrects the story
that was being told about the crash, and the corrections are the context:

**The second ArrayBuffer episode did NOT end in the OOM.** It climbed from
22:20 to **4 968 MB at 23:36:40 CEST**, LIVE across a forced compaction
(`arrayBuffers=4968MB→4954MB` on the reclaim line), and was at 47 MB by
23:38:41 — released between two probes, with no line from this process in
that window. The process died two hours later with `arrayBuffers=70MB`.

**The live set was flat for those two hours.** The reclaim line's post-GC
`heapUsed` read 2 491–2 494 MB on every pass from 23:38 to 01:28. Nothing was
growing when it died: V8 declared the mark-compacts ineffective because a
2.5 GB live set under a 3 264 MB ceiling, with ~600 req/s of churn, leaves the
mutator 32 % of the time. That live set had grown from 2 337 MB (21:13) to
2 699 MB (23:36) and dropped **208 MB in the same instant** the 4.9 GB of
ArrayBuffers were released — so the heap-object growth and the ArrayBuffer
growth had one owner, and it is still unnamed.

**The WebSocket queue is real, is the operator's phone, and is not the
ArrayBuffer episode.** `192.168.x.x` is the operator's phone with the viewer
in the background, touching nothing: iOS suspends the JS runtime, the TCP
connection stays open, the tRPC subscription stays registered, and every event
is `send()`-ed into a socket nobody drains. That is 88 MB of JSON strings in
old_space per evening per phone, scaling with the number of phones, with no
bound and no line. But it is strings in old_space measured at 2 MB/min, and
the episode was ArrayBuffers at 60–85 MB/min that D443 had already excluded
from every socket queue (`_getActiveHandles()` summed 84 MB). Fixing the
queue is mandatory; it is not the whole phenomenon.

**The measurement that names the episode's shape was never run** because it
needed a human awake during the episode. The episode does not wait.

**Ten bundle evaluations produced nothing and said nothing.**
`registerForkedAddonCustomActions` purged the require cache and re-imported a
forked addon's whole bundle inside hub-main at every spawn and hot-update, to
read one export. A `CustomActionSpec` carries two Zod schemas, which MsgPack
cannot carry, so the catalog was read from the bundle instead of from the
runner. Ten deploys in 23 h, none exported a catalog, the outcome line was at
`debug`, and every evaluation pinned the evicted graph's module-scope state.
D284 existed only to keep that re-execution survivable.

What was tried first and did not work, in this record's own lineage: a
hub-side PULL of the catalog over the addon-call plane, hooked where
`mountAddonDataPlanes` is pulled (`capability:provider-registered`). It cannot
work: `ChildManifestGate` skips a re-register whose caps are unchanged, so for
a non-device runner the only cap events fire at the PRE-init register, before
the init loop has produced any catalog, and no later event ever re-triggers
the pull. (`mountAddonDataPlanes` is exposed to the same race and is not
changed here.)

## Decision

1. **The heartbeat arms the ArrayBuffer census itself.** When
   `process.memoryUsage().arrayBuffers` has been at or above
   `ARRAY_BUFFER_CENSUS_THRESHOLD_MB` (512) for `ARRAY_BUFFER_CENSUS_SUSTAIN_MS`
   (60 s), `Runtime.queryObjects(ArrayBuffer.prototype)` runs over an
   in-process inspector session and a byteLength histogram is computed in
   memory and returned by value — one `warn` line carrying the live total
   against the raw reading, the top exact sizes, the power-of-two buckets, the
   time it took, and the cost in words (one forced full GC, nothing
   serialised, nothing written). At most once per
   `ARRAY_BUFFER_CENSUS_COOLDOWN_MS` (30 min). A sustained level that drops by
   half the threshold in one probe is logged as a RELEASE with its timestamp.
   It is not a heap snapshot; `check-no-heap-dump-command.ts` stands, and
   this module must never grow a `writeHeapSnapshot`. Only hub-main passes the
   probe — a runner that legitimately holds gigabytes of ArrayBuffers would
   fire it forever.

2. **A tRPC WebSocket client that stops reading is disconnected.**
   `bufferedAmount` above `WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES` (16 MiB) for
   the whole of `WS_SLOW_CONSUMER_GRACE_MS` (30 s) → `terminate()`, with a
   `warn` naming ip, user agent, principal, queued bytes, `bytesRead`, and
   how long the queue was over. The rule is the restreamer's (`rtsp-session.ts`):
   backpressure measures LIVENESS, not identity — a client momentarily behind
   is coming back, one that cannot drain the bound in the grace period is
   gone. Rejected: dropping events (no sequence numbers; a client that missed
   one has a corrupted view and no way to know), pausing the subscription (no
   seam in the adapter, and the client would not know to refetch), `close()`
   (the close frame queues behind the backlog and `ws` holds the socket 30 s
   more). A backlog that crosses the bound and DRAINS is logged at `info`;
   every close is logged with what was queued at that moment. Complementing
   the bound, tRPC's `keepAlive` is enabled (`pingMs` 30 s, `pongWaitMs` 10 s):
   a PING is a text frame the client's JS must answer, and a suspended app's
   JS does not run, so the suspended phone is terminated ~40 s into the
   background instead of accumulating for the night. Every WS client of this
   hub is `@trpc/client` ≥ 11, which answers PING.

3. **hub-main never evaluates a forked addon's bundle.** A runner DESCRIBES
   its custom-action catalogs (`CustomActionDescriptor`: kind, auth, scope,
   caller — the schemas stripped) in its post-init register frame
   (`RegisterMessage.customActions`, keyed by addon id, an EMPTY catalog for a
   hosted addon that declares none), exactly as it carries `eventPatterns`
   and for the same reason: race-free, from the process that owns the addon.
   The hub registers that description with passthrough schemas and dispatches
   over the addon-call plane; the runner validates the action's input and
   output itself. A described catalog identical to the child's previous one
   registers nothing and logs nothing; a changed one logs ONE `info` line per
   child naming what it registered and which addons declare nothing.
   `require-cache.ts`, its spec, `check-addon-bundle-reload.ts` and its probe
   are deleted — with no purge-and-reimport anywhere, D284 has no subject.

## Consequences

- None of this ships with `camstack deploy`. `array-buffer-census.ts`, the
  register-frame change and the runner-side validation are `@camstack/system`;
  the guard, the keep-alive and the catalog application are `server/backend`;
  the descriptor type is `@camstack/types`. All ride one published
  `@camstack/server` closure (D16), and the runner code and the hub code
  update atomically with it — a hub that reads `customActions` off the frame
  and a runner that puts it there are the same release.
- The catalog now appears in the registry only after the runner's init loop
  completes, not at spawn. Between spawn and post-init the action is
  `NOT_FOUND` ("no addon registers custom actions") rather than "no local
  child"; both are refusals, and the former is now the honest one.
- A suspended viewer is disconnected by the hub within ~40 s. The app must
  expect that and reconnect on return — the tRPC client already does — and
  should close its subscriptions itself when backgrounded rather than rely on
  the server to notice. That is viewer work, outside this record.
- The ArrayBuffer owner is still unnamed. What changes is that the next
  episode names its own shape, and its release is timestamped.

## Enforcement

- `packages/system/src/kernel/__tests__/array-buffer-census.spec.ts` and
  `heap-watch-array-buffer-census.spec.ts`: the gate's sustain, cooldown and
  release; the real inspector census finding 200 MiB the test holds; the line
  carrying its cost; the heartbeat firing once, never overlapping, and
  reporting a failed census.
- `server/backend/src/api/trpc/__tests__/ws-slow-consumer-guard.spec.ts`:
  terminated once after the grace with the peer named; a burst that drains is
  never terminated; every close logged; a throwing getter never takes the poll
  down.
- `local-child-client-custom-actions.spec.ts`, `custom-action-registry.spec.ts`
  (`describeAll`), `child-addon-call-dispatch-validation.spec.ts`,
  `forked-custom-actions.spec.ts`: the frame carries the catalogs after
  post-init and omits them before; an empty catalog is named; the runner
  refuses input its schema refuses; the hub's spec keeps auth/caller and
  refuses nothing.
- `scripts/check-no-heap-dump-command.ts`, unchanged, forbids the one thing
  the census could be mistaken for.
