---
id: D572
title: A clip subject carries the PROVIDER and the catalog WINDOW and nothing the operator drew; the wake expires with the job; and a source that holds no file says so in the type
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/types/src/capabilities/recording-export.cap.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/types/src/capabilities/capability-definition.ts
  - packages/addon-pipeline/src/recorder/addon/export-clip-catalog.ts
  - packages/addon-pipeline/src/recorder/addon/export-engine.ts
  - packages/addon-pipeline/src/recorder/addon/export-reconcile.ts
  - packages/addon-pipeline/src/recorder/addon/recording-export-provider.ts
  - scripts/lib/parse-cap.ts
  - scripts/generate-cap-routers.ts
---

## Context

[D558](./adr-0558-a-native-clip-export-is-an-export-record-with-a-subject-and-the-bytes-are-pulled-by-handle-from-the-addon-that-owns-the-camera.md)
decided the shape of a clip export and left it unimplemented. Landing it
surfaced six questions the design could not have settled, five of them because
the clip surface moved underneath it on the same day (D554 amended, D565, D567,
D568, D570) and one because the framework turned out to be lying in a place
nobody had looked.

1. **The catalog check needs a window, and a clip subject has no time in it.**
   D558 says the fail-fast gate is `videoclips.listClips` — but that method
   takes `since`/`until`, and D554 amended made `provider` **required** the same
   day (a bare call on 592 answered six rows for `limit: 3`, the union of two
   sources). So the subject must name a provider, and something must name a
   window, while D558 is emphatic that the record's `fromMs`/`toMs` are the
   camera's own boundaries and never anything a caller supplied.

2. **`deviceId` in the subject, or at the top level?** D558 writes
   `{kind:'clip', deviceId, …}`. But `METHOD_DEVICE_SELECTORS` — generated —
   maps TOP-LEVEL fields and one-level object ARRAYS, never a nested object, and
   `scope-access.ts` is what reads it. A `deviceId` that lived only inside
   `subject` would be invisible to per-device scope enforcement, and this is the
   one export that can WAKE a camera.

3. **What `includeAudio` now means.** D558 says the Reolink mux is video-only so
   a clip export sets `false`. [D567](./adr-0567-a-clip-carries-the-sound-the-download-already-held-and-is-muxed-at-the-rate-it-was-delivered-at.md)
   landed audio the day after: an `adts` track is copied, `adpcm` and `unknown`
   are served silent and NAMED. Neither `true` nor `false` is now a true
   statement about a clip made before the fetch.

4. **`Clip.inProgress` exists.** [D567](./adr-0567-a-clip-carries-the-sound-the-download-already-held-and-is-muxed-at-the-rate-it-was-delivered-at.md)
   and [D570](./adr-0570-a-clip-plays-in-the-cameras-own-frame-and-the-playback-machine-is-structurally-detached-while-it-does.md):
   a growing file's `endMs` is a frozen guess — 592 reported the same `endTime`
   for eight minutes while the file went on growing — and D570 already refuses
   to LOOP such a clip for exactly that reason.

5. **"One request is one wake" has a third leg D558 named but nothing held.**
   `export-reconcile.ts` hands every interrupted row back to the engine at boot.
   That is right for a render; for a clip export holding an operator's
   authorisation it spends a yes hours later, at a camera he is no longer
   standing in front of.

6. **A cap method the codegen cannot see does not exist.** `videoclips` gains
   `readClipBytes`, and the recorder's own `analytics` source has no file behind
   its rows at all — making the method required buys a throwing stub from every
   source, and a throwing stub reads exactly like a method somebody forgot.
   Declaring it with a new factory (`optionalMethod()`) made it **vanish** from
   the generated DeviceProxy, SystemProxy and router map, silently:
   `scripts/lib/parse-cap.ts` finds methods with a source REGEX that named only
   `method` and `systemMethod`. The only symptom was a type error in a generated
   file three packages away.

## Decision

