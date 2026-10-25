# Videoclips timeline — the clip surface, and what `videoclips` has to become

> Status: **proposed**, 2026-08-08. The viewer half is BUILT and green (see
> "What already shipped"); this document is the backend half and nothing in it
> has been implemented. Read with
> `packages/types/src/capabilities/videoclips.cap.ts`,
> `packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts`,
> [D12](../decisions/adr-0012.md), [D13](../decisions/adr-0013.md),
> [D31](../decisions/adr-0031.md), [D62](../decisions/adr-0062.md).

## What the operator asked for

A new timeline mode for a camera that shows its **videoclips in sequence,
without holes**: clips play one after another with no dead air, the timeline
stays visible and scrollable throughout, and the empty stretches between clips
are **collapsed into a visual ellipsis** — the dead time does not disappear, it
becomes a marker carrying the jump it swallowed ("⋯ 2h 14m"). Clips today are
cut-outs of the recording; tomorrow they may be replaced or joined by clips the
camera stored onboard, or by HomeKit Secure Video clips. **Per camera, the
operator must be able to choose which clip sources are shown.**

The open question, in the operator's words: *"how do we get multiple choices per
camera — maybe we just make it a collection?"*

This document answers that question. The short version is at the end of the next
section; the reasoning is everything after it.

## The recommendation, stated once

**Make `videoclips` `mode: 'collection'`, keep `kind: 'wrapper'`, and make the
device-scoped fan-out walk `getBindings(deviceId)` before it fans.**

But — and this is the load-bearing half — **do not ship the per-camera server
selector until a second provider exists**, and do not ship any of it until the
router defect in §2 is fixed. Today `videoclips` has exactly one provider, and
its per-device binding is written to a store the router never reads. A
"which sources" switch on top of that is not a feature; it is the third instance
of the defect [D62](../decisions/adr-0062.md) exists to prevent.

The per-camera choice the operator can have **today** is a view filter in the
viewer, and it already works — see §6.

---

## 1. What `videoclips` is now

`packages/types/src/capabilities/videoclips.cap.ts`:

```ts
name: 'videoclips', scope: 'device', mode: 'singleton', kind: 'wrapper', defaultActive: true
listClips({ deviceId, since, until, limit? }) → readonly Clip[]
getClipPlayback({ deviceId, clipId })         → { playbackUrl, playbackEndpoints?, token? }

Clip = { id, source, kind: 'motion'|'object'|'audio'|'native',
         timeRange: { startMs, endMs }, thumbnail? }
```

One implementer:
`packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts`. It
composes the analytics event log with the recorder's footage — a clip is a time
WINDOW over existing media, never a separate file — and mints ids of the form
`analytics:<startMs>:<endMs>:<eventId>`. `source` is the constant `'analytics'`.

Before tonight it had **one consumer in the whole system**: a "View clip" button
in `addon-admin-ui`'s `EventDetailPanel`, which takes `clips[0]` and opens
`playbackUrl` in a tab. The viewer never called it. The cap is not dead, but it
has never carried a real surface.

Two facts about the cap that matter later:

- **`mode: 'singleton'` forbids plurality by definition.** Exactly one active
  provider, cluster-wide, with an optional per-device override.
- **`getClipPlayback` throws on a foreign id.** `parseClipId` returns null for
  anything it did not mint and the provider raises
  `videoclips: unrecognized clipId`. Any design that flattens two providers'
  clips into one list must therefore route playback by source, at the router —
  it cannot be left to the provider.

## 2. The defect that has to be fixed first

The cap declares `scope: 'device'`. Its generated mount does not resolve per
device:

`server/backend/src/api/trpc/generated-cap-mounts.ts`
```ts
videoclips: createCapRouter_videoclips(
  (_ctx) => reg?.getSingleton<…>('videoclips') ?? null,
```

Compare the neighbouring `vibration`, which uses
`requireDeviceScoped(reg, 'vibration')`. `getSingleton` reads
`state.activeAddonId` and never consults `deviceOverrides` or the bindings
store.

