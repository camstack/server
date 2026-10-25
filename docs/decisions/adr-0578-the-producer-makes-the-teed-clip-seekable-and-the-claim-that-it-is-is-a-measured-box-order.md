---
id: D578
title: The producer makes the teed clip seekable, and the claim that it is, is a measured box order
status: accepted
date: 2026-09-21
applies-to:
  - packages/addon-export-hap/src/hksv/clip-remux.ts
  - packages/addon-export-hap/src/hksv/clip-ffmpeg-run.ts
  - packages/addon-export-hap/src/hksv/clip-store.ts
  - packages/addon-export-hap/src/hksv/clip-record.ts
  - packages/addon-export-hap/src/hap-export.addon.ts
  - packages/addon-export-hap/src/hksv/__tests__/clip-remux.spec.ts
last-verified: 2026-09-29
---

## Context

The HKSV tee cuts like a pipe. It subscribes to the same `Fmp4FragmentPlane`
HomeKit is being served from and writes `init + fragments` straight to a file,
so what lands is `frag_keyframe+empty_moov`: ffmpeg never returns to write a
trailer.

Measured on this hub's own clips, and independently reproduced by the work on
recorded playback ([D575](adr-0575-a-clip-plays-through-the-same-webrtc-session-because-the-feeders-byte-source-was-never-the-recorder.md)):
`mvhd.duration` is **0**, `mdhd.duration` is **0**, the `stbl` sample tables are
present and **empty**, and there is no `mfra`.

The file **decodes end to end** — it plays. What it cannot do is map a time to a
byte, and a time-to-byte map is the whole of what a scrub, a `Range` request and
a stated duration are. So a HomeKit clip could be listed, played from the start,
and nothing else: the clip-file source in the broker refuses it with
`no-samples`, and it always would.

## Decision

**The pass that fixes this belongs to the addon that MINTED the clip, and it
runs once, at mint time.**

`-c copy -movflags +faststart`, in `complete()`, before the still. Measured at
**40 ms and +0.7 % bytes**.

Three things follow, and each is the interesting half of the decision.

### The vouch is a box order read off the produced file, never an exit code

`-movflags +faststart` exiting 0 is not evidence. `moovPrecedesMdat` walks the
top-level boxes of the output and requires `moov` ahead of the media — **and
requires the file to be progressive**, because `moof` before any `mdat` means
the samples live in the fragments and the leading `moov` is the empty one
`empty_moov` wrote. The fragmented file the tee already produced is *also*
moov-first; judging on position alone would bless precisely the file this pass
exists to replace, and every other test of it would be vacuous.

This is the same discipline the thumbnail already had — the store stats the JPEG
and believes the file, not the minter — applied to the one claim that could not
be checked by looking at a size.

### A clip that does not seek is a clip; a clip the pass ate is a recording lost

HomeKit Secure Video is a sink. There is no read-back, ever, so the copy the tee
kept is the only copy that will ever exist. The pass therefore writes a
**sibling** and renames over the original only once it has vouched for it, it
never throws, and it never runs on a clip the store is about to drop.

### Every way of failing has a name, on the record

`seekable: true` when vouched, `remuxUnavailable: { reason }` otherwise —
`remux-failed | timed-out | ffmpeg-missing | not-seekable | not-attempted`. A
missing binary, a deadline and a file ffmpeg blessed but did not fix are three
different operator actions, and "it does not seek" is none of them (D400).

**Neither field means UNKNOWN**, which is why `seekable` is an optional literal
rather than a boolean: a sidecar written before this field existed cannot be
given one after the fact, and a reader must not read that silence as "does not
seek" ([D393](adr-0393.md)).

And `bytes` is re-stat'd from the rewritten file rather than carried over from
the tee's own count. Otherwise the one field a `Range` reader and the disk
accounting both use would be wrong by exactly the pass's +0.7 %, for ever.

## Alternatives rejected

**Remux in the CONSUMER, at play time.** This is what
[D570 § 5(b)](adr-0570-a-clip-plays-in-the-cameras-own-frame-and-the-playback-machine-is-structurally-detached-while-it-does.md)
costed and rejected, and D575 rediscovered from the other side: it puts an
ffmpeg **per viewer** in the broker's runner and buffers the whole file to write
a trailer, every time anybody drags. A clip is written once and read many times;
this is the side of that asymmetry the work belongs on.

**Index the fragments instead of remuxing.** Building an `mfra`-equivalent by
walking every `moof` is possible and needs no ffmpeg — and produces a sample map
that only *our* readers can use. A progressive MP4 is seekable to a browser, to
`ffprobe`, to a `Range` reader and to the export path, with no shared code.

**An ffprobe for the duration.** Rejected, and the measurement that came back
from the first live clip is why it did not stay rejected in the form it was
written. `durationMs` was `endedAtMs - startedAtMs` — how long the TEE ran —
and the record's own docblock claimed it included the prebuffer replay. It did
not: the clock starts when the tee does, and the first fragments it writes are
footage older than the tee itself. On 101, **12.0 s claimed against 19.99 s
held**.

So the duration IS read from the file, and still without a second spawn: after
the faststart pass `mvhd` sits at the front of the file the pass already
produced, and `readMovieDurationMs` reads it out of the same head buffer the
box-order vouch was checked against. `null`, never `0`, for every way of not
knowing — including the zero `empty_moov` writes, which is the case that
matters, since believing it would replace a duration that is merely wrong with
one that confidently says the clip is empty. The wall clock remains the
fallback.

## What the first live clip cost, and what a fake had hidden

The pass failed on **every** real clip — `remux-failed`, three for three — with
the suite green. `-movflags +faststart` was being written to a sibling named
`<clip>.mp4.faststart`, which is not a recognised extension, and ffmpeg
answered *"Unable to choose an output format … use a standard extension"* and
wrote nothing. The tests did not see it because the fake runner wrote the bytes
ffmpeg never would — the exact failure mode `CLAUDE.md` names: *a test passes
because the fake supplied the value production forgot to fetch*.

The fix is `-f mp4`, and the sibling keeps its non-`.mp4` name on purpose so a
sweep can never mistake a half-written temporary for a clip. What pins it is
not a better fake but a claim about the ARGUMENTS: the muxer is stated, because
the output name is ours and was chosen for a different reason.

## Consequences

- Clips teed **before this** carry neither field and are not backfilled. They
  play and do not seek, and they say `undefined`, not `false`. A sweep that
  remuxes the existing store is a separate piece of work and was not done.
- The bounded-ffmpeg spawn is now `clip-ffmpeg-run.ts`, shared by the still and
  the remux — one place a deadline can be forgotten, two budgets (10 s and
  30 s) because they answer different questions.
- `moovPrecedesMdat` refuses a box whose declared size does not advance the
  cursor. Without that guard the scanner does not return the wrong answer — it
  **never returns**, and a synchronous infinite loop is the one failure a test
  runner's timeout cannot interrupt. The revert proof for that gate is a hang,
  not a red test.
