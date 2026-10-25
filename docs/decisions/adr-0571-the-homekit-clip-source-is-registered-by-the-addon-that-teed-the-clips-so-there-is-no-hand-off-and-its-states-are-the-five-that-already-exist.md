---
id: D571
title: The HomeKit clip source is registered BY the addon that teed the clips — so the hand-off D550 feared does not exist — and it says which of the five states it is in, measured
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-export-hap/package.json
  - packages/addon-export-hap/src/hksv/videoclips-source.ts
  - packages/addon-export-hap/src/hksv/videoclips-plane.ts
  - packages/addon-export-hap/src/hksv/build-outcome.ts
  - packages/addon-export-hap/src/hksv/clip-store.ts
  - packages/addon-export-hap/src/hksv/clip-record.ts
  - packages/addon-export-hap/src/hksv/build-recording.ts
  - packages/addon-export-hap/src/hap-export.addon.ts
---

## Context

[D550](adr-0550-a-homekit-clip-is-ours-only-if-we-teed-what-we-sent-and-the-tee-may-never-touch-the-recording.md)
shipped the TEE ahead of everything that would list its output, because HomeKit
Secure Video is a sink and a stream nobody teed is gone. It left the consumer
side specified to the field — `HksvClipStore.listRecords(deviceId)`, ids of the
form `hksv:<deviceId>:<startedAtMs>-<streamId>`, vouched thumbnails, a
`schemaVersion` a reader can refuse — and one open question, stated as the
whole shape of the slice:

> **The store lives in the hub-only `export-hap` runner**, so listing and
> serving must reach it from wherever the `videoclips` provider mounts… the
> provider slice needs a cross-runner hand-off that does not exist yet.

Two rules bound any answer. Addons never import each other, so `ctx.api` is the
only cross-addon layer; and stored media is fetched BY HANDLE over a data
plane, never base64'd through a cap channel at size — the repo's one
cross-addon byte move (`recordingExport.readExportBytes`, and now
`videoclips.readClipBytes`) carries a 50 MiB cap and a docblock naming the OOM
it caused (D9/D18).

**What was measured before anything was written, 2026-09-20, read-only:**

- **The tee is not running anywhere.** The live hub serves `export-hap`
  **1.2.127** (`addons.list` — its manifest declares `device-export` only and
  no `storageLocations`); the tee landed in 1.2.129, published and not
  deployed. `storage.listLocations` returns six rows and **none of type
  `homekitClips`**, so the location has never been seeded and nothing has been
  teed. There is therefore **no real HKSV clip on this fleet to verify
  against** — the provider is proved against a real temporary directory and a
  real `HksvClipStore`, and the first live reading will be the operator's.
- **The teed container carries no duration and no index.** A file produced
  with the tee's own argv (`-movflags +frag_keyframe+empty_moov+default_base_moof`,
  `-min_frag_duration`, `-f mp4` to a pipe) and cut where a pipe would be cut:
  `mvhd.duration = 0`, `mdhd.duration = 0`, no `sidx`, and no `mfra` — the
  trailer only exists when ffmpeg closes the output, which a teed session never
  does. It decodes end to end (ffprobe reads 20.000 s by walking every `moof`),
  so the bytes are a valid fMP4; what is absent is the map a player needs to
  turn a time into a byte offset.

## Decision

1. **The provider is registered by `export-hap` itself, and the hand-off does
   not get built.** `videoclips` is `scope:'device'` + `mode:'collection'` +
   `kind:'wrapper'`: every addon whose MANIFEST declares it becomes one of a
   camera's bindings (`collectionBindings`, gated only by the cap's
   `deviceTypes`), and `resolveWrapperNodeId` routes a wrapper to the hub —
   which is where this hub-only addon already is. **Nothing about serving
   `videoclips` requires owning the device**, which is the assumption that made
   the hand-off look mandatory.

   The rejected alternative was to register the source in the addon that owns
   the camera (or in the recorder) and have it pull clips over `ctx.api`. It
   costs a cap round trip per listing, a second authority on the clip layout,
   and — for the bytes — either `readClipBytes` at 50 MiB (a per-clip rail of
   256 MB means an over-size clip would be refusable that way) or a second byte
   transport that does not exist. Registering where the store is costs nothing
   and moves no bytes: the listing is a `readdir` in the process that wrote the
   files, and `getClipPlayback` hands back a URL into this addon's OWN data
   plane, which streams the file with `Range` off the disk it was teed to.

2. **The source EXISTS because of HomeKit, and has no switch of its own.** A
   camera has it when it is exported to HomeKit AND HomeKit recording is on for
   it (`describeHksvCamera`, reading the persisted exposure and
   `resolveHksvRecording`); turn either off and `listSources` answers `[]`
   (D550 8, D569 § 5). `keepClips` is deliberately NOT part of that gate: it
   governs the TEE, and the clips already kept are still the truth about this
   camera — so the row stays and its `reason` says the copies are off, which is
   D62's other half (an off switch is REPORTED off, never made to look broken).
   A knob of this source's own would be a second authority over a decision that
   already has one.