**Consequence: `deviceManager.setWrapperActive` for `videoclips` persists and is
then ignored.** Per-camera substitution of a clip provider does not work today,
and the failure is silent — the store is written, `getBindings` reports it, and
the router serves the global singleton anyway.

`pipeline-analytics` (also `kind: 'wrapper'`, `scope: 'device'`) has the same
mount, so this is a pattern, not a typo. It is exactly the shape D62 names:
*a knob that wrote a store nobody read.*

Two smaller ones, same neighbourhood:

- `videoclips` declares no `deviceTypes`, and `listDeviceScopedCapsForType`
  treats absence as *applies to every device type* — so it is currently offered
  as bindable for a lightbulb.
- `setDeviceCollectionFilter` exists on the registry and is stored, but neither
  `getAllProviders` nor the collection branch of `getProviderForDevice` reads
  it. A per-device collection filter is, today, a third store nobody reads.

**Nothing in this proposal should be built before the first of these is fixed
and proven.** D62's own `audio-classifier` exclusion is the precedent: a toggle
that persists and stops nothing was deliberately NOT surfaced, because "it is
the same mechanism" was not taken on trust.

## 3. The kind: what each option actually buys

### Option A — keep `singleton` + `wrapper`, one provider per camera

The camera's clips come from whichever provider is bound to it: analytics by
default, a vendor provider substituted per device.

- **For:** one resolver (`getProviderForDevice`), [D13](../decisions/adr-0013.md)
  clean; the per-device binding is already the model; `getClipPlayback` keeps
  working because every id in the list came from the bound provider.
- **Against:** it cannot answer the operator's question. "Which sources" is
  plural, and this shape holds exactly one. Substituting the vendor provider
  **replaces** the recording cut-outs rather than joining them — which is not
  what "affiancabili" (side by side) means.

### Option B — `collection`, fan out globally

Every registered provider stays active; `concatCollection` already fans
array-returning methods and flattens the results
(`server/backend/src/api/trpc/cap-mount-helpers.ts`), and the generated
`collection-array-methods.ts` would list `listClips`. Non-array methods do not
fan: they dispatch to one provider chosen by an `addonId` field injected into
the tRPC input — which is precisely the shape `getClipPlayback` needs.

- **For:** plurality is native. `Clip.source` already exists as the
  discriminator a caller echoes back. The two methods split cleanly along the
  fan/dispatch line the mount already implements. No new mechanism.
- **Against:** `concatCollection` fans over the **global** provider list.
  Asking every registered clip provider about camera 101 is
  [D12](../decisions/adr-0012.md) verbatim — *"per-device aggregation walks
  `getBindings(deviceId)` only; a device belongs to exactly one integration"* —
  and its failure mode is the one D12 calls out as the dangerous kind: it
  returns well-formed data. A Reolink camera answered by the Hikvision provider
  produces plausible clips that are not that camera's.

### Option C — `collection`, fanned over the device's BINDINGS  ← recommended

Option B with the D12 defect closed: the device-scoped collection mount resolves
the provider set from `getBindings(deviceId)` — the providers actually bound to
this camera — and fans only across those.

- **For:** everything B buys, without the cross-device leak. The per-camera
  "which sources" question becomes *which providers are bound to this camera*,
  which is a question the bindings store already exists to answer — so the
  selector claims **no new authority** and D62 holds.
