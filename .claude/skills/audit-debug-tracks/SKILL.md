---
name: audit-debug-tracks
description: Use when an operator has marked tracks `debug` or names specific tracks, and when triaging reports like "tracks with no photo at all", "only the face image", "missing firstFrame/lastFrame/keyFrame", "the thumbnail is tiny/wrong", "media stopped early" or "the track ended too soon". Covers the three media owner namespaces, which media kinds imply which, what the persisted record can and cannot answer, and how the audit is closed out.
---

# Auditing debug-marked tracks

The operator marks a track `debug` because it looked wrong. Your job is to turn
that hunch into named, checkable statements, decide for each track whether the
gap is EXPLAINED or a real defect, and close the audit out.

**The hub already ships the first half of this.** Do not hand-roll a media
comparison across sibling tracks — a baseline run that did exactly that
misattributed the defect (see §7). Start at §2.

## 1. What the record can answer — read this before planning anything

| Source | Horizon | Use it for |
| --- | --- | --- |
| `pipelineAnalytics.*` + `debug.*` (SQLite) | full retention | everything below |
| `logs.query` | **≈10–40 minutes**, and it shrinks under a log storm | live repro ONLY |

**`logs.query` cannot answer a question about yesterday, or about this
morning.** Measured 2026-08-25: the `error`/`warn` ring held 35 min, the `debug`
ring held 5. A 12 h audit that plans to "check the logs for the miss" will find
an empty window and burn the session. If you need logs, you must reproduce
live — otherwise reason from the persisted record and say UNKNOWN.

Do not open the SQLite DB with `sqlite3`. Doing so via `/mnt/user` corrupted
production on 2026-08-19. tRPC or the nightly tars in
`/mnt/cache/appdata/camstack/backups/`, nothing else.

## 2. Get the marked set, and analyse it — two calls

Both are `addonId: 'pipeline-analytics'` (the MANIFEST id, **not**
`@camstack/addon-post-analysis` — that name is rejected), `auth: admin`.

```bash
cd /Users/<local-user>/Documents/Git/camstack/camstack-server
node scripts/hub/hub.mjs POST addons.custom \
  '{"addonId":"pipeline-analytics","action":"debug.listTracks","input":{}}'
# → { tracks: [{trackId, deviceId, className, firstSeen, lastSeen, durationMs, active}], truncated }
# every debug-marked track on every camera. `truncated:true` = a camera hit the
# 200 cap. Filter by lastSeen yourself for "the last N hours".

node scripts/hub/hub.mjs POST addons.custom \
  '{"addonId":"pipeline-analytics","action":"debug.analyze","input":{"trackIds":["<id>", "..."]}}'
# ≤200 ids. → { reports: [{..., mediaCount, mediaKinds, eventCount, positionCount,
#                           findings:[{code,severity,detail}]}], vanished }
```

`debug.analyze` reads index rows only — no blobs, no decode — so the whole
marked set goes in one call. Its finding codes are the same vocabulary as the
`camstack-track-audit` runbook (`ZERO_MEDIA`/`MEDIA_EVICTED_OR_NEVER`,
`MISSING_KEYFRAME`, `MISSING_FIRSTFRAME`, `MISSING_LASTFRAME`,
`MISSING_THUMBNAIL`, `MISSING_BEST_CROP`, `LASTFRAME_STALE`,
`MEDIA_STOPPED_EARLY`, `NO_PERIODIC_SNAPSHOTS`, `SHORT_TRACK`, `ZERO_EVENTS`,
`ZERO_POSITIONS`, `NO_BEST_EVENT`, `LOW_BEST_SCORE`), on purpose — so a tab and
an audit run can never disagree without it being a bug. Source of truth:
`packages/addon-post-analysis/src/pipeline-analytics/debug/debug-track-analysis.ts`.

`vanished` is not an error. `debug` does **not** pin retention (D81), so a marked
track can be evicted between the list and the analysis.

## 3. Media is owned by THREE namespaces. `getTrackMedia` reads one.

Every blob lives in one table (`pipeline-analytics:media`) keyed by
`(ownerKind, ownerId)`. There is no `trackId` column.

