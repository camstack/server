---
id: D562
title: The clip-catalog refresh is a PER-TOPOLOGY rule — free through a hub, cheap on mains, and on a standalone battery camera a timer may only MARK the catalog stale, because the real refresh is `onWakeTransition`
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-refresh.ts
  - packages/addon-provider-reolink/src/clips/clip-refresh-settings.ts
  - packages/addon-provider-reolink/src/clips/clip-thumb-queue.ts
  - packages/addon-provider-reolink/src/clips/clip-service.ts
---

## Context

[D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
decision 12 designed a refresh timer and
[D561](adr-0561-listsources-measures-the-state-it-reports-and-an-empty-list-from-a-source-that-cannot-answer-is-a-named-refusal.md)
found the half of it that shipped: `ClipCatalogCache.markStale` with **no
production caller at all**, its doc comment describing a timer nobody had
written. It was left undeclared for a real reason —
`scripts/check-settings-key-has-reader.ts` fails a settings key nothing reads,
and this repo has shipped nine such knobs — so the setting waited for its
reader. This change declares both with their readers.

**A clip catalog goes stale because the camera keeps recording, and re-reading
it costs three different things on three Reolink shapes.** The fleet,
enumerated live on 2026-09-20 rather than assumed (`deviceManager.listAll`,
26 Reolink devices):

| shape | devices | cost of a re-read |
| --- | --- | --- |
| mains standalone | 592, 618 | its own socket; 0.3–6 s for a day |
| hub child (battery, served by the parent) | 3628, 3629, 3825 | **65 ms through the parent's open session, and the child never hears it** |
| standalone battery | 640, 4263 | a login, and **the login IS the wake** |
| the Home Hub itself | 639 | `type: hub` — never a `videoclips` device |
| accessories (siren / floodlight / PIR) | 14 of them | not cameras; never bind the cap |

**639 is mains and still gets no catalog of its own.** `videoclips` declares
`deviceTypes: [Camera]`, and the hub's own uid was measured to address no
catalog at all — an empty month over 24 months, zero files, zero rows. A hub's
catalog IS its children's; refreshing it means refreshing each child, on the
one socket, which is also why those refreshes must not stack.

**And a standalone battery camera cannot be refreshed by a clock at all.** A
timer that reads it is a timer that wakes it. 640 is the live proof that this
matters now rather than in principle: it got an SD card on 2026-09-20, its
cache is empty, and it is the first camera on this fleet where a refresh can
produce anything real.

The number that decides the forced-wake default: a 15-minute forced timer is
**96 wakes/day** (24 at 60 minutes) against a natural rate of **1–20 clips/day**
on this fleet — a clip being a battery camera's wake — so 5× to 100× its normal
wake count, paid in battery.

## Decision

**The refresh mode is derived from the camera's TOPOLOGY, in one pure
function, and never from a belief about whether it is asleep right now:**
`via-hub` for any hub child (regardless of its battery — the read goes to the
mains parent), `direct` for a mains standalone, and `mark-stale` for a
standalone battery camera, which ages its catalog and reads nothing. The gate
is `isBattery`, not `sleeping`: that belief is `?? false` and reads "awake" for
a slice that has not restored, which is how a picker draw once logged into 640
(D561).

**The real refresh of a standalone battery camera hangs off
`onWakeTransition`** in `reolink-camera.ts` — the existing hook, called with
four reasons from seven sites, three of them natural signals nobody prompted:
`simple-event` (an inbound camera push), `sleep-poll` (the poll's
sleeping→awake flip), `hub-summary` (the parent's per-child summary), and
`confirmed-wake` (a wake a stream or an operator already paid for). It runs
LAST in that fan-out, after the stream catalog and the settings slices, and
`commitSleepState(false, …)` has already flipped the slice by then so the clip
path's own sleep gate lets the read through. **There is no second wake hook**,
deliberately: a feature that invents its own is a feature whose wake nobody can
attribute.

**`clipCatalogRefreshMinutes` is a global default with a per-device override,
cascaded so reset == unset == the default** (`stationary-settings.ts`'s rule),
never throwing on a bad blob, with `0` a real value meaning off. **Its
description states BOTH behaviours** — a free read on a hub child and on mains,
stale-marking only on a standalone battery camera — because one setting
silently meaning two things is how this repo has shipped knobs nobody could
reason about.

**`clipCatalogForcedWake` is per device, OFF by default, with the 96-wakes-a-day
number in its own description**, and it is a plain persisted switch: not a
`device-action-button`, no custom action behind it, so nothing that dispatches
device actions on a schedule can spend a battery camera's wakes. **One
authorised interval buys exactly one wake**: the interval is stamped BEFORE the
attempt, so a failure costs the camera the same as a success and a retry loop
cannot turn "every 15 minutes" into an unbounded wake count. The switch is not
even rendered where it would be inert.

**The refresh is the lowest-priority thing on a host.** It asks
`ClipThumbQueue.busy(host)` first — a mint in flight (either lane) or an open
400 backoff — and DEFERS, which is not a spent interval: it retries on the next
tick. One camera at a time, sequentially, because a hub's children share one
socket and the library's CoverPreview lane is one-in-flight per host.

**A failed refresh never looks like a success.** The cache stamps `catalogAsOf`
only on a listing that landed, so it keeps the last CONFIRMED time; the
scheduler marks the rows stale so the next READ retries, and names the branch
(`refresh-failed`, `forced-wake-failed`, `deferred-interactive`, `mark-stale`)
with `tags: { deviceId }`.

## Consequences

- The tick interval is the FLOOR (`CLIP_CATALOG_REFRESH_MINUTES_MIN`, 5 min);
  each camera's own interval is decided inside the tick, so changing a setting
  takes effect without re-arming a timer.
- One refresh confirms ONE DAY (`CLIP_CATALOG_REFRESH_WINDOW_MS`). A 20-day
  window measured 3.6–5.4 s per child; older days are immutable and held under
  the cache's own 24 h TTL, so re-confirming them would spend the whole budget
  on days that cannot change.
- The refresh goes through the provider's own `listClips`, so the topology
  picks the API exactly as an operator's read would and there is no second path
  to drift from it. That also means a source that cannot answer REJECTS (D561),
  which the scheduler reports as `refresh-failed` — on 618 that is a warn every
  interval, which is the honest rate for a camera whose index is broken.
- The global half of the cascade is mirrored in the addon and re-read at init
  and on every `onConfigChanged`, because `listTargets` is synchronous: a
  settings round-trip per camera per tick is not a thing a timer may cost. An
  empty mirror resolves to the DEFAULT, never to "off".
- `ClipThumbQueue.busy` deliberately has no "an interactive request is queued"
  clause: a queued request implies a running one, and a clause that can never
  be the reason for the answer is a leftover that reads as verification.
- **The refresh now drags the still prefetch behind it**
  ([D577](./adr-0577-the-still-prefetch-is-wired-to-the-catalog-refresh-budgets-mints-rather-than-rows-and-backs-away-from-a-host-that-is-not-serving.md)),
  which is the only place that knows the topology, that the catalog really
  landed, and whether an operator holds the lane. Two things this timer's
  contract now also covers: a `mark-stale` or failed refresh never reaches the
  prefetch (and `ClipPrefetchMode` says so in the type), and a `forced-wake`
  buys one wake for the CATALOG only. `hostBusy` is asked TWICE per camera per
  tick — once before the refresh and once before the prefetch — because a
  refresh is not instantaneous and the operator who took the lane during it
  must not queue behind a prefetch.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/clip-refresh.spec.ts` (the mode
per topology including a MAINS hub child — a shape this fleet does not have
today and whose branch ordering would silently send it down `direct`; the
cascade; the scheduler driven from COLD), `clip-refresh-settings.spec.ts` (both
descriptions carry their two meanings and their number; the switch is off by
default, hidden where inert, and is not a dispatchable action) and the
`busy()` section of `clip-thumb-queue.spec.ts`. Every one was proved red by
reverting the specific branch it pins. `scripts/check-settings-key-has-reader.ts`
is what stops either key from being declared again without a reader.
