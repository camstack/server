---
id: D681
title: Track history is recorded per camera for a day, a bad case becomes a committed replay test, and tracking metrics run locally
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/tracking-bench/**
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor-config.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-observation.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-id.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-relations.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/tracking-tape-index-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-relations-store.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-admin-ui/src/pages/EventsDebugTapes.tsx
---

## Context

Every tracking fix of September 2026 was judged on a one-day fleet proxy —
tracks per camera per day, a re-split rate from a 15 s heuristic, a count of
confused pairs read by hand from stored positions. The proxy could not tell a
fix from the weather, and twice it could not tell a fix from a regression:
[D678](adr-0678-a-proximity-resurrection-needs-the-corpses-size-and-a-vehicle-keeps-the-flat-graveyard-gate.md)'s
F1 (merge only pairs matched on every frame of their overlap) passed review
and was withdrawn when a reviewer showed it turned a 1–2-frame swap
permanent. And a case the operator saw could not be reproduced: the track
store thins trails and keeps matched boxes only, and D646's session replay
re-runs the root detector over a recording, explicitly not the tracker.

A first design (stage 0: a CI ratchet over a labelled scenario set, TrackEval
goldens, a replay-fidelity gate) was replaced the same day by the operator:
the system has one user and is under active development, the new tracker
(D683) replaces the old one directly with no shadow mode and no per-camera
switch between trackers, and what is needed is the history of a real case and
a test that keeps it fixed — not a leaderboard.

Implementation surfaced two more failure modes the design did not anticipate:

- **A tape detection id built from `onboard-<ms>-<i>` leaks the hour of day**
  through the timestamp embedded in the id itself — the exact thing the
  schema's ban on absolute time exists to prevent. Fixed by minting **per-frame
  ordinal ids** (`d0`, `d1`, …) and rewriting every reference (`pid`, `inj`,
  `gate.det`, `gate.weak`, `live.det`) through the same map, so nothing
  downstream ever sees the runner's own id.
- **A face's identity is not known at frame time** — on the runner,
  `labels[0]` is the `embedding:512d` marker, not a name, so a frame record
  can carry no `fid` without hashing a placeholder. The identity is instead a
  separate, observational **`identity` record** (`{t, trk, fid | null}`)
  written when the post-analysis `FaceRecognizer` settles or retracts an
  identity for a track, pseudonymised with the same per-boot keyed HMAC as
  everything else that needs one.
- **A tape has no clean edge at a crash.** A recorder that dies between
  frames leaves a segment with no `end` record, and a two-segment window that
  spans that boundary looked contiguous. Fixed by a **per-boot session id**
  in every segment header: a promotion reads a session change between
  consecutive segments — whatever the previous segment's own end reason — as
  a `restart` gap, so a boot boundary is never mistaken for continuous
  recording, and a `fid`-derived cannot-link never spans one (one face is two
  unrelated pseudonyms across a restart, by design).

## Decision

The camera's `trackingTape` setting (*Record the track history, kept 1 day*;
default off; the only authority, and off is reported off) records, on the
post-processing node (hub-only: a camera whose `postProcessingNodeId` is not
the hub is refused `not-post-processing-node`, and a node that does not own
the `artifacts` location refuses `artifacts-elsewhere`), what the detector
gave the tracker BEFORE it decided and the ids the tracker produced:
whitelisted field by field under a strict, versioned schema with no pixels,
vectors, names, absolute time or hour of day, into 10-minute gzip segments on
the `artifacts` class, swept after 24 h (**1-day retention** — decision R2,
down from the first design's 2 days).

A segment ends with one of `segment-end`, `size-cap`, `switched-off`,
`addon-stopped`, `window-end`, or **`recorder-error`** — a throw inside an
open segment closes it rather than losing the file, the next segment opens
fresh after a backoff, and (per the session-id rule above) a `recorder-error`
end is read as a `restart` gap exactly like any other non-clean end.

A window the operator promotes is pinned, labelled with the debug marks
(`same-subject`, `different-subjects`, purity) and turned by
`npm run tracking-bench -- case <bundle>` into a committed case:
`packages/addon-post-analysis/tracking-bench/cases/<slug>/`. Every committed
case is a test in the package suite (`cases.spec.ts`): replayed through
`CASE_TRACKER`, its `same-subject` pieces must end under one final id and its
`different-subjects` pieces must not. A case is `held` (must pass) or `open`
(the current tracker still fails it; run with `it.fails`), and the status is
measured when the case is made. The case contract is narrower than "does the
tracker get it right": it **asserts only what the operator labelled** — every
`same-subject` pair shares one final id, every `different-subjects` pair does
not, a labelled piece the replay never bound is a violation (`unbound`) — and
refuses to be made at all from a window with no judgeable label
(`no-labels`), a `gap` or missing `end` record (`incomplete`), an unreviewed
tape (`unreviewed`), a non-`p<n>` face pseudonym (`pseudonym`), or a
`different-subjects` mark inside an already-established `same-subject` chain
(`contradiction`, naming the chain). A **live-independence check** is part of
making a case: the replay is re-run with `live[]` scrambled (and, on an
identity tape, with track ids in `live[]` renamed and its no-identity entries
dropped) and must hash identically, so a case can never silently pass because
the replay copied the answer instead of deriving it. Everything a case does
not label — an unmarked track, an ignore region — is left for the metrics,
not the case, to judge.

IDF1, CLEAR, HOTA and the operator metrics are a local development tool
(`npm run tracking-bench -- score`), not a gate: no baseline file, no CI step.
`npm run tracking-bench` itself runs on `tsx`, which is **not a declared
dependency** of `addon-post-analysis` or the workspace root — it resolves
only because `vite`/`tsup` pull it in transitively and npm hoists it, the
same assumption every `scripts/*.ts` guard already makes. This is pre-existing
repo practice, not a new risk D681 introduces, but it is the first
*package-level* `npm run` script to depend on it: a future dependency bump
that drops `tsx` from `vite`'s or `tsup`'s tree would break
`npm run tracking-bench` with an error that does not look related.

D681 itself changes no tracking behaviour: its touches to production tracking
code — an injectable id minter, observation fields built only when asked, the
processor builder extracted into `createFrameProcessor`, a recorder that never
feeds back — are each proven neutral by a test.

## Consequences

- The tracker interface a replacement implements is `TapeTracker`
  (`tracking-bench/trackers/tape-tracker.ts`). `CASE_TRACKER` is ONE slot, the
  production `FrameProcessor` under replay today; D683 either lives inside
  `FrameProcessor` or points the slot at its adapter. There is no registry of
  trackers to rank. A `TapeTrackOutput.confirmed` means **past the tracker's
  own birth gate** (notification-eligible) — not "the operator confirmed this
  is right" — and the operator metrics (`duplicateNotifications`) read it with
  that meaning.
- Replay uses the RESOLVED settings a tape recorded; there is no replay under
  current defaults.
- A tracker under replay reads the detector's side of a frame and never
  `live[]` — with one narrow, documented exception: `TapeControlRecord` now
  carries the tape's `identity` record, and `live[]` may be read **only** to
  resolve `identity.trk` (a live track id) to the detection id(s) it bound, so
  a face-identity cannot-link can be applied to the tracker's own output.
  **Extended by D683 (Task 12, review M4):** `drop.trk` is resolved the same
  way, through the join of the frame at the record's own `t` — a recorded
  `dropTrack` names a live id too, and passing it through untranslated made
  the replay drop nothing, so a subject that live could never be linked
  again was linked in replay. No other use of `live[]` in replay is
  permitted; a spec enforces the restriction (`isLiveIndependent` renames
  every `trk` an `identity` or `drop` names, drops every other `live[]`
  entry, and removes the v2 `fusion` records — the live L2's answer) and the
  isolation guard (`check-replay-isolation.ts`) was extended to scan
  `tracking-bench/` for it.
- A case seen more than a day ago is gone; the switch's cost read-out is what
  would justify a longer window.
- A new field reaches tapes only with a `TAPE_VERSION` bump in the same change,
  and old tapes (committed cases included) are upcast at read, never rewritten.
  The `identity` record is part of `TAPE_VERSION` 1 (no v1 tape was written
  before it existed). **v2 (D683 §8.3, Task 12):** the model-free appearance
  descriptor (`app`) and the L2 `fusion` record; Task 13's upcaster strips
  every `RETIRED_TRACKING_KEYS` name from a v1 record's `tracking` blob
  (header planes and a `processor` record's `inputs`) on the same v1→v2 path.
  Upcasting is strictly forward: **a v2 tape read by an OLDER deployed reader
  (a rollback) is refused whole with `TapeVersionError`** — `loadTapeBundle`
  reports it per tape as `read-failed`, never a partial or best-effort read —
  so any tracking-bench window recorded after the deploy stays unreadable
  until the fleet rolls forward again.
- **Task 13 (D683 §7) retirement, one behavioural edge:** the old tracker's
  frame-count alias `maxMissedFrames` → `maxMissedMs` (× the retired
  `NOMINAL_FRAME_MS`, 133) goes with the key it aliased. A per-device blob
  that only ever set `maxMissedFrames` (never `maxMissedMs` directly) now
  resolves `maxMissedMs` to its plain default (4000 ms) instead of the old
  conversion (30 × 133 = 3990 ms) — a 10 ms difference for any blob that kept
  the historical default, and the only case that actually changes behaviour
  is a camera with a HAND-SET `maxMissedFrames` and no `maxMissedMs`, which
  silently loses that override.
- **Task 13 stale-key cleanup is manual, not a boot-time purge.** A retired
  tracking key left sitting in a stored row — the global
  `pipeline-analytics`/`addon-settings`/`root` row, or a per-camera
  `addon-devices` row — is harmless: `resolveTrackingSettings` is
  field-by-field and only ever reads the CURRENT schema's keys, so a retired
  name is never consulted, never fails to parse, and never masks a live
  field it sits beside. Task 13 deliberately does NOT add these 16 keys to
  the boot-time dead-key purge registry
  (`packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts`,
  which already purges this addon's global row for `mediaAttachPolicy`) —
  an operator decision, not an oversight: the operator's database will be
  cleaned up manually after the deploy instead of programmatically on every
  hub boot.
- Ground-truth relations and purity rows reference tracks by
  `leftTrackId`/`rightTrackId`/`sourceTrackId` — provenance, not ownership —
  and are bounded by count (20 000 / 5 000), never by age.
- A promoted window pins its tracks (`benchPinned`) against the age sweep and
  bulk media reclaim until released; `debug` still pins nothing (D81). A row
  is written `pinsSettled: false` and flipped only when every pin the
  promotion implies has actually landed — because the write can span an
  operation the deadline below abandons partway through. Every tape
  operation (promote, release, delete, reconcile) runs under an **op queue
  with a deadline**: past it, the operation's `AbortSignal` is aborted and
  every remaining write phase (rotation, file, row, pins, settle) checks that
  signal before writing, so an abandoned operation writes nothing more. A
  write already in flight when the deadline lands cannot be recalled; the
  queue's repair is **reconcile**, run as soon as the abandoned operation
  finally settles and again at hub start: it re-applies what every row
  implies — unreleased rows re-pinned, a released row's exclusive tracks
  unpinned — a **drift-only write** per [D447](adr-0447-a-scheduled-aggregate-is-served-from-a-covering-index-and-a-raw-stream-reads-no-chunk-the-socket-has-not-taken.md)'s
  discipline (touch only what disagrees with what should hold, never rewrite
  the whole set).
- A face verdict in force at a window's start is carried back through earlier
  segments of the SAME recorder session, but the walk is **capped at 6
  segments** (`MAX_IDENTITY_LOOKBACK_SEGMENTS`, about an hour of frame time):
  each segment decode is synchronous and a 32 MiB segment measured 552 ms, so
  an uncapped walk on a long-lived session is what would make a promotion
  outlive its own deadline. A verdict older than the cap, on a track still
  live, is not carried, and the walk logs `tracking tape identity carry
  capped` (`tags: { deviceId }`) rather than silently under-reporting.
- `readTapeFile` (`tracking-bench/tape-codec.ts`) decodes and parses **async**
  (`zlib`'s promise API, not `gunzipSync`): a promoted-tape read is now
  reachable from an admin click (the review view, the export endpoint), and a
  synchronous `gunzipSync` + JSON.parse of a multi-megabyte tape on the event
  loop is exactly the class of stall D447 exists to prevent on the hub's
  single configuration thread. Its own duration is logged at `debug` unless
  it is slow or large.
- Metrics are checked by hand-computed unit tests, not against a reference
  implementation; a disagreement with the literature is found by reading, not
  by CI.
- `packages/types/src/interfaces/track-relations.ts` adds refusal names and
  interfaces to `@camstack/types`. Rolldown 1.0.3 is known to PANIC bundling
  `addon-post-analysis`'s two-entry build the moment `@camstack/types`
  re-exports a new runtime **string constant** through an entry it inlines
  (the cross-chunk const-inlining pass; the workaround is
  `optimization.inlineConst: false` in that package's `vite.config.ts` — see
  the 2026-09-29 session entry on the publish-build panic). D681's additions
  to `@camstack/types` are Zod enum literals and interfaces, not exported
  `const` strings, and each `packages/addon-post-analysis` build across the
  branch was verified clean of the panic — but the lesson applies to this
  surface specifically: a future addition of an actual `export const
  <string>` to `@camstack/types` must build every bundle that inlines `types`,
  not only the packages the change touches.

## Enforcement

- `tracking-bench/__tests__/cases.spec.ts`: every committed case, `held` must be honoured, `open` runs with `it.fails` (so a newly honoured case must be flipped).
- `tracking-bench/__tests__/bench-isolation.spec.ts`: nothing under `tracking-bench/` except `recorder/` imports a store or a writer.
- `tracking-bench/cases/case-fixture.ts` refuses a case with a gap, unreviewed labels, a non-`p<n>` face pseudonym, contradicting labels or no label (`case-fixture.spec.ts`), and re-checks every committed fixture's pseudonyms and live-independence hash on load, not only at commit time.
- The populated-`FrameResult` whitelist spec (Task 5), the observe/no-observe equivalence spec (Task 3), the builder spec (Task 4) and the minter-independence replay spec (Task 19).
- `scripts/check-settings-key-has-reader.ts` covers `trackingTape`; the collection guards cover the three new collections.
- `scripts/check-replay-isolation.ts` extended to scan `tracking-bench/` (previously only `session-replay/`), so a tracker under replay reading `live[]` outside the one documented identity-resolution exception fails the guard, not just a code-review eyeball.
