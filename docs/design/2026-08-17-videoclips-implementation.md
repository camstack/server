# Videoclips — the implementation spec (visits, the per-device mount, and the snapshot guarantee)

> Status: **spec only, 2026-08-17. Nothing here is implemented.** This document
> is the executable follow-up to
> [`2026-08-08-videoclips-timeline.md`](2026-08-08-videoclips-timeline.md) (which
> answered *what should `videoclips` become*) and to the analysis in
> (planning repo: sessions/shipped.md) §"Session 17 afternoon" (which answered *which of the three <!-- drift-ok: moved to the private planning repo -->
> clip identities is real*). Read both first; neither is restated.
>
> Required background: [capabilities.md §"Wrapper mounts must resolve per
> device"](../architecture/capabilities.md#wrapper-mounts-must-resolve-per-device),
> [post-analysis.md §"Disk-wins reconcile"](../architecture/post-analysis.md#disk-wins-reconcile),
> [D12](../decisions/adr-0012.md), [D13](../decisions/adr-0013.md),
> [D31](../decisions/adr-0031.md), [D62](../decisions/adr-0062.md).
>
> **One decision is deliberately left to the operator** (§9). Everything else in
> this document is decided, with the reasoning attached.

---

## 1. Three identities, and the one this ships

The word "videoclip" covers three unrelated things in this system. Fusing them
into one screen is the single most expensive mistake available here, so they are
named before anything is designed.

| # | Identity | What it actually is | Ships here? |
| --- | --- | --- | --- |
| 1 | **Analytics windows** | A query-time WINDOW over footage the recorder already wrote, annotated with the analytics events that overlap it. Visit grain `VISIT_MERGE_GAP_MS` (30 s) when `recording.getAvailability` answers; per-event pad `EVENT_PAD_MS` (−5 s/+10 s) when it does not. Id `analytics:<startMs>:<endMs>:<eventId\|visit>`. No file, no id lifecycle, no retention sweep. | **YES — this is the whole of this spec.** |
| 2 | **Native onboard clips** | A catalog the CAMERA or a controller keeps. `Clip.kind: 'native'` is a placeholder with nothing behind it: a grep for `playbackURI` / `FindRecordings` / ISAPI `ContentMgmt` returns zero hits. HKSV is a **sink** — `HksvRecordingDelegate` streams fragments toward iCloud and Apple never hands them back; the fragment tee proposed on 2026-08-08 was never built. | **No.** Blocked on §2 *and* on a provider that does not exist. |
| 3 | **Recording footage** | The archive itself. Already has two complete surfaces: the theater timeline (to scale, with availability bands) and `recordingExport` (the only persisted clip ARTIFACT, with an id, a `state` and an `expiresAt`). | **No — and it must not become a gallery of clip files.** |

Two more things that look like clips and are not: the notification-centre clip
(pre-buffer bytes in a bounded scratch, no id, no catalog, expires) and an
export record (operator-authored, not automatic). Neither goes on the ribbon.

**The consequence for naming.** The surface this spec adds is called **Visits**,
not "Clips" and not "Videoclips". A visit is an interval of footage with things
that happened inside it. Calling it a clip invites exactly the question the
product cannot answer — *where is the file?* — and would make identity 2's
absence read as a bug.

---

## 2. Prerequisite: the mount must resolve per device

> **LANDED 2026-09-20** (slice 1). M1–M6 are in the tree; M3 needed no edit
> (`isBuilderMounted` is `kind !== 'skip'`). Two things below were written from
> reading and are wrong in a way that matters: there are **eight** device-scoped
> wrapper caps, not two, and 39 of their methods carry no `deviceId`, so the
> mount applies PER METHOD — see
> [D552](../decisions/adr-0552-a-device-scoped-wrapper-mount-dispatches-only-the-methods-that-name-a-device.md).

`videoclips` is `scope: 'device'`, `kind: 'wrapper'`, `mode: 'singleton'`,
`defaultActive: true`, `deviceTypes: [DeviceType.Camera]`
(`packages/types/src/capabilities/videoclips.cap.ts`). Its mount resolves the
GLOBAL singleton. `deviceManager.setWrapperActive` for this cap therefore
persists, `getBindings` reports it, and the router serves the global provider
anyway — silently. That is the [D62](../decisions/adr-0062.md) shape verbatim: a
knob that wrote a store nobody read.

### 2.1 Where the decision actually lives

The 2026-08-08 document, and the roadmap line, both point at
`server/backend/src/api/trpc/generated-cap-mounts.ts:1271`:

```ts
videoclips: createCapRouter_videoclips(
  (_ctx) => reg?.getSingleton<InferProvider<typeof videoclipsCapability>>('videoclips') ?? null,
```

That line is **type-only today**. `server/backend/src/api/trpc/trpc.router.ts`
imports `mountAllCaps` with `import type` (line 73) and never calls it — the
comment at line 380 says so outright; the VALUE comes from the runtime builder
(`buildRuntimeCapRouters`, wired by
`server/backend/src/api/trpc/cap-router-runtime.ts`). The runtime switch is at
`cap-router-runtime.ts:332`:

```ts
case 'device-native':
  return requireDeviceScoped(reg, capName)
case 'collection':
  return resolveCollectionProvider(reg, capName, addonId)
// singleton / per-node / hub-only resolve the active singleton.
default:
  return reg?.getSingleton<ResolvedProvider>(capName) ?? null
```

and the kind comes from ONE function,
`packages/types/src/capabilities/capability-definition.ts:696`:

```ts
export function resolveCapMount(def: CapabilityDefinition): CapabilityMountHint {
  if (def.mount) return def.mount
  if (def.deviceNative === true) return { kind: 'device-native' }
  if (def.mode === 'collection') return { kind: 'collection' }
  return { kind: 'singleton' }
}
```

So the defect is real and unchanged, but **it is not a codegen bug — it is a
classification bug in `resolveCapMount`**, which the codegen mirrors
(`scripts/generate-cap-mounts.ts:225` branches on the same
`deviceNative === true`). A fix applied only to the generated file would change
the AppRouter TYPE and nothing at runtime: the worst possible outcome, because
the type would then claim a per-device mount that does not happen.

`vibration` is the correct contrast **only because it is `deviceNative: true`**,
not because its mount was hand-corrected.

### 2.2 What changes

A new mount kind, derived — not a per-cap `mount:` hint. A hint on
`videoclips` alone would leave `pipeline-analytics` (the second device-scoped
wrapper, same defect) broken and would leave the next such cap broken by
default.

| # | File | Change |
| --- | --- | --- |
| M1 | `packages/types/src/capabilities/capability-definition.ts` | Add `'device-scoped'` to `CapabilityMountKind`. In `resolveCapMount`, after the `deviceNative` branch: `if (def.scope === 'device' && def.kind === 'wrapper') return { kind: 'device-scoped' }`. Document why it is not `device-native` (there is no native provider; the resolver is the D13 one). |
| M2 | `server/backend/src/api/trpc/cap-router-runtime.ts` | `case 'device-scoped': return requireDeviceScoped(reg, capName)` — the SAME dispatcher, which already falls through native → `getProviderForDevice` (the D13 fallback lives in `cap-mount-helpers.ts` and is exercised today by `virtual-doorbell`). No new resolver is written. |
| M3 | `packages/system/src/kernel/cap-router-builder.ts` | `isBuilderMounted('device-scoped') === true`, and `systemMountKindFor` keeps mapping a `systemOnly` method to `singleton` / `collection` — a batch method taking `deviceIds` must never enter the per-device dispatcher, which rejects any input without a numeric `deviceId`. |
| M4 | `scripts/generate-cap-mounts.ts` | `emitMountLine` calls `resolveCapMount` instead of re-deriving from `deviceNative` / `mode`. The two classifications stop being two. |
| M5 | `npm run codegen` | Regenerates `generated-cap-mounts.ts` so `videoclips` **and** `pipeline-analytics` read `requireDeviceScoped`. Not cosmetic: `scripts/codegen.ts` carries a drift guard over {mounted, skipped}, and the AppRouter type is derived from this file. Skipping it is silent drift — the rule, not an opinion. |
| M6 | `scripts/check-device-scoped-wrapper-mounts.ts` (landed 2026-09-20) | Fails when any cap with `scope: 'device'` + `kind: 'wrapper'` resolves to mount kind `singleton`. Wired into `.github/workflows/ci.yml`. Modelled on `scripts/check-clip-crop-single-owner.ts`. **Prefer a guard to a paragraph** — this defect survived two documents that described it correctly. |

No method signature changes, so **no SDK regeneration and no viewer release are
required by M1–M6**. The `@camstack/types` + `@camstack/system` change ships on
the framework train (`docs/architecture/update-and-release.md`);
`resolveCapMount` is read at router build time, so the behaviour arrives with the
framework, while the regenerated type file lands with the next
`@camstack/server`.

### 2.3 The regression risk, stated

`requireDeviceScoped` returns a Proxy that is **never null while a registry
exists**. `getSingleton` returning null is what makes the generated router fall
through to `remoteProxy`. Flipping the mount therefore removes the remote-proxy
fallback for this cap and replaces it with a per-device `PRECONDITION_FAILED`
when nothing resolves.

For `videoclips` that is acceptable and verifiable: `resolveForDevice`
(`packages/system/src/kernel/capability-registry.ts`) falls back to the global
active singleton whenever `isActiveForDevice` holds, so an unbound camera keeps
being answered by `addon-post-analysis` exactly as today. The two behaviour
changes are the intended ones: a per-device binding now takes effect, and a
per-device deactivation now stops the cap.

**Phase-1 verification is a test, not a reading.**
`motion-device-native-route.spec.ts` and `harness.ts` under
`server/backend/src/__tests__/cap-routers/` already drive the real builder; the
new spec registers TWO providers, binds the second to one device, and asserts
`listClips` for that device is answered by the second while another device still
gets the first. Revert M1 and it must go red.

**Nothing else in this spec depends on M1–M6 except the parts that say so.** The
Visits surface reads the cap through the ordinary singleton fallback and works
today; the mount fix is a prerequisite for a SECOND provider and for
`mode: 'collection'`, not for shipping identity 1.

---

## 3. The hub / cap surface

### 3.1 What stays exactly as it is

- A clip is a query-time window. **No clip file is ever persisted, and no clip
  retention sweep is ever added.** SQLite is an index; the filesystem is the
  source of truth (post-analysis.md §"Disk-wins reconcile").
- The visit grain, the ids, `holes`, `eventIds`, `kind` precedence
  (object > motion > audio) — all live and all covered by
  `packages/addon-pipeline/src/recorder/addon/__tests__/videoclip-visits.spec.ts`.
- `getClipPlayback` keeps returning an HLS master for the admin
  `EventDetailPanel`. It stays the ONLY consumer. The viewer plays a visit by
  seeking the recorded transport ([D31](../decisions/adr-0031.md)); a second
  byte-moving path is not created.
- The recorder is not touched. The gaps an operator sees in `mode=events` are
  real (pre/post 10 s/30 s buffers, `RecordingIndex` merges only gaps ≤ 5 s).
  Visits are how the surface tells the truth about them, not a way to hide them.

### 3.2 Two output-shape changes on `listClips` (no new methods)

When this was written a cap method could not be added at all — the generated
`AppRouter` sat at TypeScript's expansion limit. That cliff was removed on
2026-07-30 (`scripts/generate-api-types.ts` derives cap procedures from the Zod
definitions; `docs/roadmap.md` § "codegen cliff"), so a method is no longer <!-- drift-ok: moved to the private planning repo -->
forbidden. The two changes still ride `ClipSchema` because they are
output-shape changes, not because a method cannot be added:

```ts
// packages/types/src/capabilities/videoclips.cap.ts — sketch
export const ClipSchema = z.object({
  // … id, source, kind, timeRange, eventIds, holes unchanged …

  /**
   * The main event's snapshot URL — emitted ONLY when the provider has
   * verified that a media blob exists for that event. Absent is meaningful:
   * "this visit has no event still", never "we did not look".
   */
  thumbnail: z.string().optional(),

  /**
   * An instant INSIDE this visit's footage, hole-safe, where a recorded still
   * can be decoded. Present whenever the visit came from availability.
   *
   * This is not a thumbnail and not a second byte path: it is the argument to
   * the recorder's existing still route. The surface — never the provider —
   * decides whether to use it.
   */
  stillAtMs: z.number().optional(),
})
export type Clip = z.infer<typeof ClipSchema>
```

`stillAtMs` is computed by the provider because only the provider holds the
visit's `ranges` and `holes`: the midpoint of the LONGEST contiguous range, not
the midpoint of the visit. A visit spans its holes by construction, so a naive
midpoint lands in dead air about as often as not, and the still route would
answer 204 for a visit that has plenty of footage.

Rejected alternative: return `thumbnail` pointing at the still route when no
event still exists. That would make the provider mint a recording-derived
thumbnail, which the 2026-08-16 addendum forbids for good reason (the event
snapshot is the semantically right picture and it is free), and it would hide
"this visit has no event" behind a picture that looks identical to one that does.

### 3.3 `thumbnail` must be VOUCHED, and today it is not

This is the defect behind the operator's acceptance criterion.

`AnalyticsQueryFacade.withMediaUrl`
(`packages/addon-post-analysis/src/pipeline-analytics/analytics-query-facade.ts`)
stamps a `mediaUrl` on **every** event, unconditionally, whenever the
event-media plane is up:

```ts
return events.map((e) => ({ ...e, mediaUrl: `${base}/${e.id}` }))
```

`visitsToClips` then picks a thumbnail with
`attached.find((a) => a.kind === kind && a.event.mediaUrl)` — a test that is
true for every event in the system. So `Clip.thumbnail` is **always present and
sometimes dead**: the URL resolves through `readEventThumbnail` →
`resolveDefaultEventMedia`, which returns null (→ 404, → empty tile) when the
event owns no media and its owning track owns none either.

That class is not hypothetical and not rare:

- **Motion stills are best-effort and only on the transition.**
  `MotionEventSnapshotCapturer` (`services/motion-event-snapshot.ts`) fires only
  on `transitionedOn`, waits at most `MOTION_EVENT_SNAPSHOT_TIMEOUT_MS`
  (2 500 ms), never sets `force` (a sleeping battery camera answers stale or not
  at all), and swallows every failure — deliberately, because the motion ROW is
  the durable record. A miss leaves an event with no still, forever; nothing
  retries.
- **Heartbeat motion rows never get one at all** (the e2e spec asserts this
  explicitly: `expect(hbMedia.some((m) => m.kind === 'snapshot')).toBe(false)`).
- **Those events exist in bulk.** The 2026-08-17 disk-wins reconcile dropped
  **4 063** trackless snapshot-less motion/audio events born after the first
  pass (devices 104, 111, 103, 112). Between the capture miss and the reconcile,
  every one of them was a listable clip with a dead thumbnail.

**The rule this spec adds:** the provider emits `thumbnail` only for an event it
has confirmed owns at least one media row. The confirmation is one batched index
query, not a blob read (§7.2). Everything else gets no `thumbnail` and a
`stillAtMs`.

### 3.4 A second, subtler hole: the query window clips the still away

`listClips(since, until)` fetches events strictly inside the window, and
availability strictly inside it too. A visit that straddles `since` therefore
keeps its heartbeat rows and loses the transition row that carries the only
snapshot — a thumbnail that exists disappears because of where the operator
scrolled.

Fix: fetch events (and availability) with a left overhang of
`VISIT_MERGE_GAP_MS + EVENT_PAD_MS.preMs`, then drop clips that do not intersect
`[since, until)`. Cheap (one wider range scan on an indexed column) and it is
the difference between a stable list and one that changes picture with scroll
position.

### 3.5 Logging

Every line the provider writes about a camera carries `tags: { deviceId }` with
the numeric id — the existing `logWarn` wiring in
`packages/addon-post-analysis/src/pipeline-analytics/index.ts` already does this
and the shape is not to be broken:

```ts
logWarn: (message, meta) =>
  this.ctx.logger.warn(message, { tags: { deviceId: Number(meta['deviceId']) }, meta }),
```

Three new lines, all tagged, because each marks work that was silently dropped:

| Event | Level | Why it cannot be silent |
| --- | --- | --- |
| `videoclips: visit has no vouched still` (count per call, not per clip) | info | This is the operator's acceptance criterion turning into a number. A rising count is the motion-snapshot capturer failing on that camera. |
| `videoclips: availability read failed — listing unfiltered` (exists) | warn | Already there; keep. The filter fails OPEN, and a fallible read must never empty a list. |
| `videoclips: clip window has no footage in the index` (from `getClipPlayback`) | warn | `getAvailability` answers from the CALENDAR; `getPlaybackManifest` answers from the segment INDEX. They can disagree while a window is unhydrated — the exact bug `recording-export-provider.spec.ts` pins for exports ("no footage for 101/low" while availability listed four ranges). A clip that lists and refuses to play must say which side said no. |

---

## 4. The viewer surface

Half of this exists. The half that does not is the half the operator has never
been able to open.

### 4.1 What already ships (do not rebuild)

- `camstack/src/clips/clip-model.ts` — `Clip`, open `ClipSourceId`,
  `ClipPlaybackRef`, source descriptors with a `native:<vendor>` fallback.
- `camstack/src/clips/clip-timeline.ts`, `clip-axis.ts` — the ribbon and the
  compressed axis: proportional clip segments, fixed-height ellipsis rows,
  `resolveClipAdvance` (the "no holes" decision). Pure, heavily unit-tested.
- `camstack/src/clips/clip-mapping.ts` — the `listClips` boundary parser; drops
  rows it cannot draw.
- `camstack/src/data/use-clips.ts` — `videoclips.listClips` via `capQuery`, with
  an immutable-past `staleTime` and a 500-row ceiling.
- `camstack/src/components/camera/theater/TheaterTimeline.tsx` — **clips MODE**
  (`clipsMode` state, compressed axis, one cluster card per visit via
  `clip-clusters.ts`), plus `TimelineClipsPanel.tsx` as the panel form.
- Per-camera source view-filter in `camera-prefs-store` (`clipSources`, empty =
  all), and `v2.clips.*` in `locales/en.json` / `locales/it.json`.

So on the CAMERA surface, "timeline ellipses" is already the shipped behaviour.
What is missing there is only the tile fallback (§4.4).

### 4.2 New: the Library "Visits" section

`camstack/src/screens/library-sections.ts` today declares
`'events' | 'artifacts' | 'exports'` and says *"Videoclips is deliberately
absent."* That comment is what changes.

| Piece | File | Detail |
| --- | --- | --- |
| Section key | `camstack/src/screens/library-sections.ts` | `LibrarySectionKey` gains `'visits'`. `LIBRARY_SECTION_ORDER = ['events', 'visits', 'artifacts', 'exports']` — second, because it is footage-first and the operator reaches for it right after Events. `DEFAULT_LIBRARY_SECTION` stays `'events'`: the tab keeps route `/events` and every shared `camstack://events?trackId=…` link must land where it always did. |
| Param alias | same | `librarySectionFromParam` maps the legacy `?section=videoclips` onto `'visits'`. The roadmap records that param as "null today"; a link shared while it was null must not stay null. `trackId` still outranks `section` (unchanged). |
| Label keys | same + both locales | `v2.library.sections.visits` → EN "Visits" / IT "Visite". |
| Shell | `camstack/src/screens/LibraryScreen.tsx` | One more branch, `<VisitsScreen embedded />`. The shell keeps owning only the section state. |
| Screen | `camstack/src/screens/visits/VisitsScreen.tsx` (new) | §4.3. |
| Hook | `camstack/src/data/use-visits.ts` (new) | §4.3. |
| Tile | `camstack/src/components/visits/VisitTile.tsx` (new) | §4.4. |
| Nav out | `camstack/app/(app)/camera/[id].tsx` + `CameraDetailScreen` + `TheaterTimeline` | A new optional `?clips=1` beside the existing `?at=<epochMs>`, plumbed to `TheaterTimeline`'s initial `clipsMode`. Tapping a visit opens the camera already seeked AND already in clips mode. Without the second half the operator lands on the to-scale timeline and the visit they tapped is a hairline. |

### 4.3 `VisitsScreen` and its data

The screen is: a day, a camera scope, and a list of visit cards newest-first,
grouped by camera when more than one is in scope.

- **Day navigation** reuses `camstack/src/recording/day-nav.ts` — the same ‹/› +
  date semantics the theater uses. A visit list is a day's list.
- **Camera scope** reuses the Events page's camera filter chips and its stored
  selection. Empty selection = all enabled cameras, the convention already used
  by `filterClipsBySources` and the timeline filters.
- **Data**: `use-visits.ts` issues **one independent `useQuery` per camera**,
  keyed `['v2','visits',deviceId,dayFromMs,dayToMs]`, each reusing
  `useCameraClips`'s parser. Deliberately NOT one `Promise.all`:
  `camstack/src/data/use-tracks.ts` carries the scar — fanning per camera and
  merging meant "first paint blocked on the slowest camera". Here the fan-out is
  unavoidable (there is no multi-device `listClips`, §7.4), so the mitigation is
  that **each camera paints when it lands** and none waits for another. In-flight
  concurrency is capped (§7.3).
- **Ordering** is stable and total: `startMs`, then `endMs`, then `clipId` —
  `normalizeClips` already does this, and reusing it keeps two orderings from
  disagreeing.

**States, all four required.** A surface that shows the same thing for "nothing
happened" and "we could not ask" is the failure `use-recording.ts` documents at
length (a read failure drawn as an empty heatmap is a lie about the archive).

| State | Condition | What is drawn |
| --- | --- | --- |
| Loading | first fetch, no cached rows | Skeleton cards per camera in scope; the day header is already correct. |
| Empty (honest) | every camera answered, zero visits | "No footage on this day" + the day nav. Distinct copy per cause when known: a camera with `recording.getDeviceConfig.mode === 'off'` is reported as **switched off**, never as empty ([D62](../decisions/adr-0062.md): an off switch is reported off, disabled must never look like broken). |
| Degraded | at least one camera's query FAILED | The cameras that answered are drawn; a per-camera notice names the ones that did not, with a retry. Never a global empty. |
| Offline | `state !== 'connected'` | The offline notice the other screens use; the last successfully loaded day stays visible (`placeholderData`), marked stale. |

### 4.4 The tile: a picture on every card

One pure resolver, one component, three tiers. The resolver is pure so it is
testable without a renderer — the same reason the ribbon geometry is pure.

```ts
// camstack/src/clips/clip-tile.ts — sketch
export type ClipTileSource =
  | { readonly kind: 'eventSnapshot'; readonly url: string }
  | { readonly kind: 'recordedStill'; readonly atMs: number }
  | { readonly kind: 'glyph'; readonly clipKind: ClipKind }

export type ClipTileTier = 'eventSnapshot' | 'recordedStill'

export interface ClipTileInput {
  readonly clip: Clip
  /** Tiers already known to have failed for THIS clip (image onError). */
  readonly failed: ReadonlySet<ClipTileTier>
}

export function resolveClipTile(input: ClipTileInput): ClipTileSource { /* … */ }
```

1. **`eventSnapshot`** — `clip.thumbnailUrl` when the hub vouched for it (§3.3).
2. **`recordedStill`** — `clip.stillAtMs` through the EXISTING
   `camstack/src/data/still-media-url.ts`
   (`/addon/recorder/still/<deviceId>/<epochSec>`, authenticated, `image/jpeg` or
   204). `camstack/src/components/camera/theater/ExportFramePreview.tsx` is the
   working precedent, including the `Authorization` header, the
   `cachePolicy: 'memory-disk'` and the latch-failure-to-an-instant rule
   (`isStillPreviewFailed`) — a boolean `failed` flag would stick across rows.
3. **`glyph`** — the kind icon. Reached only when tier 1 is absent/failed AND
   tier 2 is absent or answered 204. This is the ONLY legal empty tile, and §6
   makes it a counted, asserted case rather than a shrug.

Tier 2 requests are made **only for on-screen rows** (the list virtualises) — the
still route decodes with ffmpeg, capped at 3 concurrent with a queue of 8, and it
must never be handed a whole day's worth of rows at once.

Note what tier 2 is not: it is not `videoclips` minting a recording thumbnail
(§3.2), and it is not a new byte path — it is the export dialog's existing still
endpoint, used by the surface that already has the right to play those bytes.

### 4.5 i18n

New keys, EN + IT, both files (`camstack/locales/en.json`,
`camstack/locales/it.json`), same nesting style as `v2.clips.*`:

```
v2.library.sections.visits          Visits / Visite
v2.visits.title                     Visits / Visite
v2.visits.subtitle                  {{count}} visits · {{duration}} of footage
v2.visits.empty                     No footage on this day / Nessun filmato in questa data
v2.visits.emptyRecordingOff         Recording is off for this camera / Registrazione disattivata per questa telecamera
v2.visits.loadFailed                Couldn't read {{camera}} / Impossibile leggere {{camera}}
v2.visits.retry                     Retry / Riprova
v2.visits.offline                   Not connected / Non connesso
v2.visits.card                      {{clock}} · {{duration}}
v2.visits.holes_one                 {{count}} gap / {{count}} interruzione
v2.visits.holes_other               {{count}} gaps / {{count}} interruzioni
v2.visits.noStill                   No still / Nessuna immagine
v2.visits.openInTheater             Open in timeline / Apri nella timeline
```

`_one`/`_other` plural suffixes as in `v2.clips.summary_*`. `v2.visits.card`
takes a pre-formatted duration so it reuses `formatGapLabel`'s unit keys rather
than inventing a second duration vocabulary.

---

## 5. The snapshot guarantee

The operator's acceptance criterion, stated precisely enough to fail a test:

> **Every visit listed by `videoclips.listClips` renders a picture, and no listed
> visit carries a thumbnail URL that resolves to no bytes.**

Three clauses, because the naive version ("every clip has a snapshot") is either
false (identity 1 includes footage-only visits) or forces the provider to
fabricate one.

| # | Clause | Owner | Falsifiable how |
| --- | --- | --- | --- |
| G1 | A clip carries `thumbnail` **only if** a media row exists for that event. | provider (§3.3) | Integration: a clip whose `thumbnail` is set must have `getEventMedia` return ≥ 1 file. Zero exceptions. |
| G2 | A clip derived from availability always carries a `stillAtMs` that lies inside footage. | provider (§3.2) | Unit: `stillAtMs` never falls in a `holes` entry, and always inside some `ranges` entry. |
| G3 | Every card renders tier 1, 2 or 3, and tier 3 only when 1 and 2 both had nothing. | viewer (§4.4) | Unit on `resolveClipTile` + a wiring spec on the card. |

**What this is NOT:** a promise that a `mode=events` camera with a dead snapshot
cap shows a photograph of the event. Tier 2 shows footage from the visit instead,
which is honest. G1 is the part that was silently false.

**Interaction with the disk-wins reconcile.** A reconcile pass deletes the
snapshot-less trackless events entirely, so it REDUCES the tier-2 population by
removing rows — it does not repair them. Nothing in this spec re-fetches pixels
for a ghost row, and nothing here runs on a schedule. `listClips` never asks "how
old is this row"; it asks "does this event own a blob".

---

## 6. The test matrix

Five levels. Every level names the mutation that must turn it red — a green suite
proves nothing here, and this repo has twice had a test pass because the fake
supplied a value production forgot to fetch.

### 6.1 Pure unit — `videoclip-visits.spec.ts` (extend)

| Case | Assertion | Mutation that must fail it |
| --- | --- | --- |
| T1 | Visit with an object event that HAS media → `thumbnail` = that event's URL, `kind: 'object'` | swap the `KIND_ORDER` precedence |
| T2 | Visit whose dominant-kind event has NO media but a motion event does → `thumbnail` = the motion event's URL, `kind` still `'object'` | drop the second `find` |
| T3 | Visit where NO attached event has media → `thumbnail` **absent**, `stillAtMs` present | make `thumbnail` fall back to `mediaUrl` (i.e. today's behaviour) |
| T4 | Visit with zero attached events (footage-only) → `thumbnail` absent, `stillAtMs` present, `eventIds: []` | — |
| T5 | `stillAtMs` for a visit with a 40 s hole between an 8 s and a 90 s range → inside the 90 s range | compute the visit midpoint instead of the longest range's |
| T6 | `stillAtMs` is absent on a per-event-pad clip (no availability) | emit it anyway (it would 204 on an unrecorded camera) |

The presence set arrives as an explicit input (`ReadonlySet<string>` of event ids
with media), so these stay pure and the fake cannot pre-seed a URL production
would not have.

### 6.2 Provider unit — `videoclips-provider.spec.ts` (extend)

| Case | Assertion | Mutation |
| --- | --- | --- |
| T7 | `listClips` calls the media-presence query **once** and never once per clip | make it per-clip → the call-count assertion fails |
| T8 | Events are fetched with a left overhang of `VISIT_MERGE_GAP_MS + EVENT_PAD_MS.preMs`, and clips outside `[since, until)` are dropped | remove the overhang → T9 fails |
| T9 | A visit straddling `since`, whose only snapshot-carrying transition row sits BEFORE `since`, still gets a `thumbnail` | as T8 |
| T10 | The availability read throwing → per-event pad clips, `thumbnail` still vouched, one warn line carrying `tags: { deviceId }` | swallow the error silently |
| T11 | The presence query throwing → **no clip carries a `thumbnail`** (fail closed on the CLAIM, open on the LIST) | fail open on the claim → G1 breaks under load |

T11 is the interesting one: the LIST must survive a failed read (a fallible read
must never empty a surface), but the CLAIM "this URL has bytes" must not be made
on a read that failed. The two failure directions are opposite and both are
required.

### 6.3 Integration — `pipeline-analytics-e2e.spec.ts` (extend)

Uses the live harness: real `EventStore`, real `MediaStore`, the existing
`waitForEventSnapshot` helper, and a `snapshot` fake whose behaviour is
per-device.

```
Given camera A whose snapshot cap ANSWERS and camera B whose snapshot cap TIMES OUT,
  and both recorded footage in the window,
When motion transitions + heartbeats are emitted on both,
Then for every clip in listClips(A) ∪ listClips(B):
       clip.thumbnail === undefined  OR  getEventMedia(mainEventId).length > 0
  and  the set of clips with a dead thumbnail is EMPTY
  and  every clip from availability has a stillAtMs inside its ranges
  and  camera B produced ≥ 1 clip with no thumbnail and a stillAtMs
```

The final `expect(deadThumbnails).toEqual([])` **is** the acceptance criterion.
The camera-B branch is the 4 063-event class reproduced deliberately: an event
with no track and no snapshot must produce a listable, drawable visit — never a
dead tile and never a dropped row.

Mutation: restore the unconditional `mediaUrl` stamp as the thumbnail source →
`deadThumbnails` is non-empty → red. The fake must NOT pre-seed media for camera
B; a pre-seeding fake is exactly what hid a live bug here before.

### 6.4 Viewer unit — `camstack/src/clips/__tests__/clip-tile.spec.ts` (new)

| Case | Assertion |
| --- | --- |
| T12 | `thumbnailUrl` present, nothing failed → `eventSnapshot` |
| T13 | `thumbnailUrl` present but in `failed` → `recordedStill` when `stillAtMs` exists |
| T14 | no `thumbnailUrl`, `stillAtMs` present → `recordedStill` (tier 1 is skipped, not "tried and failed") |
| T15 | both failed / both absent → `glyph`, carrying the clip's `kind` |
| T16 | `failed` is latched per (clip, tier) — a new clip in the same slot retries tier 1 |
| T17 | Wiring: the visit card and the theater cluster card BOTH route through `resolveClipTile`; a hard-coded `mediaUrl` on either fails the spec |

T17 exists because `clip-clusters.ts` builds a synthetic `ObjectEvent` with
`mediaUrl: clip.thumbnailUrl` today. Two tile paths that disagree is how one
surface gets the fallback and the other keeps the empty tile.

### 6.5 Guard — `scripts/` + CI

| Guard | Fails when |
| --- | --- |
| `check-device-scoped-wrapper-mounts.ts` (landed 2026-09-20) | a `scope:'device'` + `kind:'wrapper'` cap resolves to mount kind `singleton` |
| `check-clip-thumbnail-vouched.ts` <!-- drift-ok: planned guard --> | a `thumbnail:` assignment in `videoclip-visits.ts` / `videoclips-provider.ts` does not consult the presence set |

Both in `.github/workflows/ci.yml`. The second is crude on purpose: the rule it
protects was violated by code that read perfectly well.

---

## 7. Performance budget, and where the cost actually is

### 7.1 Measured facts this budget is built on

- `recording.getAvailability` answers from the **calendar**, not the segment
  index: one directory read per hour, no file opened — **25 reads, 1 489 ms for a
  cold day, 19 ms warm** (`packages/addon-pipeline/src/recorder/addon/recording-provider.ts`,
  `packages/addon-pipeline/src/recorder/addon/calendar-scan.ts`). Adjacent days
  are warmed off the critical path.
- The archive-wide walk it replaced: **68 457 ms over 258 449 files.** Nothing in
  this surface may re-introduce a dependency on it.
- The still route decodes with ffmpeg: **≤ 3 concurrent, queue of 8, 15 s
  ceiling, 204 on overflow**
  (`packages/addon-pipeline/src/recorder/still/still-frame-service.ts`).
- `MediaStore.listInfoByOwner` reads index rows only — the blob-reading twin cost
  **7.67 MB read and ~10 MB allocated on a single 140 s track**. Per-clip blob
  reads are not an option.

### 7.2 The four costs, and the fix for each

| # | Cost | Today | Fix | Target |
| --- | --- | --- | --- | --- |
| P1 | **Availability** | 1 call per `listClips`. Correct already. | Keep it at exactly 1 — never per clip, never per profile. Assert the call count. | 1 call/list; ≤ 2.0 s cold day, ≤ 60 ms warm |
| P2 | **Snapshot presence** | N/A (the URL is fabricated) | ONE batched index query per call: `where: { ownerKind: 'event', deviceId }, whereIn: { ownerId: [...eventIds] }`, ids only. `whereIn` is a first-class filter (`EventStore.queryObjectByTrackIds` uses it, and its comment records the full-table scan that believing otherwise cost). A second identical query over `ownerKind: 'track'` for the object events' `trackId` (slim object events carry `trackId`; motion/audio are trackless roots and need no second query). | ≤ 2 queries/list, independent of clip count. **Zero N+1.** |
| P3 | **Per-clip playback resolution** | `getClipPlayback` per clip, hitting the segment INDEX | Not called by the viewer at all (playback is a seek). Do not add a call. The admin panel keeps its single `clips[0]` call. | 0 calls/list |
| P4 | **List size** | `limit` truncates from an undefined end once results are flattened | `limit` stays; a day of one camera is bounded by availability, not events (visits, not heartbeats — the grain's other payoff). Add `cursor` only with §8's P7, when a second provider makes the flattened order ambiguous. | ≤ 1.5 KB/row, ≤ 200 KB for a camera-day |

### 7.3 The Library fan-out (the real risk)

15 cameras × a cold day = 15 × 1.5 s of calendar reads. Serial, that is 22 s;
`Promise.all`, that is one paint after the slowest. Neither is acceptable.

- **N independent queries, N independent paints** (§4.3). No barrier.
- **Concurrency capped at 4** in flight, ordered by "most likely to answer fast":
  cameras whose day is already cached, then cameras with recording enabled, then
  the rest. A camera the registry already reports offline is not asked at all —
  and that refusal is logged with `tags: { deviceId }`, because a camera silently
  missing from a list reads as "nothing happened there".
- **The day is the unit.** Never "the last 7 days" in one shot.

Targets: **first visit card ≤ 700 ms** after the first camera answers on a warm
day; **all 15 cameras ≤ 1.5 s warm / ≤ 6 s cold**; never more than 4 requests in
flight; scrolling recomputes nothing (the layout is pure and memoised —
`layoutClipRibbon` for 500 clips must stay **≤ 8 ms**, which the existing
geometry specs can assert directly).

### 7.4 The batch method that is NOT in this spec

The right long-term answer to §7.3 is one call:
`listVisits({ deviceIds, since, until })`, declared with `systemMethod()` so it
resolves through the cap's SYSTEM provider and bypasses the per-device dispatcher
(`packages/types/src/capabilities/snapshot.cap.ts`'s `getSnapshotOverview` is the
working precedent, and `systemMountKindFor` exists precisely for this shape).

It is not here because it was out of scope. (When this was written a NEW cap
method was blocked by the AppRouter expansion limit; that was removed on
2026-07-30 with Zod-derived API types, so nothing blocks it now.) It is a small,
mechanical change — and it is the one place the fan-out mitigation should be
deleted rather than tuned.

---

## 8. Phased plan, with a verification step per phase

Each phase is independently shippable and independently revertible. No phase
depends on a later one.

| Phase | Content | Verification (must be red before, green after) |
| --- | --- | --- |
| **P0** | Prove the mount defect. A `cap-routers` spec that binds a second `videoclips` provider to one device and asserts the router still serves the global one. No production change. | The spec is RED on `main`. If it is green, the premise is wrong and everything after it is wrong. |
| **P1** | The per-device mount: M1–M6 (§2.2). Framework train + `npm run codegen`. | P0's spec inverts (binding now honoured); `generated-cap-mounts.ts` diff shows `requireDeviceScoped` for `videoclips` AND `pipeline-analytics`; the new guard fails when M1 is reverted; `npm run typecheck && npm run test` clean. **On the cluster:** flip a binding for one camera, confirm the served provider changes, then unflip. |
| **P2** | The vouched thumbnail + `stillAtMs` + the left overhang (§3.2–3.4), with the tagged log lines (§3.5). | T1–T11 (§6.1–6.2). Then remove the presence query and confirm T3/T11 go red — the rule of this repo, not a formality. |
| **P3** | The integration acceptance test (§6.3) and the `check-clip-thumbnail-vouched` guard. | `deadThumbnails` is empty for a camera whose snapshot cap answers AND one whose snapshot cap times out. Restore the old stamp → red. |
| **P4** | Viewer tiles: `clip-tile.ts`, `VisitTile`, and routing BOTH the visit card and the theater cluster card through it. | T12–T17. Visually: a camera-day known to contain snapshot-less motion events shows footage stills, not empty tiles. |
| **P5** | The Library **Visits** section: section key + alias, shell branch, `VisitsScreen`, `use-visits.ts`, the four states, `?clips=1` navigation, i18n EN+IT. | `library-sections.ts` specs cover the new key, the order, the `videoclips` alias and `trackId` precedence. A states spec covers loading / empty / recording-off / degraded / offline. `npm run ts-check` in the viewer repo — and every `@types/*` an import needs must be in the VIEWER's own `package.json` (CI checks it standalone; a local green means nothing). |
| **P6** | Performance pass against §7: assert P1/P2 call counts, cap concurrency at 4, measure the 15-camera day on the live hub, and only then decide on `cursor`. | The budget numbers, measured and written back into §7 as *observed*. A target with no measurement beside it is a wish. |
| **P7** *(gated, not scheduled)* | `mode: 'collection'` + the bindings-scoped fan-out + `addonId` dispatch on `getClipPlayback` — and only once a SECOND provider exists. | Out of scope here. §2 is its prerequisite; [`2026-08-08-videoclips-timeline.md`](2026-08-08-videoclips-timeline.md) §§3–4 is its design. |

Deployment reminders that have cost real time before: an edit under
`packages/<addon>/src` is not running until `camstack deploy` copies it into
`<dataDir>/addons/`; a `@camstack/types` / `@camstack/system` change is not live
until a framework train carries it; a viewer change is not live until
`npm run update:patch` (OTA) **and** `npm run build:orchestrator` +
`camstack deploy packages/addon-pipeline-orchestrator` for the `/viewer` copy.

---

## 9. The open question — for the operator

Sequencing. Two surfaces want the same evidence and only one can be first.

> **(A)** The Library **Visits** section first — a new, additive page listing
> every camera's visits per day.
>
> **(B)** The camera timeline first — ellipses plus **the events list becoming
> clusters**.
>
> **(C)** A, then B.

### What is already true, before the choice

- **Half of B ships today.** The theater already has clips MODE: compressed axis,
  ellipsis rows, one cluster card per visit (`clip-axis.ts`, `clip-clusters.ts`,
  `TheaterTimeline.tsx`). The remaining half of B is *the events list becoming
  clusters*, which was attempted as roadmap item 5 (`clusterByZoom`),
  **reverted**, and is currently parked awaiting the operator.
- **A is null today.** `?section=videoclips` resolves to nothing.
- A touches no existing surface. B's remaining half touches the busiest list in
  the product.

### Recommendation: **C — A first, then B, and B re-proposed on its own terms**

Three reasons, in order of weight:

1. **Risk asymmetry.** A is a new page: its worst failure is an empty page. B's
   remaining half rewrites the events list — its worst failure is the operator's
   primary surface behaving differently than before, which is precisely why
   `clusterByZoom` was reverted rather than fixed. Doing the additive thing first
   costs nothing and buys the ability to be wrong safely.
2. **A produces the evidence B needs.** Card sizing, absorption thresholds and
   "how many clusters is too many" are all questions about the real distribution
   of visits per camera per day — a distribution nobody has yet seen listed. A is
   the cheapest instrument for measuring it, and B without it is another guess of
   the kind that got reverted.
3. **A is where the operator's own acceptance criterion is testable at scale.**
   "Every clip has a usable snapshot" is a claim about the whole archive across
   30 cameras, not about one camera's timeline. The Visits list exercises it in
   one screen, per camera, per day — which is also how a regression in the
   motion-snapshot capturer becomes visible instead of inferred.

**What C means concretely:** phases P0–P6 as scheduled (A ships in P5). B is then
re-opened as its own proposal that must answer the `clusterByZoom` revert
head-on — what changed, and what test would have caught what was wrong the first
time. It is not folded into this spec, and it does not become a phase of it.

**If the operator picks B instead:** the honest scope is *only* "events list →
clusters" (the ellipses are done), it should not be started before P1–P4 (the
tile fallback is the same code either way), and the revert reasons must be on the
table before the first line is written.

---

## 10. Smaller open points (decide while implementing, no approval needed)

- Does `stillAtMs` belong on `Clip` or should the surface compute it from `holes`
  + `timeRange`? **Provider**, as specced: the surface does not have `ranges`,
  only the holes, and "longest contiguous range" is not derivable from a visit's
  holes alone once the visit starts or ends mid-range.
- Presence query batching granularity: one query for all three event kinds
  (`ownerKind: 'event'`) plus one for tracks. If a day's `eventIds` exceeds the
  backend's `IN ()` comfort, page it — but page it by ids, never by clip.
- Whether the Visits section gets a source-filter chip row now: **no**. There is
  one source. A control that cannot change anything is the `audio-classifier`
  precedent D62 exists to prevent. The chips already exist in the theater for the
  day a second source lands.
- Whether `?section=visits` should also get a stacked `/visits` route alias like
  `/artifacts` and `/exports` have: only if a Settings entry points at it. Do not
  add an unreferenced route.
