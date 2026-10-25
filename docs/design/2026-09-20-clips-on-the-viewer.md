---
title: Clips on the viewer — the timeline shows the cheapest copy, the download picks the quality
date: 2026-09-20
status: analysis — NOT implemented, and one question is open for the operator
covers:
  - camstack/src/clips/**
  - camstack/src/components/camera/theater/clips-from-clusters.ts
  - camstack/src/components/camera/theater/TheaterTimeline.tsx
  - camstack/src/recording/export-selection.ts
  - camstack/src/recording/use-export-selection.ts
  - camstack/src/data/use-exports.ts
  - camstack/src/screens/artifacts/library-items.ts
  - packages/ui-library/src/composites/clips/ClipPanel.tsx
  - packages/types/src/capabilities/videoclips.cap.ts
---

## 0. The ask, verbatim, and what it decomposes into

> *"bisogna mostrare nella timeline IL profilo più basso di una clip disponibile
> senza sovrapposizioni. Per il download si mostra la lista degli stessi item e
> si permette la selezione della qualità disponibile per quel segmento."*
>
> [The timeline must show THE lowest profile of an available clip, without
> overlaps. For download, the list of the same items is shown and the selection
> of the quality available for that segment is allowed.]

Two sentences, and read together they are **one** principle with two halves:

- **The timeline is the cheap surface.** It shows the segments and plays them at
  the cheapest copy that exists. No quality control lives there.
- **The download is where quality is chosen** — from the same item list, and per
  segment, from the qualities *that segment actually has*.

That split is not a guess: it is the only reading in which the second sentence
adds information. If the timeline already let you pick a quality, "si permette
la selezione della qualità" [the selection of quality is allowed] in the download would be a restatement. The word
`profilo` maps to exactly one thing in this system — `CamProfileSchema`
(`high | mid | low`, `packages/types/src/capabilities/schemas/streaming-shared.ts`)
— and it only *means* something at the moment bytes are fetched.

What is **not** settled by the sentence is `senza sovrapposizioni` [without overlaps]. § 4 is
entirely about that, and it ends with a question rather than a decision.

## 1. What already exists on the viewer — measured by reading, today

The brief's leads were mostly right, and one of them is out of date in a way
that changes the whole shape of the work.

### 1.1 The viewer already has a clips mode, and it does NOT read the cap

`camstack/src/components/camera/theater/TheaterTimeline.tsx:486` holds
`clipsMode`. When it is on:

- the to-scale axis is replaced by `buildClipAxis` (`src/clips/clip-axis.ts`) —
  every clip is a FIXED-height card, every hole longer than `minGapMs` is a
  collapsed ellipsis, newest at the top;
- the cards are `PositionedCluster`s produced by `positionDerivedClips`;
- the activity lanes are hidden (`hideActivity: clipsMode`), zoom is disabled,
  cluster actions are disabled.

The clips themselves come from `deriveClipsFromClusters`
(`clips-from-clusters.ts`), which is **the timeline's own clusters ∩
`recording.getAvailability`** — not from `videoclips.listClips`. The direct read
of the cap was deleted: that module says so in its own header —

> *"only this app's own direct read of it (`use-clips.ts`,
> `TimelineClipsPanel.tsx`) is gone, deleted with the panel it fed… when a
> provider finally emits NATIVE clips (a file on the camera, an HKSV asset)
> those cannot be derived from availability at all and must come back through a
> read of that cap — see `positionDerivedClips` for where such a list would
> merge in."*

That deletion was correct and must not be undone. Two clusterers over two
datasets produced two different answers for one camera, and that is the defect
`clips-from-clusters` exists to remove. **The native list is additive**: it
arrives from the cap, it is laid out by the same axis, and it needs its own
branch in `positionDerivedClips` — not a re-plumbing of the analytics half back
onto `listClips`.

### 1.2 The vocabulary is already in the viewer, and it already anticipated this

`src/clips/clip-model.ts` is not a leftover — it is the seam:

- `ClipSourceId` is an **open string**, with `CLIP_SOURCE_NATIVE_PREFIX =
  'native:'` and `CLIP_SOURCE_HKSV` already reserved;
- `clipSourceDescriptor()` synthesises a chip for an unknown id, so
  `native:reolink:onboard` renders a correct label **with no viewer release**;
- `ClipPlaybackRef` is `{kind:'recorded'} | {kind:'url'}` — the `url` arm exists
  for precisely "an onboard or HKSV clip is a file, fetched by handle, played
  from its own start";
- `isPlayable(clip)` already reports a `url` clip with an empty url as
  not-playable rather than pretending.

`src/clips/clip-mapping.ts` parses a `listClips` row **structurally** (not from
`z.infer`), deliberately, because *"`@camstack/sdk` lags the hub"*. It is the
one module that would need extending, and its reason for existing is still true
(§ 6.1).

One thing in it is now **stale and would mislead**: its header says
`getClipPlayback` *"returns an HLS master URL… A future provider that serves a
real FILE is the case that needs a URL"*. That future arrived today —
`ClipPlaybackSchema` gained `format: 'hls' | 'mp4'` and `served` (D549 22, D555).
Likewise `src/clips/clips-status.ts` still says `listClips` is `auth: 'admin'`;
it is `protected` (checked in the cap). Both are leftovers that read as
verification.

### 1.3 The download half is already built, for exports

`src/components/media/use-media-download.ts` is the one shared recipe (web
`window.open`, native `FileSystem.downloadAsync` + `Sharing.shareAsync`, and it
reports whether the file was **delivered**). `ExportDetailModal.tsx` wires it.
`library-items.ts` merges artifacts and exports into ONE gallery with one
`libraryItemActions` authority.

So a clip that is an `ExportRecord` needs **no new viewer download plumbing at
all** — which is D558's central argument, and it holds up when read from this
side.

### 1.4 What the viewer CANNOT reuse

`packages/ui-library/src/composites/clips/ClipPanel.tsx` and `ClipsBrowser.tsx`
are React-**DOM** + Tailwind + the generated `system-hooks`. `src/**` is React
Native and is explicitly forbidden from importing them
(`src/live/stream-debug-sample.ts` says so in as many words; only `embed/**`
imports `@camstack/ui-library`). The admin clips section cannot be mounted in the
app. What *can* be shared is a **pure** rule, and § 5.2 says which one and where
it must live.

## 2. Question 1 — what does "mostrare nella timeline" [show on the timeline] mean?

The brief offers two readings: the timeline **DRAWS** clip segments, or the
timeline **PLAYS** a clip when scrubbed into one.

**It is both, and on this viewer they are not two features.** Clips mode is a
list of cards you tap, with an auto-advance sequencer (`resolveClipAdvance`)
whose whole purpose is *"clips that follow one another with no dead air"*.
Drawing without playing would be a card that does nothing; playing without
drawing would be a seek into a segment the operator cannot see. The surface the
operator already has answers both at once.

Two supporting facts, so this is not preference:

- **`mostrare … la lista degli stessi item`** [show … the list of the same items] in the second sentence presupposes
  the timeline produces a list of ITEMS. Clips mode is the only viewer surface
  that does. The to-scale timeline has bands, not items.
- **`il profilo più basso`** [the lowest profile] has no meaning for a drawing. A card needs a
  thumbnail, and a native thumbnail is minted from the sub stream regardless
  (D549 5). A profile is a choice only when bytes are fetched — i.e. at play.

There **is** a third thing that could be built and that he did not ask for: a
native-clip **lane** on the to-scale timeline, beside the recording coverage
lane (`ActivityModel` already has `recording | motion | audio` and a fourth lane
is mechanically cheap). It is not proposed here. Clips mode hides the activity
lanes entirely, so a lane and the clips list would never be on screen at the
same time, and a band that says "the camera holds footage here" without a
tappable item is a claim with no action attached.

### 2.1 "Lowest available profile" — what it resolves to, from the schema

`ClipSchema.streams` is `{ sub?: {id, bytes}, main?: {id, bytes} }`, resolved at
LISTING time so a quality change never re-searches the camera (D549 15).
`getClipPlayback({profile})` maps `low | mid` → the sub file, `high` → the main
twin; `served` reports which was really delivered, and `served` is `low` for the
sub and `high` for the main (D555).

So, precisely:

| The row has | "Lowest available" is | The timeline asks | `served` comes back |
| --- | --- | --- | --- |
| `sub` (+ optional `main`) | the sub file | `low` | `low` |
| `main` only | the main file — **there is nothing cheaper** | `low` (and is served `high`), or `high` directly | `high` |
| neither / `playable: false` | nothing | it does not ask at all | — |

**A main-only clip is shown, at 30× the bytes, and the surface says so.** That
is the honest answer and it is forced: the alternative is to hide the clip,
which is the "no clips on a camera full of them" defect this whole line of work
exists to end (D554 4, D555). Measured: 529 of 546 clips on 592 day 19 had a
main twin — so the *missing-twin* direction is the rare one (17 of 546, 3.1 %);
the main-only direction is rarer still and is whatever a camera with
`supportSub: false` holds. The cost is named on the row (`streams.main.bytes`,
main ≈ 30× sub — 20.0 MB against 0.67 MB, measured) so the surface can warn
before it spends it on a phone on cellular.

**The timeline never asks `high`, and never asks `auto`.** `auto` is refused by
the cap on purpose (a stored file has no broker session, so the adaptive tier
cannot be resolved for it). The viewer's `qualityToTarget` `auto` handling is a
LIVE concept and must not be reached from this path.

## 3. Question 1, continued — how a native clip would actually reach the axis

This is the concrete cost, and it is small only because `clips-from-clusters`
left the seam open.

1. `parseClip` gains `streams`, `playable` / `unplayableReason`, `thumbnailMint`
   / `thumbnailUnavailable`, `catalogAsOf`, `nativeTypes` / `behaviours`. All
   structural, all optional, all degrading (§ 6.1).
2. A native clip becomes a `DerivedClip` with `cluster: null` — there is no
   cluster behind it. `positionDerivedClips` currently synthesises a
   `footageOnlyCard` for that case, whose `ObjectEvent.mediaUrl` is a
   **recorded** still (`stillMediaPath`). A native clip has no recorded still;
   its picture is `thumbnail` (vouched) → `thumbnailMint` (an offer, 204 with a
   reason) → a glyph with the reason. That ladder already exists — in
   ui-library's `clip-tile-media.ts`, which the app cannot import — so the RN
   side needs its own, pinned by a spec that asserts it answers the same as the
   admin one for `sleeping`, `camera-refused`, `no-keyframe`, `unsupported`.
3. Playback. `playback: {kind:'url'}` cannot go through `onSeek` — the recorded
   transport seeks by epoch into OUR footage, and a native clip is not in it.
   The app's existing file player is the export one (`MediaViewerModal`,
   `{kind:'video', url, headers}` via `react-native-video`). **A native clip
   plays there, not in the timeline hero**, unless someone decides otherwise —
   which is a real decision and is listed as such in ADR 559's "not decided".
4. The auto-advance sequencer must **not** advance from a native clip into a
   recorded one or vice versa: `resolveClipAdvance` seeks the next clip's start
   and the two playback paths are different players. Either the sequencer is
   restricted to runs of one playback kind, or auto-advance is off while a
   native clip plays. Nothing in the module handles this today.

## 4. Question 1, the hard part — "senza sovrapposizioni" [without overlaps]

**This is the part I am NOT confident about, and I would rather it went back to
the operator than be picked here.** What follows is every overlap this system
can actually produce, what each would cost, and which ones the code can already
tell apart.

### 4.1 Overlaps that exist, by mechanism

| # | Overlap | Real? | Where it comes from |
| --- | --- | --- | --- |
| A | **Two SOURCES over one span** — CamStack's own recording (analytics) and the camera's SD card both cover 14:32:10–14:32:40 | **Yes, by design** | The cap does NO dedup and no best-source pick: *"a clip held in two storages appears twice, once per source"* (D549 2/11, D554 7). On a camera that both records to the hub and keeps its own SD footage this is the NORMAL case, not an edge |
| B | **Two rows of one FILE** — a hub child's events view lists 1–13 event windows per recording file; both rows play the same bytes | **Yes, measured** — 38 events in 28 files on 3628, 1–13 per file (D555) | The events view is the catalog on a hub child, and the clip id carries the event WINDOW so the rows are distinct (D555) |
| C | **Sub and main twins as two rows** | **No** | Paired server-side at listing time into one row's `streams` (D549 15). 529/546 paired on 592 |
| D | **The clips band overlapping the recording coverage band** | Not applicable | Clips mode hides the activity lanes entirely (`hideActivity: clipsMode`) |

So C is already solved and D cannot happen. The question is **A, B, or both**.

### 4.2 What an overlap actually breaks in the code

This matters, because "without overlaps" may be a description of a symptom he
has already seen rather than a feature request.

`buildClipAxis` assumes an ordered, non-overlapping list. Feed it overlaps and:

- `holeMs = clip.startMs - older.endMs` goes **negative**; `durationMs` is
  clamped with `Math.max(0, …)` so the gap row renders as a 0-length hole that
  still consumes `gapPx` — a spacer that claims a hole exists where footage
  overlaps;
- `clipAxisEpochToOffset` returns the **first** slot containing the epoch, so
  the playhead sits on one of two cards and the other looks inert;
- `clipAxisOffsetToEpoch` on such a gap returns `slot.toMs`, which with an
  overlap is an epoch **inside** the newer clip — a tap on the spacer lands
  inside a card that is not below it;
- **`resolveClipAdvance` re-plays footage.** It advances to `clips[index+1]`,
  whose `startMs` is *earlier* than the clip that just finished. Two sources
  covering the same 30 s means the operator watches that 30 s twice, in a row,
  from two different files, with no indication why.

`clip-timeline.ts`'s `pointAtEpoch` **does** document overlaps (*"With
overlapping sources some instants genuinely belong to two clips; picking
deterministically (ribbon order) is what keeps the playhead from flickering"*) —
so the RIBBON anticipated this and the AXIS did not. The axis is what clips mode
uses.

### 4.3 The precedent that makes me lean one way

`src/data/use-timeline-activity.ts:107` — our own recording lane, verbatim:

> *"`getAvailability` returns one range set PER PROFILE, so the same wall-clock
> spans repeat. Merge overlapping/adjacent ranges into a single coverage union —
> clean recording bar + no duplicate React keys on the recording lane."*

That is **already** "one item per stretch of footage, the profile collapsed, no
overlaps", shipped, on the surface next door. If the operator has that bar in
mind, his sentence reads as one rule and not two:

> **one item per stretch of footage, drawn as the cheapest copy of it, and never
> the same stretch twice.**

I lean to that. I am not confident enough to build it, for one reason: it
requires a **tie-break between sources**, and that tie-break is a product choice
with real consequences, not an implementation detail —

- OUR recording is scrubbable, seekable, already local to the hub, and dies with
  our retention;
- the camera's own clip survives our retention, costs a fetch (and on a
  standalone battery camera, a **wake**), and is a file with fixed boundaries.

Merging them means choosing which one the operator gets when both exist, and
that choice is invisible on a merged card. A merge that silently prefers one
producer over another is the exact shape D549 rejected at the catalog layer
(*"voglio poter decidere quali clips vedere senza perdere niente"* [I want to be able to decide which clips to see without losing anything]) — arriving
through the timeline instead of through the picker.

### 4.4 The three candidate rules, costed

| Rule | What the timeline shows | Cost | Verdict |
| --- | --- | --- | --- |
| **R1 — Merge by span, cheapest copy wins** | one card per stretch; if both a native and an analytics clip cover it, ONE card | needs a source tie-break (above), and the card must still say which copy it will play, or the merge hides a producer | The reading I lean to, **blocked on the tie-break** |
| **R2 — Filter: native clips only where we have no footage of our own** | native clips fill the gaps in our coverage; where we recorded, our clip wins | no new tie-break (our footage always wins where it exists), and it is computable from data the timeline ALREADY has (`activity.recording`), which is how `deriveClipsFromClusters` already decides what is a clip | Cheapest, and it degrades honestly: a native clip is never hidden behind footage that does not exist |
| **R3 — Show everything, order deterministically, fix only the sequencer** | two cards, each labelled with its source, exactly as the admin grid does | zero product choice, matches the cap's own no-dedup rule and D549 11's *"a duplicate reads as 'the same clip, in two places', never as two clips"* | The only one that is definitely NOT what he asked for — he said *"senza sovrapposizioni"* [without overlaps] |

R3 is what the admin `ClipsBrowser` does and it is right THERE: a grid has room
for two labelled rows and no playhead to confuse. A timeline has neither.

### 4.5 The question for the operator — as short as it can be made

> Quando la stessa mezz'ora è coperta **sia** dalla registrazione CamStack **sia**
> da una clip sulla SD della camera, nella timeline vuoi:
>
> **(a)** un solo elemento, e quale dei due si apre quando lo tocchi — la nostra
> registrazione (scrubbabile, muore con la nostra retention) o la clip della
> camera (file, sopravvive alla nostra retention, costa un fetch e su una camera
> a batteria un risveglio)?
>
> **(b)** le clip native solo dove NOI non abbiamo girato, e dove abbiamo girato
> vince la nostra?
>
> E "senza sovrapposizioni" vale anche **dentro** una sola sorgente — un file
> dell'hub che contiene 13 eventi produce oggi 13 elementi che riproducono gli
> stessi byte: vuoi 13 elementi o 1?
>
> [When the same half hour is covered **both** by the CamStack recording **and**
> by a clip on the camera's SD card, on the timeline do you want:
>
> **(a)** a single element, and which of the two opens when you tap it — our
> recording (scrubbable, dies with our retention) or the camera's clip (a file,
> survives our retention, costs a fetch and, on a battery camera, a wake-up)?
>
> **(b)** the native clips only where WE did not record, and where we recorded
> ours wins?
>
> And "without overlaps" also holds **inside** a single source — one hub file
> that contains 13 events today produces 13 elements that play the same bytes:
> do you want 13 elements or 1?]

That last clause is the one I would most hate to get wrong by guessing: it is
the difference between an events list and a files list, and D549 19 chose the
events view on a hub child **because it is the only place that camera's classes
live**. Collapsing B back to one row per file throws the classes away.

## 5. Question 2 — the download list

### 5.1 It is D558's flow, and it is not implemented yet

The brief's suspicion is right. `docs/design/2026-09-20-clip-export.md` § 5.4 and
D558 already specify exactly this surface — the same `ExportDetailModal`, the
twins on the existing profile selector, the picker offering **only the twins the
row has**, asked-vs-served shown and never silently substituted, retention
inherited, and the segment chosen from *"the existing clip lister in a different
layout — never a second one"*.

**It is `status: proposed` and nothing of it exists in code.** Checked:
`packages/types/src/capabilities/recording-export.cap.ts` has no `subject` field.
So the viewer's download surface is **blocked on a server slice**, and the
temptation to unblock it locally has a name: ClipPanel already ships

```tsx
<a href={hubPath(data.playbackUrl)} download>Download this clip</a>
```

— a bare link to the provider's playback scratch. Copying that into the viewer
is ~20 lines and is the thing D558 § 4.2 costed and refused: the scratch is a
**10-file / 200 MB per-device LRU** (the eleventh clip opened evicts the first),
the camera's catalog is not a promise (108's index stopped listing on
5 September while its calendar still marked 20 days), and `getClipPlayback`
refuses on a sleeping standalone battery camera **by design** — which is the
camera this feature is most useful on.

### 5.2 "The same items" is a structural requirement, not a wording

*"si mostra la lista degli stessi item"* [the list of the same items is shown] — the download list and the timeline
must be **one derivation rendered twice**, for the same reason D558 refuses a
second lister in the admin: the first day they diverged would be on
`index-empty` (618) or `no-storage` (640), which are the exact states this whole
line of work exists to stop rendering as "no clips".

In the viewer that means one hook — call it `useCameraClips({deviceId, window})`
— answering `{ presence, clips, sources, silent }` from `listClips` +
`listSources`, consumed by the clips-mode axis and by the download list. Not the
admin's `useClipsView` (DOM), a viewer-side twin of it, with a spec that pins the
two renderings answer identically for `index-empty`, `no-storage` and `sleeping`.

`resolveClipsStatus` (`src/clips/clips-status.ts`) is the viewer's existing
version of that decision and is **already** the right shape — except that it
predates `listSources` entirely: it distinguishes `offline | loading | failed |
empty` but cannot say *"no source could answer"* versus *"three sources answered
and there is nothing"*. That gap is the same one `ClipSourceAvailability` was
added to close, and it is where a viewer `empty` would lie.

### 5.3 The quality picker, per segment

The rule, from the schema and nothing else:

```
main present  → offer "high" (label it with streams.main.bytes — ≈30× the sub)
sub  present  → offer ONE low option
neither       → no picker; the row is not downloadable and says why
both absent from the row (older hub) → no picker, ask for the provider default
```

**`low` and `mid` are the same file.** Offering both is a non-choice presented as
a choice, and the surface is then obliged to explain that picking `mid` gets you
`low` back. One option per FILE, and its label names the file, not the tier.

**`ClipPanel` cannot be reused and today it is also wrong.** It renders
`const PROFILES = ['low','mid','high']` unconditionally, consulting
`clip.streams` nowhere — so it offers `high` on the 17-of-546 clips that have no
main twin, and then explains itself after the fact with *"Served the sub stream —
this clip has no high twin."* That sentence is correct and load-bearing (D549 15
requires it, and it must stay for the residual case where the catalog row is
stale). But it should be the **rare** path, not the designed one: the row knows
before the ask. Fixing it is small, it is in the admin train, and it should land
first — because it is the surface the operator is proving the sources on
(D549 21), and because the derived rule then has one implementation to copy from.

Where the rule lives: **one pure function**, taking only
`{ streams?, supportSub? }` so it is satisfiable structurally by the viewer's own
parsed row. `packages/types`, beside the schema that defines `streams`, is the
only place both an admin DOM component and an RN app can import it from.

### 5.4 Where the list lands in the viewer, and a guard that will stop you

The obvious home is the Library screen — and there is a test that forbids it:

`src/screens/__tests__/library-wiring.spec.ts`
```ts
expect(src).not.toContain('useCreateExport')
```
> *"The component that creates an export is the camera timeline's selection flow…
> A create modal used to exist beside it and was deleted; re-growing one here
> would be the second answer to 'what range?' that the deletion removed."*

A clip export asks for **no range at all** (D558), so it does not re-introduce
the thing that guard protects — but it trips the guard literally. Two honest
options: put the clip download flow on the **camera** screen where the clips are
(consistent with the guard's own reasoning, and with D558's entry path 1 being
the common one), or amend the guard with the reason stated. Silently deleting the
assertion is the third option and is the one this repo has a rule against.

## 6. What will bite whoever builds this

### 6.1 The viewer's installed `@camstack/types` predates the whole clip line

`camstack/node_modules/@camstack/types` is **1.2.228**; the workspace is
**1.2.233**. The installed `videoclips.cap.d.ts` still describes the cap as
*"a device-scoped WRAPPER cap… exactly one active provider per device,
substitutable"* and has **no** `streams`, no `listSources`, no `playable`, no
`switchedOff`. The viewer's tsconfig resolves `@camstack/*` from `node_modules`
**by design** (its `CLAUDE.md`: *"the answer is to publish the server package,
never to re-point the alias"*).

Consequences, in order:

- `clip-mapping.ts`'s structural parse is not a stylistic choice, it is the
  reason this is buildable at all today. Keep it.
- The shared quality rule of § 5.3 requires a **publish of `@camstack/types`**
  and a bump in the viewer before the app can import it. That publish is a
  framework train, and it is the first slice.
- Anyone who develops against `tsconfig.workspace.json` will see a green
  `streams` that the app will not have at runtime until that publish lands.

### 6.2 `ExportState` — a seventh member breaks every installed app

`src/data/use-exports.ts` mirrors the record by hand and maps any unknown state
string to `'failed'`. D558 already names this; repeating it here because the clip
path is where someone will want a `'fetching'` state. Adding a **field**
(`subject`) is safe; adding a **state** renders live exports as failed on every
installed viewer.

### 6.3 `export-selection.ts` must stay out of this path

`EXPORT_SELECTION_PROFILE = 'high'`, `resolveExportSelection`'s direction
normalisation, `MIN_EXPORT_SELECTION_MS`, the partial-coverage confirm — none of
it applies. There is no drag; a native clip is a file with ordered boundaries
from the camera; and `SelectionCoverage` is computed against OUR recording index,
in which a native clip does not appear, so it would be `unknown` for every clip
— and `unknown` must not block, so the confirm would never fire. A dialogue
wired in for symmetry that is dead in every case reads as a guard somebody is
relying on. D558 says this; it is repeated because `buildExportSelectionInput` is
the only `createExport` call site in the app and is the thing a builder will copy.

Note the polarity clash while copying: the timeline selection exports at
**`high`** on purpose (*"exporting what I was looking at would silently produce
the worst copy the hub holds"*), and a clip **timeline** plays at the **lowest**
on purpose. Same app, opposite defaults, both right. Anyone reading one and
writing the other will get it backwards.

### 6.4 The auto-advance sequencer

Covered in § 3.4 and § 4.2. Two ways to get it wrong: advancing across playback
kinds (two different players), and advancing into an overlapping clip (footage
replayed). Neither is handled today and neither is caught by an existing test.

### 6.5 Leftovers that read as verification

Delete when touched, per the repo's rule:

- `clip-mapping.ts` header — *"`getClipPlayback` returns an HLS master URL"*;
  it now returns `format: 'hls' | 'mp4'` and `served`.
- `clips-status.ts` header — *"`listClips` is `auth: 'admin'`"*; it is
  `protected`, and that is what makes this whole feature reachable from a viewer
  session.
- `clip-model.ts` — `CLIP_SOURCES` ships a descriptor for `hksv` labelled *"Not
  yet produced by any provider"*; the HKSV tee **landed** today
  (external-videoclips § 12).

## 7. Slices, and the train each one needs

| # | Slice | Train |
| --- | --- | --- |
| **S0** | `clipProfileOptions()` in `packages/types` beside the schema; **fix `ClipPanel`** to derive its picker from `clip.streams` instead of a fixed three-way | framework: `npm publish @camstack/types` + `@camstack/ui-library`, then the hub's `applyServerUpdate` for the admin UI |
| **S1** | Viewer `useCameraClips` — one hook over `listClips` + `listSources`, **native sources only**; `parseClip` extended; `resolveClipsStatus` gains the `nobodyAnswered` distinction; the stale headers deleted | viewer `src/**` → **OTA** (`npm run update:patch`), plus an `@camstack/types` bump from S0 |
| **S2** | Native clips on the clips-mode axis — the third branch in `positionDerivedClips`, the RN thumbnail ladder, **and the overlap rule** | viewer `src/**` → **OTA**. **BLOCKED on § 4.5** |
| **S3** | Play a native clip — `{kind:'url'}` MP4 at the lowest available profile, `served` reported when it differs; the sequencer restricted | viewer `src/**` → **OTA** |
| **S4** | D558 server-side — `ExportRecord.subject`, the by-handle pull, the wake gate, `createdBy` | framework + addon: publish, `applyServerUpdate`, `camstack deploy packages/addon-provider-reolink` |
| **S5** | The viewer download list — the same S1 answer rendered as a list, per-row quality from S0's rule, `createExport` with a clip subject, delivered by the existing `useMediaDownload` | viewer `src/**` → **OTA**; the guard of § 5.4 decided first |

Nothing here touches `embed/**` or the viewer's own `ui-library` usage, so
**no `build:orchestrator` and no orchestrator deploy is needed for the viewer
work** — S0 needs them only because the admin UI is served by the hub.

S1 is shippable on its own and is worth shipping on its own: it is the slice that
proves the sources answer a *viewer* session (`protected`, § 6.5) on the live
cluster, which is D549 21's bar moved one surface over.

## 8. Summary of confidence

| Claim | Confidence |
| --- | --- |
| The timeline both draws and plays, and they are one surface (clips mode) | **High** — the surface already does both; the operator's *"lista degli stessi item"* [list of the same items] presupposes items |
| "Lowest available profile" = the sub when the row has one, the main when it does not, `served` reported | **High** — forced by `streams` + D549 15 + D555 |
| The download surface is D558's `ExportRecord`, not a second flow, and not a bare URL | **High** — D558 costed the URL and refused it for three measured reasons |
| The quality picker is derived from `streams`, and `low`/`mid` are never two options | **High** — they are the same file |
| "Senza sovrapposizioni" [Without overlaps] is about items on the timeline, not about layout | **High** — clips mode hides the activity lanes; there is nothing to overlap visually |
| Which overlap (cross-source, or within a source's events view), and the tie-break | **LOW — § 4.5 is the question to bring back** |