- **Against:** two real changes, neither cosmetic:
  1. **The bindings store shape.** Today
     `perDevice[capName] = { wrapperAddonId }` — one id, or an explicit `null`
     marker that stops `getBindings` re-binding the `defaultActive` wrapper. A
     set cannot be persisted in it. This is a change to the AUTHORITY, which D62
     explicitly permits (*"if a function genuinely has no authority, add one
     where the function lives"*), but it is a schema migration, not a selector.
  2. **A device-aware collection resolver.** `getAllProviders` and the
     collection branch of `getProviderForDevice` both ignore the per-device
     filter. Making the filter real is the same work that would fix
     `setDeviceCollectionFilter`, and should be done once, for both.

### Verdict

**C.** B is the right mechanism and D12 is the right constraint; C is what you
get when you refuse to choose between them. A is a smaller change that answers a
different question than the one asked.

Sequencing matters more than the choice:

| Step | What | Gate |
| --- | --- | --- |
| 0 | Fix the mount: `videoclips` resolves per device, not `getSingleton`. Add `deviceTypes: [Camera]`. | A binding flip provably changes what the router serves. |
| 1 | Viewer clip surface on the existing `singleton` cap. | **Done** — see §7. |
| 2 | A SECOND provider exists (onboard or otherwise) and returns real clips. | Until this, there is nothing to select between. |
| 3 | `mode → 'collection'`, device-bindings-scoped fan-out, `addonId` dispatch on `getClipPlayback`. | §4. |
| 4 | The per-camera server-side source selector. | §6. |

## 4. The contract

Unchanged where it can be. The clip shape is already right and the viewer is
already built against it.

```ts
listClips({ deviceId, since, until, limit?, cursor? })
  → { clips: readonly Clip[], nextCursor?: string }

Clip = {
  id:        string          // provider-namespaced, opaque
  source:    string          // 'analytics' | 'native:<vendor>' | …
  kind:      'motion' | 'object' | 'audio' | 'native'
  timeRange: { startMs, endMs }
  thumbnail?: string
}

getClipPlayback({ deviceId, clipId, addonId? }) → ClipPlayback
```

Four notes, each load-bearing:

**Pagination.** The only change to `listClips`'s shape. A night of event clips on
a busy camera is a few hundred rows; a fanned list across three providers over a
week is not. `limit` alone silently truncates — which end it truncates is
undefined once results are flattened. An envelope with `nextCursor` is the
minimum honest shape. (When this was written the generated `AppRouter` sat at
TypeScript's expansion limit and no cap could gain a method; that cliff was
removed on 2026-07-30 with Zod-derived API types, so the shape here is a design
choice, not a constraint.)

**`addonId` on `getClipPlayback` is not a new concept** — the generated
collection mount already strips `addonId` out of the input and uses it to pick
the provider. The caller derives it from the `Clip.source` it is playing. This
is the fix for "the analytics provider throws on a foreign id": the id never
reaches the wrong provider.

**`source` is presentation and dispatch, never resolution.** D13: the resolver is
`getProviderForDevice`, and `kind` is metadata for the UI. `source` may pick
which provider answers a playback request for a clip that provider minted; it
must never become an `if` that decides which provider to ASK for a device.

**Recording-derived clips need no playback URL at all.** D31: recorded media
moves by HTTP byte range through the segment's own `mfra`, and there is no
second path. The viewer plays an `analytics` clip by seeking the recorded
transport to `timeRange.startMs` — the clip IS a time window. `getClipPlayback`
returning an HLS master is correct only for the admin panel's "open in a tab";
a clip surface that consumed it would be growing the second byte-moving path
D31 forbids.

### The providers

**`analytics` (exists).** Analytics events widened by `EVENT_PAD_MS`, over the
recorded read path. Nothing to build. Two things to fix when it becomes one of
several: it must tolerate being asked about a device it has no events for
(return `[]`, not an error), and `getClipPlayback` must keep rejecting foreign
ids — with the router, not the provider, ensuring it never sees one.

**`native:<vendor>` (does not exist, at all).** A grep across `packages/` for
`playbackURI`, `GetRecordingSearchResults`, `FindRecordings`,
`/ISAPI/ContentMgmt`, `SearchDescription`, `RecordingSearch`, `trackSearch`
returns **zero hits**. There is no ISAPI recording search, no ONVIF
Recording/Search/Replay client, no Reolink `Search`/`Download`. The `'native'`
value in `Clip.kind` and the `native:<vendor>` convention in `Clip.source` are
placeholders with nothing behind them, and the original design doc said so
deliberately (*"no native provider is built now"*). A native provider is a
from-scratch integration per vendor, and it is the thing that has to exist
before step 3 is worth doing.

**`hksv` — not a provider.** HKSV is real and recent
(`packages/addon-export-hap/src/hksv/`), but it is a **sink, not a source**:
`HksvRecordingDelegate` streams fragments out over HDS and iOS/iCloud keeps the
clip. There is no CamStack-side record, id, or catalog to list. HKSV is a
candidate *consumer* of this contract — `fmp4-fragment-child.ts` already names
"a future CamStack clip source" beside `HksvFragmentSource` — not a candidate
provider. **The operator's "even the HomeKit clips" is not reachable without
Apple returning them, which HKSV does not do.** This is worth saying plainly
before anyone estimates it.

**One more that already exists and is not on this list on purpose:**
`recordingExport` produces the only persisted clip ARTIFACT with an id and a
lifecycle (`ExportRecord`, `state`, `expiresAt`, download URL). It is
operator-authored, not automatic, so it does not belong in a clip catalog — but
if the operator later wants "my exports on the ribbon", it is the one source
that needs no new machinery at all.

## 5. What NC clips are, and why they are not on the ribbon

The notification centre's clip does **not** come from a recording. It comes from
the stream broker's pre-buffer ring
(`streamBroker.renderPreBufferClip`) — deliberately, because only finalized
segments are addressable and the one covering the moment is still being written,
so a segment-sourced clip either arrives late or shows the approach instead of
the event. It also means a camera that is not recording can still produce a
notification clip.

The artifact is bytes plus a bounded scratch (`NcArtifactStore`: default 6 h /
500 entries, swept on boot, *"a BOUNDED SCRATCH, not a media library"*). There
is **no `clipId`, no catalog, no listing**, and after expiry it is not
addressable at all.

So: an NC clip is not a `videoclips` clip and must not be made to look like one.
The right relationship is the reverse — the ribbon can show the analytics clip
covering the same moment, because both are anchored to the same event.

## 6. The per-camera selector, and the two different questions inside it

"Choose which clip sources to show for this camera" is two questions wearing one
sentence:

1. **Which providers ANSWER for this camera** — a server fact, persisted, shared
   by every client, with a cost when off (a provider that is not bound is not
   polled). This is a device BINDING. Under D62 the switch stores nothing and
   names its authority: `deviceManager.setWrapperActive` (today) or its
   set-valued successor (Option C). Availability is derived from
   `listBindableCapsForDeviceType` — *"a capability with no registered wrapper
   is not a switch; nothing could apply it"* — and off is reported off.

2. **Which of the returned sources this VIEWER draws** — a display filter. It
   costs nothing, is per-person rather than per-system, and belongs beside the
   timeline's existing kind and class filters.

Today, question 1 has **one possible answer** (`analytics` is the only
provider), so a switch for it would be a control that cannot change anything —
D62's `audio-classifier` case exactly. Question 2 is real the moment a camera
has two sources, and is what the viewer implements now.

**They must never be merged into one control.** A single "source" toggle that
sometimes unbinds a provider and sometimes just hides it is the second switch
that disagrees with the first — the failure D62 was written for.

## 7. What already shipped (viewer)

Built tonight against the existing `singleton` cap, no server change:

- `camstack/src/clips/clip-model.ts` — `Clip`, open `ClipSourceId`,
  `ClipPlaybackRef` (`recorded` | `url`), source descriptors with a
  `native:<vendor>` fallback so a source the hub grows renders without a viewer
  release.
- `camstack/src/clips/clip-timeline.ts` — the ribbon: proportional clip
  segments, **fixed-height** collapsed-gap rows, epoch↔pixel mapping, the
  `resolveClipAdvance` "no holes" decision, auto-follow offset, gap labels.
  57 unit tests, three mutations verified to fail it.
- `camstack/src/clips/clip-mapping.ts` — the `videoclips.listClips` boundary
  parser; drops rows it cannot draw.
- `camstack/src/data/use-clips.ts` — `videoclips.listClips` via `capQuery`.
- `camstack/src/components/camera/clips/` + `theater/TimelineClipsPanel.tsx` —
  the surface, as a panel that takes over the timeline body.
- Per-camera source filter in `camera-prefs-store` (`clipSources`, empty = all).

Two things the viewer proved that this proposal depends on:

- **A recording-derived clip needs no player and no URL.** `onPlayFrom(startMs)`
  on the existing recorded transport is the whole of playback, and the "no
  holes" behaviour is one seek per clip end. Whatever the cap becomes, it should
  not acquire a second way to move those bytes.
- **`Clip.source` is enough to render a multi-source ribbon.** The viewer
  colours segments, groups chips and filters by it today, with only
  `'analytics'` ever arriving. The contract does not need a richer source
  descriptor; it needs a second provider to put in it.

## Open questions

- Does the device-scoped collection resolver belong in `capability-registry`
  (alongside `getProviderForDevice`) or in `cap-mount-helpers` (alongside
  `concatCollection`)? The registry is where D13 says resolution lives; the
  helper is where the fan-out is. Probably: registry returns the bound set, the
  helper fans it.
- `DeviceBindingsStore` set-valued migration: does the explicit-`null` "do not
  re-bind the default wrapper" marker survive as an empty array, or does it need
  to stay a distinct state? An empty array and "never chose" are not the same
  fact.
- Is `limit` on `listClips` worth deprecating in favour of `cursor` outright, or
  do both stay? The admin panel's `clips[0]` caller wants a limit of 1.

## Addendum 2026-08-08 (pomeriggio) — the HKSV tee: the second provider exists after all

The blocker "there is nothing to select between" has an answer the morning
draft could not see, because HKSV recording was not yet live: **the fragments
CamStack streams to a HomeKit controller pass through our own fMP4 plane** —
iCloud keeps its copy, but nothing stops us from persisting the same bytes.

**The tee provider**: when the HKSV delegate serves a recording stream
(motion-triggered by the controller, prebuffer included), tee the identical
init+fragments into a local clip store and register each landed clip in
`videoclips` under its own source id. Properties that make it the cheapest
possible second provider:

- zero extra capture cost — the child, the window and the bytes already exist
  for HomeKit; the tee is a second writer on a stream already flowing;
- the trigger policy is HomeKit's own (its motion gating, its When-Home/Away
  modes) — the clips mirror exactly what the operator's Home timeline shows,
  which is also its limitation: no HKSV recording, no tee clip;