| ownerKind | ownerId | kinds | read with |
| --- | --- | --- | --- |
| `track` | `<trackId>` | `keyFrame` `keyFrameSmall` `firstFrame` `lastFrame` `snapshot` `thumbnail` `thumbnailSmall` `crop` | `pipelineAnalytics.listTrackMedia` / `getTrackMedia` |
| `event` | `<eventId>` | `faceCrop` `plateCrop` | `pipelineAnalytics.getEventMedia {eventId, deviceId}` |
| `face` / `plate` | `face-<trackId>` / `plate-<trackId>` | `crop` | `faceGallery.getFaceByTrack` → `faceGallery.getFaceMedia {faceId}` |

**A track that "has no media" may simply have media you did not ask for.**
`getTrackMedia` hard-filters `ownerKind='track' AND ownerId=<trackId> AND
deviceId=<deviceId>` — a face crop is `face-<trackId>`, so the `ownerId` misses;
a `faceCrop` is event-owned, so it misses too. `debug.analyze` queries the
`track`/`face`/`plate` owners for you (that is why its `mediaCount` can exceed
`getTrackMedia`'s row count) — but it does **not** query `event`, so
`faceCrop`/`plateCrop` are invisible to it as well.

Use `listTrackMedia` (manifest: kind + sizeBytes, no bytes) for the survey and
`getTrackMedia {kinds:[...]}` only when you need pixels. The full
`getTrackMedia` is 5–8 MB per track.

One more asymmetry worth knowing: `listTrackMedia` reads index rows, while
`getTrackMedia` silently drops a row whose blob is gone. **A kind that appears in
`listTrackMedia` and not in `getTrackMedia` means the blob was lost under a live
index row** — that is a finding, not a flake.

## 4. The hierarchy — which kinds imply which

Check this before calling anything missing. Several kinds are *derived*, and a
derivative present without its parent is a specific, named situation — not a
paradox.

```
keyFrame  (native full frame, best-detection instant)
   ├── keyFrameSmall   960px downscale of keyFrame — same fetch, never a second one
   └── thumbnail       close-time crop of the best-seen bbox out of keyFrame
          └── thumbnailSmall   ~480px downscale of thumbnail

firstFrame / lastFrame / snapshot   960px BOXED timeline frames, independent of keyFrame
face-<trackId>:crop                 the face gallery crop — NOT derived from any stored frame
event:faceCrop                      per-event face crop — NOT derived from any stored frame
```

| Observation | What it means |
| --- | --- |
| `keyFrameSmall` alone, `positions:[]`, `state:idle` | **an audio or sensor track.** Not a video subject, not a defect. Check `source` (`audio`/`sensor`) before flagging. 155/169 non-video tracks in a 12 h sample looked exactly like this. |
| `thumbnail` alone, **< 10 KB** | the **face-crop copy** (§5). The track captured no frame at all. |
| `thumbnail` alone, ≥ 10 KB | the close-time **detection-raster fallback** — a ≤640 crop retained during life and committed at close because nothing else landed (`zero-media-policy.ts` → `raster-fallback`). Also means no frame landed. |
| `thumbnail` present, `keyFrame` absent | the thumbnail did NOT come from a keyFrame — it is one of the two fallbacks above, or a live best-shot capture whose keyFrame missed. |
| `thumbnailSmall`/`keyFrameSmall` absent, parent present | a rendering gap, not a capture gap. `EXPECTED_CLOSED_KINDS` deliberately excludes the `*Small` variants. |
| no media at all, duration < 1.5 s | expected: `decideZeroMediaPolicy` **suppresses** such tracks. If one persisted anyway, that IS the finding. |

Healthy size reference (measured over 1859 video tracks): a keyFrame-derived
`thumbnail` is **p50 ≈ 240 KB**; a face-crop copy is **3–6 KB**. Size alone
separates them at a glance.

## 5. "The face photo exists but the frames don't" — the mechanism

This is the report that keeps coming back. It is not a paradox and it is not
retention. Two independent facts produce it:

**(a) The face crop is never cut from a stored frame.** It is cut from the
in-RAM decoded frame inside the live handle window, held in RAM for the whole
track, and written only at close
(`face-recognizer.ts` `onTrackEnd` → `mediaStore.put({ownerKind:'face', ownerId:'face-<trackId>', kind:'crop'})`).
In the `faceAlignedCrop` branch the bytes arrive over the wire from the detail
executor and the source frame never existed on this node's disk at all. The
frame kinds are a *separate*, native-gated capture that can miss on every frame
of the track without the face path noticing.

**(b) At close, the face crop is COPIED onto the track as its `thumbnail`** —
but only when the track has none of its own:

```ts
// packages/addon-post-analysis/src/pipeline-analytics/copy-face-crop-preview.ts
const TRACK_PREVIEW_KINDS = new Set(['thumbnail', 'thumbnailSmall'])
export async function copyFaceCropIfTrackHasNoThumbnail(store, input) {
  const existing = await store.listTrackMedia(input.trackId)
  if (existing.some((m) => TRACK_PREVIEW_KINDS.has(m.kind))) return false
  await store.putTrackThumbnail({ ...input, data: input.crop })
```

So the one image the operator sees IS the face crop, wearing the `thumbnail`
kind — and it appears **precisely** on the tracks whose frame captures all
missed. The derivative did not outlive its parent; it never had one.

**Prove it per track, do not assume it.** Compare the bytes:

```bash
node -e '/* fetch both and sha256 them */' # sketch:
# a = getTrackMedia {trackId, deviceId, kinds:["thumbnail"]}      → base64
# b = faceGallery.getFaceByTrack {deviceId, trackId} → faceId
#     faceGallery.getFaceMedia {faceId}                            → base64
# Buffer.from(a,'base64').equals(Buffer.from(b,'base64')) === true → it is the copy
```

Verified 2026-08-25: 5/6 of the operator's face-only debug tracks were
byte-identical (SHA-256 match, e.g. `772900d4625ebae4`, 3381 B on both sides).

**Narrowing bonus — the face row tells you whether a native frame EXISTED.**
`getFaceByTrack` returns `faceBbox` and `nativeFaceShortSidePx`. If the bbox is
in full native coordinates (e.g. 2560×1440, not the ≤640 detection raster) and
`nativeFaceShortSidePx` is populated, a decoded **native** surface was in RAM at
that instant. A track with that plus zero frame kinds separates "the frame
persist path missed while the pixels were available" from "no native frame ever
existed" — two different fixes. Say which one you observed.

**Corollary — the copy outlives its source.** `holdBufferCaps` prunes the face
buffer by capacity (`faceStore.pruneCapOverflow` → `mediaStore.deleteForOwner('face', ...)`)
and never touches track media. So a track can end up showing a face crop with
**no face-gallery row at all**: in the same 12 h sample, 57 tracks carried the
<10 KB face-copy signature but only 24 still had a face row. Finding
`getFaceByTrack → null` therefore does **not** refute the face-copy diagnosis —
check the size first.

## 6. Track duration vs session duration

Detection is not always on. Check the camera before blaming the track:

```bash
node scripts/hub/hub.mjs GET pipelineOrchestrator.getCameraStatus '{"deviceId":<id>}'
# assignment.reasons.detection — "armed:on-motion" means the detection session
#   starts on motion and stops after a cooldown; `detection:null` = not running now.
# assignment.detectionNodeId / decoderNodeId — WHICH node owns the frames. A
#   frame handle is fetched by handle FROM THAT NODE; an offline node fails
#   every native fetch for every camera assigned to it (2026-08-06: one offline
#   laptop owned 388 of a day's key-frame misses).
```

A track cannot hold media from outside its session. A track whose `lastSeen`
runs past the session's disarm, or whose `firstSeen` sits inside the warm-up,
loses the captures in that stretch.

**But do not assume it — this was measured and REFUTED as the general cause.**
Bucketing 1859 video tracks by the quiet gap before their birth (a proxy for a
cold session), zero-media tracks were **13%** cold-start vs **17%** for fully
healthy tracks. Cold sessions are not why tracks lose media on this cluster.
Re-measure before invoking it; do not copy the hypothesis forward.

## 7. What NOT to conclude — measured and refuted

A baseline run that skipped §2–§5 read a lone 3 KB `thumbnail` stamped 706 ms
after birth and concluded "capture fired once at birth then stopped"
(`MEDIA_STOPPED_EARLY`). It was wrong: that row was the face crop copied in at
CLOSE, and its timestamp is the face's `held.timestamp`, not a capture instant.
**A media row's timestamp is the instant of the PIXELS, not of the write.**

Also refuted by measurement on the same 12 h window — do not re-derive these:

| Hypothesis | Measurement | Verdict |
| --- | --- | --- |
| Multi-track pressure evicts the native ring | mean same-camera overlap 0.59 (zero-media) vs 0.61 (healthy) | no signal |
| A cold/just-armed session | 13% vs 17% cold-start | refuted |
| One bad camera or one bad hour | spread across 22 cameras and all 12 hours | refuted |
| The native key-frame lease | only 1 `key-frame native miss` line in the observable window — **but the window was 35 min**, so this is UNTESTED, not disproven | UNKNOWN |

What *is* correlated: duration. Zero-media tracks ran a median 5.1 s / 14
positions; fully-healthy ones 14.4 s / 46. Consistent with retry-bounded capture
losing the race on short tracks — a correlation, not a proven mechanism. Say so.

## 8. Closing the audit out — there is NO `verified` flag

`pipelineAnalytics.setTrackFlags` is the only per-track write, and its patch
accepts exactly three booleans — `markForTrain`, `debug`, `favourited`
(`TrackFlagFields`, `packages/types/src/capabilities/pipeline-analytics.cap.ts`).
There is no `verified`, no `audited`, no timestamp.

**The patch schema is non-strict: an unknown key is silently stripped and the
call returns 200 with nothing changed.** Verified on the live hub — sending
`flags:{verified:true}` returned `{markForTrain:false, debug:true,
favourited:false, retrainStatus:'none'}`. Do not read a 200 as a write.

So "mark as verified" has exactly one honest expression today: **clear `debug`**.

```bash
node scripts/hub/hub.mjs POST pipelineAnalytics.setTrackFlags \
  '{"deviceId":<id>,"trackId":"<id>","flags":{"debug":false}}'
# → the RESOLVED flags; drive your report off this, not off the request.
```

Apply it by verdict, one track at a time:

- **EXPLAINED-BENIGN** (audio/sensor track, `*Small` variant only, sub-1.5 s
  suppression working as designed) → clear `debug`. The mark did its job.
- **EXPLAINED-DEFECT** (a real capture gap, fix not shipped yet) → **leave
  `debug: true`.** Clearing it erases the operator's only handle on the track and
  makes "audited, still broken" indistinguishable from "never looked at".
- **VANISHED** → nothing to write. Report the count.

Never substitute `favourited: true` for verification — per the cap doc it is a
retention PIN, so it silently exempts the track from pruning. A knob that writes
a store nobody reads for the purpose is exactly what D62 forbids.

Always end by recording the audited ids and their verdicts in
the current month file `../planning/sessions/<YYYY-MM>.md` (sibling clone of github.com/camstack/planning, from the repository root). Until a real flag exists, that log is the audit
trail.

### What would have to be added for a real "verified"

Not a method — a field, and then the train. In order:

1. `packages/types/src/capabilities/pipeline-analytics.cap.ts`: add to
   `TrackFlagFields` an `audited` marker. Prefer `auditedAt?: z.number()` over a
   boolean — "who looked, and when" is the question actually asked, and a
   boolean cannot answer it. It must also land in `TrackFlagsSchema` (the
   resolved write result) so a surface can render it without a re-fetch.
2. A column on the tracks collection + the store read/write in
   `addon-post-analysis` (alongside `debug`), and the in-RAM active-track update
   so a flag set on a live track survives its expiry-time persist.
3. `npm run codegen` — the cap routers are generated.
4. Ship it: a `*.cap.ts` change is a **framework** change. It reaches a node only
   inside a published `@camstack/server` (D16) — an addon `camstack deploy`
   cannot expose it. See `camstack-hub-image-deploy`.
5. Consider `.strict()` on `TrackFlagsPatchSchema` in the same change, so the
   next caller's typo is a 400 instead of an invisible no-op.

Until all five land, do not write a method name that does not exist and do not
tell the operator a track was marked verified.

## Checklist

- [ ] `debug.listTracks` → the marked set (filter by `lastSeen` for a window)
- [ ] `debug.analyze` on ≤200 ids → findings + `vanished`
- [ ] For anything reported missing: checked all THREE owner namespaces (§3)
- [ ] Applied the hierarchy (§4) before calling a kind missing — `source`
      checked, `*Small` variants discounted, thumbnail SIZE read
- [ ] Any "only the face" track: byte-compared thumbnail vs face crop (§5),
      and read `faceBbox`/`nativeFaceShortSidePx` to say whether a native frame existed
- [ ] `getCameraStatus` read for arming mode and owning node (§6)
- [ ] No claim rests on `logs.query` for anything older than ~30 min (§1)
- [ ] Every unproven cause named UNKNOWN, not "probably"
- [ ] Verdict per track; `debug` cleared ONLY on EXPLAINED-BENIGN (§8)
- [ ] Audited ids + verdicts appended to `../planning/sessions/<YYYY-MM>.md`
