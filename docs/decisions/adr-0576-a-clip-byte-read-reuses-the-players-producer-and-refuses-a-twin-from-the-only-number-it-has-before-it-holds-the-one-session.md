---
id: D576
title: A clip byte read reuses the PLAYER's producer, bypasses the scratch for the twin it does not hold, and refuses an over-size twin from the only number it has rather than holding the one session for a transfer it will throw away
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-service.ts
  - packages/addon-provider-reolink/src/clips/reolink-videoclips-provider.ts
---

## Context

[D572](./adr-0572-a-clip-subject-carries-the-provider-the-catalog-window-and-nothing-the-operator-drew-and-a-source-that-holds-no-file-says-so-in-the-type.md)
landed the clip export and left one half of it unbuilt: `packages/addon-provider-reolink`
belonged to another agent that day, so a `native:reolink:*` clip export failed
at the router with `NOT_IMPLEMENTED`. This is the producing half, and building
it forced four questions D572 could not have settled.

1. **There was already a fetch, and it was not parameterised.**
   `clip-service.ts` fetched `row.subFileName` — hard-coded — proved the decode
   against the catalog row on a 300 ms idle window, retried once on 2 000 ms
   (D568) and muxed at the MEASURED rate with the AAC track copied (D567). A
   byte read needs the same rules and a DIFFERENT file, and the obvious way to
   get one is a second fetch. That is precisely the second authority D568 was
   written to prevent.

2. **The scratch holds one twin and its key cannot say which.** The playback
   scratch is keyed `clipKeyFor(channel, subFileName)` — no twin in it — and
   is bounded at 10 files / 200 MiB per device. It has only ever held the SUB
   file, because the player has only ever fetched the sub file.

3. **`high` against a 50 MiB ceiling is not a corner case on this fleet.**
   Measured read-only on 592 over 24 h (396 clips): the sub twin runs
   286 KB–8.9 MB (median 852 KB) and **0 of 396 exceed the bound**; the main
   twin runs 2.2 MB–175 MB (median 25.7 MB, ratio 31.1×) and **89 of 390
   (22.8 %) exceed it**. A `high` clip export on this camera is refusable
   almost a quarter of the time.

4. **The only cheap number is one D568 proved does not match.** The catalog row
   carries the camera's listed file size. D568 established it "has never
   matched the received byte count on any clip measured", and this session
   re-measured the same thing on five live clips: the DELIVERED file is
   58–81 % of the listed size, because a remux drops the container, the index
   and any track it will not copy. So the row can prove "this fits" and can
   never prove "this does not".

## Decision

**`readClipBytes` and the player share ONE producer, and the twin is a
parameter of it.** `produceTwin` in `clip-service.ts` is the only place in this
addon where a clip's bytes are made: it runs the gates, the cmd 5 fetch on
`CLIP_IDLE_WINDOW_MS`, `judgeClipDuration` against the row, the single retry on
`CLIP_IDLE_WINDOW_RETRY_MS`, and the mux — once, for both callers. It never
throws for a gated branch; every exit is a NAMED refusal in the clip-export
vocabulary (`ClipBytesRefusalCode`, an `Extract` of `ClipExportFailure` so a
token invented here cannot compile). Its in-flight map is keyed
`(deviceId, clipKey, twin)` and is shared by the player and the read, because a
per-caller map would buy a second wake on a camera the operator authorised
once.

**`durationMs` is the decode's, or nothing.** `stats.durationSeconds` rounded
to milliseconds when it is finite and positive; `null` otherwise, and the
answer then omits the field. The row's `endMs − startMs` is a projection and is
never returned wearing a measurement's clothes (D393).

**A `sub` read reuses and warms the scratch; a `main` read bypasses it in both
directions.** Reuse, because the scratch key names exactly the sub file and a
clip the operator just watched must not cost a second cmd 5 — and a read that
lands there warms it for the play that follows. Bypass for `main`, because
writing a main file under that key would serve 33× the bytes to every `low`
playback of the clip, and filing it under a second key would evict the sub
clips the player really does re-read in order to cache a one-shot export nobody
reads twice. A scratch hit answers with **no `durationMs`**: that pass measured
nothing, and the file carries no sidecar.

