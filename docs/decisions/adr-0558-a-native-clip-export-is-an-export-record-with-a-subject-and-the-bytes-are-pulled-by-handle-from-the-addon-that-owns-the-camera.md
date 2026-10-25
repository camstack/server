---
id: D558
title: A native clip export is an ExportRecord with a SUBJECT — the recorder owns the file, and the bytes are pulled once by handle from the addon that owns the camera
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/types/src/capabilities/recording-export.cap.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-pipeline/src/recorder/addon/export-clip-catalog.ts
  - packages/addon-pipeline/src/recorder/addon/export-engine.ts
  - packages/addon-pipeline/src/recorder/addon/export-reconcile.ts
  - packages/addon-pipeline/src/recorder/addon/recording-export-provider.ts
last-verified: 2026-10-04
---

> **Landed 2026-09-21, server side.** The subject, the by-handle read, the
> recorder's clip branch and the wake are implemented; what this record left
> open — where the catalog check gets its window, whether `deviceId` may live
> only in the subject, what `includeAudio` and `Clip.inProgress` now mean, and
> how an authorised wake expires — is settled in
> [D572](./adr-0572-a-clip-subject-carries-the-provider-the-catalog-window-and-nothing-the-operator-drew-and-a-source-that-holds-no-file-says-so-in-the-type.md).
> The VIEWER half (slices 5–9) is not built; the producing side of
> `videoclips.readClipBytes` exists for HKSV and not yet for Reolink.

## Context

The operator asked for a button near a clip tile that does not download but
**asks**, with the result landing where exports land: *"forse conviene andare
sempre tramite backend e trovare poi la clip in exports"*.

A clip is not what `recording-export` was built for. An `ExportRecord` is keyed
on `(deviceId, profile, fromMs, toMs)` — a stretch of footage **we** wrote and
**we** render. A native clip is a finished file on a camera, with boundaries the
camera chose, that we fetch and mux but do not author. Three shapes were
defensible: extend `createExport` with a discriminated subject; mint a separate
clip-export record listed beside the recording ones; or decide the existing
Range-capable clip route
(`/addon/provider-reolink/clip/<deviceId>/<clipKey>.mp4`, already used by the
admin UI) is enough and the record is the wrong abstraction.

**The third is by far the least work and it was seriously considered.** The
viewer already has the download half — `use-media-download.ts` (web
`window.open`, native `FileSystem.downloadAsync` + `Sharing.shareAsync`), shared
by the export and artifact modals — so a button calling one with the other is
~20 lines and no server change. Three measurements defeated it. The provider's
playback scratch is an LRU bounded at **10 files / 200 MB per device**, so the
eleventh clip opened evicts the first; the camera's own catalog is not a promise
either (618's index stopped listing on 5 September while its calendar still
marked 20 days); and on a sleeping standalone battery camera `getClipPlayback`
refuses before it opens a session, by design — which is precisely the camera this
feature is most useful on. None of those three copies is one the operator
controls.

What defeated the **second** shape is mechanism, not taste. The recorder's
export machinery — a per-row durable store (written after one blob-per-job
clobbered a row on 2026-08-14 and a scheduler re-queued forever), an expiry
janitor, final-byte download accounting, a history that survives file deletion,
and a tenant subtree in the `artifacts` storage class — exists because each piece
cost an incident. Rebuilding it inside `provider-reolink` would mean rebuilding
it again for HKSV, and again for the next vendor, and would put two writers in
`<root>/<deviceId>/exports/`, which is the two-authorities-on-one-subtree shape
D385/D386 forbid.

The operator settled the three open questions the same day, and his three answers
are one principle: **reuse the export surface that exists, adapted, rather than
designing a clip-specific one.** *"Mostriamo lo stesso modal per l'export ma con
i soli dati per una clip"* [let's show the same modal for the export but with only the data for a clip]; *"per gli export già mostriamo cosa abbiamo, si deve
adattare per le clips"* [for exports we already show what we have, it must be adapted for the clips]; *"Quando un export viene richiesto si sveglia la
camera."* [When an export is requested the camera wakes up.] That decides the surface (the same `ExportDetailModal`), the twin
selection (the profile selector that already exists), the retention (inherited,
not chosen for clips) and the wake (on request, now).

He then specified the CREATION side, which the note had been treating as "the
same modal" without saying how one is started: *"nel modal non si seleziona start
e end ma si seleziona il segmento, o da fuori e quindi senza selezione, o
all'interno facciamo mostrare un carosello di slides con i segmenti disponibili
dalle clips."* [in the modal you do not select start and end but you select the segment, either from outside and so without selection, or inside we show a carousel of slides with the segments available from the clips.] A clip export asks for no time range at all. Which raises the one
thing that could go wrong cheaply: a carousel of clip segments is a clip
lister, and a clip lister already exists — `ClipsBrowser` with its four
tellable-apart states and each source's verbatim refusal. A second one would
diverge, and the first day it did would be on `index-empty` (618) or
`no-storage` (640) — the exact states this whole line of work exists to stop
rendering as "no clips".

