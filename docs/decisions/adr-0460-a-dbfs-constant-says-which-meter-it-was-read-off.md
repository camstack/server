---
id: D460
title: A dBFS constant says which meter it was read off — and only a measurement converts
status: accepted
date: 2026-09-11
applies-to:
  - packages/types/src/audio/audio-scale-epoch.ts
  - packages/types/src/notification/audio-condition.ts
  - scripts/check-dbfs-era.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/audio-anomaly-detector.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
last-verified: 2026-09-11
---

## Context

D459 corrected the native G.711 decoder and deliberately shipped only half a
change. Its own Consequences say so: *"The correction is not releasable on its
own… level-mode notification rules and audio-triggered recording bands on
native G.711 cameras will over-fire by 12–18 dB of margin. This ADR is the
statement that the second half is outstanding."* That half is this record.

D459 stopped where it did for a stated reason: *"the law is not known per
camera anywhere a migration could read it."* **It was known.** The line
`audio: track detected {codec=…}` had been in the logs the whole time. A census
over 10 hours of it:

| codec | cameras | law | correction |
| --- | --- | --- | --- |
| PCMU | 19 | μ-law | +12.04 dB |
| MPEG4-GENERIC | 5 | AAC | none — always correct |
| L16 | 1 | linear PCM | none — always correct |
| PCMA | **0** | — | — |

Two things fall out immediately. **There is no A-law camera on this
installation**, so the phase inversion D459 found never affected anything and
the only live correction is a single number, +12.04 dB. And the fleet splits
19/6, which is what made the problem look like a majority vote.

### The framing that was wrong, and cost the most time

D459 reasoned — and the source comments it left behind repeated — that each
shared constant is *"ONE number serving BOTH camera populations"*, so no single
value can be right for both. That was true for exactly one day.

**After the epoch there is only one population.** The decoder is correct
everywhere; the amplitude scale is uniform across all 25 cameras. Nothing about
a shared constant serves two scales any more. The two populations exist only in
the *past*, and only as a question about where a number came from.

So "re-scale the globals or leave them, and who wins, the 19 or the 6" is the
wrong question. Counting cameras cannot answer it, because the constants were
never calibrated by counting cameras.

### The question that does decide it

**What kind of number is this?** Every absolute-dBFS constant in the repo is one
of two things, and only one of them converts:

- **A statement about the scale.** `-55 dBFS is near silence`. `-25 dBFS is
  loud`. `0 dBFS is full scale`. These are true on the ITU-T scale before the
  epoch and after it. Nobody read them off a meter; they are what those words
  mean on a 16-bit full-scale range.
- **A measurement taken through the old decoder.** A number somebody read off a
  meter that under-reported by exactly 4×. It describes a sound that was really
  12.04 dB louder, and it is wrong by that much on a corrected system.

Asked that way the shared constants answer themselves, and they answer the
opposite of what the 19-vs-6 count suggests:

**The defect was never in `SILENCE_FLOOR_DBFS = -55`. The defect was that 19
cameras did not obey it.** That constant has meant exactly what it says, on the
5 AAC and 1 L16 cameras, for its entire life in production, with no complaint
about either. Shifting it to −43 would take a value that is correct on the true
scale and make it wrong — in order to preserve the behaviour of a bug — and
would make the six cameras that were always right newly deaf. What actually
happens at the epoch is not that 19 cameras overshoot; it is that 19 cameras
**converge on the behaviour the 6 always had**.

`audioMarkerMinDbfs = -25` carries the same answer with an extra argument. On
the old scale a PCMU reading of −25 required a true level of −13 dBFS, near
clipping: bar 1 of the three-bar anomaly gate was effectively dead on 19 of 25
cameras, and the feature has been running on two bars. At the epoch it starts
working as designed.

### The one constant that does convert

`NC_AUDIO_DB_OFFERED = -55` is the only absolute-dBFS number in the repo with a
recorded provenance, and its provenance says *measurement*: *"measured on the
live installation, real crying sits between -55 and -26 dBFS."* Three things
agree that the camera measured spoke PCMU:

- 19 of 25 cameras are PCMU, and none are PCMA, so μ-law is the only candidate
  correction;
- **−55…−26 dBFS is not a close cry on a true scale.** −26 dBFS is a quiet
  room. Read as a PCMU measurement the band is −43…−14, which is exactly where
  a cry a metre from a microphone sits;
- D459 itself reached the same conclusion from the other direction, and used
  this constant as its corroborating evidence that the decoder was 12 dB low.

