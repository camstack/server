---
id: D555
title: A source that cannot answer is a LISTED source that says so — ONE Reolink source that picks its own API and REPORTS which, a row that names its serving addon, and a per-device switch keyed by SOURCE
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/reolink-videoclips-provider.ts
  - packages/addon-provider-reolink/src/clips/clip-event-catalog.ts
  - packages/system/src/builtins/device-manager/device-source-activation.ts
  - packages/system/src/builtins/device-manager/device-meta-types.ts
  - server/backend/src/api/trpc/device-collection-dispatch.ts
  - scripts/check-device-selection-authority.ts
  - packages/addon-provider-reolink/src/clips/clip-addressing.ts
  - packages/addon-provider-reolink/src/clips/clip-service.ts
  - packages/addon-provider-reolink/src/clips/clip-catalog.ts
  - packages/addon-provider-reolink/src/clips/clip-mux.ts
  - packages/types/src/capabilities/videoclips.cap.ts
---

## Context

[D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
settled the whole external-clip line, and
[D554](adr-0554-a-per-device-wrapper-that-becomes-a-collection-stays-per-device-and-its-sources-are-fanned-out-not-picked.md)
settled the router. Slices 2, 3 and 5 — the Reolink provider, its thumbnails
and its playback — then hit four things neither record could have known,
because each is a fact about the pinned LIBRARY or about a schema that had
already been written:

1. **The hub EVENTS view had no library method, and then it did.** D549
   decision 19 makes that view the catalog on a hub child — measured faster
   (29 events in 293 ms against 20 files in 503 ms) and the only class source
   there, since a hub child's files carry `recordType none`.
   `@apocaliss92/nodelink-js@0.7.8` named 516/517/518 in its constants and read
   them nowhere, so the source shipped as a LISTED row saying exactly that.
   **0.7.9 published `searchEventLog` and `searchAlarmVideos` the same day**
   and the row became real. The rule this record states is the one that
   survived the change, and it is the reason the switch cost one branch: the
   source was never hidden, so there was nothing to un-hide.

2. **`index-empty` had nowhere to live on the wire.** D549 decision 18 says
   618's dead days are reported "as a per-day `unavailable` with reason
   `index-empty`, never as no clips". `ClipSourceAvailabilitySchema.state` is
   per SOURCE and its four values are `ok | sleeping | unreachable |
   no-storage`. There is no per-day availability anywhere in the cap, and
   inventing one would put a calendar in a schema whose whole job is to say
   whether a source can answer.

3. **The library's demuxer returns Annex-B VIDEO only.** D549 decision 6 asks
   for a mux of "video AND audio". `downloadRecordingDemuxed` counts the audio
   packets (`stats.audioPackets`) and returns none of them; `downloadRecording`
   returns the raw BcMedia frames, which ffmpeg cannot parse. There is no 0.7.8
   call that yields the audio.

4. **The per-device source switch was keyed by ADDON, and this addon serves
   TWO of a hub child's sources.** [D556](adr-0556-a-per-device-source-switch-is-the-wrapper-activation-and-the-registry-holds-only-its-projection.md)
   made the persisted wrapper activation the one authority and keyed its deny
   set by addon id — correct when every provider served exactly one source.
   `addon-provider-reolink` answers a hub child with `native:reolink:onboard`
   AND `native:reolink:hub`, so ticking one off against that key would turn
   both off while the label said one. [D557](adr-0557-a-clip-source-picker-filters-the-view-because-the-persisted-authority-is-keyed-by-addon-not-by-source.md)
   measured the mismatch, refused to ship the mislabelled switch, and shipped
   the picker as a view filter that persists nothing — naming the unblock as
   one additive field plus a re-key. `ClipSourceSchema` also carried no
   `addonId`, so the surface could not even resolve a row to who answers it.

5. **`onboard` and `hub` were never two stores.** D549 decision 11 made a hub
   child expose TWO sources side by side, at the operator's explicit request,
   on the stated premise that they might hold DIFFERENT sets — the record even
   says the measurement "informs the default filter and the labels, never
   whether there are two sources". Implementing them disproved the premise,
   with our own numbers: the hub's uid addresses **no catalog at all** (empty
   month over 24 months, zero files, zero rows) while the child's uid
   addresses all of it; cmd 5 returns **identical bytes** under either; and on
   3628 the two views cover each other — 29 events, **28 inside the 20 listed
   files**, and all 20 files carrying an event. Two VIEWS of one store. Told
   that, the operator collapsed them the same day: *"Per le reolink mi sembrava
   avessi specificato che la lista è la stessa. Il provider rimane solo uno,
   onboard, e si utilizza la migliore API disponibile secondo l'analisi."* [For Reolink I thought you had specified that the list is the same. The provider remains only one, onboard, and the best available API is used according to the analysis.]

