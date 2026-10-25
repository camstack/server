---
id: D560
title: A clip source over recorded footage is REGISTERED by the addon that owns the footage — and the half that went remote is the half that needs a degradation
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/videoclips-wiring.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts
  - packages/addon-pipeline/src/recorder/addon/videoclip-visits.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-shared.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/types/src/media/media-owner-key.ts
  - scripts/check-videoclips-footage-owner.ts
---

## Context

The `analytics` clip source — "CamStack recordings", the one every camera on
this fleet has — was registered by `pipeline-analytics`. It composes two
things: the recorder's continuous segments (`recording.getAvailability`,
`recording.getPlaybackManifest`) and the analytics event log. It lived with the
event log because that is the half whose store it read in-process.

Operator, 2026-09-20: *"Anche il recorder deve registrare il suo contributo,
deve essere coerente con gli altri"* [the recorder too must register its contribution, it must be consistent with the others], then *"la source camstack è esattamente
quello che è adesso … quello non cambia"* [the camstack source is exactly what it is now … that does not change], then the decisive one: *"intendo che
il meccanismo in sé rimane lo stesso come view di eventi e segmenti, ma deve
registrarla CHI ha il footage e non altri addons casuali"* [I mean that the mechanism itself stays the same as a view of events and segments, but it must be registered BY WHOEVER has the footage and not other random addons]. Checked back
against him: *"intendo chi fa le registrazioni! … chi registra il provider per
le clips? Se sì allora è giusto."* [I mean whoever makes the recordings! … whoever registers the provider for the clips? If so then it is right.]

**"Registrare" means two things two metres apart in this system** — writing
video to disk, and declaring a provider to the capability registry. He
identified the addon by the first and asked for the second to move to it.

The premise was verified rather than assumed. `recorder`
(`packages/addon-pipeline/src/recorder/addon/index.ts`) is the only registrant
of the `recording` capability, declares the `recordings` / `recordingsLow`
storage locations, and owns the segment writer. Nothing else holds the footage.

**Why it is not a naming preference.** Ownership decides where the failure
surfaces. The half that is REMOTE is the half that can be unreachable, and a
source's degradation vocabulary has to be written for that half. The provider
already had two, both of them about the footage side:

- an availability read that fails ⇒ list unfiltered, logged;
- a media-presence read that fails ⇒ list without thumbnails, logged.

With the registration on the wrong addon, "the footage is gone" and "the
annotations are gone" are the wrong way round. Moving it makes the events the
remote half, and that case had no answer at all.

## Decision

**1. The `videoclips` source over recorded footage is declared and registered
by the addon that owns the footage — `recorder`.** The manifest entry declares
`videoclips` beside `recording`; `pipeline-analytics` declares neither any
more. `ClipSource.addonId` for the `analytics` row is now `recorder`.

**2. The COMPUTATION does not move, and neither does the source id.** The
composer is the same code, moved file-for-file
(`videoclips-provider.ts`, `videoclip-visits.ts`, `videoclips-shared.ts`) with
its two unit specs unmodified: a clip is still a time WINDOW over existing
footage, visits are still clustered at `VISIT_MERGE_GAP_MS`, `getClipPlayback`
still resolves through `recording.getPlaybackManifest`, the per-event padded
fallback is still there. `ClipSchema.source` stays `analytics` and clip ids stay
`analytics:<start>:<end>:<id>`: the source id is the clip-id NAMESPACE that
`getClipPlayback` routes on and that stored ids carry, and it is a different
question from which addon serves it. `ClipSource.addonId` is the answer to the
second (D557), which is exactly why the two are separate fields.

**3. The FILES move with the registration.** Leaving the composer in
`addon-post-analysis` while `addon-pipeline` registers it would be a
cross-addon import, which this repo forbids — `ctx.api` is the only cross-addon
layer, even for an existence check. There is no third option: the helpers have
one consumer and it is the registration.

**4. Every read goes over `ctx.api`, the recorder's OWN two included.**
`recorder` is `placement: 'any-node'`, so several nodes register the capability
and the dispatcher resolves the binding to ONE of them (`addonIdentityOf`
strips the `@<nodeId>`, D554 amended). That registration is not necessarily the
node holding this camera's segments. `ctx.api.recording.*` is device-scoped and
routes to the node that is; a short cut to the in-process `RecordingProvider`
would answer a camera recorded on agent-a out of the hub's empty index —
an empty clip list on a camera with weeks of footage, the exact misreading this
line of work exists to end. Rejected for that reason, and it is the one thing
about this move that looks like an optimisation and is a defect.

**5. The media-presence probe becomes a cap method, batched per owner kind.**
`pipelineAnalytics.ownersWithMedia({ deviceId, ownerKind, ownerIds })` — the
wire form of `MediaStore.ownersWithMedia`, bounded at the same 5 000 the
annotation fetch is bounded at, throwing rather than answering partially. One
call per owner KIND, never one per owner: that N+1 is what the store method
exists to prevent and a process boundary in front of it would multiply the cost,
not absorb it.

**6. Footage present, events unreachable — the answer follows the BRANCH.**

