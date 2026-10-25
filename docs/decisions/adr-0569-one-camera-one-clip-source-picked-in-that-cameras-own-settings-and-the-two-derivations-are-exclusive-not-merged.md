---
id: D569
title: One camera, ONE clip source — picked in that camera's own settings, stored where the viewer stores what it is LOOKING at, and the two derivations are exclusive rather than merged
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - camstack/src/clips/clip-sources.ts
  - camstack/src/clips/clip-quality.ts
  - camstack/src/clips/clip-tap.ts
  - camstack/src/clips/clip-mapping.ts
  - camstack/src/clips/clips-status.ts
  - camstack/src/clips/use-clip-playback.ts
  - camstack/src/data/use-camera-clips.ts
  - camstack/src/components/camera/ClipSourceRow.tsx
  - camstack/src/components/camera/clips/NativeClipModal.tsx
  - camstack/src/components/camera/theater/clips-from-clusters.ts
  - camstack/src/store/camera-prefs-store.ts
  - camstack/src/grid/view-options-scope.ts
---

## Context

[D559](adr-0559-the-viewers-clip-timeline-plays-the-cheapest-copy-and-quality-is-a-download-time-choice-derived-from-the-row.md)
specified the viewer half of the clip line and left ONE thing undecided, on
purpose: *senza sovrapposizioni*. Three overlaps are mechanically possible —
two SOURCES over one span, many EVENT rows over one file on a hub child, and
sub/main twins — and picking between them needs a tie-break between our own
recording and the camera's file, which is a product choice, not an
implementation detail. The record says so and hands the question back.

**The operator answered it, and his answer dissolves the question rather than
picking one of the three candidates:**

> *"La sorgente deve essere selezionata lato viewer dall'utente nelle settings
> generali della camera come provider di quella camera. Mai mischiate provider
> diversi."*
>
> [The source must be selected on the viewer side by the user in the camera's general settings as the provider of that camera. Never mix different providers.]

and, on the relationship to our own recordings:

> *"non importa la sorgente di clips, sarà uno sul viewer. Non devono avere
> alcuna connessione."*
>
> [it does not matter which clips source, there will be only one on the viewer. They must not have any connection.]

One source at a time, per camera, chosen by the person looking. Two sources are
never drawn together, so there is no overlap to resolve and no tie-break to
make. What that does settle, and what D559 did NOT anticipate, is that **the
native list is not ADDITIVE** — D559's own phrasing (*"native rows arrive from
the cap … and get their own branch in `positionDerivedClips`"*, beside the
derived ones) describes a merge the operator has now ruled out.

Three things were found by reading the viewer, and each one changed the shape of
the work:

1. **A guard forbade the cap read outright.**
   `camstack/src/components/camera/clips/__tests__/clip-surface-wiring.spec.ts`
   asserted `expect(src).not.toContain('useCameraClips')` and
   `not.toContain('listClips')` on `TheaterTimeline.tsx`. It was written for the
   right defect — two clusterers over two datasets showed one camera two card
   sets, and the operator saw it — but it forbids the mechanism rather than the
   failure. A camera whose clips live on its SD card cannot be served by a
   derivation over footage we never recorded, so keeping the guard as written
   means showing no clips on a camera full of them, which is the defect the
   whole clip line exists to end (D554 4, D555).
2. **The per-camera store already held a clip-source field, and nothing read
   it.** `CameraPref.clipSources` is a DENY LIST — a multi-source VIEW filter —
   with `normalizeClipSources`, `setCameraClipSourcesEntry`,
   `toggleCameraClipSourceEntry`, a store action, a parse branch and a 15-case
   spec. It was built for `ClipSourceChips`, which was deleted; grepping the
   app finds no consumer. It also describes a contract the hub retired:
   `listClips` took `sources?: string[]` and now takes one `provider`
   ([D557](adr-0557-a-clip-source-picker-filters-the-view-because-the-persisted-authority-is-keyed-by-addon-not-by-source.md) § 4).
3. **An absent `provider` is not an expression of a choice.** The cap documents
   it as *"the device's BOUND provider, which is CamStack on every camera
   today"*. Measured on the live hub, 2026-09-20, with 592's `getBindings`
   holding BOTH `recorder` and `provider-reolink` for `videoclips`:
   `listClips({deviceId:107})` with no provider answered with the **Reolink**
   rows. The documented default is already not what the fleet does.