6. **`ClipPlayback.served` is a `CamProfile`, and a clip has two files, not
   three.** D549 decision 15 maps `low | mid` → the sub file and `high` → the
   main twin. So `served` can answer three values and the catalog holds two
   things; which value a sub file reports was never stated.

**Measured on the HUB (639 → children 3628 / 3629 / 3825), read-only, one
session closed at the end, no child logged into.** The events view running
through this provider's own modules:

- **`hasRecFile` is not uniformly false — it is uniformly TRUE on the children
  that can be addressed.** 3628: 222 rows / 20 days, **0** orphans. 3629:
  1 059 rows / 20 days, **0** orphans. Fleet: **0 of 1 281**. The coordinator
  relayed 515 of 1 886 (27 %); the reconciliation is the third child. **3825
  has NO persisted uid** (`config.uid` absent, as design § 1b already noted),
  and § 1b measured it at "17 rows, 0 with clip". So the orphans are
  concentrated on the one child this provider currently answers `uid-missing`
  for. The rate is a per-camera fact, not a fleet constant, and a surface that
  assumed either extreme would be wrong on some camera.
- **The join holds.** 3628, 2026-09-09: 38 events in 267 ms, 28 files in
  717 ms, **38/38 resolved to a file** by window containment, 1–13 events per
  file. Classes on the event rows where the file rows carry none:
  `people 129 / md 75 / dog_cat 18` over 20 days.
- **`chnbits` is inert, and `devices` is not optional.** `chnbits: 3` answered
  the same 9 rows as the default; omitting `devices` is REFUSED by the library
  ("no devices to search"), not answered emptily — stronger than "inert", and
  the provider always passes `devices`. With one child named, foreign rows in
  the reply: 0.
- **`searchAlarmVideos`'s `streamType` did NOT select a file set here.**
  `0` → 39 windows, `1` → 37, and **both returned the same 28 file names**
  (`0120260909093129`). That matches design § 10's "unsettled" reading (same
  167 names either way, 90 differing rows) and not the "0 = main names, 1 =
  sub names" the coordinator relayed. Recorded as still unsettled. **SETTLED 2026-09-20 the
  other way (D565): it DOES select the file set, and the two sets simply
  overlap heavily on a hub child.** Measured by comparing each name's 14-digit
  tail against the files' own start stamps: on 592/09-19, `streamType 0` →
  539 names of which **539 are MAIN starts** and 205 sub; `streamType 1` →
  539 names of which **539 are SUB starts** and 205 main. On 3628/09-16 the
  same split is 20-of-22 main against 20-of-21 sub. Comparing the name SETS,
  as this record did, cannot see that; comparing them to the files can.
- **The one-local-day clamp is real**: a two-day ask answered 39 windows all
  dated the start day. The library clamps and says so; the caller owns the
  iteration.
- **A hub CoverPreview through the child's uid**: 62 869 B in 917 ms.
- Timing for the window default: one child, 1 day → **267 ms**; 20 days →
  **3.6–5.4 s** per child. A day-range default is a UI decision with a number
  behind it.

**Measured while deciding, read-only, on 592 (E1 Outdoor PoE, mains, SD card),
2026-09-20, through one session closed at the end.** The catalog path of slice
2 running against the real camera: calendar 18 days in 1.86 s; 2026-09-20 →
**209 clips in 6.0 s**; 2026-09-19 → **546 clips in 4.3 s with 529 main twins
paired**; classes `people` → `person`, `md` → the `motion` kind and no class;
main ≈ 30× the sub (20.0 MB against 0.67 MB); two CoverPreview→JPEG mints of
31 035 B in 423 ms and 30 243 B in 376 ms. Two failures that matter more than
the successes: the FIRST command after login raced the socket
(`getHddInfoList` → "Baichuan socket closed") and the main-stream search for
the 20th failed the same way. Both were survived — the storage read answered
`unknown` rather than `absent` and the day still listed; the day still listed
209 sub rows with no twins and named the refusal — which is the D393 rule
("a measurement that FAILED is `null`, never `0`") paying for itself on the
first live run.