| what answered | what the source does | why |
| --- | --- | --- |
| availability answered (rows, or `[]`) | a **degraded list**: the footage visits, unannotated — no labels, no stills, no event ids — logged with `tags: { deviceId }` | a visit is a window over footage; events only ANNOTATE it, so the visits are still real and still playable (their ids encode the window). An availability that answered `[]` gives an empty list that is TRUE about footage — with availability present a clip only ever comes from a recorded range, so it is the same answer a successful events read would have given |
| availability absent, or its read failed too | a **named refusal**, naming both reads | without availability the clips ARE the events. An empty list here is the precise lie: "this camera has no recordings" |

A refusal for the first case was rejected: it throws away a list that is real,
playable and correct about footage, and tells the operator nothing about the
archive. A degraded list for the second was rejected: it is the lie.

**7. The degradation is REPORTED, not only logged** — `listSources` carries it
on the row, as `state: 'ok'` with the reason. `ok` because the source ANSWERED:
`unreachable` renders as *"Could not be reached — its clips are missing from
this list"* (`clip-source-state.ts`) and drawing that beside a list that HAS
them is the same defect pointed the other way. A fifth member of
`ClipSourceAvailabilitySchema` was rejected too: that enum models what a source
can do about its STORE, every consumer of it is exhaustive, and the one
consumer lives in a package this change could not touch. The provider keeps a
per-device mirror of what its own last `listClips` did — set when the read
fails, cleared when one succeeds. It is not a cache of anybody else's fact
(D224): `listSources` has no window argument and must not go and ask again, or
the surface would carry a second, disagreeing answer to a question `listClips`
already answered.

## Consequences

- **A camera's `analytics` binding changes addon.** `getBindings` step 0
  derives a collection cap's sources from its DECLARERS (D554 amended) and
  persists nothing, so the row goes from `providerAddonId: 'pipeline-analytics'`
  to `'recorder'` with no migration, no back-fill and no window. Before:
  `{ capName: 'videoclips', kind: 'wrapped', providerAddonId: 'pipeline-analytics' }`.
  After: the same row with `providerAddonId: 'recorder'`. That is the whole
  persisted delta of this change, and deriving is why there is not more of one.
- **Nothing keyed off the old addon id.** Swept: clip ids carry the SOURCE
  (`analytics:`), not the addon; `ClipsSection`'s picker quotes `addonId` from
  the `listSources` row the dispatcher stamps, so it follows automatically;
  `listClips`'s `provider` pin is quoted from the same row; the nine hard-coded
  `'pipeline-analytics'` literals in `addon-admin-ui` and one in `server/backend`
  are all other capabilities (notification center, photo enrol, debug, storage
  discard, placement board) and none is a clip surface. Nothing persisted names
  the videoclips provider.
- **`listClips` now costs four cross-process calls where it used to cost
  three.** `ownersWithMedia` was an in-process store read. On a pathological
  camera-day that is up to four batched requests carrying at most 5 000 ids
  each, against an index, on an admin surface that renders once per day
  selection. Not measured on the live hub, and stated as unmeasured.
- **The recorder now depends on `pipelineAnalytics` for a listing path.** It
  already did for the trigger reconcile (`loadMotionEvents` /
  `loadObjectEvents`), so this adds a consumer, not a dependency. What it does
  add is a listing that degrades when the analytics addon is down — which is
  decision 6, and is the point.
- **One more addon declares a collection cap**, so a camera whose recorder
  never booted gets the dispatcher's "device is bound to `recorder`, which has
  registered no provider here" warning rather than a silent absence. That is
  the D554 behaviour and it is the right one.
- **Not decided here:** whether `ownersWithMedia` should be batched ACROSS
  owner kinds into one call. It would be one round trip instead of up to four,
  and it needs the owner-kind disambiguation D476 added to be carried per id.
  Nobody has measured that the four are a problem.

## Enforcement

- `packages/addon-pipeline/src/recorder/addon/__tests__/videoclips-is-the-footage-owners.spec.ts`
  — the recorder entry declares `videoclips` beside `recording`; the wiring
  reads events AND footage through `ctx.api` (never the local provider); the
  source row names `recorder` while the clip-id namespace stays `analytics`;
  every line it logs carries `tags: { deviceId }`. Proven red before the
  manifest edit (1 of 5) and before the wiring module existed (5 of 5).
- `packages/addon-pipeline/src/recorder/addon/__tests__/videoclips-provider.spec.ts`
  § "footage present, events unreachable" — the degraded list is the visits
  unannotated; an empty list happens only when the FOOTAGE read said there is
  none; neither read answering is a refusal naming both; the source row reports
  it and stops once a list reads its events; a device nobody touched is
  untouched. Proven red on the pre-move provider: 4 of 4.
- The same file's other 29 cases and `videoclip-visits.spec.ts`'s 14 moved
  **unmodified** and pass unmodified. That is the proof decision 2 holds — a
  change there would mean more than the registration moved.
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/owners-with-media-on-the-wire.spec.ts`
  — one batched index read naming the owner kind and the device; an empty ask
  costs no read; a failed read THROWS rather than answering partially. Proven
  red before the method existed: 3 of 3.
- `scripts/check-videoclips-footage-owner.ts` (wired into CI) — the invariant,
  not the instance: any addon entry declaring `videoclips` whose package
  resolves clip playback through `recording.getPlaybackManifest` must declare
  `recording` too; and any entry declaring `videoclips` must have a provider
  registration behind it, because a collection cap's sources are derived from
  its DECLARERS and a declaration with nothing behind it hands every camera a
  source the dispatcher cannot resolve. Proven red by removing the `recording`
  declaration from the recorder entry.
