---
id: D432
title: The faststart pass is silent by design, and the watchdog must know it
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-pipeline/src/recorder/addon/export-engine.ts
last-verified: 2026-09-30
---

## Context

The operator confirmed an export from the viewer's scrub and it failed. The hub
recorded, verbatim:

```
[mp4 @ …] Starting second pass: moving the moov atom to the beginning of the file
ffmpeg stalled: no progress for 90000ms
```

`code=null` — the process did not fail, it was **SIGKILLed by our own
watchdog**, and its first pass had already finished.

`runFfmpeg` arms a stall timer and re-arms it only when a line matches
`TIME_RE` (`time=HH:MM:SS`). `-movflags +faststart` runs a SECOND pass that
rewrites the whole file to move the moov atom to the front, and it emits **no
progress line at all** while doing so. So the silence that pass is *made of*
read as a hang, on a budget (90 s) sized for the first pass. The larger the
export, the more certain the kill — the failure is systematic, not flaky.

The stderr above it is noisy (`DTS 0 < 152871 out of order`, `Found duplicated
MOOV Atom`, timestamp discontinuities), which is the expected shape of
concatenating fMP4 segments that each restart their timeline. It is not the
cause and was a good way to be misled.

Measured against a second, independent export the same day: a one-hour
timelapse on camera 101 (`everyMs: 10000`, 336 frames, **92 MB**, 3 m 50 s
wall) completed cleanly. Its faststart pass is trivial because its file is
small — which is exactly why the defect had never been seen on a timelapse.

## Decision

**The faststart pass gets its own budget.** When ffmpeg announces it
(`Starting second pass: moving the moov atom`), the watchdog re-arms with
`EXPORT_FASTSTART_STALL_MS` instead of `EXPORT_STALL_MS`.

The budget is **not removed**: a genuinely wedged rewrite must still die. It is
sized for rewriting a long export on a spinning array, and it is armed by the
one signal ffmpeg gives — its own announcement.

## Consequences

- A large export completes instead of being killed at the last step, after all
  of its decode work is already done. That is the worst possible moment to lose
  it.
- The general rule this is an instance of: **a watchdog that measures liveness
  by one kind of output cannot supervise a phase that produces a different kind
  — or none.** The same shape appears elsewhere in this repo whenever "silent"
  is read as "stuck".
- Not fixed here: the export's stderr is full of `DTS out of order` and
  duplicated MOOV atoms from the fMP4 concat. It is noise today, but it is the
  noise a real muxing defect would hide in.
