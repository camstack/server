---
id: D564
title: The clips list follows a BAND on the recording timebar, the band has exactly one owner, and a band is asked for only if its LOCAL DAYS are affordable
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/ui-library/src/composites/clips/clip-band.ts
  - packages/ui-library/src/composites/clips/clip-view-state.ts
  - packages/ui-library/src/composites/clips/ClipBandBar.tsx
  - packages/ui-library/src/composites/clips/ClipsSection.tsx
  - packages/ui-library/src/composites/clips/clip-day-window.ts
---

## Context

The clips section ([D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md),
[D557](adr-0557-a-clip-source-picker-filters-the-view-because-the-persisted-authority-is-keyed-by-addon-not-by-source.md))
shipped with a `‹ day ›` pair of its own and asked `listClips` for one whole
local calendar day. It sits at the END of the Recording tab, immediately under
a section that already owns a navigable timebar with a day picker, a zoom, a
pan and an event-density heatmap. The operator saw the two controls together
and said what they should be:

> *"Possiamo utilizzare lo stesso componente della sezione recording con la
> timebar dove selezionare un periodo e mostrare le clip solo di quella banda
> selezionata, espandibile."*
>
> [We can use the same component as the recording section with the timebar where you select a period and show the clips only of that selected band, expandable.]

Two facts shaped the answer and neither is obvious from the screen.

**The two sections are not related in the React tree.** `host/recording-panel`
and `host/clips-browser` are both `location:'top-tab'`, `tab:'recording'`
widget sections; the framework mounts each through its own `WidgetSlot` from
the device aggregate ([D14](adr-0014.md)). Nothing either package owns is an
ancestor of both. So "share the instance" would have meant a context installed
by the generic section renderer, present on some surfaces and absent on
others — and an absent context reads as "no selection", which is the
not-known-looks-like-not-there defect
([D315](adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry.md))
wearing a different hat.

**A period is not a day, and the cost is not proportional to its width.** A
Reolink search is clamped to one camera-local day per call — measured
2026-09-20 on hub child 3628: a two-day ask answered 39 windows all dated the
START day, silently, and `nodelink-js` now clamps and trace-logs it — so the
provider LOOPS local days. A day listing is 4.3–6.0 s on 592 (209 clips in
6.0 s; 546 in 4.3 s) and sub-second on a hub child, and 400 rows already mint
349 thumbnails through a lane that is one in flight per host. A band's width in
ms says nothing about what it costs; the number of LOCAL DAYS it touches says
everything.

## Decision

**The clips list follows a band selected on the recording section's own
timebar components, the band has exactly one owner, and it is asked for only
when its local-day count is inside the bound.**

1. **The same components, a separate instance.** `ClipBandBar` composes
   `TimelineControls` and `EventHeatmap` — the pieces `RecordingTimeline` is
   itself built from — over the same `recording-timeline-model`
   (`dayWindow`, `panWindow`, `zoomWindowAnchoredRight`, `bucketMsForSpan`,
   `axisTicks`). One implementation and one model; two surfaces, because there
   is no ancestor to hang a shared one on. They cannot disagree about anything
   an operator can act on, because they answer different questions: the
   recording timeline's selection is WHAT PLAYS, the clips band is WHAT IS
   LISTED.
2. **`CoverageTrack` stays behind.** In the recording section a click on it
   moves the hero player's playhead, over the `camstack-control` channel or an
   HLS VOD request. A copy in the clips section would be a dead bar or a
   SECOND claimant on that position.
3. **The band lives in `ClipsSection`, once.** `ClipBandBar` holds no state:
   the day, the visible window and the picked bucket are all in the section
   that turns them into the `listClips` argument. A bar keeping its own copy
   would be the second authority one component down.
4. **The band IS the visible window, narrowed by a picked bucket.**
   `bandForSelection(view, bucket)` — nothing picked means the whole visible
   window, which is safe only because the timebar bounds it; it is never
   "everything the camera holds" ([D382](adr-0382-a-consumer-is-served-the-history-it-asked-for-and-an-unstated-ask-is-zero.md)).
