---
id: D189
title: A synthetic track is shaped like a regular one
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/audio-track-class.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/audio-track-class-migration.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/synthetic-track.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/audio-marker-projector.ts
---

## Context

An audio episode is materialized as a SYNTHETIC track. Until now
`openAudioEpisode` opened it with `kind: ref.className` — the naked audio macro
(`speech`, `animal`, `water`) — plus `source: 'audio'`. So `Track.className`
meant two different things depending on a second field: `animal` was a COCO
quadruped on a pipeline row and a barking dog on an audio row.

That is not a cosmetic problem, because the two vocabularies OVERLAP. `animal`,
`vehicle`, `siren`, `door` and `water` are all in both. On this hub there is a
live notification rule `classes: ['animal']` on camera 101, and
`rule-engine.ts:749` builds a rule subject from `track.classes ?? [className]`
— so a dog heard barking presented itself to the matcher as an animal in frame.
`key-event-scoring.ts` ranked those same rows at `CLASS_RANK_ANIMAL` for the
same reason.

Every consumer was therefore obliged to remember to read `source` before
interpreting `className`. One did not: the viewer drew the neutral `Tag` glyph
on every audio tile, and v1.0.354 patched it with a per-consumer compensation
that namespaces to `audio-<id>` when `source === 'audio'`. That is the shape of
a contract failure — a compensation per consumer, forever, one of them always
missing.

**The system already contained the right answer.** The sibling projector,
`services/audio-marker-projector.ts`, has always materialized `kind: 'audio'`
and put the heard class on `audioLabels`, with a comment saying why: the audio
macros collide with detection subs, so a sub per audio class puts a barking dog
in the animal lane. And that is exactly what a REGULAR track does — when a
camera hears something while a subject is on screen, `addAudioLabelEpisode`
stamps the macro onto that track's `audioLabels` and its `className` stays
`person`. Two producers of the same row disagreed; the model was never the
problem.

The first framing of this fix was "namespace the className to `audio-<macro>`".
That was rejected: it would have introduced 25 new class values no regular track
ever carries, so consumers would still need audio-specific knowledge — a
narrower special case, not the absence of one.

## Decision

**A synthetic track carries information in the same fields a regular track
does. A consumer written for one renders the other correctly without knowing
which it is holding.**

For audio that means: `className` is the taxonomy macro `'audio'` — never a
naked audio sub-macro — and the class HEARD lives on `Track.audioLabels[].label`,
the field a regular track already uses. `source: 'audio'` stays on the row: it
is honest and it answers a query, but no consumer has to read it to interpret
the class.

The constant is `AUDIO_TRACK_CLASS` in
`store/audio-track-class.ts`, and both projectors import it — there is no second
place that decides what an audio row's class is.

The `audio-<macro>` namespace keeps its one job: it is an **iconId**, derived
from an `audioLabels` entry at render time (`audioKindId`). It is not, and never
becomes, a class.

## Consequences

- **The `audioLabels` chip is now the only carrier of the heard macro.** A
  surface that renders only `className` shows "audio" and nothing finer. Two
  such surfaces exist and are accepted as-is: the admin `EventCard` title
  (`KeyEventSchema` carries no `audioLabels` — a types change, deliberately not
  taken here), and the viewer reel (its audio chips are gated `!isReel`).
- **A debounce keyed on the class had to follow it.** `SyntheticTrackMaterializer`
  debounced on `${cameraId}:${kind}`; with every audio row saying `audio` that
  collapsed to one bucket per camera, and the episode hysteresis cools down PER
  class — a bark three seconds after speech is a legitimate second episode. The
  key now includes the first `audioLabels` entry.
- **An accidental importance boost disappears.** 11 of 576 live audio rows
  ranked as ANIMAL/VEHICLE purely through the collision; they now rank at the
  default, like the other 565 always did.
- **A rule `classes: ['audio']` now matches an audio track** (the macro expands
  to its `audio-*` subs). A rule `classes: ['audio-dog']` still does not — the
  subject carries the macro only. Narrowing by heard class remains the job of
  the dedicated `NcAudioCondition`, which is where it already was.
- **`class.audio` had to be added to the NC text catalogs** (en/it), or the
  notification body would read the literal token.
- **Legacy rows converge, they do not accumulate a second format.**
  `normalizeAudioTrackClass` runs in `TrackStore.rowToTrack` — the single
  hydration point, seven call sites — so correctness does not wait on the
  rewrite. `runAudioTrackClassMigration` (marker-gated, paged, bounded,
  idempotent, off the readiness path) rewrites the disk. When it reports
  `rewritten: 0` on a fleet boot the read-side call is dead code and **must be
  deleted** — D182 and D185 both refused a permanent dual-read and this inherits
  that refusal. Observed on the live hub the day it shipped: three overlapping
  deploy boots rewrote 366 / 545 / 261, and the next clean boot reported
  `scanned: 8372, rewritten: 0`. The disk has converged; the retirement
  condition is met for this hub and waits only on the fleet.
- **The completion marker does not persist, and that is not this pass's bug.**
  `pipeline-analytics:migrations` is in neither `CANONICAL_KV_COLLECTIONS` nor
  any addon `declareCollection`, so `set` is rejected and every boot re-scans.
  `runLabelTierMigration` has had this since it shipped (27,719 + 8,363 rows
  re-scanned per boot, forever); this pass inherits it and adds 8,372. Harmless
  — the decision is idempotent and a converged pass writes nothing — but the
  marker is decoration until the collection is declared.
- **The viewer compensation stays, and had to be made idempotent.** It protects
  a real window: an old hub serving naked classes to a new viewer. But the
  embed's `audioKindId` had no idempotency guard, so under this contract it
  produced `audio-audio` — an id the taxonomy does not know, shadowing both
  `EVENT_KIND_ICONS.audio` and the 25 curated `audio-*` glyphs. It now matches
  its server-side twin in `@camstack/types` and is a no-op on a correct row.

## Enforcement

Tests, at each of the three levels the bug lived at:

- `pipeline-analytics/__tests__/audio-track-uniformity.spec.ts` boots the real
  addon and asserts on the row that reached the store — including
  `className !== 'animal'` for a heard `animal`, which is the collision itself.
  Its assertions are about FIELDS and never read `source`, which is the
  acceptance test restated.
- `store/__tests__/audio-track-class-migration.spec.ts` pins the rewrite rule
  against RAW rows (hydrating would apply the read compat and hide them), plus
  idempotence, marker gating, and that a refused write is counted and logged
  with `tags: { deviceId }`.
- `__tests__/synthetic-track.spec.ts` pins the per-heard-class debounce.
- `pipeline/__tests__/key-event-scoring.spec.ts` pins `classRank('audio')` at
  the default, so nobody "fixes" the fall-through.
- `embed/src/embed/__tests__/events-audio-icon.spec.ts` pins that
  `audio-audio` is unreachable.

No guard script: the rule is about a value two call sites write, and both import
the shared constant. If a third projector appears, the uniformity spec is what
should be extended.
