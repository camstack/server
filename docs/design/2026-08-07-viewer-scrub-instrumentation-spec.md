# Viewer spec — scrub instrumentation (the client half of D69)

> Status: to implement in the VIEWER app (the `camstack/` submodule →
> github.com/camstack/viewer.git, `src/`). The hub half is DONE
> ([D69](../decisions/adr-0070.md)): the feeder emits one per-drag aggregate
> with every phase, and the `scrubTo` control message already accepts the
> mapping hint this document tells you to send. Written so a viewer session
> needs no re-derivation.
>
> Companion: [`2026-08-07-viewer-scrub-drag-mapping-spec.md`](2026-08-07-viewer-scrub-drag-mapping-spec.md)
> is the FEATURE spec (port `drag-mapping.ts`, wire the pan handler, the instant
> label, the warm-up). This is the MEASUREMENT spec. Implement them together —
> item 1 below is two extra arguments on a call that spec already changes.

## Why

D68 shipped five scrub mechanisms and none has run on hardware. Six phases have
to be visible before the next OTA is tuned by argument instead of measurement.
Five of them are server-side and are now instrumented. The two that are not:

- **the mapping decision** — velocity lives in the gesture; the hub cannot see
  it, and if fine mode never engages nothing downstream matters;
- **the render clock** — the hub measures push→`scrubAck` round trip, but only
  the client knows how long its own leg took, and only the client can say
  whether a pushed frame was ever painted.

The precedent is `boot-timeline.ts`, shipped in the viewer yesterday: put the
whole interaction on ONE clock and emit ONE line at the end. Do that for a drag.

## 1. Send the mapping hint with every `scrubTo` (REQUIRED)

The bridge call already exists. In `camstack/embed/src/playback/recorded-track-session.ts`
it is now:

```ts
retarget(epochMs: number, hint?: { mode: 'fine' | 'coarse'; velocityPxPerS: number }): void
```

which serialises to `{ t: 'scrubTo', epoch, m, v }` — `m` and `v` optional,
`v` rounded to an integer, keys terse because this rides every pointer move.
The server parses both or neither: a mode without a velocity is discarded whole
(it would put a guessed number into the drag's percentiles).

In the viewer's pan handler, `mapDragSample` already returns the mode, and the
velocity is the same quantity it computed:

```ts
const dtMs = Math.max(now - lastSampleAtMs, 1)
const velocityPxPerS = (Math.abs(dxPx) / dtMs) * 1000
dragRef.current = mapDragSample(dragRef.current, { dxPx, dtMs }, { coarseMsPerPx: zoomMsPerPx })
embed.scrubTo(clampToCoverage(dragRef.current.cursorMs), {
  mode: dragRef.current.mode,
  velocityPxPerS,
})
```

If the viewer's embed bridge wraps `scrubTo` with its own signature, widen it —
do not drop the second argument silently. Without this the hub's aggregate
reports `mapUnknown` for every tick, which is honest but useless.

**Do not** compute or send anything else per pointer move. This is the entire
per-move addition: two scalars on a message that already goes out.

## 2. One line per drag, on one clock

Model it on `boot-timeline.ts`: a small object created at gesture GRANT,
accumulated during the drag, emitted ONCE at RELEASE (and at any abort — a drag
that ends without a line reads exactly like a drag that never happened).

**Scope:** `scrub-timeline`. **Level:** `info`.

> **The defect found here yesterday, do not repeat it.** The viewer's
> `logger.emit` only ships `verbose || warn || error` unless the scope appears
> in `ALWAYS_SHIP_SCOPES`. A new `info` scope that is not in that allowlist is
> **invisible** — it looks like it works locally and ships nothing. Add
> `'scrub-timeline'` to `ALWAYS_SHIP_SCOPES` in the same commit as the emit,
> and verify by grepping Loki for the message before calling it done.

**Message:** `scrub:drag-timeline`.

**Fields** (flat scalars — every one must be Loki-queryable; `null` where the
drag never produced the sample):

| Field | Meaning |
| --- | --- |
| `deviceId` | numeric camera id — **required**, and as a TAG if the viewer logger supports tags, not only in the message |
| `dragMs` | grant → release, wall clock |
| `samples` | pointer-move samples the handler processed |
| `retargets` | `scrubTo` messages actually sent (≤ `samples` if you coalesce) |
| `fineSamples` / `coarseSamples` | mapping census, client-side — the pair that must agree with the hub's `mapFine`/`mapCoarse` |
| `modeFlips` | fine↔coarse transitions; a high count means the hysteresis thresholds are wrong for this gesture |
| `velPxPerSP50` / `velPxPerSMax` | the gesture's own velocity distribution |
| `spanMs` | `abs(lastCursorMs − anchorMs)` — how far the drag actually travelled in media time |
| `positions` | `position` messages received (the server's per-push playhead) |
| `renders` | frames rendered via `requestVideoFrameCallback` while the drag was live |
| `acks` | `scrubAck` messages sent (should equal `renders`, or `positions` on a platform without rvfc) |
| `rvfc` | whether rvfc was available at all — the ack path differs, and so does what `renders` means |
| `firstFrameMs` | **grant → first painted scrub frame.** The number the operator feels, and the one the hub cannot see: its `firstPushMs` stops at the wire |
| `paintMsP50` / `paintMsMax` | per-frame `position`-received → next rvfc paint; the client leg of the hub's `ackMs*` |
| `staleMs` | at release, ms since the last painted frame — a drag that froze mid-gesture ends with a large value here and nowhere else |

`renders === 0` with `retargets > 0` is the signature of a drag the viewer asked
for and never saw, and it is one query away with these fields.

## 3. What NOT to add

- No per-pointer-move log line. At 60 Hz across a grid that is the flood D69
  exists to avoid; the counts above already carry it.
- No per-frame log line — `renders` is the count, `paintMsP50/Max` the shape.
- No new timer, no new subscription: every input above is already observed by
  `RecordedTrackSession` (`retargets`, `positionsSeen`, `renders`, `acks` are
  literally its existing per-drag counters — extend that object rather than
  building a second one beside it).
- Do not re-implement the mapping to compute the census. Read
  `state.mode` off the value `mapDragSample` already returned.

## 4. How to verify it landed

1. Drag slowly on one camera for ~5 s, release.
2. Loki, viewer stream: `scrub:drag-timeline` present, with `fineSamples > 0`.
   Absent ⇒ the `ALWAYS_SHIP_SCOPES` entry is missing (§2).
3. Loki, hub stream, same minute:
   `{container="CamStack"} |= "scrub-feeder:drag-end" | json | mapFine > 0`.
   `mapFine` still `0` while the viewer reports `fineSamples > 0` ⇒ the hint is
   not reaching the wire (§1 — most likely a bridge wrapper dropped the second
   argument).
4. Compare `firstFrameMs` (viewer) with `firstPushMs` (hub) for the same drag:
   the difference is the network + decode + paint leg, which is the thing no
   single side could ever measure.
