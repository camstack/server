---
id: D573
title: The viewer keeps its OWN copy of the still-retry ladder — the published package boundary is the only one it has — and a guard reads the other copy rather than trusting that both were edited
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - camstack/src/clips/clip-still.ts
  - camstack/src/clips/use-clip-still.ts
  - camstack/src/components/camera/theater/EventThumb.tsx
  - camstack/src/components/camera/theater/clips-from-clusters.ts
  - camstack/src/components/camera/theater/event-cluster.ts
---

## Context

[D563](adr-0563-a-still-that-is-queued-is-loading-not-refused-and-the-route-says-which-because-the-client-must-never-classify-the-servers-prose.md)
established that a clip still's 204 says in its own header whether to come
back, and gave the admin UI a bounded jittered ladder to come back on. The
viewer shipped D569/D570 the same day and got neither: a tile whose still is
deferred draws its class glyph and waits for the next refetch.

Re-measured on 592 on 2026-09-20, against `@camstack/server@1.2.357` with
`provider-reolink` deployed, firing one page of 60 mint URLs in parallel
exactly as a first paint does:

    60 parallel mints  →  17 × 200 image/jpeg
                          43 × 204  x-camstack-disposition: deferred
                                    x-camstack-reason-code: queue-full
                                    retry-after: 16

**43 of 60 tiles, blank for ever, for stills the camera was seconds from
cutting.** Being queued is the majority answer on this surface, not the edge
case.

Two further measurements decided the shape of the fix.

**The mint route has no cache.** Firing the SAME 60 URLs a second time, thirty
seconds later, answered 17 × 200 and 43 × 204 `queue-full` again — identical.
So the obvious cheap design is structurally broken: a tile that PROBES with
`fetch` to learn the disposition and then hands the URL to `<Image>` throws
away the still it already downloaded and rejoins the queue on a request whose
headers nobody reads. It would be the same blank tile, one round trip later.
The bytes the probe got are the bytes the tile must render.

**And the ladder could not be imported.** D569's report already said `src/**`
cannot reach `packages/ui-library`; the measurements behind that are worth
recording, because they are what closes the question:

| route | what the code says |
| --- | --- |
| `import` from `@camstack/ui-library` | it is a **DOM** component library and `src/**` is React Native. Already named in `src/live/stream-debug-sample.ts`. Closed outright. |
| `import` from `@camstack/types` | possible in principle — the viewer already imports runtime VALUES from it (`ruleKindSpec`, `DeviceType`, `CamProfileSchema`), so the boundary is precedented. But the viewer resolves `@camstack/*` from the PUBLISHED packages by design, and the version it holds is **`@camstack/types@1.2.235`** against a hub on `1.2.357`. `grep -r CLIP_STILL node_modules/@camstack/types` finds nothing: D563's header constants are not in the package this app has. |

So "share the rule" is not an import. It is: move the policy into
`@camstack/types`, publish `@camstack/types`, bump the viewer's dependency 122
versions, OTA. And it stays a two-train change for ever after — every later
tweak of the curve would need a types publish before the viewer could see it,
where the admin UI gets it on the orchestrator train it already rides. The
122-version gap is itself the evidence: nobody has walked that route for this
app in a long time.

## Decision

**The viewer keeps its own copy of the ladder, in one module, and a guard reads
the other copy.**

`camstack/src/clips/clip-still.ts` holds the header names, the disposition
rule, the refusal-code → i18n-key table and `planClipStillRetry` — the same
four numbers as `packages/ui-library/src/composites/clips/clip-still-retry.ts`
(4 s base, ×2, ±25 % jitter, 30 s cap, 4 attempts). It is a DELIBERATE
duplicate and the module says so at the top.

What is shared is not the code, it is the **contract**, and the contract lives
on the wire where it always did:

- only `x-camstack-disposition: deferred` means come back;
- a missing or unrecognised disposition is **final** — byte-for-byte the
  pre-D563 behaviour, so an addon older than that header keeps latching instead
  of gaining a retry loop nobody tested it against;
- the client never classifies `x-camstack-reason`. It is carried and rendered
  verbatim; the CODE keys the words.

