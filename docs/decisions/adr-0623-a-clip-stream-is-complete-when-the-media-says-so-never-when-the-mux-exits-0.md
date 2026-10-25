---
id: D623
title: A clip stream is complete when the MEDIA says so, never when the mux exits 0 — and a short serve is named to the operator, not retried
status: proposed
date: 2026-09-24
supersedes:
applies-to:
  - packages/addon-provider-amcrest/src/clips/clip-truncation.ts
  - packages/addon-provider-amcrest/src/clips/clip-stream.ts
  - packages/addon-provider-amcrest/src/clips/clip-stream-mux.ts
  - packages/addon-provider-amcrest/src/clips/clip-stream-dial.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-http.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-feeder.ts
  - packages/addon-pipeline/src/stream-broker/recorded/control-protocol.ts
---

## Context

The Amcrest `/cam/playback` replay hangs up part way through a clip, and
**ffmpeg exits 0 when it does**. The producer's only completion signal was that
exit code:

```ts
settle({ kind: 'served' }, code === 0 ? 'complete' : 'ended-nonzero')
```

so a camera that dropped the session two thirds of the way through a clip was
logged `videoclips: a clip stream was served … branch: "complete"`, with no
line anywhere saying the media was short. Measured on the live hub, camera
3836, from the operator's own session on 2026-09-23 19:37:

| clip | row window | branch | bytes |
| --- | --- | --- | --- |
| `1790183010-1790183055` | 45 s | **`complete`** | 4 978 237 |
| the same clip, the next attempt | 45 s | `peer-closed` (he gave up) | 11 841 121 |
| `1790183099-1790183304` | 205 s | **`complete`** | 3 496 519 |
| `1790184551-1790184730` | 179 s | **`complete`** | 6 925 986 |

The whole 45 s clip, dialled through the same route on 2026-09-24 00:39 and
allowed to finish, is **39 294 962 bytes / 69.569 s of media**. So the serve the
system called a success delivered **12.7 % of the bytes**, and the attempt the
operator abandoned in disgust had already delivered 2.4× more than it. A
separate probe saw the camera grant a replay session, answer `PLAY 200` and
deliver no RTP at all — the same branch at its limit, also wearing `complete`
once ffmpeg had written an `ftyp` and an empty `moov`.

Three things had to be decided.

**What "expected" is.** `clip-search.ts` records that the row's `Duration` is
WALL CLOCK and that the container inside the camera's FILE runs about 7.5 %
shorter (74 s row → 68.433 s media, `ffprobe`), and warns that "a completion
check that compares the delivered media against the ROW naively would fire on
every clip this camera makes." **That number does not transfer to the replay
path**, and assuming it did would have bought a multi-second blind spot per
clip. The file is the whole `.dav` the camera wrote; the replay is cut by the
`starttime`/`endtime` in the URL, so it tracks the row. Measured over the dial
route on 3836, 2026-09-24 (video-track duration, `ffprobe`):

| clip | row window | delivered | against the row |
| --- | --- | --- | --- |
| `1790189744-1790189787` | 43 s | 42.986 s | **−0.015 s** |
| `1790189367-1790189411` | 44 s | 44.835 s | +0.835 s |
| `1790189415-1790189537` | 122 s | 124.650 s | +2.650 s |
| `1790189791-1790189844` | 53 s | 56.463 s | +3.463 s |
| `1790189601-1790189740` | 139 s | 140.483 s | +1.483 s |
| `1790183010-1790183055` | 45 s | 69.569 s | **+24.569 s** |

Five of six ran OVER their row. So only a shortfall is a defect, the tolerance
is absolute (the only clean shortfall measured is 0.015 s, and it does not
scale with clip length), and it is **1.5 s** — the same number and the same
argument as the Reolink judge: the row's stamps are whole seconds, and ffmpeg's
`out_time` is the last frame's presentation stamp rather than the end of its
interval, which under-states by one frame interval.

**Where the measurement comes from.** `-progress pipe:3`, on a fourth
descriptor. `-progress pipe:2` was never an option: stderr is where the
camera's own sentence lands, it is kept to its last 4 000 characters so a
refusal can be classified and quoted, and a progress block every half second
would evict that sentence. Verified against the hub container's own ffmpeg:
`-progress pipe:3` writes `frame=` / `out_time_us=` there and nothing to
stderr.