And the surface the viewer has is the right one: clips mode is a list of
fixed-height cards on a compressed axis (`buildClipAxis`), with a tap and an
auto-advance sequencer. Building a second clips surface for native clips would
be two places to look at one camera's clips — the failure D62 describes, and
worse than the merge, because a merge at least has one screen.

## Decision

**A camera has ONE clip source at a time, the operator picks it in that
camera's own settings menu, and the two derivations are EXCLUSIVE.**

1. **The pick is a SOURCE id, the call carries an ADDON id.**
   `listSources` answers one row per source and each row names the addon that
   serves it (`ClipSource.addonId`, D555). The stored pick is the source — the
   finer grain, and the thing the operator's label says — and the request
   carries the addon the row itself named. No `native:reolink:* →
   provider-reolink` table anywhere in the app: that is a second authority on
   provider identity, and it is wrong the day a third source appears (D557's
   rejected option 1).

2. **`provider` is ALWAYS sent.** Absence is not a choice; on this fleet it is
   not even CamStack. A pick the camera no longer offers is REPORTED
   (`chosenMissing`) and never sent — the cap refuses an unbound provider by
   name, so a stale preference would otherwise be a permanently red timeline.

3. **The default is CamStack and the default is stored as ABSENCE.** Absence
   must reproduce exactly what the app drew before this setting existed. A
   camera with no CamStack row falls to its first source instead of to nothing.

4. **Exactly one derivation fills the body.** CamStack ⇒
   `deriveClipsFromClusters`, and `listClips` is not called at all. Any other
   source ⇒ `listClips` for that one provider, and the derived list is not
   built. Never a concatenation, never a merge, never a dedup. **This is what
   makes reading the cap again safe**: the two clusterers can only disagree
   where they are both on screen, and one camera has one source.

5. **The setting is stored CLIENT-side, in the per-camera prefs document**
   (`camera-prefs-store`, AsyncStorage `@camstack/v2/camera-prefs`, keyed by
   numeric device id) — the same document as `quality`, `audioOn` and
   `timelineClasses`, because it is the same kind of fact: **what the person
   holding the phone is LOOKING at.** It writes no hub state. Sources are not
   enabled or disabled here — each exists because of a configuration that lives
   somewhere else (HKSV because the camera is exported to HomeKit, the Reolink
   source because Reolink is that camera's provider, CamStack's because it is
   always there) — and a knob over somebody else's decision is D62's failure
   reached from the direction D62 does not describe, which is precisely what
   D557 § 3 rejected on the admin side. `setWrapperActive` is NOT this control.

6. **`clipSources`, the multi-source deny list, is DELETED** — the field, the
   three functions, the store action, the parse branch and its spec. A leftover
   that describes the right design for a retired contract reads as
   verification, and this one described a contract that is retired twice over
   (the surface is gone, and `listClips` no longer fans out).

7. **A native clip's card is its own card.** Its picture is the provider's MINT
   path and nothing else — `footageOnlyCard`'s `stillMediaPath` is the
   recorder's own frame route, and on a clip held on an SD card it resolves
   into footage we do not have, so the card would draw a picture of the right
   moment from the wrong source. Its chip is `labels` (the hub's resolved
   vocabulary, what every other card on this timeline is chipped with), never
   `nativeTypes` (`md`, `dog_cat` — the camera's word, with no translation in
   this app). The two are different claims.

8. **A native clip plays in the app's FILE player, and auto-advance is off
   while it does.** The recorded transport seeks by epoch into footage the hub
   holds; a file on an SD card is not in it, and seeking its timestamp plays
   whatever our recorder happened to hold at that instant. It opens
   `MediaViewerModal` — the app's one file player, the same one an export opens
   in. `resolveClipAdvance` advances by SEEKING, so it does not run in this
   mode: two players, one sequencer, and an advance across them would throw the
   hero onto an unrelated moment behind an open player.

9. **The timeline asks for the CHEAPEST copy the row resolved, and never
   `auto`.** D559's rule, implemented as `cheapestClipProfile` — sub ⇒ `low`,
   main-only ⇒ `high`, no twins ⇒ ask for nothing and take the provider's
   default. A `served` that disagrees with the ask is shown. D559 puts this
   rule in `packages/types` so the admin DOM component and the app share one
   implementation; **it lives in the viewer for now** because the viewer
   resolves `@camstack/*` from the PUBLISHED packages and this session shipped
   no publish. That is a duplication with `ClipPanel`'s fixed
   `['low','mid','high']`, and it is named here so it is paid rather than
   forgotten.

