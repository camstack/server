---
title: Moving the snapshot wrapper out of hub-main
last-verified: 2026-08-26
covers:
  - packages/system/src/builtins/snapshot/**
  - server/backend/src/core/addon/addon-registry.service.ts
  - packages/system/package.json
---

# Moving the snapshot wrapper out of hub-main

> **STATUS: SHIPPED 2026-08-13, re-verified 2026-08-14.** This is a record, not
> an outstanding plan. [D123](../decisions/adr-0123.md).
>
> **BUILT.** `packages/system/package.json` declares `execution.isolate: true`
> on the `snapshot` entry, and `AddonRegistryService`'s blanket
> `packageName === '@camstack/system'` skip is gone, replaced by the
> `runsInOwnRunner` predicate that the in-process boot filter and
> `isForkedAddonEntry` also read. The wrapper — capture ladder, sharp resize,
> courtesy frame, both byte caches and BOTH HTTP planes — runs in its own
> process. A forked builtin reaching its native needed a new mechanism
> (`native: true` on the cap call-out); that, not the Moleculer claim this
> document spends a section demolishing, was the real blocker.
>
> **NOT built.** The profiling run §"Why" asks for. The verification table
> below has still never been measured, before or after — so the 90 % remains
> unexplained and the win remains unquantified. Height alongside width in the
> resize/link path is still open, deliberately.
>
> **Dropped.** Options B and C of "bytes or handle" were never weighed in the
> end: the data-plane facility binds the listener in the addon's own process, so
> A happened for free. Read the last section for the four places the code
> disagreed with the design.

Operator directive, 2026-08-11: *"Progettiamo anche l'uscita del plugin snapshot
dai builtin in un addon separato ma nello stesso bundle system."* [Let us also design the move of the snapshot plugin out of the builtins into a separate addon, but within the same bundle system.]

## Why

The snapshot wrapper is a `@camstack/system` builtin, so it loads in the hub's
ROOT process — the same process and the same event loop that serve the tRPC API,
the WebSocket and the Admin UI.

Measured on the live hub 2026-08-11, while the operator reported the Admin UI as
unusable ("la pagina devices si svuota e si riempie a intervalli, caricare un
device rimane appeso"):

```
starter.js (hub root, PID 7)      90.1 % CPU, 4.4 GiB RSS
ffmpeg resize children of PID 7   64/64 sampled observations, ~1.6 concurrent
deviceManager.listAll             1.38 s and 4.30 s for the same call
```

**What is NOT established.** Nobody has profiled `starter.js`. The resize
transcode itself ran in the CHILD and was charged to ffmpeg, not to the parent —
so the 90 % is not explained, only the fact that snapshot work lands there. The
profiling run is agreed as the next step, and this design does not depend on its
outcome: whatever that 90 % turns out to be, capture + resize + base64 for every
camera does not belong on the process that answers the API.

## The blocker that turned out not to be one

`AddonRegistryService.buildAddonGroupPlan` drops system builtins from the runner
plan by package name:

```ts
if (entry.packageName === '@camstack/system') continue
```

with this rationale in the doc comment above it:

> `@camstack/system` builtins are dropped too — they stay in-process on the hub
> (…) moving them into a sibling subprocess would isolate them on a separate
> Moleculer node that child brokers cannot reach.

**That reasoning does not hold, and the transport docs say so directly.**
`docs/architecture/transport.md`: *"There is **no per-addon Moleculer broker**.
Addons run broker-less; a child reaches the hub, **and its siblings**, over the
UDS channel."* The code agrees — `LocalChildRegistry` documents and implements
child→sibling routing (`UDS_NO_ROUTE_PREFIX`, *"the first time each capName is
routed child→sibling over UDS"*), and `parent-unowned-call.ts` only takes over
when no local sibling owns the cap.

So a snapshot runner IS reachable from another runner. The route is
`analytics runner → UDS → hub parent → LocalChildRegistry → snapshot runner`,
which is the same path every deployed addon already uses. The comment describes
a Moleculer topology that addons do not participate in.

This document does not change that comment; the implementation should, and
should say what replaced it.

## The decision that actually matters: bytes or handle

Snapshot returns `{ base64, contentType }`. Moving the provider into a runner
puts a MsgPack serialization of a JPEG on every call that crosses the boundary.

**Be careful which volume you reason about.** An earlier draft of this document
cited "600–800 capture requests per minute" as traffic that would cross this
boundary. That number is real but belongs to a different system: it is
`pipeline-analytics`' `CaptureScheduler`, which is *"THE single owner of capture
pressure on the retained-frame ring"* — resolutions of decoder frame HANDLES for
crops, embeddings and event media. Those never touch the snapshot cap and would
not cross this boundary at all. (Its `droppedStale` counter is not waste either:
a queued request past its deadline resolves `null` **without exec**, which is
the scheduler declining work on a frame the decoder already recycled.)

The volume that WOULD cross is the snapshot cap's own callers: the client's 5 s
`getSnapshotLinks` poll while a grid is open, plus whatever asks for bytes. As
of 2026-08-11 there is no server-side timer adding to it — the keep-warm loop
was removed, so the hub captures only what somebody asked for.

[D9/D18] is the governing rule: *"Frames never cross a process boundary at
frame-rate. (…) Cross-process media is fetched on demand, compressed, by
handle. This OOM'd hub-main."* Snapshots are compressed and not frame-rate, so
they are inside the letter of the rule — but "by handle" is the shape the rule
prefers, and 800/min of base64 JPEG over UDS is exactly the kind of traffic that
produced D18.

Three options, in order of preference:

**A — Split the plane: work in the runner, bytes over HTTP (recommended).**
The wrapper already has an authenticated media plane
(`/addon/snapshot/media/<id>.jpg`, `snapshot-media-handler.ts`) and a signed
link plane (`snapshot-link-url.ts`). Those planes serve BYTES to clients over
HTTP and never need the cap. Put the capture, the resize and the caches in the
runner; keep the HTTP routes bound in the hub and have them read through the
cap by handle. In-process callers of `getSnapshot` that want bytes (the cap's
public contract) still get them — one UDS round-trip each — but the high-volume
path (grid polling) resolves to a handle plus an HTTP fetch,
which is what the viewer already does.

**B — Keep the byte contract, accept the serialization.** Simplest, and
measurable before committing: a 640 px card JPEG is ~7–17 KB (measured on this
grid), so 800/min ≈ 130 KB/s of UDS traffic. That is not obviously fatal, and it
is trivially reversible. The risk is the FULL-size path: `lastBytes` for one
terminal camera was 212 KB, and a 4K camera's native frame is larger still.

**C — Co-locate with `pipeline-analytics` via `execution.group`.** Removes the
hop for the loudest caller. Rejected: [D29] confines grouping-for-RAM to
non-live, frame-free, low-crash addons, and a shared runner means an
analytics crash takes snapshots with it — for the one caller that already sheds
86 % of its own queue.

## What has to change

1. **`packages/system/package.json`** — the `snapshot` addon entry gains an
   explicit opt-out of the builtin rule. A manifest flag (e.g.
   `camstack.addons[].execution.isolate: true`) is preferable to a hard-coded
   addon-id list in the registry, because the next builtin that needs this
   should not require a registry edit.

2. **`buildAddonGroupPlan`** — replace the blanket package-name skip with
   "skip system builtins UNLESS the declaration opts in", and rewrite the doc
   comment: the Moleculer-isolation claim is wrong and will mislead the next
   reader exactly as it nearly stopped this change.

3. **Cache ownership.** `SnapshotCache` and `SnapshotVariantCache` move with the
   provider. The HTTP media handler currently peeks the cache synchronously
   (`SnapshotPeek`); once the cache is in the runner that peek becomes a cap
   call, so the handler's fast path needs a decision of its own — this is the
   part most likely to be got wrong quietly, because a peek that silently
   becomes a round-trip turns a cheap route into an expensive one.

4. **`resolveIngestOwner` / battery gates.** These read device state through
   `ctx.fetchDevice` and the device-state mirror. A runner has the same
   `ctx.api`, so they keep working — but the mirror read (`handle.refresh()`)
   was already documented as the thing that "shipped twice without ever firing".
   It needs a live re-verification after the move, not a passing unit test.

## Verification

The move is only worth shipping if it is visible, so measure the same three
things before and after, on the live hub:

| Signal | How |
| --- | --- |
| hub-root CPU | `ps -eo pcpu,args` filtered to `starter.js` |
| resize children of hub-root | sample `ps -eo ppid,args`, count `image2pipe` with ppid = root |
| Admin UI responsiveness | `deviceManager.listAll {}` wall-clock, several samples |

And one correctness canary that has nothing to do with performance: a grid mount
must still paint every tile. `scratchpad/grid-images.mjs` measures exactly that
(links + concurrent image fetches, per-tile HTTP status).

## Order

This lands AFTER the sharp resize migration (already local, same session), so
the before/after is not confounded by two changes at once — and after the
profiling run the operator asked for, which may reveal that the 90 % is
something else entirely and change what "after" should look like.

## Implemented 2026-08-13 — where the code disagreed with this design

Landed as [D123](../decisions/adr-0123.md). The manifest flag and the
`buildAddonGroupPlan` rewrite are as designed (`execution.isolate: true` on the
`snapshot` entry; the blanket package-name skip replaced by one predicate,
`runsInOwnRunner`, shared with the in-process boot filter and
`isForkedAddonEntry`). Four things this document got wrong or did not see:

**"Bytes or handle" resolved itself — as A, for free.** §"The decision that
actually matters" treats the HTTP planes as something to keep in the hub and
read through the cap. They are not: `createAddonDataPlaneFacility` binds the
listener **in the addon's own process** and publishes it for the hub's
reverse-proxy, keyed by bare addon id. Moving the wrapper moved both planes with
it, byte-for-byte the same URLs, and §3's `SnapshotPeek` worry evaporates —
the peek stays in-process with the cache it peeks. Option A is what happened
without anyone choosing it, and no HTTP route was rewritten.

**`ctx.getNativeProvider` does NOT keep working in a runner.** §4 says "a runner
has the same `ctx.api`, so they keep working". For the battery gates, true. For
the native, false and dangerous: `buildRemoteNativeProvider` dispatches back
through the cap NAME with a `bypassWrapper: true` flag the server reads nowhere,
and `localProviderLink` short-circuits it to the runner's own provider before it
reaches the socket. The wrapper calls itself, the inner call joins the outer
call's `SingleFlight`, and nothing settles. Fixed with a `native: true`
cap-call-out honoured by `LocalChildRegistry` + `onUnownedCall`; this was the
real blocker, not the Moleculer claim.

**The link-signing secret is a boot-order hazard.** In hub-main this addon
booted after `settings-store` in the same process. In a runner it can observe a
store that is not answering, and `state.get()` reports that as empty — so a
one-shot mint either never serves the link plane again (blank grid, nothing
failing twice) or writes a second secret over a live one. The plane is now
retried on demand and the mint is gated on reading the value back. The isolated
builtin is also spawned AFTER the in-process builtins, which removes most of the
window.

**2026-08-18 — the caches §3 moved are now BOUNDED.** Both grew without eviction
after the move, and the variant cache leaked outright: a superseded `sourceTs`
returned `undefined` and was never deleted, so its key could never match again.
Each now carries a byte budget with LRU plus an idle TTL on the frame cache
(`SNAPSHOT_CACHE_MAX_BYTES`, `SNAPSHOT_CACHE_IDLE_TTL_MS`, one hour) — idle
rather than capture-age, because a battery camera's frame is legitimately fresh
for an hour. An eviction is logged with `tags: { deviceId }`: it is the reason a
later capture had to happen.

**Ordering.** The sharp migration this document waits for is already in the tree
 — both `snapshot-resize.ts` and `snapshot-courtesy.ts` use sharp,
so the before/after is not confounded. The profiling run §"Why" asks for has
still NOT been done; the verification table below is unchanged and unmeasured.
Height alongside width in the resize/link path is still open and deliberately
not in this change: it moves the width out of the link's SIGNED identity and the
ETag, which is its own slice.