- it lands exactly the multi-source shape the ribbon's source chips were built
  for (recording-cuts vs tee clips per camera).

Open points for the implementation session: retention for tee clips (they are
redundant with the continuous recorder where recording is enabled — the tee is
most valuable on cameras WITHOUT continuous recording); the store (the clip
ring's successor or the recorder's directory layout); and the scope-device
mount fix which remains a prerequisite for per-camera source selection.

## Addendum 2026-08-16 — recording-clip thumbnail is the main event snapshot

Collection-mode `videoclips` still generates stills **on the server** and
stores them under the device folder on `recordingsLow`; how a still is *made*
stays inside the provider.

For the **recording** provider (events-mode visits today; continuous
event+fragment visits when that path ships) the how-to-make is fixed:

> The clip thumbnail is the **snapshot of the main event of the interval**.
> Do not extract a frame from the recorded segments.

**Main event** = the overlapping analytics event that already owns
`Clip.kind` (object > motion > audio); if several of that kind overlap, the
one that has a still. **Snapshot** = `getEventMedia({ eventId, kind:
'snapshot' })` (`?kind=snapshot` on the event-media URL). Missing snapshot
blob → the event’s default still (`mediaUrl`) is allowed; never a frame from
the recording. No still at all → omit `thumbnail`. Onboard and HKSV providers
are unchanged (their own still pipeline). See
`2026-06-15-recording-modes-and-videoclips-design.md` (planning repo: superpowers/specs/2026-06-15-recording-modes-and-videoclips-design.md)
§5.1.
