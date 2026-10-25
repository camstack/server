---
id: D561
title: `listSources` MEASURES the state it reports — `ok` is never a default — and an empty list from a source that cannot answer is a named refusal, not `[]`
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/reolink-videoclips-provider.ts
  - packages/addon-provider-reolink/src/clips/clip-catalog-cache.ts
---

## Context

[D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
and [D555](adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md)
built a five-value vocabulary for what a clip source is saying, from two
cameras measured on the hardware: 106 had no SD card (`HddInfo mount 0`,
2026-09-20 morning — the operator fitted one later the same day, so the state
keeps its rule and the fleet keeps no live example), and 618's own calendar
marks 3–20 September while its own index lists zero files for 6–20 with
177 GB free. `packages/ui-library` renders all five distinctly
and the provider computes all five. The specs passed.

**On the live cluster, minutes after the deploy that made every runner cold,
both cameras answered `ok` and then an empty list.** The measurement:

    listSources 640 → native:reolink:onboard, via files, state ok
    listSources 618 → native:reolink:onboard, via files, state ok
    listClips  640 → []
    listClips  618 → []

Nothing was lost in transport. The states were being computed as a SIDE EFFECT
of `listClips` — written into an in-process `health` map by `readOnboard` — and
`listSources`, the one method whose entire job is to answer this question,
never established anything: it answered `ok` after at most one storage command,
and `ok` on a cold process for every camera in the fleet. Confirmed on the same
hub later the same day: once a `listClips` had run, 618 reports `index-empty`
with its days and 640 reports `sleeping`, from the same build, over the same
wire. The lie was cold, and cold is exactly what a deploy, a crash respawn and
a restart produce — and exactly when a surface draws the picker.

Three separate defects fed it, each one an instance of a rule this repo already
has:

1. **`ok` was a DEFAULT.** The cheap storage question was the only probe, and
   everything that was not `absent` fell through to "this source's list may be
   read as complete".
2. **A FAILED measurement was folded into a positive claim** (D393).
   `readStorageState` answers `{ state: 'unknown' }` when the read throws or
   the reply carries no `mount`, and `unknown` took the same branch as
   `present`. The first Baichuan command after a login racing the socket is
   MEASURED on this fleet (592, 2026-09-20, `getHddInfoList` → "Baichuan socket
   closed"), so this is how a camera with no card reports `ok`.
3. **A wake gate branched on a BELIEF instead of on what the camera IS.**
   `ReolinkCamera.sleeping` is `state.battery.sleeping ?? false`, so a slice
   that has not restored reads as awake; `listSources` then called `getApi()`
   on a standalone battery camera, and on UDP the login IS the wake. A picker
   draw must never be able to wake 640.

And `listClips` answered `[]` for both. `[]` has nowhere to carry a reason, and
the caller cannot tell it from a quiet night — which is the single sentence the
whole external-clip line exists to stop a surface from having to guess.

## Decision

**`listSources` measures the state it reports, and `ok` is returned only
because something was really read.** A source with nothing established is
probed, in this order, and each step's cost is chosen rather than inherited:

- **a standalone battery camera is asked NOTHING, ever** — no `getApi`, not
  even the cheap command. It answers `sleeping` with the age of whatever the
  catalog cache holds. The gate is `isBattery`, never the belief `sleeping`.
- **a hub child**: one `getDayRecords` through the parent's existing socket,
  addressed with the CHILD's uid (65 ms measured on 3628). The child never
  hears it and the storage question is the hub's, so it is not asked.
- **a mains standalone**: `getHddInfoList` (ms) → `getDayRecords` for the
  CURRENT month (38 ms–1.9 s) → ONE listing of the NEWEST day the calendar
  claims (0.3–6 s), cache-backed, so a day already listed costs nothing and a
  day listed here is free for the `listClips` behind it. That last step is what
  separates `index-empty` from `ok`, and nothing cheaper can; `no-storage` is
  the cheap question and it comes FIRST so a camera with no card never pays it.

`index-empty` is every day the CALENDAR claims that the INDEX has been asked
about and answered nothing for — read out of the catalog cache, so it is one
day cold and the whole window after a listing, without a second memory.

**A measurement that failed is `unreachable` with the camera's own words, never
`ok`** (D393, restated for this surface).

**And an empty clip list is an answer only when the source could ANSWER.** When
`listClips` produced no rows and the source's state is not `ok`, it refuses by
name — the state and the reason verbatim — instead of returning `[]`. An
ordinary empty day (the camera's own calendar names no day in the window) is
still `[]`, because over-refusing is the same defect with its polarity
reversed.

## Consequences

- A cold `listSources` on a mains standalone now costs up to three Baichuan
  commands, one of which is a day listing. It is paid once per process per
  camera (the answer is remembered exactly as before) and it warms the cache
  the following `listClips` would have paid for anyway.
- A listing that already ran still wins: `listClips` asked the whole window and
  the probe asks one day, so an established state is never re-decided from the
  narrower question.
- `listClips` can now REJECT. The collection dispatcher already handles that —
  a failing source loses only its own rows and says so per source with
  `tags: { deviceId }` (D554 rule 2) — and a caller that pinned this provider
  gets the reason instead of an empty array. Six specs that pinned `[]` as the
  answer were changed to pin the refusal.
- The honest state is still process-local. A restart re-probes every camera it
  MAY probe; 640, which it may not, reports `sleeping` with no `catalogAsOf`
  until something lists it. That is the truthful answer for a camera nobody is
  allowed to ask, and it is never `ok`.
- `no-storage` is verified in the suite and NOT on hardware, because the
  fleet's only card-less camera got a card hours after it was measured. The
  spec names the SHAPE (`CARDLESS_CAMERA`), never 106 — a fake that carries a
  real device id is a claim about a machine nobody re-measures, and this file
  had already done it once with an "640" configured `isBattery: false`.
- The five states are unchanged. There is deliberately no sixth: `ui-library`
  maps the enum exhaustively, and "nothing has been read yet" is not a state to
  report — it is a probe that has not been run.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/reolink-videoclips-provider.spec.ts`
§ "listSources answers COLD, before anything has been listed" and § "listClips
refuses by name rather than answering an empty list". The gap the previous
suite had is named in that file: every spec that pinned an honest state called
`listClips` first, so all of them pinned a warm `health` map and none asked
`listSources` the way a surface does — first, cold. The new specs assert with
no prior listing, assert zero logins on a battery camera whose belief says
awake, and assert that a storage read that THREW is not `ok`.
