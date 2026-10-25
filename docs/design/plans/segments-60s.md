---
title: Plan — 60-second segments
date: 2026-08-26
status: proposed
---

# 60-second segments

Sub-plan of `../2026-08-25-viewer-track-query-plan.md` (Phase E.3). The
project is NOT open: it is already in `../2026-08-25-reference-scrub-teardown-and-plan.md`
§4(b). This plan makes it executable.

## Why it is worth it

`DEFAULT_SEGMENT_SECONDS = 10` (`recorder/addon/recorder-defaults.ts`), already
raised once from 4 to 10. Taking it to 60:

- **six times fewer index rows** — 3.5 M → ~104 k
- six times fewer file opens per unit of timeline
- and it is what makes a forward sequential strategy possible, which today it
  is not

## The blocker, and why it is not unknown

Approved by the operator some time ago and never done, with this rationale on
record: there is no way to ask *"how many consecutive GOPs fit in N bytes"*. The
teardown has already given the answer, and it is **`tfra`**: the random-access
table of the MP4 fragments carries the offsets of every fragment, so a byte
budget converts into a set of fragments **without reading the payload**. The
chicken-and-egg problem — you need the bytes to know how many bytes you need —
does not exist if you read the index instead of the content.

The number that makes the work mandatory:

> `SCRUB_WHOLE_SEGMENT_MAX_BYTES = 1_500_000` was tuned on a `low` segment of
> ~230 KB at 10 seconds. A native 60 s `low` is ~1.4 MB — **on the edge**; a
> derived 60 s `low` would be ~4.8 MB and would **silently fall back** to
> per-GOP reads.

Silently: that is the point. Raising the duration without touching the read unit
breaks nothing visibly, degrades every scrub and nobody finds out.

## Constraints

The global constraints of the parent plan apply. In addition:

- **Do NOT raise `DEFAULT_SEGMENT_SECONDS` until Task 1 is verified.**
  The order is the content of this plan.
- `RecordingConfig.segmentSeconds` is a PER-DEVICE override. Whatever is done
  must keep working for a device that already has its own value.
- Segments already written stay at 10 s. The code must read both durations
  without knowing in advance which one it is looking at — the migration is
  *none*, coexistence is mandatory.

## Task 1 — The read unit becomes a byte budget over `tfra`

**Files:**
- `packages/addon-pipeline/src/recorder/scrub/` — where `fmp4-keyframes.ts` already lives
- the caller in `packages/addon-pipeline/src/stream-broker/recorded/`

- [ ] **Step 1** — read `fmp4-keyframes.ts`. Today it does `appendBuffer` + `flush` and
      demuxes the WHOLE segment: that is the reason the unit is the file. Establish
      where `tfra` (or `sidx`) is readable and with which library — `mp4box` is already a
      dependency.
- [ ] **Step 2** — failing test: given a segment and a byte budget,
      the function returns the set of fragments that fits inside it, and their
      byte range. Cover the case where **a single fragment exceeds the
      budget** — it must return one anyway, or explicitly declare that
      it cannot, never an empty set that the caller reads as "nothing to
      read".
- [ ] **Step 3** — red. **Step 4** — implement. **Step 5** — green.
- [ ] **Step 6** — replace `SCRUB_WHOLE_SEGMENT_MAX_BYTES` used as
      "the whole file fits / does not fit" with the real budget. The per-GOP
      fallback branch must stay, but **logged**: today it is fallen into silently.

## Task 2 — Measure BEFORE raising the duration

- [ ] **Step 1** — with the budget active and segments still at 10 s, measure
      `scrub-feeder:drag-end` on the live system. It must be **identical or better** than
      now: Task 1 must cost nothing at 10 s, or it has a defect.
- [ ] **Step 2** — write the numbers in (planning repo: sessions/sessions.md). <!-- drift-ok: moved to the private planning repo -->

## Task 3 — Raise the duration, on ONE camera

- [ ] **Step 1** — set `RecordingConfig.segmentSeconds` to 60 on **a single**
      camera, chosen together with the operator. Do not touch the default.
- [ ] **Step 2** — after it has written enough segments, re-measure scrub on
      that camera and on a control one left at 10 s.
- [ ] **Step 3** — bring the two numbers to the operator. The default is raised only
      after a real camera has proven the gain.

## What NOT to do in this plan

- **Do not touch the profile fallback.** Teardown §3.6 records a separate
  defect: degradation towards `high` silently disables three
  optimisations, because the entry warm-up, the 48 MB budget and
  `SCRUB_WHOLE_SEGMENT_PROFILE` are all gated on the exact string `'low'`.
  **Three cameras have no `low` at all** and there a cold GOP read was
  measured at **2642 ms**. It is a job of its own, and it must be done — but mixing it in here
  makes it impossible to attribute the result of the Task 3 measurement.
- **Do not merge `feat/scrub-velocity-mapping`.** It is parked and relevant
  (teardown §3.7), but it is a viewer change and this plan is recorder-side.
  Two variables together, no conclusion.
- **Do not adopt the `.rtsp` format.** Already decided and justified: no player
  opens it.
