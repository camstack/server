---
title: A native clip reaches the operator through the export record — one button that ASKS, and a file that lands in the Library
last-verified: 2026-09-20
covers:
  - packages/types/src/capabilities/recording-export.cap.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-pipeline/src/recorder/addon/recording-export-provider.ts
  - packages/addon-pipeline/src/recorder/addon/export-store.ts
  - packages/addon-pipeline/src/recorder/addon/export-engine.ts
  - packages/addon-provider-reolink/src/clips/**
  - packages/ui-library/src/composites/clips/**
  - packages/addon-admin-ui/src/components/recordings/NewExportModal.tsx
---

> Status: **slices 1–4 LANDED, 2026-09-21** — the `ExportSubject` on the cap,
> the bounded by-handle `videoclips.readClipBytes`, the recorder's clip branch
> (catalog gate, named refusal per failure, honest `null` progress) and the
> wake, including its expiry. Slices 5–10 (the modal, the carousel, the buttons,
> the debts) are NOT built, and the producing side of `readClipBytes` exists for
> HKSV but not yet for Reolink. What this note left open is settled in
> [D572](../decisions/adr-0572-a-clip-subject-carries-the-provider-the-catalog-window-and-nothing-the-operator-drew-and-a-source-that-holds-no-file-says-so-in-the-type.md):
> the clip subject also carries `provider` and `catalogWindow`, `deviceId` stays
> top-level, `includeAudio` is claimed neither way, an `inProgress` clip is
> refused by name, and an authorised wake expires with its job. Decision record:
> [D558](../decisions/adr-0558-a-native-clip-export-is-an-export-record-with-a-subject-and-the-bytes-are-pulled-by-handle-from-the-addon-that-owns-the-camera.md).
> Required reading first: [2026-09-20-external-videoclips.md](2026-09-20-external-videoclips.md)
> (the clip surface this rides on) and [D549](../decisions/adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
> decisions 6, 13, 17 and 22.

## 0. The ask, and the answer in one paragraph

Operator, 2026-09-20: *"Sul Viewer, mostrare un pulsante per scaricare una clip
al volo vicino al tile, ma forse conviene andare sempre tramite backend e
trovare poi la clip in exports."* [On the Viewer, show a button to download a
clip on the fly next to the tile, but perhaps it is better to always go through
the backend and then find the clip in exports.]

The button does not download. It **creates an `ExportRecord`** whose subject is a
clip instead of a footage range, and the file lands exactly where a timeline
selection's file lands — `<artifacts root>/<deviceId>/exports/<id>.mp4`, with an
`expiresAt`, a janitor, download accounting, and a row in the Library gallery the
viewer already renders. The bytes are produced by the addon that owns the camera
(it is the only process that may talk to it) and **pulled once, by handle, under
a bound**, by the recorder — which stays the single writer of that directory.

The operator answered this document's § 8 on the same day, and the three answers
are one principle: **reuse the export surface that exists, adapted — do not
design a clip-specific one.** Verbatim: *"Mostriamo lo stesso modal per l'export
ma con i soli dati per una clip"* [Let us show the same modal for the export but
with only the data for a clip]; *"Vedi prima, per gli export già mostriamo
cosa abbiamo, si deve adattare per le clips"* [Look at what exists first: for
exports we already show what we have, it must adapt to clips]; *"Quando un export viene richiesto
si sveglia la camera."* [When an export is requested the camera is woken up.] So: the same `ExportDetailModal` with the rows a clip
actually has (§ 5.4.1); the sub/main twins ride the profile selector that already
exists (§ 5.4.2); the lifetime is inherited, not chosen for clips (§ 5.3); and a
requested clip export **wakes the camera** — `next-natural` is not wanted and is
recorded as considered-and-not-taken (§ 5.2). And he specified the CREATION
side, which this note had been treating as "the same modal" without saying how
one is started: *"nel modal non si seleziona start e end ma si seleziona il
segmento, o da fuori e quindi senza selezione, o all'interno facciamo mostrare un
carosello di slides con i segmenti disponibili dalle clips."* [In the modal you do
not select start and end, you select the segment, either from outside and
therefore without a selection, or inside we show a carousel of slides with the
segments available from the clips.] There is **no time
range control on this path at all** (§ 5.4.3).

The direct clip route (`/addon/provider-reolink/clip/<deviceId>/<clipKey>.mp4`)
is not replaced and not deprecated: it stays what it is, the playback path and
the admin UI's one-click save. It is the wrong answer to this ask for three
measured reasons stated in § 4.

## 1. The leads, verified

Every item in the brief was checked against the code. Verdicts:

| Lead | Verdict |
| --- | --- |
| `recording-export.cap.ts` is `scope:'system', mode:'singleton'` with those seven methods | **True**, and there is an eighth the brief did not name: `readExportBytes` (base64, ≤ 50 MiB, `ready` only) |
| `ExportRecordSchema` carries those 15 fields | **True**, verbatim |
| The viewer already drives `createExport` from a timeline selection | **True** — `camstack/src/recording/use-export-selection.ts` → `buildExportSelectionInput` → `useCreateExport`. Both traps in its docblock are real and both are pinned by `export-selection-cycle.spec.ts` |
| A clip has a Range-capable MP4 route on `provider-reolink`, session-cookie auth, no token in the URL | **True** — `clip-data-plane.ts`, `access:'authenticated'`, Range hand-rolled over `createReadStream().pipe(res)` per D447 |
| `training-export-handler.ts` is a different export and explains why bytes never ride a cap channel | **True**, and its reasoning is duplicated in `recording-export.cap.ts`'s `RECORDING_EXPORT_MAX_READ_BYTES` docblock (D9/D18, the hub-main OOM) |
| "The viewer never implemented the download half" | **FALSE.** It is implemented and shared — see § 5.4 |

Two things the brief did not say, and both are load-bearing:

- **Export files do not live in the addon data dir.** `export-store.ts` puts them
  in the `artifacts` storage CLASS, `<root>/<deviceId>/exports/<id>.mp4`, shared
  with the notification shelf as two tenants of one location (D341). If that
  location is unresolved the whole export subsystem **refuses** rather than
  falling back. A clip export inherits that dependency; the clip route today does
  not have it.
- **There is no addon→addon byte transport.** `AddonDataPlane` only lets an addon
  *serve*; the listener is `127.0.0.1` behind a per-listener secret the hub
  injects, so **only the hub may reach it**. There is no `ctx.dataPlane.fetch`.
  The one existing cross-addon byte move in this repo is the timelapse's
  `readExportBytes` → artifact publish: base64 over the cap channel, capped at
  50 MiB, with the cap's docblock naming exactly why the cap is there. That
  constraint decides the shape more than taste does.

## 2. The question that decides the design

An `ExportRecord` is keyed on `(deviceId, profile, fromMs, toMs)` — a stretch of
*our* recording. A native clip is a file on a camera with boundaries the camera
chose. Three shapes were on the table.

### 2.1 What is actually shared, and what is not

Lay the existing record against a clip, field by field, before choosing:

| Concern | Recording export | Clip export | Shared? |
| --- | --- | --- | --- |
| Identity of the subject | `deviceId, profile, fromMs, toMs` | `deviceId, source, clipId` | **No** |
| Who produces the bytes | the recorder, from footage it wrote | the camera's owning addon, over cmd 5 + one ffmpeg mux | **No** |
| Fail-fast gate | "does the recording index cover this range" | "does this source still list this clip, and may we reach it" | **No** |
| Progress | ffmpeg `time=` against a known output duration | § 5.1 — mostly not a percentage | **No** |
| Where the file lands | `<artifacts>/<deviceId>/exports/<id>.mp4` | the same place, for the same reason | **Yes** |
| Retention | `expiresAt`, `deleteAfterDownload`, `downloadedAt`, the 5-min janitor | identical requirement | **Yes** |
| How it is collected | `getDownloadUrl` → the recorder's `exports` plane, download-complete accounting | identical requirement | **Yes** |
| History / audit | the row survives file deletion | identical requirement | **Yes** |
| How the viewer shows it | `LibraryItem` union, `ExportCard`, `ExportDetailModal`, `useMediaDownload` | identical requirement | **Yes** |

Four differences, five sameness rows — and every one of the five is a piece of
machinery that took a decision record and a live incident to get right. That
asymmetry is the argument.

### 2.2 The shape chosen

**`createExport` gains a discriminated SUBJECT, and `ExportRecord` gains the
same discriminant. The recorder stays the sole owner of the file, the janitor
and the download plane. The bytes are pulled once, by handle, from the addon
that owns the camera, under a bound, and a pull above the bound is a NAMED
refusal on the record.**

```
CreateExportInput =
  | { subject: { kind: 'footage', deviceId, profiles[], fromMs, toMs }, options }
  | { subject: { kind: 'clip',    deviceId, source, sourceLabel, clipId,
                 profile, wake? }, options }

ExportRecord.subject: ExportSubject      // the same discriminated union
```

`sourceLabel` is the operator-facing name of the clip source, frozen at creation
(§ 5.4.1); `profile` is exactly one, and is what was ASKED (§ 5.4.2); `wake` is
the operator's authorisation to wake a sleeping camera, absent by default
(§ 5.2). There are **no `fromMs`/`toMs` in a clip subject** — the camera chose
them, the surface never asks for them (§ 5.4.3), and they reach the record only
as the projection below.

One subject, **two producers, chosen by the source namespace** — the same
dispatch `getClipPlayback` already performs. A `native:*` source takes the
by-handle fetch of § 3; the `analytics` source is a window over footage we wrote,
so it takes the recorder's existing render path, where holes are already handled
(§ 5.4.3). The caller never picks the producer.

`deviceId`, `fromMs`, `toMs` and `profile` stay on the record as TOP-LEVEL
fields for a clip too, filled from the clip's `timeRange` and its **served** twin
— so the top-level `profile` is what was delivered and `subject.profile` is what
was asked, and the modal renders the difference rather than hiding it —
because the whole Library sorts and labels on them (`library-items.ts` orders an
export by `fromMs` — the start of the footage it covers — and `export-format.ts`
draws `rangeLabel` from the pair). A clip that did not fill them would sort under
the epoch and render a blank range label. `subject` is the AUTHORITY on what was
exported; those four are its projection, and the record's docblock has to say so
in those words or somebody will write to one and read the other.

Legacy inputs (the flat `{deviceId, profiles, fromMs, toMs}` the timelapse
scheduler and the viewer send today) are rewritten into `subject.kind:'footage'`
by the same `preprocessCreateExportInput` helper that already rewrites
`profile` → `profiles`. That helper exists precisely because the generated
routers call `.input.loose()` on a ZodObject, so the union must be expressed as
one object with an optional discriminant — **not** as `z.discriminatedUnion`,
which has no `.loose()`. This is a real constraint on the Zod, not a style note.

## 3. Why, from the mechanism

Three facts force it.

**1. The recorder cannot produce the bytes.** Talking to a Reolink camera is the
owning addon's monopoly — one session per host (a second session to the Home Hub
produced 27 `ECONNRESET`s, D549 17), the sleep gate must run *before* `getApi()`
because on UDP the login IS the wake, and the cmd 5 transfer has no end-of-stream
marker so completion is an idle window with a bounded retry (D58). None of that
is portable into `export-engine.ts`, and copying it there would be a second
authority on camera access — the failure mode this repo has recorded four times
(D385, D386, D224, D62).

**2. The owning addon must not become a second export system.** Give
`provider-reolink` its own record type and it needs: a durable store with
per-row writes (the recorder's `export-store.ts` exists because one blob-per-job
clobbered a row and the scheduler re-queued forever, 2026-08-14, camera 101), an
expiry sweeper, download-complete accounting with a grace window, a history that
survives file deletion, and a storage-class tenant. Then HKSV needs all of it
again, and the next vendor after that. The recorder already has every piece, and
it has them because each one cost an incident.

**3. The operator's ask is about WHERE IT LANDS.** *"trovare poi la clip in
exports"* is a statement about the Library, not about a transfer. The Library is
already a merged, discriminated gallery (`library-items.ts`: `LibraryItem` is
`{source:'artifact'} | {source:'export'}`, with source-prefixed ids because "the
two id spaces are independent and a collision would silently drop one of the two
rows"). A clip export that IS an `ExportRecord` appears there with **zero** new
viewer plumbing. That is not a convenience; it is the difference between a slice
that ships and a third gallery source.

## 4. What the rejected alternatives cost

### 4.1 A separate clip-export record, listed beside recording exports

Cost, concretely:

- A second durable store, a second janitor, a second download plane with its own
  final-byte accounting, a second history. Every one of those is a re-derivation
  of something in `packages/addon-pipeline/src/recorder/addon/export-*.ts` whose
  docblock names the incident that shaped it.
- A **third tenant** on the `artifacts` storage location, or a second physical
  root. The location is declared by two addons today "with identical cardinality
  — the registry throws at kernel boot on a conflict", so a third declaration is
  possible; but two writers into `<root>/<deviceId>/exports/` is exactly the
  two-authorities-on-one-subtree shape D385/D386 forbid, and a separate subtree
  means occupancy has a third class to attribute (D327).
- On the viewer: a third arm on `LibraryItem`, a third fetch in
  `ArtifactsScreen`, a third `wantsX` predicate, a third detail modal. The file
  that merged the first two says in its own docblock that the two screens it
  replaced "each answered the first two questions with inline booleans, and they
  disagreed."
- It is not free on the server either: `listExports` is the query the Library
  calls; a second list means a second poll and a merge the client has to order.

The one thing it buys — a record shape with no `subject` union and no projected
fields — is bought back immediately by needing the projections anyway to sort and
label the row.

**Verdict: rejected.** It is more work than the chosen shape *and* worse.

### 4.2 The clip route is enough; an export record is the wrong abstraction

This is the tempting one, and it is the least work by a wide margin: the viewer
already has `useMediaDownload`, the clip already has an authenticated Range URL,
and a button that calls one with the other is perhaps twenty lines and no server
change at all. **Say plainly that it is the least work.** It is still wrong here,
for three reasons that are measurements and not preferences:

1. **The camera copy is not durable and the scratch copy is not either.** The
   provider's playback scratch is an LRU bounded at **10 files / 200 MB per
   device** (`clip-artifact-store.ts`, D549 6). The eleventh clip an operator
   opens evicts the first. The camera's own SD rolls over on the camera's
   retention (measured: 18–19 days on 592/618; and 618's index stopped listing
   after 5 September while its calendar still marked 20 days — a camera's
   catalog is not a promise). "I saved that clip" has to survive both.
2. **A direct download is refused on the camera this feature is most useful
   for.** `getClipPlayback` on a sleeping standalone battery camera throws before
   any `getApi()` — by design. A URL the viewer cannot fetch is not a download
   button; § 5.2 is the whole answer there, and it needs a record.
3. **The first byte is ~4 s away, on a mobile radio.** Measured: the transfer is
   ≈ 2 s for 1.8 MB on the LAN plus the 2 s idle window that decides completion,
   then one bounded ffmpeg. `FileSystem.downloadAsync` on a phone would hold an
   open request across all of that with no progress and no resumption; the
   recorder's `exports` plane serves an already-finished file with `Range`.

There is a fourth, softer reason: the operator asked for the backend path in the
same sentence as the button. Building the direct-URL version would be answering a
question he did not ask.

**Verdict: rejected as the ANSWER, kept as the MECHANISM.** The direct route is
what the export engine itself fetches (§ 5.3), so nothing about it is wasted.

### 4.3 The chosen shape's own cost

Stated so it is not discovered later:

- One new `videoclips` method (a by-handle byte read) on a cap file another agent
  owns today. That file is `packages/types/src/capabilities/videoclips.cap.ts`.
- A bound on that read, and an honest refusal above it (§ 5.3). A 4K main-stream
  clip **can** exceed 50 MiB; a sub clip measured 92 KB – 2.29 MB and a 16 s main
  clip 455 KB, so the bound bites rarely — but "rarely" is not "never" and the
  refusal must be a named `error` on the record, never a truncated file.
- `ExportRecord` grows a field. Additive, and § 6.1 shows why that is safe and
  why a new `ExportState` member would not be.

## 5. The five things that must be answered

### 5.1 What does `progressPct` mean for a clip?

**Mostly nothing, and it should say `null` rather than ramp.**

A recording export renders: `export-engine.ts` parses `time=` out of ffmpeg's
stderr and scales it against a known expected output duration, so its percentage
is a real fraction of a real job. A clip export has three phases and only the
last of them is that:

| Phase | Observable | Honest `progressPct` |
| --- | --- | --- |
| queued | nothing | `null` (what the record already does) |
| fetch from the camera (cmd 5 → scratch) | bytes landed; the expected total is on the catalog row **only when** `Clip.streams.{sub,main}.bytes` is present, which is optional | a real byte fraction when `bytes` is known; **`null` when it is not** |
| mux (one bounded ffmpeg, `CLIP_MUX_TIMEOUT_MS` 60 s) | ffmpeg `time=` against the clip's `timeRange` duration | a real fraction — the same parser already in the engine |
| transfer to the recorder | bytes | a real fraction, but it is ~2 s |

So: **no fake ramp.** Where the number is real, emit it; where it is not, emit
`null` and let the surface say *"preparing — 3 s"*, which is what
`2026-09-20-external-videoclips.md` § 6 already specifies for the playback path
and what the operator has already seen. `progressPct` is `number | null` in the
schema today precisely so `null` is representable, and the viewer's
`ExportCard`/`ExportDetailModal` already render a `null` progress for a `queued`
row without a bar.

**The temptation to add `'fetching'` to `ExportState` is resisted, not
sequenced.** § 6.1 is why: the viewer maps any unknown state string to `failed`,
so a seventh member renders every live export — clip and recording alike — as
FAILED on every installed app. `subject.kind` already tells the surface what
`rendering` means for a clip, and § 5.4.1 keeps `stateLabel` untouched precisely
because `v2.exports.state.*` exists for six values and no more.

The whole operation is measured at roughly **4–6 s** end to end for a sub clip on
the LAN. That is worth saying out loud: the progress question is small because
the job is short. What matters far more is that a clip export that FAILS says
why, per phase — `camera-refused` (verbatim), `no-file-for-window`, `sleeping`,
`mux-failed`, `too-large-to-transfer` — on `ExportRecord.error`. A branch that
accepts work and produces nothing is the branch this repo keeps losing work in
(D391).

### 5.2 A battery camera

**Yes, a clip export may wake a camera — and only on an authority that already
exists, never a new one.**

The existing authority is a `force`-shaped operator signal decided *before* any
`getApi()`. `snapshot-wake-gate.ts` states the contract in the clearest words in
this repo: *"`snapshot.getSnapshot`'s `force` flag, and nothing else… a
background caller must never set it… Stale but honest beats woken"*, and it also
records why a cooldown is not a contract (device 106, 2026-09-15: the cooldown
let an unforced read through, the camera woke, and the very next line composed
the picture from cache — "the wake bought nothing at all"). The operator-facing
gestures built on it are the **"Wake and refresh"** button (design § 7, refused
below 15 % battery) and the *refresh from camera* device action
(`deviceManager.runDeviceAction`, `protectedProcedure` — a viewer session can
call it).

So, three rules, and no new authority:

1. `createExport` with `subject.kind:'clip'` on a **sleeping standalone battery
   camera REFUSES** by default, with the reason the clip surface already uses
   (`sleeping`), decided before the owning addon opens a session.
2. The refusal is liftable **only** by an explicit flag on the subject
   (`wake: 'authorised'`, absent by default, never settable by a scheduler or a
   retry), which the viewer sets **only** behind the same confirm the "Wake and
   refresh" gesture uses, and which is refused below 15 % exactly as that gesture
   is. Demand is never rate-limited (same rule as `wakeForStream` /
   `wakeIfSleeping`), but it **stamps** the shared proactive-wake cooldown so
   background paths back off behind it.
3. **A queued clip export never retries into a wake.** One authorised wake is one
   wake. A job that sat in a queue and woke the camera twenty minutes later would
   turn an operator's single yes into an unbounded licence — the exact shape D49
   warns about (a one-shot gated on a fallible read).

**The "ask now, collect later" the operator meant is about HIM, not the camera.**
Operator, 2026-09-20: *"Quando un export viene richiesto si sveglia la camera."*
[When an export is requested the camera is woken up.]
A requested clip export wakes the camera, now, on rule 2's flag. What the record
buys is that the operator does not stand in front of a spinner for the wake round
trip (measured 2.9–6.2 s just to log in on 640) plus the transfer plus the mux —
he taps, walks away, and the row is in the Library when he looks.

Rule 3 has teeth that need spelling out, because there are three ways to break it
without meaning to:

- a **retry** of a failed clip export is a second wake — so a retry is an
  operator act, never automatic, and it re-asks for the flag;
- a **queued** export that outlives the wake it was granted must fail with a
  reason rather than wake again on its turn;
- a **two-twin** create (§ 6.3) is two jobs on one tap, and two jobs are two
  fetches — which is a second reason, on top of the return-shape defect, that a
  clip export takes exactly ONE profile per call (§ 5.4.2).

### Considered and not taken: `wake: 'next-natural'`

This document's first draft proposed a second mode: do not wake — fetch the next
time the camera is awake **for its own reasons**, on the `onWakeTransition` hook
`reolink-camera.ts` already observes (stream / operator action / event wake / the
hub-summary reconcile), the same transition design § 5 hangs the standalone
battery catalog refresh on. It costs the battery nothing and it is the one thing
a URL genuinely cannot do.

**The operator does not want it.** A requested export wakes the camera. It is
written down here, with its mechanism, so a later session recognises it as
already-decided rather than re-proposing it as an obvious win: the cost it hides
is a durable pending-work queue (a runner respawn must not lose it), a second
expiry story for work that never ran, and a record that sits `queued` for hours
looking to the operator exactly like one that is stuck.

### 5.3 Who owns the bytes, and for how long

**A third copy, yes — and the reason is that neither of the other two is a copy
the operator controls.**

| Copy | Owner | Lifetime | Controlled by |
| --- | --- | --- | --- |
| The camera's SD / the hub's storage | the camera | its own retention, measured 18–19 days; and 108 stopped *listing* after 5 Sep while its calendar said otherwise | nobody here |
| The provider's playback scratch | `provider-reolink` | LRU, **10 files / 200 MB per device** — evicted by the eleventh clip opened | nobody, by design |
| The export file | the recorder | `expiresAt` (operator-chosen) + `deleteAfterDownload` + the 5-min janitor | **the operator** |

Cost of the third copy: small and already budgeted. Measured clip sizes are
92 KB – 2.29 MB (sub) and 455 KB for a 16 s main clip; the `artifacts` class on
this hub already holds ~8.4 GB of operator exports. Clip exports are noise
against timeline selections, and they land in the same class with the same
occupancy attribution (`eventMedia` → `events/`, the artifacts class subtree
rules of D327 apply unchanged because the tenant subtree is unchanged).

Three consequences to hold:

- **Reuse the scratch when it is still warm.** The recorder fetches over the
  provider's own `/clip/<deviceId>/<clipKey>.mp4` route, and that route serves
  the cached muxed file when it exists. A clip the operator just watched costs no
  second camera transfer and no second wake. This is the reason to pull over the
  route rather than invent a private path.
- **Defaults are INHERITED, not chosen for clips** (operator, 2026-09-20). A clip
  export gets whatever the export subsystem already applies, and gets no bespoke
  retention policy. Following that instruction turned up something worth stating
  plainly: **the export subsystem has no default.** `ExportOptionsSchema` makes
  `maxLifeMs` a required positive integer and `deleteAfterDownload` a required
  boolean; the provider only computes `expiresAt = now + options.maxLifeMs`.
  The "default" lives in the CLIENTS, duplicated twice and agreeing by
  coincidence:

  | Caller | constant | value |
  | --- | --- | --- |
  | admin `NewExportModal.tsx` | `EXPORT_LIFE_MS` | `7 * 24 * 60 * 60 * 1000`, `deleteAfterDownload: false` |
  | viewer `export-selection.ts` | `EXPORT_SELECTION_LIFE_MS` | `7 * 24 * 60 * 60 * 1000`, `deleteAfterDownload: false` |

  So "inherit" means: **use the same seven days and the same `false`, from the
  same constant as the surface you are creating from** — which is the right
  answer and also the one that makes a third copy of the number. The subsystem
  should own the default (a `DEFAULT_EXPORT_LIFE_MS` in the cap beside the
  schema, with `maxLifeMs` staying required so nothing silently gets a lifetime
  it did not ask for); that is § 7 slice 8, not a clip concern, and until then a
  clip export MUST NOT invent a third number. It does not produce something
  wrong for clips — it reveals that the agreement is held by two copies and
  nothing checks them.
- **`includeAudio` is meaningless today and must not be claimed.** The Reolink
  mux is video-only (`clip-mux.ts`: the library counts `audioPackets` and has no
  API that returns them). `ExportOptionsSchema` makes the field required, so a
  clip export sets `false` — and § 5.4.1 removes it from the modal's variant row
  rather than rendering "without audio" as if audio had been declined.
- **The bound.** The by-handle read is capped. Above the cap the export goes
  `failed` with `error: 'clip exceeds the transfer bound (<n> > <max>)'` and a log
  line — never a truncated MP4, same rule `readExportBytes` already follows
  ("half a video is worse than a notification that says there is no
  attachment"). The clean follow-on is a **chunked** by-handle read so `high`
  twins of long clips stop being refusable; that is a slice, not a v1.

### 5.4 Where the viewer puts it

**The download half IS implemented — the brief's suspicion is wrong.**

`camstack/src/components/media/use-media-download.ts` is the one shared recipe,
written after the same thing was hand-rolled three times and had already drifted:

- **web**: `window.open(url, '_blank')`. The export plane is
  `access:'authenticated'` and the browser satisfies it with the session cookie —
  so this only works while the viewer's web build is served from the hub origin.
- **native (iOS + Android)**: `FileSystem.downloadAsync(url, cacheDirectory + name, { headers })`
  then `Sharing.shareAsync(uri, { mimeType })` when a share sheet exists. It
  returns whether the file was **delivered**, so the caller can report a failure
  instead of a silent nothing.

`ExportDetailModal.tsx` already wires it for an export: `getDownloadUrl` →
absolutise against `system.serverUrl` (`useResolveDownloadUrl`) → attach the
session Bearer → `download({ url, fileName: 'export-<id>.mp4', mime:'video/mp4' })`.

**So a clip export rides exactly that path with no new viewer plumbing** —
provided it is an `ExportRecord` and therefore already a `LibraryItem`. This is
the single most concrete argument for § 2.2 over § 4.1.

Two honest gaps to name:

- On native the file lands in the **app cache directory** and is handed to the
  share sheet. It is not saved to Photos. If the operator expects a camera-roll
  save, that is `expo-media-library` plus a permission prompt and it does not
  exist in this app today. Nothing about clip export changes that, and nothing
  about clip export should smuggle it in.
- No share sheet ⇒ reported as success, deliberately ("the bytes are on the
  device either way"). Correct, but it means an Android device without a sharing
  target leaves the operator with a file in a cache dir and a success toast.

#### 5.4.1 The same modal, showing only what a clip has

Operator: *"Mostriamo lo stesso modal per l'export ma con i soli dati per una
clip… per gli export già mostriamo cosa abbiamo, si deve adattare per le clips."*
[Let us show the same modal for the export but with only the data for a clip…
for exports we already show what we have, it must adapt to clips.]
So `ExportDetailModal` is the surface, unchanged in structure. Its `metaRows` are
eight, and going through them one at a time is what decides the adaptation:

| Row | Recording export | A clip export | Verdict |
| --- | --- | --- | --- |
| `kind` — `t('v2.artifacts.kind.export')` | "Export" | should name the SOURCE the clip came from ("SD card", "Home Hub"), because that is the thing the operator picked and the thing that distinguishes two rows of one camera at one minute (D549 11: a clip in two storages is two rows) | **adapt** — carry `subject.sourceLabel`, frozen at creation the way `createdBy` is, so a history row still reads after a source is unbound |
| `camera` — `cameraName` | camera name | same | **unchanged** |
| `range` — `rangeLabel(fromMs, toMs)` | the stretch the operator drew | the camera's own boundaries. The VALUE and the FORMAT are still right — `"20 Sep, 14:30 → 14:45 (15m)"` is a true statement about what the file covers, and `formatDuration` is the most useful single number a clip has. Only the LABEL key is wrong: `v2.exports.range` reads as "the range you asked for" | **keep the value, change the label** to the clip's own time span |
| `variant` — `variantLabel(options, t)` | speed / timelapse / ± audio | **all three are meaningless.** Nothing is re-timed (the mux is a remux, not a render), and `includeAudio` is a lie today (§ 5.3). Calling `variantLabel` here renders "Real time (1×) " for a file nobody timed | **replace** with the TWIN: "Main (high)" / "Sub (low)", plus the asked-vs-served divergence of § 5.4.2 |
| `state` — `stateLabel(record.state, t)` | six localised keys | identical — and this is exactly why a clip reuses the six states rather than adding `'fetching'`: `v2.exports.state.*` exists for six values and no more (§ 6.1) | **unchanged** |
| `size` — `formatBytes(record.fileBytes)` | bytes once ready, `—` before | same | **unchanged** |
| `expiry` — `expiryLabel(expiresAt, nowMs, t)` | countdown, or "deleted" | same, on the inherited lifetime (§ 5.3) | **unchanged** |
| `error` — conditional | failure reason | this is where a clip's named refusal lands verbatim — `sleeping`, `camera-refused`, `no-file-for-window`, `mux-failed`, `too-large-to-transfer` | **unchanged, and load-bearing** |

Two adaptations (`kind`, `variant`), one relabel (`range`), five rows untouched.
No new row, no new component, and `MediaViewerModal`, `libraryItemActions`,
`ExportCard` and `useMediaDownload` are not touched at all.

Three things that fall out of the walk-through:

- **The player works as-is.** `media` resolves to `{kind:'video', url, headers}`
  through `getDownloadUrl`, gated on `libraryItemActions(...).playback`, which
  keys on `record.state`. A clip export's file is the provider's muxed MP4, which
  is already written with `-movflags +faststart` ("it puts `moov` first, so the
  player knows the duration before the bytes arrive and seeking works over the
  Range route natively"). Nothing to change.
- **Set `options.title` at creation.** The server already slugifies it into the
  download filename (`exportFileName`), so a clip export saved to a phone lands
  as something recognisable instead of `export-<uuid>.mp4`. Zero new machinery,
  and it also fixes the notifier-attachment filename for free.
- **`createdBy` is not displayed at all.** The modal has no row for it. That
  makes § 6.7 worse, not better: the one action in this feature that spends a
  camera's battery is attributed to a constant string AND invisible in the only
  surface that shows the record.

One check to perform when the fetch lands: if the muxed file's measured duration
disagrees with the catalog row's `timeRange`, the `range` row is describing a
file the operator does not have. The row may be stale (`catalogAsOf`). Log the
disagreement with `tags: { deviceId }`; do not silently rewrite either number.

#### 5.4.2 The twins ride the existing profile selector

Operator: adapt what exists rather than inventing a clip-only toggle. It already
fits, and better than expected:

- `CreateExportInput.profiles` is `min(1)`, and the admin `NewExportModal`
  already renders a Profile select over `['high','mid','low']` — which is
  `CamProfileSchema` minus `auto`.
- `videoclips.getClipPlayback` takes that same `CamProfileSchema`, with the
  mapping already decided by D549 15: **`low | mid` → the sub file, `high` → the
  main twin**, and `auto` deliberately refused because "a stored file has no
  broker session, so the adaptive tier cannot be resolved for it".

So the honest mapping is the one that already exists, and the export path must
not invent a second one. Three rules:

1. **One profile per call for a clip.** `profiles` stays `min(1)`, but a clip
   subject carries exactly one — because a two-twin create is two jobs of which
   only the first id is returned (§ 6.3), and on a battery camera two jobs are
   two fetches and a second wake (§ 5.2).
2. **The picker offers only the twins the row HAS.** `Clip.streams.{sub,main}`
   is resolved at LISTING time precisely so "a quality change never re-searches
   the camera" (D549 15), so the surface knows before it asks. A clip with no
   main twin does not offer `high`.
3. **Asked and served are both on the record, and a divergence is SHOWN.**
   `ClipPlayback.served` already exists as the "say which twin you got" contract
   — *"a missing main twin is never served silently as if it were the asked-for
   quality"*. The export record inherits it: `subject.profile` is what was
   asked, the top-level `profile` is what was served, and the modal's twin row
   (§ 5.4.1) renders the difference when there is one.

Rule 3 is not theoretical and it is not common — which is exactly the shape a
silent fallback hides best. Measured on 592, day 19: **529 of 546 clips had a
main twin**, so 17 did not. A fallback that said nothing would be right 96.9 % of
the time and would quietly hand the operator the worst copy the camera holds on
the other 3.1 %, of footage he is deliberately keeping — the same failure
`EXPORT_SELECTION_PROFILE`'s docblock guards against on the recording side
("exporting *what I was looking at* would silently produce the worst copy the
hub holds").

**Rule 3 is already built.** `ClipPanel.tsx` renders the same three-value picker
and, when the answer's `served` differs from the asked profile, the sentence
*"Served the **sub** stream — this clip has no low twin."* The export record does
not invent this contract; it persists what that panel already shows, so a row
read a week later says the same thing the panel said at the moment of the tap.

#### 5.4.3 How a clip export is STARTED — there is no time range to pick

Operator, 2026-09-20: *"nel modal non si seleziona start e end ma si seleziona il
segmento, o da fuori e quindi senza selezione, o all'interno facciamo mostrare un
carosello di slides con i segmenti disponibili dalle clips."* [In the modal you
do not select start and end, you select the segment, either from outside and
therefore without a selection, or inside we show a carousel of slides with the
segments available from the clips.]

A clip export never asks for a range. `NewExportModal`'s two `datetime-local`
inputs and the viewer's drag-on-the-timeline are both **absent** from this path:
the camera chose the boundaries, and the only thing the operator picks is *which
segment*. Two entry paths:

| | Entry | What the modal must resolve | Carousel? |
| --- | --- | --- | --- |
| **1** | **From outside** — the operator clicked a clip (a `ClipTile` in the Clips section today; a tile in the viewer later) | nothing: `deviceId` and the `Clip` are both in hand | **no** — confirm and create |
| **2** | **From inside** — the modal opened with no clip | a camera, a day, and a segment | **yes** |

Path 1 is the common one and it is the cheap one: no query, no day, no state.
The modal opens on a chosen segment and shows the twin picker (§ 5.4.2), the
inherited retention (§ 5.3), and a Create button. Path 2 is the one that needs a
lister.

##### The carousel is the existing tile row in a different layout

It can be, and the reason is that `ClipsBrowser.tsx` is **already** split into a
pure decision and a rendering. Of its 216 lines, the part that decides anything
is about sixty:

| Piece | What it is | Reusable in a strip? |
| --- | --- | --- |
| `useCapabilityPresence('videoclips')` | the four-state presence gate (D315) — `pending \| present \| absent \| unknown` | **verbatim** |
| `dayWindow` / `toDayId` / `shiftDay` / `formatDayLabel` | local-wall-clock day arithmetic, DST-safe, pinned by spec | **verbatim** |
| `useVideoclipsListSources` + `useVideoclipsListClips` | the two hooks, one day window, `limit: 500` | **verbatim** |
| `resolveClipsView(...)` | **pure**, returns `loading \| failed \| empty \| listed`, each carrying its `answered` and `silent` notices | **verbatim** |
| `describeSource` / `formatCatalogAge` | a source's verbatim refusal and its catalog age | **verbatim** |
| `ClipSilentSources` | the compact amber block naming every source that contributed nothing, reason verbatim | **verbatim** |
| `ClipTile` | vouched → mint → glyph-with-reason ladder, the latched 204 refusal, `playable:false` with its reason | **verbatim except its shape** |
| `ClipSourceRow` tick-box list | the full source list with availability and age | **does not fit a strip** |

So the answer is: **do not write a second lister — extract the sixty lines.** A
`useClipsView({ deviceId, dayId, hidden })` returning `{ presence, view,
sourceRows, window }`, with `ClipsBrowser` (grid) and the carousel (strip) as two
renderings of ONE answer. That removes the divergence structurally rather than by
discipline: there is one `resolveClipsView` path, one presence gate, one day
window, so a strip cannot show "no clips" on a day the grid shows `index-empty`.
Writing a parallel lister is what produces exactly that defect, and this surface
exists because that defect shipped.

Two things the strip genuinely cannot carry, and what it does instead:

- **The tick-box source list.** `ClipSourceRow` is a `<li>` per source with a
  checkbox, a headline, a detail line and a catalog age; a horizontal strip has
  no room for it. The carousel therefore has **no view filter** — which is
  acceptable precisely because the filter persists nothing (it is the cap's own
  `sources` argument, and D557 records why it cannot be the persisted authority).
  What it must NOT drop is the *information*: `view.answered` already carries the
  labels of the sources that contributed, so the strip names them in one line
  above it.
- **`ClipTile`'s shape.** The tile is layout-agnostic in every way that matters —
  the media ladder, the latch, the labels, the `playable:false` line — but it is
  a `<li>` laid out as a horizontal row (`flex w-full gap-3`, a 16×28 thumb on
  the left, text on the right). A slide wants the thumb on top. That is a
  className decision, not a second component: the tile takes a layout prop, or
  the strip's `<ul>` supplies the axis. Either way the media ladder is not
  re-derived.

##### What the carousel shows when a source cannot answer

This is the entry path where an empty strip is most dangerous — the operator has
no clip in hand, so "nothing to show" and "we could not look" are
indistinguishable unless the surface says which. `resolveClipsView` already
distinguishes them and the strip renders its four states as text, above or
instead of the slides — never as a blank rail:

| State | The strip renders |
| --- | --- |
| `loading` | *"Loading clips for Sat, 20 Sep 2026…"* — never an empty rail, which would be a claim the data does not support |
| `failed` | the read's own message. Not an answer, so not "empty" |
| `empty`, `nobodyAnswered: true` | *"No source could answer for Sat, 20 Sep 2026."* plus `ClipSilentSources` with each refusal verbatim — this is the 640 `no-storage` case and the 618 `index-empty` case |
| `empty`, `nobodyAnswered: false` | *"No clips on Sat, 20 Sep 2026 from SD card, Home Hub."* — the day AND who answered, plus `ClipSilentSources` for the rest |
| `listed` | `ClipSilentSources` **above** the slides, then the slides. One unreachable source never empties the others (the dispatcher's rule 2) |

`ClipSilentSources` is already a compact block and is already rendered above the
list in the grid, so the strip inherits it unchanged. **The Create button is
disabled in every state but `listed`** — and disabled with the reason beside it,
not disabled blankly.

##### Where the segments come from: the modal needs a device, and says so

`listClips` requires a `deviceId` and a window; **an export modal opened from the
Library has neither.** So, from the code rather than from preference:

- **Entry path 2 is only reachable from a context that has a camera, or that
  asks for one first.** Two such contexts already exist. The Clips section is
  per-device by construction (`ClipsBrowser({ deviceId })`, mounted as a
  device-config widget, D14), so a modal opened there always has the camera.
  And the admin `NewExportModal` **already has a camera select** — it renders
  `useDeviceManagerListAll({ isCamera: true, projection: 'slim' })` and requires a
  pick before Create. A clip export opened without a camera reuses that select;
  it does not need a new one, and it must not guess.
- **The day defaults to today and navigates by day**, reusing `toDayId(new Date())`
  and the `‹ / Today / ›` controls `ClipsBrowser` already has. Never a multi-day
  window, and the reason is measured: one child's events for ONE day is 267 ms
  and for 20 days is 3.6–5.4 s; 592's day 20 lists 171 clips in 712 ms and a busy
  day 546 clips in 2.0 s. A carousel that silently widened the window would turn
  a modal into a multi-second fetch.
- **The day label is rendered in every state, not only the populated one** —
  `formatDayLabel` exists for exactly that reason: *"no clips with no date beside
  it is the ambiguity this surface exists to remove"*.

##### `fromMs` / `toMs` on the record: always the camera's boundaries

They stay the projection the Library sorts and labels on (§ 2.2), and for a clip
they are **always** `clip.timeRange.startMs` / `endMs` — never an operator's
drag, because there is no drag on this path. The record's docblock must say that
in those words. A future reader who knows the recording export will otherwise
assume `fromMs`/`toMs` mean "what was asked for", and for a clip they mean "what
the camera happened to record"; the two are the same TYPE and different FACTS,
which is the shape this repo keeps getting wrong (D385's two authorities, D224's
second copy).

##### `ExportSelectionRange` and the hole warning do NOT apply — do not wire them in

`camstack/src/recording/export-selection.ts` and `use-export-selection.ts` are
the timeline path and stay there. Three reasons, so nobody adds them for
symmetry:

1. **There is no drag to order.** The module's first trap — *"the drag runs in
   EITHER direction… `{fromMs: anchor, toMs: current}` would hand the hub a
   negative interval half the time"* — is a fact about a gesture that does not
   exist here. `resolveExportSelection`, `MIN_EXPORT_SELECTION_MS` and the
   live-edge clamp all have nothing to normalise: the boundaries arrive ordered,
   from the camera.
2. **A native clip cannot cross a hole — it is a file.** The coverage question
   the confirm asks is answered against OUR recording index, and a native clip is
   not in it, so `SelectionCoverage` would be `unknown` for every clip. Per that
   module's own rule `unknown` must not block, so the confirm would never fire —
   a dialogue wired in for symmetry that is dead in every case is worse than
   none, because it reads as a guard somebody is relying on.
3. **An ANALYTICS-source clip is a different animal, and the recorder already
   handles its gaps.** `Clip.holes` is real for that source — a visit is a window
   over our own footage and may span GOP rolls. But the boundaries were chosen by
   the analytics producer, not the operator, so asking him to approve a hole he
   did not draw is noise. The right dispatch is the one `getClipPlayback` already
   uses: **branch on the source namespace.** A clip whose source is the analytics
   one is a footage export with boundaries it did not choose, and goes down the
   recorder's existing render path — where the source playlist concatenates the
   segments and `export-dense-map` translates wall clock to stream time, which is
   the machinery that handles holes properly. Only a NATIVE source takes the
   by-handle fetch of § 3. One record, one subject, two producers, chosen by the
   namespace — never by a flag the caller sets.

### 5.5 Auth — can a viewer create and collect an export today?

**Yes, today, with no change.** Checked method by method:

| Method | auth |
| --- | --- |
| `videoclips.listClips` / `listSources` / `getClipPlayback` | `protected` |
| `recordingExport.createExport` / `listExports` / `getExport` / `cancelExport` / `deleteExport` / `getDownloadUrl` / `readExportBytes` | `protected` |
| `deviceManager.runDeviceAction` (the wake gesture) | `protectedProcedure` |
| the recorder's `exports` data plane | `access:'authenticated'` (cookie or Bearer; no token in the URL) |
| the reolink `clip` / `clip-thumb` planes | `access:'authenticated'`, no token in the URL (D549 22) |

Nothing on this path is admin-gated. Two caveats that become sharper once a
viewer can create exports with one tap:

- **`createdBy` is a constant** — now a defect in its own right, see § 6.7. It was
  tolerable while an export only spent CPU. The operator has made a wake part of
  the normal path, and an action that wakes a camera with no attributable
  requester is not auditable.
- **`listExports` has no per-principal scoping.** Every `protected` session sees
  every export ever created, on every camera. Same today; higher volume tomorrow.

## 6. What is already broken or unimplemented, and will bite whoever builds this

Found while reading. All pre-existing; none introduced by this design.

### 6.1 The viewer turns an unknown `ExportState` into `failed`

`camstack/src/data/use-exports.ts`:

```ts
function toState(v: unknown): ExportState {
  return typeof v === 'string' && EXPORT_STATES.has(v) ? (v as ExportState) : 'failed'
}
```

The viewer mirrors the record shape by hand rather than importing `z.infer`, and
its `EXPORT_STATES` set is a local copy of the six members. **Adding a seventh
member to `ExportStateSchema` makes every already-installed viewer render a live
export as FAILED.** Adding a *field* is safe (it is ignored). So:

- `ExportRecord.subject` — safe, additive, ship server-side whenever.
- a `'fetching'` state — **not** safe. Either do not add it (use `rendering` with
  a `null` progress and let `subject.kind` tell the surface what "rendering"
  means for a clip — recommended), or ship the viewer first and accept the skew
  window. The same trap applies to any future state.

This is worth a guard: a test in `packages/types` that pins `ExportStateSchema`'s
members against a literal list, with a comment pointing at the viewer's copy.

### 6.2 `getDownloadUrl` checks nothing

`recording-export-provider.ts` `getDownloadUrl` calls `requireRecord` and then
returns a formatted URL — for a `queued`, `rendering`, `failed`, `expired` or
`deleted` export alike. The download route then answers 404 (`rec.state !== 'ready'`).
`readExportBytes` is the only method that refuses with a reason. The viewer papers
over it by treating a 404 as "unavailable". It will bite harder with clips, where
`failed` carries an operator-meaningful reason (`sleeping`, `camera-refused`)
that a bare 404 throws away.

### 6.3 A multi-profile `createExport` returns only the first record

The loop creates one job per profile and returns `first`. A caller asking for both
twins of a clip (`sub` and `main`) would get one id back and lose the other. For
clips, **ask for one profile per call** and make that explicit in the subject, or
change the return shape. Note also that this line is a **cast**
(`return first as ExportRecord`), which the repo's own type rule forbids; the
non-null is guaranteed by the `profiles.length < 1` guard above it and should be
expressed structurally.

### 6.4 `listExports` is unpaged whole-history

The provider returns every row (optionally filtered by device); the viewer's own
comment says *"`listExports` answers with the whole history"* and only the
artifact half of the merged gallery is paged. Timeline selections are rare; a
one-tap clip button is not. The store is now one row per export (`RowMapStore`,
after the 201 KB blob rewrite-per-second incident of 2026-08-14), so the write
side is fine — the LIST is the risk, and D447 is the record about a scheduled
aggregate on `hub/sqlite-settings` holding a synchronous thread. Paging
`listExports` is a prerequisite slice if clip exports become common.

### 6.5 The whole subsystem refuses without the `artifacts` location

`exportsDirOrThrow()` throws by design (D341) when the artifacts storage location
is unresolved, and the download handler answers 503. Correct — but it means the
clip **download** acquires a dependency the clip **playback** does not have, and
the surface must say "exports are unavailable on this hub", not "this clip
failed".

### 6.6 There is no export-subsystem default lifetime

`maxLifeMs` and `deleteAfterDownload` are required fields with no default
anywhere on the server; the seven days exist as two unrelated client constants
that happen to agree (§ 5.3). Nothing checks that they still agree. The operator's
instruction — *a clip export inherits the subsystem default* — has no single
place to inherit from, and a third caller makes a third copy.

### 6.7 `createdBy` is the literal string `'operator'`, and a wake has no requester

`recorder/addon/index.ts`:

```ts
// No per-call caller identity reaches a cap provider (methods receive only
// `input`), so the audit field records the addon principal.
createdBy: () => 'operator',
```

Every row in the export history — the operator's timeline selection, the admin
modal, the scheduled timelapse — is attributed to the same six characters. The
comment is accurate about the cause: a cap provider is handed `input` and nothing
else, so there is no principal to record.

This was a wart. It stops being one now that a clip export **wakes a camera** on
request (§ 5.2): the one action in this feature that spends a battery is
untraceable to a person, and (§ 5.4.1) the field is not even rendered in the
modal, so nobody would notice. Two exports that woke a camera four times overnight
would be indistinguishable from the timelapse scheduler's work.

What it would take, in increasing order of reach:

1. **Carry the principal in the input.** A `requestedBy` on `CreateExportInput`,
   filled by the tRPC layer from the session — rejected on sight: an input field
   the client sets is a claim, not an identity, and the provider cannot tell the
   difference.
2. **Carry it out-of-band, like `nodeId`.** `CreateExportInputSchema` is already
   `.loose()` so the generated routers can pass `nodeId` past the schema. The
   same seam could carry a principal stamped by the ROUTER (which has `ctx`)
   rather than by the client. That is the smallest honest change, and it is
   one-method-wide — it does not fix the class.
3. **Give cap providers a caller context.** The class fix, and much the largest:
   every `method(...)` invocation would need a second argument, which is a
   codegen-wide change to `capability-definition.ts` and every generated router.

**Do not fix it here.** It is named so the wake slice can decide whether (2) is a
precondition for shipping a camera-waking export, and so the next person does not
rediscover it from an audit that cannot answer "who woke 640 at 03:14".

### 6.8 Export telemetry is an untyped event category

`emitExportEvent` notes the export categories are *"telemetry, not in the typed
catalog"*, and the viewer's `useExportEvents` reads `exportId` **or** `id` from
the payload because the producers disagree. Any clip-export event should pick one
key and, better, join the typed catalog.

## 7. Slices

Ordered so each one ships something observable, and so the viewer never depends
on a wire shape it cannot parse.

| # | What ships | Where | Proven by |
| --- | --- | --- | --- |
| **1** | `ExportSubject` on the cap: `createExport` accepts the discriminated subject, `ExportRecord` carries it, the legacy flat input is rewritten to `kind:'footage'`, codegen run. Behaviour unchanged for every existing caller. | `packages/types`, `npm run codegen` | a test that pins the legacy rewrite, and one that pins `ExportStateSchema`'s six members (§ 6.1) |
| **2** | A by-handle clip byte read on `videoclips` (bounded, named refusal above the bound), served by the Reolink provider from the scratch it already has. **Cap file currently owned by another agent — sequence with them.** | `packages/types`, `packages/addon-provider-reolink` | the bound proven by removing it; a refusal for a sleeping standalone camera proven before any `getApi()` |
| **3** | The recorder's clip branch: `createExport` with `kind:'clip'` validates against `videoclips.listClips` instead of the recording index, fetches once by handle into `<artifacts>/<deviceId>/exports/<id>.mp4`, honest progress (§ 5.1), named `error` per failure branch, the existing janitor and download plane unchanged. | `packages/addon-pipeline/src/recorder/addon` | a fake provider that REFUSES, that returns short bytes, and that exceeds the bound — three distinct `error` strings |
| **4** | The wake, now on the normal path: `wake:'authorised'` on the subject, refused below 15 %, stamping the shared cooldown, never set by a scheduler; one request = one wake (no automatic retry, no re-wake of a stale queued job); the refusal reason reaching the surface. Decide here whether § 6.7 (2) — a router-stamped principal — is a precondition. | `packages/addon-provider-reolink` + the cap | a test that a subject WITHOUT the flag never reaches `getApi()` on a sleeping standalone camera; a test that a failed clip export does not re-wake on its own |
| **5** | **The modal, shown** (§ 5.4.1): two rows adapted (`kind` → source label, `variant` → twin), one relabelled (`range`), five untouched; the twin picker offering only the twins on the row and showing asked-vs-served (§ 5.4.2); `options.title` set at creation. No new component. | `camstack/src/components/artifacts` + `src/data/export-format.ts` | unit tests on the pure formatters (already framework-free), including a served≠asked row and a clip with no main twin |
| **6** | **The modal, started** (§ 5.4.3) — entry path 1 only: opened FROM a chosen clip, no selection step, no query, no day. This is the operator's common case and it ships without the carousel. | admin `ClipPanel`, later the viewer | a test that no range control is rendered and that `fromMs`/`toMs` come from `clip.timeRange` |
| **7** | **The carousel** (§ 5.4.3, entry path 2) — and the refactor that makes it honest: extract `useClipsView` out of `ClipsBrowser` so the grid and the strip are two renderings of ONE `resolveClipsView`. Camera from the existing `NewExportModal` select when absent; day defaults to today with the existing day nav; all four states rendered as text; Create disabled with a reason in every state but `listed`. | `packages/ui-library/src/composites/clips` (owned by another agent today) | a test that the strip and the grid answer identically for `index-empty`, `no-storage` and `sleeping` — the divergence this refactor exists to prevent |
| **8** | The admin UI "Save to Library" beside the existing `ClipPanel` download. (Proving ground first — design § 7b: *"Quando sono provate andiamo invece su Viewer"* [Once they are proven we go to the Viewer instead].) | `packages/ui-library` | on a real camera, both mains and battery |
| **9** | The viewer button near the tile → `createExport`, and the row appearing in the existing Library with no new gallery source. Reuses `useMediaDownload` and `ExportDetailModal` verbatim. | `camstack/src` | a mount test driving create → poll → `getDownloadUrl` → `download()` |
| **10** | The debts: page `listExports`; give `getDownloadUrl` a state check; a single owned `DEFAULT_EXPORT_LIFE_MS` beside the schema (§ 6.6); a real principal for `createdBy` (§ 6.7); a chunked by-handle read so a `high` twin is never refusable on size. | across | each independently |

Slices 1–4 are the feature. 5–6 are the modal, shown and started, and **6 ships
the operator's common case without 7** — the carousel is a separate slice
precisely because it carries a refactor and should not hold up a confirm-and-
create dialogue. 8–9 are the button, in the order § 7b already fixed (admin
proves it, then the viewer). 10 is the honest remainder.

**Slice 7 is the one to refuse to shortcut.** A carousel written as its own
lister is a second answer to "what does this camera hold today", and the first
time the two disagree it will be on the exact states this line of work exists to
tell apart (108's `index-empty`, 106's `no-storage`, a sleeping battery camera).
The refactor is ~60 lines moving out of a 216-line component; writing the
parallel lister is less work today and is the defect.

**`wake:'next-natural'` is not in this list.** It was slice 7 of the first draft
and the operator declined it — see § 5.2 "Considered and not taken".

## 8. The three questions, and the operator's answers

Asked and answered the same day, 2026-09-20. All three collapse into one
principle — **reuse the export surface that exists, adapted, rather than
designing a clip-specific one** — which is why they are recorded together.

| Asked | Answered |
| --- | --- |
| `deleteAfterDownload` / lifetime default for a clip export? | *"Vedi prima, per gli export già mostriamo cosa abbiamo, si deve adattare per le clips."* [Look at what exists first: for exports we already show what we have, it must adapt to clips.] **Inherit.** No bespoke clip policy. § 5.3 — and the inheritance has no single owner, § 6.6 |
| One profile or both twins per tap? | *"Mostriamo lo stesso modal per l'export ma con i soli dati per una clip."* [Let us show the same modal for the export but with only the data for a clip.] **The existing profile selector**, mapped `low\|mid → sub`, `high → main`, one per call, asked-vs-served shown. § 5.4.2 |
| `wake:'next-natural'`, or "wake now or refuse"? | *"Quando un export viene richiesto si sveglia la camera."* [When an export is requested the camera is woken up.] **Wake now.** `next-natural` dropped — recorded as considered-and-not-taken in § 5.2 so it is not re-proposed |
| (not asked — the operator specified it) How an export is STARTED | *"nel modal non si seleziona start e end ma si seleziona il segmento, o da fuori e quindi senza selezione, o all'interno facciamo mostrare un carosello di slides."* [In the modal you do not select start and end, you select the segment, either from outside and therefore without a selection, or inside we show a carousel of slides.] **No range control at all**, two entry paths, and the carousel is the existing tile in a strip. § 5.4.3 |

Nothing in §§ 1–4 changed as a result; the analysis stands. What changed is
§ 2.2 (no range in a clip subject; two producers chosen by namespace), § 5.2
(one mode, not two), § 5.3 (inherit, and what inheriting reveals), § 5.4 (the
modal field by field, the twin picker, and how an export is started), § 6.6/
§ 6.7 (two findings promoted to defects) and § 7 (the slice list loses
`next-natural`, gains the modal shown, the modal started, and the carousel).

One thing did NOT change and must not be quietly relaxed: **`ExportStateSchema`
keeps its six members** (§ 6.1). A seventh renders every live export as `failed`
on every installed viewer, and now that the same modal serves both kinds of
export, it would do so for clips and recordings alike.