That is the half a divergence would actually break, and it is pinned by
`clip-still.spec.ts` against the real captured wire. The five numbers are a
client-side politeness budget sized against a server-side lane depth; a small
divergence there is harmless, which is why they may be copied at all — and
`clip-still-drift.spec.ts` keeps them from diverging anyway.

**A mint is asked for with `fetch`, never with `<Image src>`**, and the bytes
it returns are what the tile draws (a `data:` URI — `URL.createObjectURL` does
not exist on Hermes). An `<Image>` handed a 204 fires `onerror` with nothing to
say, turning a named, temporary refusal into an anonymous broken tile; that is
exactly what shipped. The mint therefore travels on its own field,
`ObjectEvent.thumbnailMintUrl`, and never on `mediaUrl`, which is handed
straight to `<Image>`.

**A tile is never blank with no explanation.** Before the first answer it says
it is asking; after a deferral it keeps saying which wait it is in; when the
ladder ends it says it gave up; a final refusal names its reason, or shows the
provider's own sentence when the code is one this build has never heard of.
Every one of those states carries the text as an `accessibilityLabel` as well,
because at 96 px a caption is two lines of 9 px and sometimes there is no room
for it at all.

**The merge into `@camstack/types` is the right end state and is not blocked on
anything but a publish.** It is worth doing the next time `@camstack/types` is
published AND the viewer's dependency is bumped — both, or it is not a merge.
Until then the guard is what holds the line, and it holds it where the edit
actually happens.

## Consequences

- Two copies of five numbers, for as long as the viewer's `@camstack/types` is
  122 versions behind. The guard makes the drift loud; it does not make the
  duplicate free.
- The guard compares against the sibling `camstack-server` checkout. That is
  the layout in which either file is ever edited — this repo is a submodule of
  it — but in the viewer's own standalone CI there is nothing to compare, and
  the spec says so out loud instead of passing quietly.
- Worst case a tile makes 5 requests instead of 1. Measured on the live hub,
  driven by the shipped module: **103 requests served all 60 tiles in 20.3 s,
  every deferred tile on its SECOND request**, because the hub's real
  `retry-after: 16` beats the 4 s curve and the curve is only a floor. Against
  17 served and 43 blank for ever.
- One page of stills is ~2 MB of JPEG held as `data:` URIs (31–33 KB each,
  measured). The page bounds it and a tile that scrolls away unmounts and drops
  its copy. If the page size grows a lot, this is the thing to re-measure.
- `nativeClipCard` no longer stamps `mediaUrl`, so nothing downstream may
  assume a native clip card has one. Both specs that asserted the old field
  were updated rather than deleted.
- If the provider's lane depth or the viewer's page size moves, the budget
  sizing (D563's "the tail tile is ~60 mints away") is what to re-check.

## Enforcement

- `camstack/src/clips/__tests__/clip-still.spec.ts` replays the REAL captured
  first paint (`fixtures/live-592-first-paint-stills.json`, 60 tiles, every
  answer's headers as the hub sent them): 17 served, 43 deferred, the prose and
  the code asserted to DIFFER so a client that went back to matching the
  sentence goes red, and the budget proved to outlast the real drain. Jitter is
  asserted with the real `Math.random`, not a stub — a stub cannot fail the way
  43 tiles in lockstep fail.
- `clip-still-drift.spec.ts` reads
  `packages/ui-library/src/composites/clips/clip-still-retry.ts` and compares
  all four numbers. A drifted value and a RENAMED constant were both confirmed
  to go red; an absent match is a failure, never a pass.
- `use-clip-still.spec.ts` pins the machine: a named wait on the first paint
  with nothing awaited, the still on the second request, a final refusal
  latched on one request, the budget ending with `gaveUp`, and a pending retry
  dropped on unmount.
- `clip-still-tile.spec.ts` mounts the real `EventThumb` against a stubbed
  `fetch` returning REAL `Response` objects with the hub's real headers, and
  asserts what the operator sees in each state.
- Each of those was confirmed to go red with its fix removed — the deferral
  latched, the jitter flattened, the hint-floor dropped, the budget unbounded,
  the cleanup deleted, the mint put back on `mediaUrl`, the mint branch removed
  from `EventThumb`.
- Nothing mechanically forbids a second copy of the ladder appearing a third
  time. The drift guard would not see it.