## Decision

**A source this provider cannot read is LISTED, with the refusal verbatim in
its own row, and the reason names what is missing rather than what is broken.**
Never hidden (an operator who cannot see the row cannot ask why it is empty —
D554 decision 4), never silently served from the other view under its name
(two sources that are one source is the D62 defect the two-entry shape was
chosen to avoid), and never blocked on. That is how `native:reolink:hub`
shipped against 0.7.8 and why 0.7.9 cost one branch to adopt: the row already
existed and only its `availability` changed.

**And an EVENT is not a clip.** The hub view lists events; the file that backs
one is resolved by window containment against the day's `FileInfoList` rows,
and a row with no file is `playable: false` with a reason that distinguishes
the two causes — `no-rec-file` (the hub says none exists) from
`no-file-for-window` (it says one does and none of the day's files covers the
window). Both are LISTED. `getClipPlayback` refuses such an id in the row's own
words, without touching the hub, because the id says so itself.

Three corollaries, each a choice D549 did not make:

- **`index-empty` is a fifth `ClipSourceAvailability.state`**, set when the
  camera's own CALENDAR named days inside the window that its own INDEX listed
  no files for, with the days enumerated in `reason`. Per source, not per day:
  the honest claim is about whether this source's list may be read as complete,
  and it may not be. `ok` keeps meaning exactly what its doc says.
**SUPERSEDED in part 2026-09-20 by
[D565](adr-0565-the-file-list-is-the-clip-catalog-on-every-topology-and-the-class-is-joined-onto-it.md):
there is still ONE Reolink source per camera, and it no longer picks
anything.** `FileInfoList` is the catalog on every topology, so the reported
`via` had one value and the field is gone. The rule below — that a choice made
invisible must be paid for by being reported — is unchanged and is why the
choice was cheap to remove: `via` had said, on every listing line, exactly
which path was about to be deleted. What follows is the reasoning as it stood.