**A clip subject names the PROVIDER that serves it and the catalog WINDOW it
was picked from; those are the only two things a caller states, and neither is
a time range.** `provider` is the `addonId` the `listClips` pin requires;
`catalogWindow` is the one local day the surface was already listing
(`ClipsBrowser`'s `dayWindow`), and it says WHERE TO LOOK, never what to
export. The record's `fromMs`/`toMs` come from the catalog ROW that answers,
and a window that does not contain the clip is a `catalog-miss` — never a
silently wider search. A top-level `fromMs`/`toMs` alongside a clip subject is
**refused**, not ignored: there is no drag on this path and nothing to
normalise.

**`deviceId` stays REQUIRED at the top level of `createExport`, for both kinds,
and a clip subject naming a different one is refused.** The subject is still
the authority on WHAT; the top-level field is what per-device scope enforcement
can see, and it is not optional to keep it visible.

**A clip export refuses what a remux cannot honour, and claims nothing about
audio.** `options.speed !== 1` and `options.timelapse` are `unsupported-option`
refusals at creation — nothing on this path is re-timed, and a silently ignored
option is a claim the record carries for its whole life. `includeAudio` is
neither honoured nor contradicted: the delivered sound is whatever the
producer's mux could copy, the producer names what it did (D567), and the
surface does not render the variant row for a clip.

**A clip the source says is still being WRITTEN is refused by name
(`clip-in-progress`).** Its `endMs` is not its end, so the projection would be a
duration nobody knows on a durable row, and D568's completion rule — prove the
decoded duration against the catalog span — has nothing true to prove itself
against.

**Every clip-export failure is a TOKEN plus the producer's own words**
(`ClipExportFailureSchema`, composed by `clipExportFailure`, read back by
`clipExportFailureOf`): `catalog-miss`, `catalog-unreachable`,
`no-file-for-window`, `clip-in-progress`, `unsupported-option`, `sleeping`,
`camera-refused`, `fetch-failed`, `too-large-to-transfer`, `wake-expired`. A
producer that already speaks the vocabulary is BELIEVED; anything else is
`fetch-failed` with its words verbatim — a more specific token invented from
prose is how a surface came to render every refusal on this fleet as
`Refused: <prose>` (`ClipStillRefusalCode`'s own record).

**An authorised wake EXPIRES with the job it was granted for**
(`CLIP_WAKE_TTL_MS`, 5 min, against a job measured at 4–6 s end to end). Past
it the export fails `wake-expired` instead of reaching the camera. And **the
boot reconcile never re-queues a clip export that carried a wake** — it fails it
by name, which the operator can retry with one tap, re-asking for the
authorisation. A clip export WITHOUT a wake is re-queued like any render: there
is nothing to spend twice, and a sleeping camera refuses at its own gate exactly
as it did the first time.

**`ExportRecord.subject` is OPTIONAL, and `exportSubjectOf` is the one thing
that says what absence means.** The store parses every row through
`ExportRecordSchema` on every read, so a required field would make the export
AUDIT — the reason rows survive file deletion — unreadable in one release.
Absence means `footage`, built from the projection, in exactly one place.

**A cap method a collection SOURCE may legitimately not serve is declared with
`optionalMethod()`, and the generated router CHECKS before it calls**, answering
`NOT_IMPLEMENTED` with the capability and the method — the same answer
`device-collection-dispatch.ts`'s `callSource` already gives per source, so the
two routing layers say the same thing. **And the codegen's cap reader is pinned
against the factories `capability-definition.ts` exports**, mechanically, so a
fourth factory turns a test red on the commit that adds it rather than deleting
a method from five generated files in silence.

## Consequences

- A surface creating a clip export must pass `provider` and `catalogWindow`
  alongside the clip. Both are things it already holds — `listSources` gives the
  `addonId`, `ClipsBrowser`'s day window gives the pair — so this is not a new
  query, but it IS a new way to be wrong: a mismatched window reads as
  `catalog-miss`, which is the honest answer and not an obvious one.
- The clip catalog is asked at ONE day's width, page-limited to 1 000 rows
  (`EXPORT_CLIP_CATALOG_LIMIT`). A busy day on 107 measured 546 rows. A camera
  that ever exceeds it would report a listed clip as missing — the one answer
  this gate must never give wrongly — and the limit is named so that failure is
  findable.
- `wake-expired` is a state an operator will meet: a clip export queued behind
  two long renders for five minutes fails rather than completing. That is the
  cost of the rule and it is deliberate — the alternative is a camera woken for
  a tap nobody remembers.
- `providerOptional` is a new framework flag and the first thing that can make
  `InferProvider` partial. Used wrongly it softens a method somebody has not got
  round to writing; its docblock says so, and there is exactly one use today.
- **The producing side of `videoclips.readClipBytes` is not in this change.**
  `packages/addon-provider-reolink` was owned by another agent; the HKSV source
  (`addon-export-hap`) implemented it during the same session. Until Reolink
  does, a `native:reolink:*` clip export fails at the router with
  `NOT_IMPLEMENTED` naming the method — a named refusal, not a hang.
- `createExport` still returns only the FIRST record of a multi-profile footage
  request (D558 § 6.3). The `as ExportRecord` cast that expressed the non-null is
  gone — the loop yields it structurally — but the return SHAPE is unchanged,
  because changing it is a wire break for every existing caller. A clip subject
  carries one profile, so the defect cannot reach this path.
- Left as D558 found them, deliberately: `getDownloadUrl` still checks neither
  state nor expiry, `listExports` is still unpaged whole-history, `createdBy` is
  still the constant `'operator'`, and there is still no owned
  `DEFAULT_EXPORT_LIFE_MS`. The first two are shared with the footage path and
  would change behaviour every existing surface depends on; `createdBy` needs the
  router-stamped principal D558 § 6.7 describes, which is one method wide at best
  and codegen-wide at worst. None of them is a precondition for a clip export
  that refuses honestly.

## Considered and not taken

**A `videoclips.getClip({deviceId, clipId})` by-handle catalog read**, which
would have removed `catalogWindow` entirely: the id is self-contained and the
dispatcher routes on its prefix, so no window is needed. It is the cleaner
contract. It was not taken because it is a SECOND method another agent's
provider must implement before anything works, and the whole point of reusing
`listClips` is that the validation half needs nothing new from anybody. If a
third source ever appears, this is the first thing to revisit.

**Refusing a clip whose asked twin is missing.** Rejected on sight: D549 15 and
D558 § 5.4.2 rule 3 say the divergence is SHOWN, not refused — 17 of 546 clips
on 592 have no main twin. The ask stays on `subject.profile`, the served twin
lands on the record's `profile`, and the engine corrects the projection from the
producer's own `served` and logs when it had to.

**Adding `'fetching'` to `ExportStateSchema`**, which would have made the clip
phases visible. Not taken, and now pinned by a test: the viewer maps an unknown
state string to `failed`, so a seventh member renders every live export — of
BOTH kinds, through the same modal — as FAILED on every installed app.

## Enforcement

- `packages/types/src/__tests__/export-state-members.spec.ts` — the six members,
  with the viewer's hand-written copy as the stated reason.
- `packages/types/src/__tests__/export-subject.spec.ts` — no range in a clip
  subject, `auto` refused, one profile, the required top-level `deviceId` with
  the scope-enforcement reason, and `exportSubjectOf` on a pre-D558 row.
- `packages/types/src/__tests__/cap-method-factories-are-parsed.spec.ts` — the
  codegen cap reader against the factories actually exported.
- `packages/types/src/capabilities/__tests__/provider-optional-method.type.spec.ts`
  — a source may omit the method; every other method stays required.
- `packages/addon-pipeline/src/recorder/addon/__tests__/recording-export-clip-subject.spec.ts`
  — one provider asked, the projection from the row, and a distinct named
  refusal for each gate.
- `packages/addon-pipeline/src/recorder/addon/__tests__/export-engine-clip-fetch.spec.ts`
  — one fetch, the bound, the served twin, no fabricated progress, no ffmpeg, no
  retry, the namespace dispatch, and the wake TTL.
- `packages/addon-pipeline/src/recorder/addon/__tests__/export-reconcile-never-rewakes.spec.ts`
  — a restart never spends an authorised wake a second time.