3. **The states are the five that exist. There is no sixth, and `ok` is
   measured** (D561). Every answer — the source row AND the clip list — comes
   from ONE directory read:

   - **`ok`** — the read answered. Including with nothing: a camera HomeKit has
     not recorded yet is a complete list of zero, and `reason` says which
     flavour of nothing it is. This is not D561's cold `ok`: that one was
     returned without reading anything, and this one cannot be returned without
     a `readdir` that succeeded.
   - **`no-storage`** — there is no writable `homekitClips` location: none
     seeded, or it is `readonly` / `drain` / `disabled`. Named by
     `clip-location.ts`, the only module allowed to interpret a location's mode
     (D385/D388). Exactly the Reolink meaning — the medium is not there.
   - **`unreachable`** — the storage cap could not be reached, or the directory
     read threw. A measurement that failed is never folded into "no clips"
     (D393).
   - **`index-empty`** — HomeKit recording is switched ON and the store holds
     nothing because `buildHksvRecording` WITHHELD the advertisement. The
     camera's own switch disagrees with its own index, which is what this state
     already means on 618, and the refusal travels verbatim.
   - **`sleeping`** — never. There is no camera to wake; the read is local.

   A sixth state was considered for "HomeKit never recorded this camera" and
   rejected: `ui-library` maps the enum exhaustively, so adding one is a
   breaking change to a consumer, and the contradiction that state describes is
   what `index-empty` already is.

4. **A camera HomeKit never recorded can only SAY so if the build wrote it
   down.** `buildHksvRecording` already logs each of its three refusals with
   `tags: { deviceId }`, and a log line is not an answer to a surface. It now
   also notes its verdict — `profiles-unreadable`, `no-recordable-stream`,
   `key-frame-interval`, or advertised — into `HksvBuildOutcomes`, a
   process-local MIRROR written by the authority at the moment it decides and
   read only to be reported. A camera whose accessory has not been built in
   this process has `null`, which is reported as nothing rather than as a
   refusal that did not happen.

5. **An empty clip list is an answer only when the source could ANSWER**
   (D561). `listClips` filters by OVERLAP (a teed clip's duration is whatever
   iOS pulled, so one that began before `since` is still the clip the operator
   is looking at), orders newest first, caps at `limit` — and when it produced
   no rows and the state is not `ok`, it THROWS with the state and the reason
   instead of returning `[]`, which has nowhere to carry them. An ordinary
   quiet window on a healthy source is still `[]`.

6. **A clip whose fMP4 is gone is LISTED, saying so.** One `readdir` answers
   both "what was written" (the sidecars) and "what is still there" (the file
   names), so `playable: false` + `unplayableReason: 'clip-file-missing'` costs
   no extra syscall and a sidecar that outlived its bytes never vanishes.
   `HksvClipStore.listCatalog` is that read; `listRecords` is now its `records`
   and nothing else, so the D550 contract and the provider cannot disagree.

7. **The bytes are served over `Range`, as they were teed, and the fMP4 does
   NOT seek.** The route streams the file with `createReadStream().pipe(res)`
   (backpressure, D447), answers 206 / 416 / 404 / 405 honestly, and puts no
   token in the URL — the hub's `/addon/<id>/<prefix>` proxy takes the session
   cookie, exactly as the recorder's plane does (D549 22). What the container
   does not give is stated rather than discovered: **no duration and no index**
   (measured above), so a player can start it but cannot map a time to a byte
   offset, and the duration a surface draws must come from the row's
   `timeRange`, which is the sidecar's and is exact.

   **What it would cost to fix, measured:** one `ffmpeg -i clip.mp4 -c copy
   -movflags +faststart out.mp4` — no re-encode — took **40 ms** and **+0.7 %
   bytes** on a 20 s 640×360 clip and yielded a real `mvhd` duration and a full
   sample table. That is the same remux D549 22 chose for Reolink. It is NOT
   taken here, because the cheap part is the ffmpeg and the expensive part is
   everything around it: a derived file needs a bounded cache with its own
   eviction, and the clip pruner deletes any MP4 in the device directory that
   no sidecar names (D550 5) — a remuxed twin written beside the clip would be
   removed as an orphan of a crashed write. It is a slice, named here so the
   absence is not mistaken for a decision that it plays fine.

8. **`served` is a measurement the tee makes, never derived from the pixels.**
   The sidecar gains an optional `profile` (`high | mid | low`), parsed from
   `pickRecordingSource`'s choice and never cast, because the resolution says
   nothing about which broker slot produced it. `getClipPlayback` omits
   `served` when the sidecar never recorded one; `readClipBytes` — where
   `ClipBytesSchema` makes it a required field, because an export row persists
   it — REFUSES such a clip by name rather than guessing a twin (D393). `profile` is optional and
   `schemaVersion` stays 1: nothing existing MEANS anything different, and
   there are no legacy sidecars in the fleet to migrate (see Context).