**Retry, or say so?** Asked, the operator chose saying so, verbatim: *"Se cade
la sessione cade non fa niente, magari mostriamo un errore dove mostriamo anche
l'errore di stream."* [If the session drops it does nothing, maybe we show an error where we also show the stream error.] A retry would contend for the camera's single replay lane
exactly when that lane is already failing, and the bytes are already at the
peer — there is nothing to replace.

## Decision

A clip stream is judged by the MEDIA it delivered against the catalog row's own
window, never by the mux's exit code. The producer is handed the row's span
(`ClipStreamRequest.expectedMs`, required), measures what it wrote off
`-progress` on a dedicated fd, and answers `served` with a **verdict**:
`complete`, `short` (beyond `CLIP_DURATION_SHORTFALL_TOLERANCE_S = 1.5`),
`empty` (zero frames — not a 100 % shortfall, a camera fault, and never the
same branch), or `unknown` (nothing measured; never folded into either). Each
gets its own WARN/INFO line with `tags: { deviceId }`, the delivered and
expected figures and a greppable `branch`, in the vocabulary the Reolink
provider already uses. A short or empty serve is **reported to the operator and
never retried**: the provider adds `x-camstack-reason-code` /
`x-camstack-reason` as HTTP **trailers** — the only channel still open once the
status line has been spent on the first fragment — the broker reads them at
`end` and relays them as one `clipIncomplete` control message, named by clip.

## Consequences

- **`ClipStreamRequest.expectedMs` is required.** A caller that cannot supply
  the row cannot open a stream. It is read from `rowsByKey`, the same row the
  mint used; nothing derives a span from the clip key, because a second
  arithmetic on one fact is how two answers start disagreeing.
- **`{ kind: 'served' }` is no longer a bare marker.** Every caller of the
  producer sees the verdict, which is what makes the trailer possible at all.
- **The `Trailer` header goes only on a response that has a body.** Node throws
  `Trailers are invalid with this transfer encoding` from inside `writeHead` on
  a response that is not chunked; declaring it on the route's `HEAD` turned the
  probe every consumer makes before it dials into a 500. Same family as the
  refusal header that hung the socket it existed to explain (D611).
- **The broker relays, it does not derive.** It already measures how long the
  media it received runs (`clipDuration`, D575); it does not know the camera's
  catalog row, so it must not form a second opinion on completeness (D62).
- **`completeness-unverified` never reaches the viewer.** "We could not check"
  is a provider diagnostic and stays on the provider's log line; the wire
  schema refuses it, so one cannot leak onto a screen.
- **This is the THIRD spelling of one judgement.** Reolink's
  `clip-truncation.ts` and Hikvision's inline `isShort()` answer the same
  question with the same words and two different tolerances (1.5 s and 1.0 s).
  The Amcrest copy uses Reolink's names to the letter so the extraction is
  mechanical — but it was NOT extracted here, on purpose: the shared home is
  `@camstack/types`, which travels inside the published `@camstack/server`
  closure, so extracting would have turned a provider bugfix (an addon deploy)
  into a framework release on every node. The debt is real and is named here so
  the next person does not have to rediscover it.
- **The viewer has not been changed.** The hub now emits `clipIncomplete`;
  until the viewer renders it, the improvement is the log lines and the wire
  message. The viewer work is specified in (planning repo: sessions/sessions.md). <!-- drift-ok: moved to the private planning repo -->

## Enforcement

Tests, in both packages, each disarmed individually and confirmed red:
`clip-truncation.spec.ts` (the verdict and its four kinds), `clip-stream.spec.ts`
(the producer names a short serve, keeps `empty` separate, refuses to call an
unmeasured stream complete, and asks ffmpeg for progress on `pipe:3` and never
`pipe:2`), `clip-stream-dial.spec.ts` (the trailers on a real socket, and `HEAD`
still 200), `clip-stream-http.spec.ts`, `clip-stream-feeder.spec.ts`,
`timeline-session-clip.spec.ts` and `control-protocol.spec.ts`.

**One hop has no test and it is named rather than hidden**: `clip-service.ts`'s
dial callback, where the row's window is handed to the producer, is inside the
`createClipService` closure, which needs a live camera (RPC2 login for the
clock) to reach — replacing `expectedMs: row.endMs - row.startMs` with
`expectedMs: 0` leaves the whole Amcrest suite green. Two things stand in for a
test there: the field is required, so the compiler refuses a caller that omits
it, and a zero window makes the judge answer `row-window-unknown`, which is a
WARN line saying the clip could not be checked — loud, not a false `complete`.
