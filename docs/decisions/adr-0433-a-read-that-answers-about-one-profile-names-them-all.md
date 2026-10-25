---
id: D433
title: A read that answers about one profile names them all
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-pipeline/src/recorder/addon/calendar-scan.ts
last-verified: 2026-09-10
---

## Context

The operator asked for a timelapse export off the LOW stream.
`recording.getAvailability` for camera 101 returned twenty ranges, every one
`profile: 'high'`. From that I concluded — out loud, and wrongly — that no
camera on this deployment records `low` at all.

The operator knew better. `/media-fast/recordingsLow/101/low/2026/09/10/` holds
hours 00–10, **14 GB for that one camera**, on a storage location the `high`
tree does not share. The export ran fine when asked for `low` explicitly, and
the difference is not marginal:

| profile | file | resolution | render |
| --- | --- | --- | --- |
| high | 92 MB | 3840×2160 | 230 s |
| **low** | **320 KB** | 640×360 | **52 s** |

Nothing was broken in the reader. `availabilityFor` resolves ONE profile
(`availabilityProfileFor`) deliberately: the timeline is a single bar, and
enumerating all three triples the directory reads for a bar that would look
identical. `PROFILE_PREFERENCE` puts `high` first, so a camera that records
both will always be described by `high`.

**The defect is the answer's silence about that.** Its shape is
`{ profile, startMs, endMs }[]` — which reads as "these are the profiles" — and
nothing in it distinguishes "this camera has only `high`" from "I chose `high`
for you". A caller asking *what can I export?* gets a false negative, and so
does a reader of the log.

## Decision

**A read that deliberately answers about PART of what exists names the whole.**

`RecordingAvailability` gains `profilesWithFootage`: every profile the camera
holds footage in, unioned **across roots** — because on this hub `high` and
`low` do not share a location, so a per-root answer sees one of them. It is
non-emptiness rather than existence (a directory left by a config change is not
offered) and `KNOWN_PROFILES` only (the camera dir also hosts `events/` and the
retired `strips/` trees). It costs the same shallow read the profile choice
already makes, and it is cached the same way.

`getAvailability` also takes an optional `profile`: answer for that one when
the camera records it, else the preferred pick — the fallback
`servedProfileFor` already owned, so it is never silent.

The batch answers the same fields. A row that dropped `profilesWithFootage`
would tell a grid caller the archive holds one profile, and the existing
"answers exactly what the SINGULAR method answers" case now compares every
field rather than a chosen pair.

## Consequences

- An export UI can offer `low`, which for a notification-sized artefact is the
  whole game: 320 KB against 92 MB for the same window.
- The timeline is unchanged — no `profile` input, one bar, one set of reads.
- **This was nearly shipped without a guard.** The `profile` input passed every
  test until it was disarmed on purpose and nothing failed; the case that pins
  it was written afterwards. The `profilesWithFootage` half had tests from the
  start. Both halves needed them.