**There is ONE Reolink source per camera, and it picks the best API for what
the camera IS.** `native:reolink:onboard`: a hub child reads the parent's
event log (`searchEventLog` — 38 rows in 267 ms, classed, where that same
camera's own files carry no class at all), a standalone reads its own file
list (`FileInfoList` + `recordType`, because a standalone answers
`findEventLog` with an empty body). The choice is the provider's, derived from
the device and from nothing else, and is never a row the operator has to
understand.

**But it is REPORTED**, on `ClipSource.via` and on the listing log line with
`tags: { deviceId }`. A source that silently reads a different API on two
cameras and then behaves differently is the thing nobody can debug later, and
this is the whole cost of making the choice invisible — so it is paid.

**The chosen view is the catalog, and it does not fall back.** If the event
log refuses, the source is `unreachable` with the refusal verbatim; it does
not quietly serve the file list instead, which would hand the operator a
differently-shaped list indistinguishable from the real one.

**Collapsing the sources does not collapse a disagreement.** The views cover
each other on the measured day, not perfectly: one event of 29 sat inside no
file. That row still lists, `playable: false`, `no-file-for-window` — and the
two unplayable reasons stay distinguished.

**And the per-device source switch is keyed by SOURCE.** A source row now
names the addon that serves it (`ClipSource.addonId`, stamped by the
collection dispatcher from the registry, so the row carries a fact and not a
provider's claim), and `setWrapperActive` takes an optional `sourceId`. The
deny set is `DeviceCapBinding.disabledSourceIds`, a set of SOURCE ids.
Everything D556 decided is kept unchanged: it is still a DENY set so a source
nobody ruled out is a source; it is still mirrored onto the registry on write
AND replayed at boot; the device's own native provider is still asked
separately because it is not in the registry's provider map.

**A pre-re-key entry keeps its meaning, by a READ rule and not a data
rewrite.** An id persisted before this change names an ADDON, and there is
exactly one thing it could have meant: every source that addon serves for that
camera. So the deny set is read as a union of the current and legacy fields,
and one predicate decides — an entry matches either a source's own id or the
id of the addon serving it. Nothing walks the fleet, nothing is migrated in
place, and an operator's existing decision cannot silently stop applying. New
writes are always source ids, and the legacy field is dropped on the first
write to that row because the union already folded it in.

**The per-source half applies on the ROW path.** `sourcesForDevice` drops
PROVIDERS and cannot express "the hub view off, the camera's own recordings
on" — one provider, two sources. Rows are where sources are actually named, so
the dispatcher filters them there, including on the single-provider fast path,
where a camera with no deny entry still gets its rows verbatim in the
provider's own order (D554 decision 6).

- **An events-view clip id carries the event WINDOW as well as the file.** A
  file holds 1–13 event windows, and both rows play the same bytes; without
  the window the two events of one recording would share an id, and a merge
  ordering on `(startMs, endMs, id)` or a surface keying on `id` would treat
  them as one row. The suffix is optional, so every `onboard` id keeps its
  exact shape.
- **The mux is still video-only, and the REASON has changed.** Re-checked
  against 0.7.9: `downloadRecordingDemuxed` still returns `annexB` video only.
  But 0.7.9 reaches the audio two ways — `getRecordingVideo` (muxes video and
  audio) and the exported `BcMediaAnnexBDecoder`, whose `onAudioFrame` hands
  over the raw frames. So this is no longer "the library returns no audio", it
  is "we have not wired the second input", and it is named as such.
  `getRecordingVideo` is deliberately NOT adopted: it emits
  `-movflags frag_keyframe+empty_moov+default_base_moof`, a fragmented MP4
  with no `moov` first and no known duration, which costs exactly the seek and
  the duration D549 22 and design § 6 say the one player needs. The shape of
  the fix is the decoder path — keep our one bounded ffmpeg and `+faststart`,
  add a second input (`-f aac`, or `-f s16le -ar 8000 -ac 1` for ADPCM) and
  `-c:a aac` — and it needs the per-camera audio codec measured first.
- **`served` is `low` for the sub file and `high` for the main twin.** A `mid`
  request is answered `low` — truthfully, because `mid` and `low` are the same
  file and the surface is owed the file it got, not the tier it asked for.

## Consequences

- § 7b's three cases are all MET at the provider layer: 592 standalone
  (209 clips / 6.0 s, 546 / 4.3 s with 529 twins, real thumbnails), a hub
  child's own files (28 files / 717 ms), and the same child's events view
  (38 events / 267 ms, classed, 38/38 joined, a 62 869 B thumbnail). What is
  NOT met is § 7b's actual bar, which is the operator seeing them in the admin
  section on the live cluster — that is slice 4's, and nothing here was
  deployed.
- **The picker can now persist, and it has one call**:
  `deviceManager.setWrapperActive({ deviceId, capName: 'videoclips',
  wrapperAddonId: <row.addonId>, sourceId: <row.source>, active })`. Omitting
  `sourceId` keeps D556's cap-wide meaning. D557's "this surface offers no
  persistent per-source switch at all" is lifted.
- **A switched-off source must still be visible to switch back on, and that is
  NOT answered by the collapse.** D556's contract drops a disabled source from
  `listSources`, so once the choice persists an unticked source has no row to
  un-tick — the picker survives today only because its deny set is
  client-side. With one Reolink source the picker is now the camera's PROVIDER
  choice ("show me the camera's own recordings, or only CamStack's"), which
  makes the hole more visible, not less: switch the camera's recordings off and
  the row that would switch them back on is gone. The answer is almost
  certainly that `listSources` keeps every source and MARKS the disabled ones —
  it is D554 decision 4's own rule ("a source that cannot answer produces a
  ROW, not an absence") and D557's own stated property ("a source is never
  hidden, only its rows"), and the dispatcher already has the deny set in hand
  where it finishes the rows. It changes D556's asserted semantics and its six
  tests, so it is a decision and not a refactor: named here, and slice 4 must
  settle it before wiring `onToggle`. **Settled the same day, exactly this way:
  D556 was AMENDED** (its "Amended 2026-09-20" section) — `listSources` keeps
  every source and marks the switched-off ones on `ClipSource.switchedOff`, a
  boolean beside the availability rather than a member of it, and the six tests
  moved with it.
- **D549 decision 11 is superseded by the operator's own later decision.** The
  earlier one was not wrong to make: two plainly separate entries was the safe
  shape while the sets were UNKNOWN, and the alternative on the table was an
  automatic best-source pick with a merge, which hides a producer. What
  changed is the evidence, and it came from building the thing. The record of
  the earlier choice stays, with its reason.
- **`no-storage`'s only live example is gone.** 640 was measured `mount 0` on
  the morning of 2026-09-20 and the operator fitted a card the same day. The
  state stays — a card-less camera must still be reported as storing nothing
  rather than as having no clips — but it is now proven in the suite and not
  on hardware (`docs/design/2026-09-20-external-videoclips.md` § 7b).
- **One row means one availability.** `no-storage`, `sleeping`, `index-empty`,
  `uid-missing` and `unreachable` all now belong to the one source, and
  `uid-missing` still names itself: 3825 is a hub child with no persisted uid
  and must not look like a camera with nothing.
- **A hub child with no persisted uid has no clips from either source.** 3825
  is that camera today. It answers `uid-missing` on both rows rather than
  "no recordings", which is the honest state, and healing the uid is a
  different piece of work (the hub's cmd 145 push is the second source D549
  § 1 names).
- A hub child's `onboard` rows carry no class: `recordType` is `none` on the
  hub (measured). `nativeTypes: ['none']`, no `labels` — honestly unlabelled,
  not motion. **The events view is where that camera's classes live**, which
  is D549 19's reason restated by the data: 222 rows on 3628 carried
  `people`/`md`/`dog_cat` while its own files carried nothing.
- **`searchAlarmVideos`'s file names are SHORT** (`01` + YYYYMMDD + HHMMSS —
  the `FileInfoList` `<name>`), while a byte handle is the full `<Id>` path.
  This provider does not use that surface, so the mismatch costs nothing
  today; the per-window label-upgrade slice must join on `<name>` and will
  need the catalog row to carry it. Stated here so that slice does not
  discover it by re-listing a camera.

  **Landed 2026-09-20, and the join is NOT on `<name>`** — see
  [D565](adr-0565-the-file-list-is-the-clip-catalog-on-every-topology-and-the-class-is-joined-onto-it.md).
  The library's `RecordingFile.fileName` is the full `<Id>` path, not the XML
  `<name>`, so a literal string join scores **0 of 539**. The 14-digit tail of
  the short form is the file's START in the camera's wall clock, and that is
  the key (`clip-alarm-labels.ts`). The catalog row did not need to carry the
  name after all; it needed the MAIN twin's start (`mainStartMs`).
- `ClipSourceAvailabilitySchema.state` gained a member. Every consumer that
  switches on it must have a default arm; slice 4's section is the only one
  today, and it is being written against this schema.
- A clip played at `high` on a camera whose main search failed that day gets
  the sub file and `served: 'low'`. The surface must say so — a missing twin
  served silently as the other is exactly what D549 15 forbids.
- The post-login race is real and is NOT worked around: `readStorageState`
  answers `unknown` and the listing proceeds. A retry there would be a second
  authority on "is there a card", and the cheap question is allowed to be
  unanswered — it is only allowed to be wrong in the direction that lists.

## Amendment, 2026-09-20 — the uid requirement is the HUB CHILD's, not every camera's

The first live run of the clips surface answered 592 — an E1 Outdoor PoE that
had listed 209 clips through this very provider an hour earlier — with
`state: 'unreachable', reason: 'uid-missing'`. The gate was unconditional, and
the topology says it must not be:

- **Standalone: the uid is ignored.** `getDayRecords` answered 592 the same 19
  days with the right uid, with a WRONG uid and with none at all (design § 1b,
  "cmd 142 needs the uid on the hub and ignores it on a standalone"), and
  nodelink-js resolves a standalone's own uid over cmd 114 for the commands
  that carry one. Nothing persists a uid for a standalone: 592's
  `deviceMeta.metadata` has none and never will. **That absence is not a
  second defect** — it is what a standalone looks like.
- **Hub child: the uid is what SELECTS the camera.** Channel 1 asked with
  channel 0's uid answers channel 0's days; the hub's own uid addresses no
  catalog at all. 3825 stays `uid-missing`, and everything this record says
  about it stands.

So the rule follows the topology and lives in exactly ONE place,
`packages/addon-provider-reolink/src/clips/clip-addressing.ts` (`uidIsRequired`
/ `uidIsMissing` / `UID_MISSING_REASON`), asked by all four gates that had
spelled it themselves: the file-list read, the event-log read, the
never-yet-read availability, and the thumbnail mint. `via: 'files'` was already
correct on 592 — the API choice was right and only the precondition in front of
it was wrong, which is the shape of this defect: the camera did not decline, we
did. This is D315's "not-yet-known must never look like not-installed" wearing
a vendor hat.

Enforced by `…/__tests__/reolink-videoclips-provider.spec.ts` ("a STANDALONE
with no persisted uid still lists", "…is OK before anything has been read") and
`…/__tests__/clip-uid-is-topological.spec.ts` (the mint). Proven red by making
`uidIsRequired` return `true` unconditionally: 3 fail.

## Enforcement

- `packages/addon-provider-reolink/src/__tests__/reolink-videoclips-provider.spec.ts`:
  a hub child lists TWO source rows; the `hub` row is `unreachable` and its
  reason names `findEventLog`; a window whose calendar days list nothing is
  `index-empty` with the day in the reason. Proven red by dropping the hub row
  (2 fail) and by folding `index-empty` into `ok` (1 fails).
- `…/__tests__/clip-catalog.spec.ts`: `mount 0` is `absent`, an unreadable
  disk is `unknown` WITH the camera's reason, and neither is the other. Proven
  red by treating an unread disk as absent.
- `…/__tests__/clip-mux.spec.ts`: `-movflags +faststart` is present and every
  input option precedes `-i`; an empty download is a failed attempt. Proven red
  by removing the flag (2 fail) and by accepting zero bytes (1 fails).
- The collapse, in the provider spec: exactly ONE source row on a hub child as
  well as a standalone; `via` is `events` on the one and `files` on the other;
  a hub child lists the events view INSTEAD of the files view; a standalone
  never calls `searchEventLog`; a refusing event log answers nothing and says
  why, rather than falling back. Proven red three ways — inverting the view
  choice (8 fail), adding a silent fallback (2 fail, including the one that is
  about it), and putting the second source back (2 fail).
- `…/__tests__/clip-event-catalog.spec.ts` (14) and the events block of the
  provider spec: `devices` is the selector and `chnbits` is never sent; ONE
  open for the whole window; a sibling child's row never becomes this
  camera's; `no-rec-file` and `no-file-for-window` are distinguished; an
  unplayable row is listed, offers no mint, and gets a key of its OWN; two
  events of one recording get two ids; the files view survives an event-log
  refusal and vice versa. Proven red by dropping the hub row and by folding
  the two unplayable reasons into one.
- The per-source activation spec **enforced nothing after this record was
  superseded and has been deleted with the machinery it covered.** It had gained
  the case the per-addon key could not express, end to end through the REAL
  registry and the REAL router: one addon serving two sources, one of them
  switched off, the other still answering; re-enabling one brings back only
  that one; the choice survives a registry rebuild through the replay; a
  MIGRATED addon-id entry still denies every source that addon serves; and the
  cap-wide verb (no `sourceId`) still means what D556 shipped. Proven red
  before the change — 4 of 12 failed, including "names the addon that serves
  each source row" (undefined) and "disables ONE … and leaves the other
  answering" (both gone).
- `scripts/check-device-selection-authority.ts` gains check 5: the dispatcher
  must read `getDeviceDisabledSources` on the row path. Checks 1–4 cannot see
  that deletion — the mutator, the mirror and the replay are all still in place
  — so without it a per-source toggle would persist and do nothing. Proven red
  by stubbing that read out; and the first draft of the check accepted
  `isDeviceSourceDisabled` too and stayed GREEN on exactly that mutation,
  because the provider-level call survives it. The arm is only worth having in
  its narrow form. D556's own arms re-proven red here as well (the mirror
  stubbed out; the boot replay renamed).
- Nothing checks that the events view is not quietly implemented from the files
  view — review only. The `source` constant is the one place the two names
  exist, and each clip id carries the source that minted it, which is what the
  analytics-provider spec's rule (the dispatch key and the id mint cannot
  drift) already asserts for the other provider.