And the recorder cannot simply do the work itself: talking to a Reolink camera is
the owning addon's monopoly (one session per host — a second one produced 27
`ECONNRESET`s, D549 17; the sleep gate must run **before** `getApi()` because on
UDP the login IS the wake; the cmd 5 transfer has no end-of-stream marker so
completion is a bounded idle-window retry, D58). There is also no addon→addon
byte transport in this framework: `AddonDataPlane` only lets an addon *serve*,
behind a per-listener secret only the hub may present.

## Decision

A native clip export is an **`ExportRecord`**, not a new record type and not a
bare URL. `createExport` takes a discriminated `subject`
(`{kind:'footage', …} | {kind:'clip', deviceId, source, clipId, profile?}`) and
`ExportRecord` carries the same discriminant; `deviceId`, `fromMs`, `toMs` and
`profile` remain top-level as the **projection** the Library sorts and labels on,
with `subject` as the authority on what was exported. The **recorder** stays the
sole owner of the file, the janitor, the retention and the download plane; the
**addon that owns the camera** stays the sole producer of the bytes, which the
recorder pulls **once, by handle, under a bound** over that addon's existing
authenticated clip route — reusing its warm scratch when it is there. A pull
above the bound is a named `error` on the record and never a truncated file.

**A requested clip export wakes the camera**, on the authority that already
exists and no new one: an explicit operator `force`-shaped flag on the subject,
decided before any `getApi()`, absent by default, never settable by a scheduler,
refused below 15 % battery, stamping the shared proactive-wake cooldown. **One
request is one wake** — a failed clip export is retried only by an operator act
that re-asks for the flag, a queued job that outlived its wake fails with a
reason rather than waking again, and a clip subject carries exactly ONE profile
so one tap is never two fetches.

**Everything the operator sees is the export surface, adapted, never a
clip-specific one.** The same `ExportDetailModal`: of its eight meta rows, two
are adapted (`kind` shows the clip's source label, frozen at creation; `variant`
shows the twin instead of speed/timelapse/audio, none of which a clip has), one
is relabelled (`range` keeps its value and format — the camera's boundaries are
still a true statement about what the file covers — and loses only the wording
that implies the operator drew it), and five are untouched. The sub/main twins
ride the existing profile selector on the mapping D549 15 already fixed
(`low | mid` → sub, `high` → main, `auto` refused); the picker offers only the
twins the catalog row has, and asked-vs-served is carried on the record and
SHOWN, never silently substituted. Retention is **inherited** — a clip export
gets no bespoke `expiresAt` or `deleteAfterDownload` policy.

**A clip export asks for no time range, and its carousel is the existing clip
lister in a different layout — never a second one.** There is no drag, no
`datetime-local` pair, no `fromMs`/`toMs` in the subject: the camera chose the
boundaries and they reach the record only as the projection. Two entry paths —
from a chosen clip (no selection step, no query) and from the modal itself (a
strip of segments) — and the strip is built by extracting `ClipsBrowser`'s
decision half (`useCapabilityPresence`, the day window, the two hooks,
`resolveClipsView`, `describeSource`, `ClipSilentSources`, `ClipTile`) into one
hook that both the grid and the strip render. The strip may drop the tick-box
source list, because that filter persists nothing; it may **not** drop a state:
all four are rendered as text, `ClipSilentSources` sits above the slides, the day
label is shown in every state including the empty one, and Create is disabled
with its reason in any state but `listed`. Entry path 2 requires a device
context and says so — it reuses `NewExportModal`'s existing camera select rather
than guessing, and asks for ONE day, defaulting to today.

Correspondingly, `export-selection.ts` and `use-export-selection.ts` are the
TIMELINE path and are never wired into the clip path: there is no drag to order,
a native clip cannot cross a hole because it is a file, and an `analytics`-source
clip — which can span holes — is a window over footage we wrote and therefore
goes down the recorder's existing render path, where the source playlist and
`export-dense-map` already handle gaps. **One subject, two producers, chosen by
the source namespace** exactly as `getClipPlayback` already dispatches; the
caller never picks.

`progressPct` stays honest — a real fraction only where one exists (the mux, and
the fetch when the catalog row carries `bytes`), `null` otherwise. No ramp.

## Consequences

- `videoclips` gains one by-handle byte read, bounded. `recording-export` gains
  one field and one validation branch; the recording-index fail-fast does not
  apply to a clip and is replaced by a catalog check.
- **`ExportRecord.subject` is safe to ship before the viewer; a new
  `ExportState` member is not.** The viewer mirrors the record by hand and maps
  any unknown state string to `failed`, so a seventh member would render live
  exports as failed on every installed app. A clip therefore reuses the existing
  states, and `subject.kind` tells the surface what `rendering` means.
