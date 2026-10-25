---
id: D550
title: A HomeKit clip is ours only if we TEED what we sent — the tee may never touch the recording that feeds it, and it keeps what it teed on a location the operator picked, for a time he set
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-export-hap/package.json
  - packages/addon-export-hap/src/hap-export.addon.ts
  - packages/addon-export-hap/src/hksv/clip-location.ts
  - packages/addon-export-hap/src/hksv/clip-writer.ts
  - packages/addon-export-hap/src/hksv/clip-store.ts
  - packages/addon-export-hap/src/hksv/clip-tee.ts
  - packages/addon-export-hap/src/hksv/clip-thumbnail.ts
  - packages/addon-export-hap/src/hksv/clip-record.ts
  - packages/addon-export-hap/src/hksv/recording-delegate.ts
---

## Context

The operator asked for the clips CamStack did not record to appear beside the
ones it did — a Reolink camera's SD card, a Home Hub's storage, and HomeKit's.
[D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
settled the shape for all of them: additional providers of the one `videoclips`
capability, listed in a collection, never a swap. Its slice 7 is HomeKit, and
its § 8 deferred it behind the framework work.

**Deferring the whole thing was wrong for one half of it, and the reason is
physical.** HomeKit Secure Video is a SINK. HAP's HDS `dataSend` is
`hello/whoami/open/data/ack/close` and `CameraRecordingDelegate` is push-only:
there is no read-back, from HomeKit or from iCloud, ever. A clip "recorded by
HomeKit" can therefore only be ours if we kept our own copy of what we SENT, at
the moment we sent it. **A stream nobody teed is gone.** Every day waiting for
the provider slices is a day of HomeKit clips that cannot be recovered later —
unlike Reolink's catalog, which sits on an SD card and will still be there.

What already existed, built for exactly this and never used: `Fmp4FragmentPlane`
(`packages/types/src/ffmpeg/fmp4-fragment-plane.ts`), whose own docblock says it
was made dual-use for a clip source and that *nothing consumes it yet*; and a
permanent per-camera `-c:v copy` child feeding it with an 8 s / 16 MB prebuffer
ring (D80, D84). The only subscriber in the repo was the HKSV delegate.

**The constraint that outranks the feature.** That plane is feeding the
operator's real home right now. HKSV is on by default (D80/D84), and a second
subscriber that stalls, throws or fills is a subscriber that stops his HomeKit
recordings. The plane already closes a slow subscriber rather than gapping it
(D80) — a gapped fMP4 is corrupt, not short — and it fans out per subscriber, so
the isolation exists; what had to be decided is that the tee USES it and never
works around it.

## Decision

1. **The tee is a SECOND subscription, never a shared one.** The delegate opens
   `source.subscribe('clip/<deviceId>#<streamId>', CLIP_TEE_QUEUE_CAPACITY)`
   after its own, hands it to a `ClipTeeFactory`, and releases it in the
   generator's `finally`. Isolation is structural — two queues on one plane —
   not a matter of care.
2. **The tee never blocks, slows or fails the recording.** `ClipTee.finish()`
   and `.acknowledge()` are synchronous handles; every awaited step (mkdir,
   open, write, ffmpeg, prune) happens behind them. Opening the tee is inside a
   `try`: a factory that throws, a plane that refuses, a store that cannot
   write — each costs the CLIP and produces a warn carrying `tags: { deviceId }`,
   and the HKSV stream proceeds byte for byte as it would have. `done` never
   rejects; every failure is a named `HksvClipTruncation`
   (`size-cap | slow-consumer | write-failed`).
3. **The clips live on a DECLARED storage location the operator picks:
   `homekitClips`.** `cardinality: 'single'`, `access: 'local-path'`,
   `defaultsTo: 'recordings'`, declared in `package.json` under
   `camstack.storageLocations` — the kernel aggregates it, the orchestrator
   seeds `homekitClips:default`, and the operator repoints it from the
   storage-locations surface. The first cut wrote to `<dataDir>/hksv-clips/`;
   it was defensible and gave him no say, which was the first thing he asked
   for.

   **A new id, argued against the four that exist.** Not `eventMedia`: a teed
   clip has no track, no detection and no event behind it, so filing it there
   would hand its lifetime to the post-analysis retention sweep, a policy
   written for a different question. Not `recordings`/`recordingsLow`: those
   rows belong to the recorder's placement planner, evictor and drain ratchet,
   and these files are not segments its index knows — an unknown id inside
   them is what `ghost-location-sweep.ts` exists to clean up. Not `artifacts`,
   the closest call: it IS a singleton multi-tenant root with per-tenant
   retention, but its description enumerates its three tenants, and because it
   is one root, choosing a disk for HomeKit clips would mean moving the
   notification shelf and the enrolled gallery with them — the opposite of the
   ask. Ids are deployment-wide and two addons declaring one must agree on
   cardinality; adding a fourth tenant to a shared description is the silent
   widening this repo punishes.

   `single`, not `multi`: the operator repoints one instance to choose the
   disk, and a second location of one class would need a placement policy, an
   evictor interplay and a drain ratchet paced to what the ACTIVE locations of
   the class grew (D386), none of which exists here. `local-path` because the
   tee does real `node:fs` I/O — a remote provider must be refused by
   declaration, not discovered when the first write lands on a same-named
   local directory that is something else. Every write goes under the
   `homekit-clips/` SUBTREE, because `defaultsTo` makes the seeded default
   share the recordings root and occupancy of a class sharing a disk is the
   class subtree (D327).

   The mode is asked of `mayWriteToLocation` and of nothing else (D385/D388):
   `readonly`, `drain` and `disabled` all resolve to "no root", which the tee
   treats exactly as it treats a directory it cannot open — no clip, a named
   warn, HomeKit untouched. The answer is mirrored in memory, invalidated by
   the `StorageLocationsChanged` doorbell (the payload is never the authority,
   the re-read is) and revalidated after 60 s so a missed event self-heals,
   which is D49's shape.
4. **Retention is a bounded recent window, because HomeKit's own is
   unreadable.** There is no read-back, so CamStack can never ask "does iOS
   still hold this one?" and mirror it; pretending otherwise is the second
   authority D62 keeps charging for.

   **The AGE is the operator's, per camera, defaulting to 14 days.** Global
   `clipRetentionDays` plus a per-device override, resolved ONLY by
   `resolveClipRetentionDays` so that reset == unset == the default — the rule
   `stationary-settings.ts` exists to keep, because an override that resolves
   differently from "never set" makes a Reset button a lie. Out-of-range values
   fall back rather than being stored: 0 days would turn the tee into a silent
   no-op, which is not a preference an operator can express by accident.

   **The other three are RAILS and stay fixed**: **256 MB per clip** (the only
   ceiling on a session that never closes — a clip's duration is whatever iOS
   pulled, not a window we choose; at the ~64 KB/s a 1080p copy branch produces
   that is over an hour), **200 clips and 512 MB per camera** oldest-first
   (measured fragments: ~255 KB per 8 s at 720p, ~500 KB at 1080p, 6.35 MB at
   4K — a 25× spread, so a count-only bound is a per-camera disk figure nobody
   can predict), and **4 GB across every camera** applied after the per-device
   pass, because per-device bounds alone multiply by a camera count the
   operator changes without thinking about this store. Rails, not preferences:
   an operator able to lower the first to zero could turn the tee into a no-op
   and one able to raise the last without limit could fill the disk, and
   neither is a thing he should be able to do without saying so.

   The interaction is stated rather than discovered: **a retention longer than
   the rails allow does not reach.** A busy camera hits 200 clips or 512 MB
   first, and every prune logs which bound fired (`reason: age | count |
   bytes`), so "my 30 days did nothing" has an answer in the log instead of a
   theory. A file nobody prunes is a disk that fills.
5. **A clip that is being WRITTEN is never a pruning candidate**, and a clip
   file with no sidecar that is not being written is an orphan of a crashed
   write and is removed. The pruner enumerates the MP4s, not the sidecars, so
   bytes nothing will ever name cannot hide from it.
6. **A thumbnail is VOUCHED or absent with a named reason.** The minter is
   injected and its verdict is not believed: the store stats the JPEG and writes
   `thumbnailFile` only for a non-empty file really on disk. A minter that
   reports success and wrote nothing yields `thumbnailUnavailable.reason:
   'decode-failed'` and its leftover deleted. The reasons are distinct because
   the operator's next move differs: `decode-failed`, `timed-out`,
   `ffmpeg-missing`, `no-init-segment`, `not-attempted`. The frame is taken at
   the TRIGGER instant (`prebufferSpanMs`), not frame zero — the head of a teed
   clip is a picture of the moment before anything happened.
7. **Undecodable bytes are not a clip.** A tee that never saw an init segment
   has no `ftyp`/`moov`, so nothing in its file is readable; it is deleted and
   the drop is logged. Same rule as the plane's: a corrupt artifact that looks
   like a working one is worse than none.
8. **Keeping the copies is PER CAMERA, and absent means on.**
   `ExportDeviceSettings.keepClips`, resolved by `resolveKeepHomekitClips`
   (`!== false`, never a scattered `=== true`). Off costs nothing and saves the
   disk plus one thumbnail ffmpeg per clip; the HomeKit recording is untouched
   either way. ON by default for the same reason `resolveHksvRecording` is, and
   one stronger: HKSV has no read-back, so every recording made while a switch
   was off by accident is gone permanently, and a default of off would mean the
   feature did nothing until the operator visited every camera.

   `clipsKept` on the advertisement line reports the CONJUNCTION and
   `clipsSwitchedOn` the operator's half, because the two failures call for
   different actions — he turned the copies off for this camera, or the addon
   has no writable clips location. One flag saying false for both would send
   him to the wrong screen.
9. **The coverage limits are stated, not discovered.** Only a camera with an
   enabled H.264 slot (`pickRecordingSource`), preferably ≤ 1080p
   (`MAX_RECORDING_HEIGHT`) and with a GOP ≤ 8 s (`deriveFragmentLengthMs`)
   records at all — a camera the tee never writes for is a camera HKSV never
   recorded, and `buildHksvRecording`'s advertisement line now carries
   `clipsKept` so silence never reads as "it is being kept". A clip's duration
   is the prebuffer replay plus however long the hub kept the HDS stream open.

## Consequences

- **The framework slices are unblocked, not pre-empted.** Nothing here touches
  `videoclips`, the per-device wrapper mount or the collection dispatch (D549
  decision 3 makes the mount a hard gate, and it still is). `export-hap` is
  hub-only in its own runner, so the provider slice needs a cross-runner
  hand-off that does not exist yet. What it will find when it lands:
  `HksvClipStore.listRecords(deviceId)` → `HksvClipRecord[]`, newest first,
  with self-contained ids (`hksv:<deviceId>:<startedAtMs>-<streamId>`), vouched
  thumbnails, honest absences and a `schemaVersion` a reader can refuse.
- **Bytes must travel by handle, never inline.** D9/D18: the provider serves
  `getClipPlayback` as a Range route over the file, the way D549 decision 6
  serves Reolink's — never a buffer through a cap call.
- Extra RAM per recording is bounded at `CLIP_TEE_QUEUE_CAPACITY` (2) fragments
  plus the prebuffer replay, and the replay is already bounded by the ring's own
  16 MB ceiling. The plane hands every subscriber the same `Uint8Array`, so a
  tee that keeps pace costs nothing over the delegate; only a tee that falls
  behind holds bytes the delegate has released, and two fragments is 8–16 s of
  slack on a copy branch. Less than the delegate's four, deliberately: the
  right answer to a stalled disk is a truncated clip, not a growing heap.
- Worst case on disk is 4 GB, and it is reached only by cameras that actually
  record — it is not a per-camera multiplier.
- HKSV is on by default, so the tee is too. The disk cost is now the operator's
  to refuse per camera, and every kept clip logs its bytes.
- **The location must exist before anything is teed.** It is seeded from the
  addon's own declaration, so a hub running an `export-hap` older than this
  change has no `homekitClips` row and keeps nothing — reported once, by name
  (`no-location`), not silently. No change was needed in `packages/system`: the
  kernel already aggregates `camstack.storageLocations` and the orchestrator
  already seeds `<id>:default` from `defaultsTo`.
- Three per-camera settings keys now exist where there were none
  (`keepClips`, `clipRetentionDays`) plus one global. Each ships with its
  reader in the same change, which is what `check-settings-key-has-reader`
  demands and what stops the next dead knob.

## Enforcement

- `packages/addon-export-hap/src/hksv/__tests__/clip-writer.spec.ts` drives a
  REAL `Fmp4FragmentPlane` with two subscriptions and asserts the delegate's
  stream is byte-identical to a control run while every tee write throws, and
  that its subscription still closes `ended` rather than `slow-consumer`.
  Remove the writer's `catch` and it goes red.
- The same file pins the per-clip ceiling and the slow-consumer truncation.
- `clip-store.spec.ts` pins the vouching against a real temporary directory: a
  minter that reports success and wrote nothing must yield no `thumbnailFile`.
  Believe the minter's verdict instead of the filesystem and it goes red; so
  does removing the in-flight guard, which then prunes a clip mid-write.
- `recording-delegate.spec.ts` pins that the tee takes a SECOND subscription
  (`clip/…`, never `hksv/…`) and that a factory which throws leaves the packet
  count equal to a control run.
- `clip-tee.spec.ts` is the wiring, end to end, against a real plane and a real
  directory: a file, a sidecar, and an acknowledgement that lands on disk.
- `clip-location.spec.ts` pins the D385 rule: a `readonly`, `drain` or
  `disabled` location is refused by name, and the root is the class SUBTREE of
  the resolved path, never the shared root. Replace `mayWriteToLocation` with
  anything that accepts every row and the three mode tests go red.
- `clip-store.spec.ts` pins the per-camera retention: two cameras with
  different windows prune differently in one pass. Fold them back into a single
  cutoff and it goes red — which is the bug a whole-store pass invites.
- `hksv-clip-settings.spec.ts` pins reset == unset for the cascade, the ON
  default for `keepClips`, and the clamp that refuses a retention of zero.
- `camera-accessory-recording.spec.ts` drives the REAL `buildCameraAccessory`
  and asserts `clipsKept` is false when the operator switched the camera's
  copies off — not only when the store is missing. Remove the switch from the
  gate and it goes red.
- `settings-switches-write.spec.ts` is structural and already covers the two
  new keys: a switch drawn and never written fails it, for a key nobody thought
  to test.
- `scripts/check-storage-write-target-enabled.ts` fired when the
  `listLocations` call lived in the addon away from the filter; the cap calls
  moved into `clip-location.ts` beside `mayWriteToLocation` rather than being
  exempted. `check-storage-access-declarations.ts` and
  `check-settings-key-has-reader.ts` both pass with the new declaration.
- Nothing yet checks the bounds against a live fleet; the first operator-visible
  numbers are the `clipsKept` / `clipsSwitchedOn` / bytes triple in the
  advertisement and completion logs.