5. **"Espandibile" is the timebar's own zoom-out, pan and day picker, plus one
   named button that releases a picked bucket back to the visible window.** No
   gesture was invented. The consequence is worth stating plainly: the timebar
   CANNOT express more than one calendar day — `ZOOM_LEVELS` tops out at 24 h
   and `zoomWindowAnchoredRight` falls back to the day's bounds — so the
   widest band reachable today is exactly the day the section used to ask for,
   and every other band is cheaper.
6. **A band is asked for only if `planClipBand` says it is affordable**, and
   the unit is LOCAL DAYS, walked through `Date`'s own day arithmetic so a DST
   week is seven. `MAX_BAND_LOCAL_DAYS` is 2 — every band the control can
   produce, including one sitting across local midnight. Past it the query is
   NOT FIRED and the surface renders a refusal naming the band, its local-day
   count and the bound. Asking and rendering whichever days answered is
   forbidden: that is a partial range shown as the whole of it, the same
   defect class as an empty list reading as "no clips".

## Consequences

- **`clip-view-state.ts` grows a fifth state, `refused`, decided FIRST** —
  before any query status. A refused band fired nothing, so its clips query
  stays `pending` for ever (a skeleton on a request nobody sent), and any rows
  still in React Query's hand belong to the NARROWER band the operator had a
  moment ago. The other four (`loading`, `empty`-with-a-cause, `listed`-with-
  its-silent-sources, `failed`) are unchanged, and `empty` now carries the
  BAND where it carried a day id.
- **Every cost moves down, not up.** The default band is "local midnight →
  now" instead of a whole calendar day — the old window's right edge was the
  NEXT local midnight, an instant in the future — and any zoom or bucket pick
  makes it smaller. Fewer clips, fewer mints.
- **One extra query per section**: `pipelineAnalytics.getEventDensity` over
  the visible window, the same one the recording timeline already asks for the
  same device. It is read over the WINDOW and not the band, because its job is
  to show where to select next.
- **`clip-day-window.ts` survives, minus its window builder.** `toDayId`,
  `shiftDay` and `formatDayLabel` are exactly the local-day arithmetic the
  band's cost count and label need. `dayWindow(dayId)` and `ClipDayWindow`
  were deleted with the day picker they served — two functions named
  `dayWindow` in one directory was a confusion worth removing, and
  `recording-timeline-model.ts`'s `dayWindow(date, nowMs)` is the one that
  builds windows now.
- **The bound is a guard for a widening that has not happened.** If
  `ZOOM_LEVELS` ever grows a multi-day level, the refusal is already there and
  the number to revisit is `MAX_BAND_LOCAL_DAYS` — with the measured per-day
  cost above as the input.
- `clip-source-state.ts`, `clip-tile-media.ts`, `clip-thumbnail-fetch.ts` and
  `ClipTile.tsx` are untouched: the vouched → mint → glyph-with-reason ladder,
  the `playable:false` rows and the per-source verbatim reasons are decisions
  about a CLIP, and none of them was ever about a day.

## Enforcement

`packages/ui-library/src/composites/clips/__tests__/clip-band.spec.ts` (the
local-day walk, the refusal, the bucket clamp),
`clip-view-state.spec.ts` § "a band too wide to ask is refused BEFORE
loading", `clips-section-band.test.tsx` (the band on the wire from a real
first paint — both queries pending — and every control that moves it) and
`clips-section-band-refusal.test.tsx` (the section disables the query and
renders words). The last one stubs `planClipBand`, and says so: the bound is
deliberately above everything the control can reach, so a test that tried to
reach it by clicking would be asserting the control.

Nothing scripted stops a future `ClipBandBar` from growing its own `useState`
for the day or the selection — review only, which is why rule 3 is written
down.