- A clip export is a **third copy** of the same media (camera, provider scratch,
  export file). That is the point: it is the only one with an `expiresAt` the
  operator chose. Measured sizes make the disk cost noise against the ~8.4 GB of
  operator exports the class already holds.
- `includeAudio` must never be claimed true for a Reolink clip: the mux is
  video-only until the library returns audio packets.
- Because it is an `ExportRecord`, the viewer needs **no new gallery source** —
  `library-items.ts`, `ExportCard`, `MediaViewerModal` and `useMediaDownload`
  carry it unchanged, and `ExportDetailModal` changes by three rows and no new
  component. That is the payoff, and it is forfeited the moment anyone mints a
  parallel record type.
- **`createdBy: () => 'operator'` is now a defect, not a wart.** No per-call
  principal reaches a cap provider (a method is handed `input` and nothing else),
  so every export in the history is attributed to the same six characters — and
  the field is not rendered in the modal at all. While an export only spent CPU
  that was tolerable. An action that WAKES a camera on request and cannot say who
  asked is not auditable. The smallest honest fix is a principal stamped by the
  ROUTER through the `.loose()` seam that already carries `nodeId` (never a
  client-supplied field, which is a claim and not an identity); the class fix is
  a caller context on every cap method, which is codegen-wide. **Not fixed by
  this decision** — named so the wake slice can decide whether it is a
  precondition.
- **The "inherited" retention has no owner.** `maxLifeMs` and
  `deleteAfterDownload` are required with no server default; the seven days live
  as two client constants that agree by coincidence and nothing checks them. A
  clip export MUST use the same value as the surface it is created from and MUST
  NOT invent a third number; the subsystem should grow one owned default.
- `listExports` is unpaged whole-history, and a one-tap button grows it far
  faster than timeline selections did.
- **The carousel costs a refactor before it costs a component.** `ClipsBrowser`
  must give up its decision half to a shared hook first; the strip is then a
  rendering. Writing the strip as its own lister is less work today and is the
  defect. The refactor is ~60 lines out of 216 and it forbids something
  permanently: after it, a strip that disagreed with the grid would have to
  disagree with itself.
- **`fromMs`/`toMs` on a clip export mean something different from what they
  mean on a recording export** — the camera's boundaries, never what was asked
  for. Same type, different fact. The record's docblock must say which, or a
  reader who knows the recording export will assume the other.

## Considered and not taken

**`wake: 'next-natural'`** — a second mode that never wakes, fetching the clip
the next time the camera is awake for its own reasons, on the `onWakeTransition`
hook `reolink-camera.ts` already observes and the standalone-battery catalog
refresh already uses. It costs the battery nothing and it is the one thing a URL
genuinely cannot do, which is why it was proposed. **The operator declined it:**
*"Quando un export viene richiesto si sveglia la camera."* [When an export is requested the camera wakes up.] Written down with its
mechanism so a later session recognises it as decided rather than re-proposing it
as an obvious win — and so the cost it hides is on the record: a durable
pending-work queue that must survive a runner respawn, a second expiry story for
work that never ran, and a row that sits `queued` for hours looking exactly like
one that is stuck.

**A separate clip-export record type**, and **the bare clip URL** — both argued
and costed in the design note §§ 4.1–4.2. The URL is the least work by a wide
margin and is still wrong: the provider scratch is a 10-file LRU, the camera
catalog is not a promise, and the route refuses on the sleeping camera this
feature is most useful on.

## Enforcement

- A `packages/types` test pinning `ExportStateSchema`'s members against a literal
  list, commented with the viewer's hand-written copy as the reason — the only
  thing standing between a new state and every installed app showing `failed`.
- A test that a `kind:'clip'` subject **without** the wake flag never reaches
  `getApi()` on a sleeping standalone battery camera, proven red by removing the
  gate — and a second that a FAILED clip export does not wake the camera again on
  its own (one request, one wake).
- A test on the pure formatters (`export-format.ts` is already framework-free)
  that a clip export whose SERVED twin differs from the ASKED one renders the
  difference — the measured case is 17 of 546 clips on 592 with no main twin, so
  a silent fallback would be right 96.9 % of the time and quietly hand the
  operator the worst copy on the rest.
- A test that `variantLabel` is not reached for a clip subject: it would render
  "Real time (1×)" for a file nobody timed, and "without audio" for a mux that
  has no audio path at all.
- A test that the carousel and the grid answer **identically** for
  `index-empty`, `no-storage` and `sleeping` — driven through the one shared
  hook, so the assertion is that there is one answer and not two that agree
  today. This is the only mechanical guard against the divergence the carousel
  risks; without the refactor there is nothing to assert against.
- A test that the clip path renders no range control and that a created record's
  `fromMs`/`toMs` are `clip.timeRange`, not anything a caller supplied.
- Tests driving a fake clip provider that refuses, that returns short bytes, and
  that exceeds the bound — three distinct `error` strings on the record, none of
  them silent.
- Otherwise review only, which is worth writing down: nothing mechanical stops a
  future vendor addon from minting its own export record type.
