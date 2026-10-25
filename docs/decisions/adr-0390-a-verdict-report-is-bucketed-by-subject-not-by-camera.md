---
id: D390
title: A verdict report is bucketed by SUBJECT, not by camera
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/no-match-report-key.ts
---

## Context

The notification center prints one INFO line when an event interests no rule
(`event matched NO rule`) and one when a muted camera drops an event. Both
exist because the per-rule verdicts are `debug`, which does not reach the log
pipeline — a rule that had stopped matching entirely went unnoticed for fifteen
hours on 2026-07-31. Both were rate-limited to **one line per device per 60 s**
so a busy camera prints one line rather than one per event.

The bucket was the defect. On 2026-09-07 at 18:29 camera 101 saw a person and a
cat cross together:

| time | subject | what happened |
| --- | --- | --- |
| 18:29:18 | person `862ea601` | zone.enter on `Aiuola` → evaluated → rejected → **line printed** |
| 18:29:20 | animal `68069671` | appearance event — off the bus by design, no verdict |
| 18:29:24 | animal `68069671` | `left` event → evaluated → rejected on `Animale su Aiuola:zones` → **line SUPPRESSED** |

The person's verdict consumed the window the cat's verdict needed. The absence
of the line was then read — by the operator and by the session that
investigated — as *"no object-event was ever emitted for the animal track, so
the notification rules never evaluated it"*. That premise is false in every
part: two object-events were stored, one reached the rule engine, and it was
rejected on a condition (`zones: []`, the track never overlapped the polygon)
that nothing in the log could name. Hours went into looking for a missing event
and for a tracker bug (cross-class absorption) that the evidence later cleared.

The suppression is not silent in principle — the next report folds an
`alsoSuppressedSinceLastReport` count — but that count rides a line about a
DIFFERENT subject, in a different class, minutes later. It cannot answer "was
the cat evaluated?", which is the only question anyone asks of this log.

## Decision

The rate-limit bucket of a verdict report is `noMatchReportKey` — **device,
subject kind, and the subject's class set** (lower-cased, de-duplicated,
sorted) — never the device alone. One subject's verdict may never stand in for
another's on the same camera. The two reports that share the shape
(`reportNoMatch`, `reportMutedDrop`) share the key.

## Consequences

- Log volume is bounded per (camera × kind × class set) per 60 s instead of per
  camera. A stream of identical person events is still one line; a camera
  showing three classes at once now prints three. That is the point.
- The absence of a verdict line for a class is again evidence — which it was
  not, and which is what made this bucket worth changing rather than the
  interval.
- The key is a pure function so the bucketing is pinned by tests rather than by
  reading the call site. Anything else keyed on `deviceId` alone in this file
  should be read with the same suspicion.
- It does NOT change which events are evaluated or which notifications fire. It
  changes only what can be seen. The two functional defects this miss exposed —
  a `left` event carrying `bbox {0,0,0,0}`, and `object.entering` being
  unreachable above 5 fps (`enteringFrames` counts FRAMES while
  `minTrackAgeMs` counts MILLISECONDS, so the entering window closes at ~715 ms
  on a 7 fps camera before the 1000 ms age gate opens) — are recorded in
  (planning repo: sessions/sessions.md) and are not decided here. <!-- drift-ok: moved to the private planning repo -->

## Enforcement

Unit tests on the pure function (`no-match-report-key.spec.ts`) pin every axis,
including the case the rate limit exists to protect: the same class on the same
camera is one bucket. The wiring into the two call sites is review-only — a
behavioural test would have to stand up the whole notification center, and it
does not exist today. Worth knowing when trusting this rule.
