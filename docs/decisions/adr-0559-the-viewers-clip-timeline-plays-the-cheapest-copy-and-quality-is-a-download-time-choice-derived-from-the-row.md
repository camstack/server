---
id: D559
title: The viewer's clip timeline plays the CHEAPEST copy a row has, quality is a DOWNLOAD-time choice derived from that row, and both surfaces render ONE derivation
status: proposed
date: 2026-09-20
supersedes:
applies-to:
---

## Context

The operator specified the viewer half of the clip line in two sentences:
*"bisogna mostrare nella timeline IL profilo più basso di una clip disponibile
senza sovrapposizioni. Per il download si mostra la lista degli stessi item e si
permette la selezione della qualità disponibile per quel segmento."* [the timeline must show THE lowest profile of an available clip without overlaps. For the download, the list of the same items is shown and the selection of the available quality for that segment is allowed.] The full
reading is `docs/design/2026-09-20-clips-on-the-viewer.md`; this record holds
the rules it rests on, and names the one thing it does **not** settle.

What was found by reading the viewer, today:

- **The viewer already has a clips mode and it does not read the cap.**
  `TheaterTimeline.tsx:486` switches the to-scale axis for `buildClipAxis`, and
  the clips are `deriveClipsFromClusters` — the timeline's own clusters ∩
  `recording.getAvailability`. The direct read of `videoclips.listClips`
  (`use-clips.ts`, `TimelineClipsPanel.tsx`) was **deleted**, because two
  clusterers over two datasets showed the operator a different set of cards than
  the one he had just been looking at. That module's own header names
  `positionDerivedClips` as the seam a native list must merge into.
- **The vocabulary was built for this.** `ClipSourceId` is an open string with
  `native:` reserved, `clipSourceDescriptor()` synthesises a chip for an id the
  build has never seen, and `ClipPlaybackRef` already carries a `{kind:'url'}`
  arm *"for exactly an onboard or HKSV clip"*. `clip-mapping.ts` parses rows
  **structurally**, on the stated grounds that the SDK lags the hub.
- **That structural parse is load-bearing, not stylistic.** The viewer resolves
  `@camstack/*` from `node_modules` by design. Installed `@camstack/types` is
  **1.2.228** against a workspace **1.2.233**, and its `videoclips.cap.d.ts`
  still describes a substitutable single-provider wrapper: no `streams`, no
  `listSources`, no `playable`, no `switchedOff`.
- **`ClipPanel` already ships the picker the operator is asking not to have.**
  `const PROFILES = ['low','mid','high']`, rendered unconditionally, consulting
  `clip.streams` nowhere — so it offers `high` on the 17 of 546 clips measured
  on 592 day 19 with no main twin, and explains itself afterwards with *"Served
  the sub stream — this clip has no high twin."* And `low` and `mid` are the
  **same file** (D549 15), so two of its three buttons are one choice.
- **`ClipPanel` also ships a bare `<a href={playbackUrl} download>`.** That is
  ~20 lines to copy into the viewer and it is the shape D558 § 4.2 costed and
  refused for three measured reasons: the provider scratch is a 10-file /
  200 MB per-device LRU, the camera catalog is not a promise (108 listed nothing
  after 5 September while its calendar marked every day), and `getClipPlayback`
  refuses on the sleeping standalone battery camera this feature is most useful
  on.
- **The axis was never written for overlapping clips.** `buildClipAxis` clamps a
  negative hole to a 0-length gap row that still consumes `gapPx`;
  `clipAxisOffsetToEpoch` on such a row returns an epoch inside the *newer*
  clip; and `resolveClipAdvance` advances to a clip that starts before the one
  that just ended — the operator watches the same thirty seconds twice, from two
  files, with nothing on screen saying why. `clip-timeline.ts`'s `pointAtEpoch`
  anticipated overlapping sources; the axis clips mode actually uses did not.

## Decision

**On the viewer's timeline a clip is played at the cheapest copy the ROW says it
has, and the timeline offers no quality control at all.** Cheapest is the sub
file when `streams.sub` is present and the main file when it is not — a
main-only clip is shown at 30× the bytes rather than hidden, because a clip that
is not rendered is the "no clips on a camera full of them" defect this line of
work exists to end (D554 4, D555). The timeline never asks `high` and never asks
`auto`; `auto` is refused by the cap because a stored file has no broker session,
and the viewer's live `auto` resolution must not be reached from this path. When
`served` disagrees with what was asked, the surface says so — a missing twin is
never served silently as the other (D549 15).

**Quality is a DOWNLOAD-time choice, and its options are derived from the row,
never from a fixed list.** `main` present ⇒ one option, labelled with
`streams.main.bytes`; `sub` present ⇒ ONE option, because `low` and `mid` are one
file and a second button for it is a non-choice presented as a choice; neither
⇒ no picker and the row says why (`playable:false`, `unplayableReason`). The rule
is **one pure function** taking only `{ streams?, supportSub? }` so it is
satisfiable structurally by the viewer's own parsed row, living in
`packages/types` beside the schema that defines `streams` — the only place a DOM
component and a React Native app can both import it from. `ClipPanel` adopts it
in the same slice: the admin surface is the proving ground (D549 21) and must not
be the one that disagrees.

