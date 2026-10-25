---
id: D435
title: The timelapse asks for the cheap band by name
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-post-analysis/src/notification-center/timelapse/timelapse-renderer.ts
last-verified: 2026-10-02
---

## Context

The scheduled timelapse rule has been off since 2026-09-03, and the reason is
recorded in `pickProfile`'s own docblock: a test render of a ten-hour window
chose `profile=high` at 97% coverage — 4K read from a USB spinning disk.
Decoding it made the machine stop answering SSH and its own web UI for half an
hour, and it had to be power-cycled.

The fix written that day was to stop ranking by coverage and **take the
cheapest band that has anything**, every time: "a timelapse is watched
accelerated, resolution buys nothing at 12 fps over a night, and the cost
difference between the bands is one to two orders of magnitude in both bytes
read and frames decoded."

**That fix could never fire.** `pickProfile` chooses among the ranges it is
handed, and it is handed `recording.getAvailability(...).ranges` — which
answers for ONE profile, the PREFERRED one, and the preference puts `high`
first ([D433](adr-0433-a-read-that-answers-about-one-profile-names-them-all.md)).
The safety rule could only choose from the expensive band and nothing else.

Measured on camera 101, the same one-hour window:

| band | file | resolution | render |
| --- | --- | --- | --- |
| high | 92 MB | 3840×2160 | 230 s |
| **low** | **320 KB** | 640×360 | **52 s** |

287× the bytes and 4.4× the time, for a video watched at 12 fps.

## Decision

**The renderer names the band it wants.**

One availability read learns which bands exist (`profilesWithFootage`); if the
band the answer describes is not the cheapest, a second read asks for the
cheapest by name. On a deployment where the preferred band is already the
cheapest, there is no second read.

`pickProfile` is unchanged — it was right. What changed is that it is now
handed a real choice.

## Consequences

- The rule can be re-enabled. A ten-hour night off the low band is minutes of
  ffmpeg on a file of a few MB, against the 4K read that cost a power cycle.
- The artefact is notification-sized without any re-encoding: the low band's
  timelapse is **320 KB** at 640×360. A GIF of the same clip is 492 KB at
  320px/5fps and 3.5 MB at 640px — the MP4 is smaller than every usable GIF and
  looks better, so GIF is only worth it where a notifier refuses video.
- **The pattern to carry:** a safety rule that filters a list is only as good
  as the list. `pickProfile` read as correct for a week, in code review and in
  its own tests, because nothing in it was wrong — the defect was one call
  upstream, in a method that answered a narrower question than its shape
  implied.