9. **The thumbnail narrowing is lossy, forced, and logged.** The store's five
   reasons (`decode-failed`, `timed-out`, `ffmpeg-missing`, `no-init-segment`,
   `not-attempted`) are narrowed onto the cap's closed four, which `ui-library`
   maps exhaustively: `no-keyframe` for "the clip had nothing decodable"
   (`no-init-segment`, `decode-failed`, `timed-out`) and `unsupported` for "no
   still exists and nothing here will make one" (`ffmpeg-missing`,
   `not-attempted`, or a JPEG no longer on disk). Nothing re-mints a teed clip,
   so every one of them is FINAL — that is the only distinction a surface can
   act on. The lossless copy is on the sidecar and on the listing line.

## Consequences

- **Coverage limits, stated rather than discovered.** Only a camera with an
  enabled H.264 slot ≤ 1080p and a GOP ≤ 8 s records at all (D550 9), so a
  camera with no source row or an `index-empty` one is usually the camera's
  configuration and not a CamStack fault. A clip's duration is whatever iOS
  pulled — the prebuffer replay plus however long the hub kept the HDS stream
  open — never a window we choose, so short clips are normal and only
  `truncated` means truncated.
- **Every camera now carries one more binding.** `collectionBindings` is gated
  only by `deviceTypes`, so `export-hap` is a `videoclips` provider of every
  camera in the fleet; the per-camera gate is `listSources` answering `[]`,
  which costs one map lookup and no I/O for a camera HomeKit does not have.
- **`readClipBytes` is optional on the cap and implemented here.** An addon
  cannot fetch another addon's data-plane URL (`AddonDataPlane` only lets an
  addon SERVE, behind a per-listener secret only the hub presents), so a clip
  EXPORT reaching a HomeKit clip has this seam or none — a source the operator
  can see and not save is worse than one he cannot see. It went from `method`
  to `optionalMethod` in the same session this landed; the implementation is
  unaffected.
- **A 256 MB clip is playable and not inline-readable.** The per-clip rail is
  256 MB (D550 4) and `VIDEOCLIPS_MAX_READ_BYTES` is 50 MiB, so a very long
  session refuses `readClipBytes` with its size in the message and still plays
  through the route. Half a video is never an answer.
- **The first live reading is the operator's.** Nothing here has run against a
  real teed clip, because none exists: `export-hap` 1.2.129 (the tee) and this
  change both need deploying, and the `homekitClips` location is seeded from
  the manifest at install. Until then every camera's HKSV row will answer
  `no-storage` / `no-location`, which is the honest state and is exactly what
  the operator should see.
- **Three new modules, no new authority.** The store still owns the layout (the
  routes address a STEM and ask it for a path), `clip-location.ts` still owns
  the mode, and `buildHksvRecording` still owns the verdict.

## Enforcement

Every spec below was confirmed RED by reverting the thing it pins, not merely
by passing:

- `hksv/__tests__/videoclips-source.spec.ts` — the whole surface, against a
  real directory and a real store, and **every honest-state spec asks
  `listSources` FIRST, cold** (the gap D561 found was in the suite before it
  was on the wire). Fold `no-root` into an empty catalog, or make `ok` a
  default, and the state specs go red; delete the refuse-empty branch and
  "REFUSES by name rather than answering []" goes red; drop the `playable`
  join and the gone-fMP4 spec goes red; answer `served: record.profile ?? 'mid'`
  and "leaves `served` absent when the sidecar never recorded one" goes red.
- `hksv/__tests__/videoclips-plane.spec.ts` — the routes through a REAL `http`
  server and real files: 200 with `accept-ranges`, 206 for a range, open-ended
  and suffix ranges, 416 past the end, HEAD with no body, 404 with a warn
  carrying `tags: { deviceId }`, 400 for anything that is not a device id and a
  stem, 405 for a write. Ignore the `Range` header and three of them go red.
- `hksv/__tests__/clip-store.spec.ts` § `listCatalog` — the three answers kept
  apart (`catalog` / `no-root` / `failed`), a sidecar whose clip file was
  removed, and `listRecords` served from the same read.
- `mappers/__tests__/hksv-build-outcome.spec.ts` — drives the REAL
  `buildCameraAccessory`: an H.265-only camera notes `no-recordable-stream`, an
  H.264 one notes the advertisement, and a camera with recording switched off
  notes nothing. Remove the `note()` call and it goes red.
- `__tests__/hksv-videoclips-wiring.spec.ts` — the two authorities behind
  `describeHksvCamera`, and that the MANIFEST declares `videoclips`. The second
  is not decoration: an addon that registers the provider in code and forgets
  the manifest entry compiles, boots, and never appears in `getBindings`.
- Guards re-run green with the new declaration: `check-registered-caps-declared`,
  `check-storage-write-target-enabled`, `check-storage-access-declarations`,
  `check-capability-metadata-drift`, `check-addon-entries`,
  `check-device-scoped-wrapper-mounts`, `check-collection-cap-pin`.
- Nothing checks the fMP4 claim on hardware; it is measured in Context against
  a file built with the tee's own argv, and the first real clip should be
  ffprobe'd to confirm the same three absences.