**Both surfaces render ONE derivation.** A single viewer hook over `listClips` +
`listSources` answers the clips-mode axis and the download list. Not two
queries, not two day windows, not two empty-state resolvers — D558's rule for the
admin carousel (*"do not write a second lister"*) applied to the app, for the
same reason: the first day they diverged would be on `index-empty` (618) or
`no-storage` (640), which are precisely the states this work exists to stop
rendering as "no clips".

**The native list is ADDITIVE to the derived one.** `deriveClipsFromClusters`
stays the authority for analytics clips; native rows arrive from the cap, are
laid out by the same axis, and get their own branch in `positionDerivedClips`.
Re-plumbing the analytics half back onto `listClips` would restore the two
clusterers that deletion removed.

**No clip download ships before D558's `ExportRecord.subject` does.** Until then
the viewer shows no download control at all, rather than a link to the
provider's scratch. A control that works for ten clips per camera and refuses on
the battery cameras it exists for is worse than its absence, because its absence
is legible.

**What this record does NOT decide: `senza sovrapposizioni`.** Three overlaps are
mechanically possible and they are different features — two SOURCES over one
span (by design, no dedup, D549 11), many EVENT rows over one file on a hub child
(1–13, measured), and sub/main twins (already paired server-side, so not one).
The merge candidates and the question to put to the operator are design note
§ 4.4–4.5. It is not picked here because it needs a tie-break between our own
recording (scrubbable, dies with our retention) and the camera's file (survives
it, costs a fetch and possibly a wake), and a merge that silently prefers one
producer is the shape D549 rejected at the catalog layer arriving through the
timeline instead.

## Consequences

- The first slice is a **framework train** — `@camstack/types` publish plus a
  viewer bump — before any viewer-visible slice. The structural parse in
  `clip-mapping.ts` stays for the ROW; only the derived rule is imported.
- `resolveClipsStatus` is the right shape and is one distinction short: it
  predates `listSources` and cannot tell *"no source could answer"* from *"three
  answered and there is nothing"*. Its `empty` is the place a viewer would lie,
  and the hook must carry that distinction or the states are four where they
  need five.
- A native clip cannot be played by `onSeek`: the recorded transport seeks by
  epoch into OUR footage. The app's file player is the export one
  (`MediaViewerModal` over `react-native-video`). **Not decided here:** whether a
  native clip plays in that modal or the timeline hero grows an MP4 branch.
  Whichever, `resolveClipAdvance` must not advance across playback kinds — two
  players, one sequencer.
- The timeline's other export path exports at **`high`** on purpose
  (`EXPORT_SELECTION_PROFILE`, *"exporting what I was looking at would silently
  produce the worst copy the hub holds"*) and the clip timeline plays at the
  **lowest** on purpose. Same app, opposite defaults, both right; a builder
  copying `buildExportSelectionInput` will get it backwards unless both say why.
- `library-wiring.spec.ts` asserts the Library screen contains no
  `useCreateExport`. A clip export asks for no range so it does not re-introduce
  what that guard protects, but it trips it literally. The download flow lives on
  the camera screen, or the guard is amended with its reason restated — never
  quietly deleted.
- Three leftovers in the viewer describe a world that ended today and read as
  verification: `clip-mapping.ts`'s *"`getClipPlayback` returns an HLS master
  URL"*, `clips-status.ts`'s *"`listClips` is `auth:'admin'`"* (it is
  `protected`, which is what makes this reachable from a viewer session at all),
  and `clip-model.ts`'s *"HKSV — not yet produced by any provider"*. They are
  deleted by the slice that touches each file.
- Adding a **field** to `ExportRecord` is safe for installed apps; adding a
  **state** is not (`use-exports.ts` maps any unknown state string to `failed`).
  The clip path is where a `'fetching'` state will be wanted. D558 already
  forbids it; restated because this is the surface that will ask.

## Enforcement

- A `packages/types` spec on the derived-options rule: a row with both twins
  offers two options; a row with only `sub` offers ONE (not `low` **and**
  `mid`); a row with only `main` offers one and it is not labelled as cheap; a
  row with no `streams` offers none. Proven red by restoring `['low','mid',
  'high']`.
- An admin spec that `ClipPanel` renders exactly the options that rule returns,
  driven by a clip with no main twin. Proven red by the constant it ships today.
- A viewer spec that the clips-mode playback request carries the cheapest
  profile the row has, and never `high` or `auto` — proven red by hardcoding
  `high`; and a second that a `served` differing from the ask is rendered.
- A viewer spec that the clips-mode axis and the download list answer
  **identically** for `index-empty`, `no-storage` and `sleeping`, driven through
  the one shared hook — so the assertion is that there is one answer, not two
  that agree today. Without the shared hook there is nothing to assert against.
- A viewer spec that `parseClip` keeps a row it cannot fully understand (an
  unknown `source`, an absent `streams`) and drops only a row it cannot DRAW —
  the existing rule, extended to the new fields.
- Nothing mechanical stops a bare `<a download>` or a `window.open` on a
  `playbackUrl` in the viewer. A grep-style guard over `src/**` for
  `playbackUrl` reaching `use-media-download` is the cheap arm, and it is worth
  having: the temptation is ~20 lines and the failure is invisible until the
  eleventh clip or the first sleeping camera.
- Nothing guards the overlap rule, because there is no rule yet. Whoever lands
  one lands a spec on `buildClipAxis` with overlapping input first — today it
  emits a 0-length gap row that still consumes `gapPx`, and `resolveClipAdvance`
  re-plays footage, with no test noticing either.