Being the one number derived from the broken meter, it is the one number that
moves. It is also the cheapest thing in the enumeration to move: it is what an
editor OFFERS when the level filter is switched on with nothing stored. Moving
it changes no existing rule — it stops seeding *new* ones 12 dB too permissive.

### Why a note in prose is not enough

The whole defect survived for months because **a number in a source file
carries no record of the meter it was read off**, and the single exception —
one sentence of JSDoc that happened to record where −55 came from — is what
made D459 diagnosable at all. D459 closed by naming this as unenforced: *"a
guard would need to know which numbers are levels, and it does not."*

It does not need to. The guard does not classify the numbers; it makes the
author classify them, and checks only that a classification is present and is
one the vocabulary knows. The undecidable half is the half a human answers for
free while writing the line.

## Decision

**An absolute-dBFS constant declares which amplitude era it was calibrated in,
and only a number MEASURED through the pre-epoch decoder is converted — by
`ituDbfsFromPreEpoch`, never by hand.**

1. **Provenance, not population, decides.** A constant that states a property
   of the dBFS scale (`@dbfs-era itu`) is not shifted: it was correct before
   the epoch and is correct after, and the 6 always-correct cameras are the
   standing proof. A constant read off the old meter (`@dbfs-era pre-itu-pcmu`
   / `pre-itu-pcma`) is restated through `ituDbfsFromPreEpoch`, which keeps the
   law, the original measurement and the derivation visible at the call site —
   `-55 + 12.04` typed into a source file is, six months later, indistinguishable
   from a threshold somebody simply preferred. A difference, step or deviation
   (`@dbfs-era relative`) is scale-invariant and must never be "corrected"; a
   bound of the scale itself (`@dbfs-era scale-bound`) likewise.

2. `NC_AUDIO_DB_OFFERED` becomes `Math.round(ituDbfsFromPreEpoch('PCMU', -55))`
   = **−43**. `SILENCE_FLOOR_DBFS`, `audioMarkerMinDbfs`, `NC_AUDIO_DBFS_FLOOR`,
   `NC_AUDIO_DB_MAX` and `NC_AUDIO_DB_STEP` keep their values, each now
   carrying the argument for why in its own comment.

3. **Operator-written values are declared, not migrated** — and never
   silently. Stated in full below.

4. `ituDbfsFromPreEpoch` converts an authored CONSTANT, once, where it is
   declared. It is **never** applied to a live sample or a stored
   `AudioEvent.dbfs`: the decoder is correct now, and a second authority
   adjusting numbers the decoder already got right is D459's defect with an
   extra place to argue with.

### Why the operator's values are not migrated

Four stored per-object values are in scope: `NcAudioCondition.dbThreshold`,
`RecordingTriggers.audioThresholdDbfs`, `audioMarkerMinDbfs` and the viewer's
per-grid `GridHighlightSettings.audioDb`. Unlike the shared constants these
genuinely ARE pre-epoch calibrations — an operator picked each one while
watching a meter, so on a PCMU camera he was watching a meter that under-read,
and his number is now 12.04 dB too permissive.

The codec census removes D459's stated blocker: the law IS known per camera.
It does not remove the others.

- **A migration cannot read the census.** The law is known from a LOG LINE, not
  from a durable store. `DecodedAudioChunk` carries no codec, `AudioWindowFormat`
  tracks `{sampleRate, channels}`, the broker's `audioCodec` never leaves the
  process, and `StreamMetadata.audio.codec` comes from an ffprobe that may be
  absent, stale, or taken on another profile. A migration would have to trust
  exactly the source D459 already refused to trust, to move an operator's
  number by 12 dB.
- **A notification rule has no single camera.** `dbThreshold` is per RULE.
  A rule scoped to a mixed device set — or to none, which means all — has no
  single correct shift. `audioThresholdDbfs` (per device per band) and
  `audioMarkerMinDbfs` (per device) are unambiguous; `dbThreshold` is not, and
  a migration that got two of the four right would be worse than none, because
  the operator would no longer know which of his numbers had been touched.
- **The arithmetic is not the intent.** +12.04 dB is a hypothesis about what
  the operator MEANT. He chose a number that made the rule fire when he wanted
  it to, watching real behaviour; whether the same intent survives the shift is
  something only he can say.

So the shift is offered, not performed: the factor is known and derived, the
census names the cameras, and `native: audio decoder initialized` carries
`tags.deviceId` plus `preD459LevelDeficitDb` so any camera can be checked
individually. This is an operator action with the numbers in hand, and it is
**outstanding work, not finished work** — the same honesty D459 applied to
itself.

## Consequences