10. **`resolveClipsStatus` gains two states.** `silent` — a source answered and
    could not read its list (`sleeping`, `unreachable`, `no-storage`,
    `index-empty`, and `unknown`, which is not folded into `ok`, D561 defect 1)
    — and `source-missing`. Only an `ok` source licenses `empty`. `empty` is
    the sentence "no clips for this camera", and 108 with 177 GB free, 106 with
    no card and a sleeping battery camera were all rendering it.

## Consequences

- **The guard is amended, not deleted, and the reason is restated in it.** What
  stays forbidden is the MERGE and the old server-side re-clustering
  (`clipsToClusters`); `camera-clips-wiring.spec.ts` now holds the exclusivity
  directly.
- **A per-camera view setting can now be a grid-cell row.**
  `view-options-scope` gained `clipSource` under the `timeline` group, owned by
  the CELL — the mirror image of `clusterLabel`, which is the bar's because one
  band serves every tile. That removes the `timeline` group's status as the one
  group invisible in a grid cell, and its spec was tightened rather than
  relaxed.
- **Nothing shipped needs a published `@camstack/types`.** Every new field is
  read structurally, for `clip-mapping.ts`'s stated reason (installed types lag
  the hub; the installed `videoclips.cap.d.ts` still describes a substitutable
  single-provider wrapper). A bump buys nothing here, and would not have been
  enough for the shared quality rule anyway — that needs a publish.
- **The still ladder is NOT in this slice and its absence is measured.** A
  native card renders the mint URL directly. The route answers 204 with
  `x-camstack-disposition: deferred|final` (D563), and a `deferred` still —
  43 of 60 tiles on a real first paint — renders the glyph until the next
  refetch instead of appearing seconds later. ui-library has the ladder
  (`clip-tile-media.ts`, `clip-still-retry.ts`) and `src/**` cannot import it.
  This is the next slice and it is the one an operator will notice first.
- **No download control ships, per D559** — D558's `ExportRecord.subject` does
  not exist. Nothing in the viewer offers a clip download, and no `<a download>`
  or `window.open` on a `playbackUrl` exists to copy.
- **Overlaps WITHIN one source are untouched.** A hub child's events view can
  still list 1–13 rows over one file (measured, D555). That is one source's own
  answer and the operator asked for it; `buildClipAxis` is still not written for
  overlapping input and D559's Enforcement note about it stands unaddressed.

## Enforcement

- `camstack/src/data/__tests__/camera-clips-wiring.spec.ts` — the read is one
  hook, `provider` is always named, the addon comes off the row, the cap is not
  touched while CamStack is the source, the read fails loudly
  (`rethrow: true`) under the BULK deadline, no `getClipPlayback` while
  listing, and the theater branches on `clips.choice.derivation` rather than
  concatenating. Proven red by removing the branch and by dropping `rethrow`.
- `camstack/src/clips/__tests__/clip-sources.spec.ts` — the default is CamStack
  even when the hub lists it second (proven red by `sources[0]`), `unknown` is
  not `ok` (proven red by defaulting to `ok`), a missing pick is reported rather
  than sent (proven red by `missing = false`), and the picker offers every
  source the camera has (proven red by filtering to `ok`).
- `camstack/src/clips/__tests__/live-wire.spec.ts` — **the captured wire**, not
  a fixture written to the reading the author already had: 357 real rows of
  592's onboard catalog, 2 of 3628's, both source lists. Every row parses, every
  one is playable (not one carries `playable`), every one asks `low`, every one
  becomes exactly one card whose picture matches `clip-thumb` and never
  `still`. Proven red by preferring the main twin and by reading an absent
  `playable` as a refusal — which emptied the surface on a camera holding 357
  clips.
- `camstack/src/components/camera/__tests__/clip-source-setting.spec.ts` — the
  row is in the ONE scope registry, under `timeline`, owned by the cell; the
  picker never writes `setWrapperActive` or any mutation; it offers what the hub
  listed and draws nothing below two options. Proven red by removing the
  two-option gate.
- `camstack/src/clips/__tests__/clip-tap.spec.ts`,
  `clip-quality.spec.ts`, `clips-status.spec.ts`,
  `camstack/src/components/camera/theater/__tests__/native-clip-cards.spec.ts`,
  `camstack/src/store/__tests__/camera-prefs-clip-provider.spec.ts` — one per
  rule above, each proven red by restoring the behaviour it replaced.
- **Nothing guards the still ladder's absence**, because there is no rule yet.
  Whoever lands it lands a spec on the 204 disposition first: today a
  `deferred` and a `final` refusal are the same blank tile, which is D563's
  original defect reappearing one surface over.