**An asked twin that does not EXIST is a divergence; one that is too BIG is a
refusal.** No main twin ⇒ serve the sub, `served: 'low'`, log `no-main-twin` —
D549 15's rule, and 6 of 396 rows on 592 and 1 of 2 on the 639 child have no
main copy. A main twin over the bound ⇒ `too-large-to-transfer`, **decided from
the camera's listed size, before any session is opened**, with the number and
the fact that it is the CAMERA'S number in the message; the delivered file is
bounded again after the mux, on a distinct branch whose log line carries
`bytes` where the first carries `declaredBytes`.

**A read never wakes a standalone battery camera; `wake: 'authorised'` lets it,
once.** The gate is in `produceTwin`, before `getApi()`, because on UDP the
login IS the wake. There is exactly one such gate on this path — the provider
does not re-decide it — and the one wake is protected by the shared in-flight
map, not by a second authorisation.

## Consequences

- **The declared-size gate refuses some clips that would have fitted.** With
  the 0.581 floor measured here, 44 of 390 main twins on 592 (11.3 %) are
  listed above 50 MiB and might have delivered under it. That is the price and
  it is deliberate: the alternative is pulling up to 175 MB over the ONE
  session every other read on that camera shares (D549 17), muxing it,
  base64-ing it to ~233 MB of string, and refusing anyway — on a hub this repo
  has already OOM'd (D9/D18). A wrong "no" costs one export; a right "yes" that
  arrives 30 s later having taken the runner down costs the camera.
- **The remedy is not a better estimate, it is a bounded transfer.** Two exist:
  the CHUNKED read the cap already names, and a byte cap on the fetch itself
  (`downloadRecordingDemuxed` takes none today) so a transfer stops at the
  ceiling instead of being guessed at in advance. Either removes this gate
  entirely. A shrink RATIO tuned from five samples was considered and refused:
  it is an unmeasured guess in the direction that OOMs.
- `readClipBytes` answers from the provider's own `rowsByKey`, which a restart
  empties. From cold it refuses `catalog-miss` naming the day to list — correct,
  and rare, because D572's engine lists the catalog window first through the
  same provider instance.
- The uid gate (`clip-addressing.ts`) now runs on the byte path as well, which
  its own docblock already claimed ("the gate every catalog, still and byte read
  runs") and which nothing enforced. A hub child with no persisted uid is
  `catalog-unreachable` instead of a download that cannot be addressed.
- `preparePlayback` still reports `served: 'high'` for a `high` playback while
  `prepareClip` fetches the sub file, because the playback URL carries no twin.
  That predates this change and is untouched by it; it is written down here
  because `readClipBytes` deliberately does NOT inherit it — this method serves
  the twin it names.

## Considered and not taken

**Falling back to the sub when the main twin is over the bound**, reporting
`served: 'low'`. The engine is built for a divergent `served` and would have
accepted it. Refused because the cap's own docblock settles it — "above the
bound the provider REFUSES with the size in the message, never truncates" — and
because a quality that does not EXIST and a quality we decline to TRANSFER are
different facts: the operator still has the unbounded playback route for that
file, and a silent 31× substitution of the archive copy he asked for is not a
thing he can see in a modal.

**A second fetch path for the export**, with its own completion rule. It would
have been three lines shorter and is exactly what D568 exists to forbid.

**Filing the main twin in the scratch under a twin-suffixed key.** It would
make a repeated `high` export free. At 20–175 MB a file against a 200 MiB
per-device bound it would also evict every sub clip the player holds, to cache
the one artifact that already persists somewhere else — the export record.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/clip-read-bytes.spec.ts`, 23
tests, each proved by reverting the gate it covers and watching exactly that
test go red:

- the window and the single retry the download SAW (`size-gate`, `twin-handle`)
- the measured duration, and its absence when nothing measured one
- the twin asked for, the twin served, and the `no-main-twin` divergence
- the declared-size refusal with NO session opened, the caller's bound, the
  ceiling capping the caller, and the delivered-size refusal on its own branch
- the sleep gate with no session opened, one authorisation ⇒ one fetch, and a
  hub child never gated
- `catalog-miss` from cold, a foreign id, `clip-in-progress`, `camera-refused`,
  `fetch-failed`
- the scratch: reused for `sub`, never written for `main`, one fetch for two
  racing reads