- **`main` becomes shippable.** D459's blocker was that absolute gates were
  12–18 dB too permissive with no re-scaling pass. After this record every
  shared constant has been examined, has a stated era, and is either converted
  or argued-and-kept; the remaining exposure is bounded, named, and belongs to
  values the operator can see and change. What ships is a *seed* change plus
  documentation plus a guard — no live gate moves.
- **Nineteen cameras get more sensitive at the epoch, by design.** Level-mode
  rules, audio recording triggers and audio markers on PCMU cameras all fire
  more readily than yesterday, converging on how the 6 AAC/L16 cameras have
  always behaved. An operator who tuned a threshold on a PCMU camera should
  expect it to over-fire until he moves it, and the per-object list above is
  where to look.
- **`classificationMinScore` / `minConfidence` remain open and are NOT
  re-scaled here.** The classifier's input amplitude moved by 12.04 dB on 19
  cameras, so its output scores change in a way no multiplication describes.
  D459's refusal stands verbatim: it must be measured, not predicted. It is the
  one item in this area that this record deliberately does not close.
- **The viewer's constants are unexamined here.** `GridHighlightSettings.audioDb`
  (−30), `AUDIO_LEVEL_THRESHOLDS_DBFS`, `AUDIO_HIGHLIGHT_LEVELS`, `dbfsToUnit`'s
  −60 floor, `AudioMetricsPanel`'s −80 and `AudioLevelWaveform`'s −96/−6 live in
  the `camstack/` submodule, which is not checked out in this worktree. They are
  rendering ladders and a per-grid highlight rather than gates that drop work,
  so the same provenance test applies to them and almost certainly gives the
  same answer (`itu`, unchanged) — but it has not been applied, and the guard
  does not reach that repo. Named so the next session does not mistake silence
  for clearance.
- The guard's vocabulary is CLOSED. An unrecognised tag is a refusal, not a
  pass: a typo that silently satisfies it would read as a classification that
  was checked when it was not — the failure shape D459 called out in its "the
  two implementations agree" test.

## Enforcement

`scripts/check-dbfs-era.ts`, wired into `.github/workflows/ci.yml`. Every
module-scope constant and Zod default whose identifier carries `db` or `dbfs`
as a token and binds a number must declare `@dbfs-era` in the comment directly
above it. It covers 3413 files and currently holds 9 declarations.

Two false-positive sources are handled deliberately, because either would have
got the guard switched off within a week: **`db` also means "database"**
(separated by position — a database name uses it as a leading qualifier,
`dbPath`; a decibel name uses it as a unit, and a unit never leads the quantity
it qualifies), and **a local binding is not a calibration** (`const dbfs =
readNumber(…)` inside a function is reading a value, not choosing one).

`scripts/__tests__/check-dbfs-era.spec.ts` asserts the behaviour on fixtures
rather than on the live tree — a guard tested only against the repo goes green
the moment it stops matching anything at all.

Disarms run, each producing the expected red:

| disarm | red |
| --- | --- |
| `ituDbfsFromPreEpoch` absent | 4 failures in the epoch spec |
| `NC_AUDIO_DB_OFFERED` moved to −43 | 3 — the old assertion pinned the raw measurement (`toBeLessThanOrEqual(-55)`), and two admin-ui tests hard-coded the seed literal |
| era annotation removed from `SILENCE_FLOOR_DBFS` on the real tree | guard names it, exits 1 |
| `db` position rule | `dbConnections` / `DB_PATH` caught as levels |
| local-binding rule | `const dbfs = readNumber(…)` caught as a calibration |
| dotted-call RHS | `Math.round(ituDbfsFromPreEpoch(…))` NOT caught — the guard would have exempted the one constant whose provenance is the entire point |

The last three are reds this session produced by writing the assertion first
and watching the implementation fail it; each changed the implementation.

**Three reds were RE-ANCHORED rather than fixed**, and the reason is the same
each time: the assertion had pinned a number read off the broken meter.
`toBeLessThanOrEqual(-55)` in `audio-condition.spec.ts` and the literal `-55`
in `NotificationRuleConditions.spec.tsx` / `NotificationRules.spec.tsx` were
green on the defect and went red on the fix. The property those tests exist for
— "the editor seeds whatever the shared constant offers", "the offered floor
sits at the quiet end of the band where crying lives" — survives the scale
change; the literals did not. They now derive from `NC_AUDIO_DB_OFFERED` and
`ituDbfsFromPreEpoch`.

What is NOT enforced: nothing checks that an `@dbfs-era itu` claim is *true* —
an author who tags a pre-epoch measurement as a scale statement gets no
complaint. The guard makes the claim exist and be legible in review; it cannot
make it honest. And nothing reaches the viewer submodule.
