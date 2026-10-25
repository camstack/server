/**
 * `recording-archive` — OUR archive, and the intent that fills it.
 *
 * The system-singleton half of the 2026-09-24 cut (D625). `recording` used to
 * be one 33-method system singleton holding two unrelated subjects: three
 * per-camera READS about coverage and playback, and everything else — storage
 * locations, retention, relocation, rebalance, the ops log, the placement
 * table and the byte-plane primitives our scrub and export are built on.
 *
 * The reads became a device-scoped COLLECTION, so a camera's own card can be a
 * source beside ours (`recording.cap.ts`). Everything that is about OUR store,
 * or unimplementable by a camera, stayed here.
 *
 * ## On the name
 *
 * `recording-storage` was the obvious choice and is wrong: this cap also holds
 * `getDeviceConfig`/`setDeviceConfig`, which are recording INTENT — bands,
 * retention, the D62 switch authority — and a name that says "storage" invites
 * the next reader to move them out again. An archive is a thing we keep, and
 * what we keep it under is a policy; the name covers both halves honestly and
 * sits in the existing family (`recording-onboard`, `recording-export`,
 * `recording-signal`).
 *
 * ## What must NOT happen to it
 *
 * It stays a SINGLETON. It is registered by `recorder`, which is
 * `placement: 'any-node'` and runs on every recording node; the hub dispatches
 * to one of them. Putting the ledger, the placement table or the relocation
 * jobs behind a fan-out is the one genuinely dangerous move in this cut.
 *
 * `getDeviceConfig` / `setDeviceConfig` in particular are the D62 recording
 * authority (`CameraSwitch.authority`). If a write reached a different provider
 * than the read — which a collection fan-out permits — two authorities would
 * decide when one camera records, and the symptom (recording silently off, or
 * a `bands` array clobbered by a partial write) is durable and silent. Keeping
 * them here means the worst case during a rollout is a 412: the switch refuses
 * to flip and SAYS so. **Do not move them into the collection, at any point,
 * for any reason.**
 *
 * ## The two batch reads
 *
 * `getAvailabilityBatch` / `getDaysWithRecordingsBatch` take `deviceIds:
 * number[]` with no single `deviceId`, and a device-scoped mount routes
 * through `getProviderForDevice(deviceId)` — there is nothing for it to route
 * on. They stay here, and on this cap the batch is explicitly OURS: a grid has
 * no per-camera picker, and a caller that wants another source's coverage asks
 * `recording.getAvailability` per device with that source's `provider`.
 */
import { z } from 'zod'
import {
  OpsLogEntrySchema,
  OpsLogQueryInputSchema,
  OpsLogReasonSchema,
} from '../interfaces/ops-log.js'
import {
  RecordingConfigSchema,
  RecordingStorageModeSchema,
} from '../interfaces/recording-config.js'
import {
  LedgerWalkInputSchema,
  LedgerWalkReportSchema,
  RelocateFootageInputSchema,
  RelocateJobSchema,
  RelocateResidueInputSchema,
  RelocateResidueSchema,
  StorageMigrationFootageMoveInputSchema,
  StorageMigrationLeaseInputSchema,
} from '../interfaces/relocate.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { RecordingRangeSchema } from './recording.cap.js'

export const RecordingStatusSchema = z.object({
  deviceId: z.number(),
  enabled: z.boolean(),
  /** THE derived storage mode, from the one definition
   *  (`deriveRecordingMode`) — never a second enum. A duplicated list is how
   *  `on-device-decision` could have reached the recorder and not the status. */
  activeMode: RecordingStorageModeSchema,
  nodeId: z.string(),
  storageBytes: z.number(),
})
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>

// ── Batched timeline reads (multi-camera grid) ────────────────────────────────

/**
 * Most cameras one `getAvailabilityBatch` / `getDaysWithRecordingsBatch` may
 * name.
 *
 * Matches the ceiling the per-camera batches elsewhere in the system carry
 * (`pipelineAnalytics.getKeyEventsBatch`, `sceneMonitor.listScenesBatch`): a
 * grid is tens of cameras, never hundreds, and each id costs the recorder one
 * calendar walk whose answer crosses a process boundary.
 *
 * The ceiling is on the SCHEMA. An over-eager ask is REFUSED, never truncated
 * to the first {@link RECORDING_TIMELINE_BATCH_MAX} ids — a truncated answer
 * looks exactly like a complete one, and the caller would draw an empty
 * timeline for the cameras it never learned were dropped.
 */
export const RECORDING_TIMELINE_BATCH_MAX = 200

/**
 * One camera's row in a `getAvailabilityBatch` answer.
 *
 * `ranges` is EXACTLY what `recording.getAvailability` returns for that camera
 * at OUR source — the batch collapses the transport, not the work — plus the
 * `read` mark the singular answer now carries too (D625):
 *
 *  - `read: 'read'` — answered. `ranges: []` means "read, and this camera has
 *    no footage in the window", which is a real claim.
 *  - `read: 'unreadable'` — the recorder could not answer for this camera (its
 *    calendar rung threw, its location is unmounted). `ranges` is empty and
 *    that emptiness means NOTHING.
 *
 * A timeline that renders the second as the first tells an operator there is no
 * footage when the truth is that nobody looked.
 */
export const RecordingAvailabilityForDeviceSchema = z.object({
  deviceId: z.number(),
  read: z.enum(['read', 'unreadable']),
  ranges: z.array(RecordingRangeSchema).readonly(),
  /** Same field, same meaning, as the singular answer (D433). A row that
   *  dropped it would tell a grid caller the archive holds one profile.
   *  Empty on an `'unreadable'` row: nobody looked. */
  profilesWithFootage: z.array(z.string()).readonly(),
})
export type RecordingAvailabilityForDevice = z.infer<typeof RecordingAvailabilityForDeviceSchema>

/**
 * One camera's row in a `getDaysWithRecordingsBatch` answer. Same rule as
 * {@link RecordingAvailabilityForDeviceSchema}: `days: []` on a `'read'` row is
 * "no footage in this month", `read: 'unreadable'` is "nobody could look", and
 * the date-picker's day dots must not spell them the same.
 */
export const RecordingDaysForDeviceSchema = z.object({
  deviceId: z.number(),
  read: z.enum(['read', 'unreadable']),
  /** Local-midnight epochs (UTC ms) of days that have ≥1 recorded segment. */
  days: z.array(z.number()).readonly(),
})
export type RecordingDaysForDevice = z.infer<typeof RecordingDaysForDeviceSchema>

/**
 * Recording storage usage for one camera — what the ARCHIVE holds for it,
 * across every profile and every resolvable location on this node.
 *
 * ## Archive vs residency, which is the whole point of this shape (D418)
 *
 * `usedBytes` / `oldestMs` / `segments` are the durable hour ledger's numbers:
 * the same quantity `RecordingLocationUsage.usedBytes` reports for the volume
 * this camera writes to, so the two can be added up and compared.
 *
 * They were not always. Until D418 this row came from the recorder's in-RAM
 * `RecordingIndex`, which since D287 holds only the live tail plus the hours
 * somebody hydrated — so a hub with 1.9 TB and 3.3 days of footage reported
 * 60.5 GB and "oldest: three hours ago" on the same page as the volume row
 * that said otherwise, and two people read it as retention eating recent
 * footage. Residency is still reported, under `residentBytes` /
 * `residentOldestMs`, which answer a different question and say so.
 */
export const RecordingDeviceUsageSchema = z.object({
  deviceId: z.number(),
  /** Bytes the ARCHIVE holds for this camera on this node's resolvable
   *  recordings locations. */
  usedBytes: z.number(),
  /**
   * Start of this camera's OLDEST ARCHIVED segment, across every profile and
   * location — the "Oldest footage" column in Recordings → Storage, and the
   * only honest answer to "is retention actually holding?" per camera.
   *
   * `null` = the camera has no footage. OPTIONAL because a recorder that
   * predates this field omits it entirely, and a hub whose types carry the
   * field must keep validating that older provider's payload: the framework
   * (types) and the addon ship on different trains, and the addon is usually
   * the later of the two.
   */
  oldestMs: z.number().nullable().optional(),
  /** Segments the archive holds for this camera — the "M" beside `usedBytes`.
   *  OPTIONAL for the same train-skew reason as `oldestMs`. */
  segments: z.number().optional(),
  /**
   * RESIDENCY, not the archive: bytes the recorder process currently holds in
   * its RAM index — the live tail plus the hours a reader hydrated.
   *
   * It answers "what can be served without touching the disk", never "how much
   * footage this camera has". A UI that renders it must label it as such, and
   * must never total it as storage. OPTIONAL: a recorder predating D418 omits
   * it, and so does a node whose ledger could not answer.
   */
  residentBytes: z.number().optional(),
  /** The residency counterpart of `oldestMs` — the oldest segment currently in
   *  RAM, which on a healthy recorder is minutes ago and means nothing about
   *  retention. `null` = nothing resident. */
  residentOldestMs: z.number().nullable().optional(),
})
export type RecordingDeviceUsage = z.infer<typeof RecordingDeviceUsageSchema>

/** Recording storage usage + capacity for one storage location. */
export const RecordingLocationUsageSchema = z.object({
  /** StorageLocation id; null for the legacy/degraded single-root fallback. */
  locationId: z.string().nullable(),
  /** Every location id sharing this row's PHYSICAL volume (aliases). One row
   *  is emitted per physical disk (2026-07-29): two locations on one root
   *  previously rendered as two identical "disks" with a nonsensical used
   *  split — hydrate attribution across aliases is arbitrary by nature. */
  locationIds: z.array(z.string()).optional(),
  /**
   * Filesystem root of the physical volume this row accounts — the only
   * operator-legible identity when a location has no `displayName` yet, and
   * what a "which disk is full" alert has to name. OPTIONAL for the same
   * train-skew reason as `oldestMs`: a recorder that predates the field omits
   * it, and this schema must keep validating that older provider's payload.
   */
  root: z.string().optional(),
  /** Bytes of recordings stored on this PHYSICAL volume (all aliases). This is
   *  the footage's SHARE of the volume, not how full the volume is — the disk
   *  also holds everything that is not recordings. Volume fill is
   *  `(totalBytes - availableBytes) / totalBytes`. */
  usedBytes: z.number(),
  /** Free bytes on the location's volume; null when capacity is unknown
   *  (remote/unstattable — the recorder logs the statfs failure with the root). */
  availableBytes: z.number().nullable(),
  /** Total bytes of the location's volume; null when unknown. */
  totalBytes: z.number().nullable(),
})
export type RecordingLocationUsage = z.infer<typeof RecordingLocationUsageSchema>

/** Aggregate recordings storage usage for a node: global total + per-camera +
 *  per-location used/available. Stat-based (accurate even for detached cameras),
 *  computed on demand — not from the name-only playback index. */
export const RecordingStorageUsageSchema = z.object({
  nodeId: z.string(),
  totalUsedBytes: z.number(),
  devices: z.array(RecordingDeviceUsageSchema),
  /**
   * WHERE `devices[]` came from, so an empty table is never mistaken for empty
   * disks (D418).
   *
   * `archive` = the durable hour ledger answered. `unavailable` = this node
   * declared no ledger and the recorder REFUSED rather than answering the
   * question with the resident index (D295 rule 3) — the rows are UNKNOWN, not
   * zero, and a UI must say so. OPTIONAL: a recorder predating D418 omits it,
   * and its rows are residency.
   */
  devicesRead: z.enum(['archive', 'unavailable']).optional(),
  /**
   * Is the `archive` answer WHOLE (D674): the hour ledger loaded without
   * hitting its row cap, and at least one location resolved? Only then may a
   * camera ABSENT from `devices[]` be read as "no footage" — and only then is a
   * row's `oldestMs` the archive's oldest rather than the oldest of a fraction.
   * OPTIONAL: a recorder predating D674 omits it, and a consumer must read the
   * absence as `false`. A retention floor is a delete; it never guesses.
   */
  complete: z.boolean().optional(),
  /**
   * Per-physical-volume capacity. OPTIONAL, and consumers must render the rest
   * of the payload without it: a recorder that could not build it omits it. A
   * UI that dereferences it unconditionally crashes the whole Storage page over
   * a missing disk bar. (The hub's cap routers pass output through unvalidated
   * since 2026-07-11 — `cap-router-builder.ts` — so a newer recorder's fields
   * are not stripped by an older hub.)
   */
  locations: z.array(RecordingLocationUsageSchema).optional(),
})
export type RecordingStorageUsage = z.infer<typeof RecordingStorageUsageSchema>

/**
 * The OPERATOR-ARMED half of multi-location recordings (D116).
 *
 * The placement plan decides where NEW writes go and moves nothing. A rebalance
 * is the operator asking for the EXISTING archive to be brought into line with
 * that plan: one relocate job per (camera, profile) pile that sits on the wrong
 * location, run FIFO behind the single-flight mover.
 *
 * `plan…` and `start…` return the SAME shape deliberately — what the operator
 * confirms is exactly what gets enqueued, and `jobIds` is the only difference
 * (empty on the plan).
 */
export const RecordingRebalanceMoveSchema = z.object({
  deviceId: z.number(),
  profile: z.string(),
  fromLocationId: z.string(),
  toLocationId: z.string(),
  bytes: z.number(),
  files: z.number().int(),
})
export type RecordingRebalanceMove = z.infer<typeof RecordingRebalanceMoveSchema>

/** Why a pile that is out of place is staying there. Every refusal is
 *  reported: a rebalance that silently drops a camera reads exactly like one
 *  that had nothing to do. */
export const RecordingRebalanceSkipReasonSchema = z.enum([
  'unassigned',
  'target-not-writable',
  'below-threshold',
  'no-headroom',
])
export type RecordingRebalanceSkipReason = z.infer<typeof RecordingRebalanceSkipReasonSchema>

export const RecordingRebalanceSkipSchema = z.object({
  deviceId: z.number(),
  profile: z.string(),
  fromLocationId: z.string(),
  /** The location the plan wants; null when the camera has no assignment. */
  toLocationId: z.string().nullable(),
  bytes: z.number(),
  reason: RecordingRebalanceSkipReasonSchema,
})
export type RecordingRebalanceSkip = z.infer<typeof RecordingRebalanceSkipSchema>

export const RecordingRebalancePlanSchema = z.object({
  moves: z.array(RecordingRebalanceMoveSchema),
  skipped: z.array(RecordingRebalanceSkipSchema),
  bytesToMove: z.number(),
  /** Relocate job ids enqueued. Always empty for the plan (dry-run) call. */
  jobIds: z.array(z.string()),
})
export type RecordingRebalancePlan = z.infer<typeof RecordingRebalancePlanSchema>

export const RecordingRebalanceInputSchema = z.object({
  /** Copy throttle in MB/s (default 40) — a rebalance is a background chore. */
  throttleMbps: z.number().min(1).max(1000).optional(),
  /** Ignore piles smaller than this (default 1 GB). */
  minMoveGb: z.number().min(0).optional(),
})
export type RecordingRebalanceInput = z.infer<typeof RecordingRebalanceInputSchema>

/**
 * Operator-facing placement of one camera onto a recordings location.
 *
 * `pinLocationId` is the operator instruction: a location id, or `null` for
 * Auto (the planner may move this camera). `locationId` is where high/mid
 * currently write — the plan, which may disagree with the pin when Auto.
 */
export const RecordingDevicePlacementSchema = z.object({
  deviceId: z.number().int(),
  profile: z.string(),
  locationId: z.string(),
})
export type RecordingDevicePlacement = z.infer<typeof RecordingDevicePlacementSchema>

export const RecordingDevicePinSchema = z.object({
  deviceId: z.number().int(),
  /** Recordings-class location this camera is pinned to. */
  locationId: z.string(),
})
export type RecordingDevicePin = z.infer<typeof RecordingDevicePinSchema>

export const RecordingPlacementViewSchema = z.object({
  assignments: z.array(RecordingDevicePlacementSchema),
  pins: z.array(RecordingDevicePinSchema),
  defaultLocations: z.record(z.string(), z.string()),
})
export type RecordingPlacementView = z.infer<typeof RecordingPlacementViewSchema>

export const RecordingSetDevicePlacementInputSchema = z.object({
  deviceId: z.number().int(),
  /** `null` = Auto. Otherwise a `recordings:*` location id. */
  locationId: z.string().nullable(),
})
export type RecordingSetDevicePlacementInput = z.infer<
  typeof RecordingSetDevicePlacementInputSchema
>

/**
 * Result of locating footage at a wall-clock instant for one device/profile.
 * `segment` carries the covering segment's window; `gap` reports the forward
 * nearest covered edge (`null` past the end of footage / when none exists)
 * and the backward covered edge `prevEndMs` (exclusive end of the nearest
 * footage behind the epoch; `null` when none — optional so older providers
 * that omit it stay valid). `prevEndMs` lets a backward frame-step hop the
 * small inter-segment cracks (durMs under-covers the span to the next
 * startMs by ~11-17 ms) instead of no-opping at a segment head.
 */
export const LocateSegmentResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('segment'),
    startMs: z.number(),
    durMs: z.number(),
    bytes: z.number(),
  }),
  z.object({
    kind: z.literal('gap'),
    nearestEdgeMs: z.number().nullable(),
    prevEndMs: z.number().nullable().optional(),
  }),
])
export type LocateSegmentResult = z.infer<typeof LocateSegmentResultSchema>

/** Raw bytes of one finalized footage segment (read off disk on the recording node). */
export const ReadSegmentBytesResultSchema = z.object({ data: z.instanceof(Uint8Array) })
export type ReadSegmentBytesResult = z.infer<typeof ReadSegmentBytesResultSchema>

/**
 * One GOP of a finalized segment, cut by byte range through the segment's own
 * `mfra` (D31 on the D42 feeder path). `data` is the `ftyp`+`moov` head plus
 * the single `moof`+`mdat` covering the requested instant — standalone-
 * demuxable, never the whole file. When the segment's index cannot be parsed
 * the provider degrades INSIDE the mechanism to the whole segment (still one
 * `data`, `gopStartMs` = the segment start) — a worse read, not another path.
 */
export const ReadGopBytesResultSchema = z.object({
  data: z.instanceof(Uint8Array),
  /** Absolute epoch ms of the returned fragment's first sample. */
  gopStartMs: z.number(),
  /** Media ms the returned fragment covers. */
  gopDurMs: z.number(),
})
export type ReadGopBytesResult = z.infer<typeof ReadGopBytesResultSchema>

/**
 * A time WINDOW of one finalized segment, cut by byte range — the multi-GOP
 * twin of {@link ReadGopBytesResultSchema}'s single instant. Built for the
 * replay clip's `recording` source (`docs/design/plans/2026-08-26-clip-replay-on-pipeline.md`):
 * a replay needs several seconds of native pixels, not one frame.
 *
 * `ok.data` is standalone-demuxable, same as a GOP read. `ok.reachesRequestedEnd`
 * is `false` when the returned bytes were cut short by the read's own safety
 * byte cap before covering `[fromMs, toMs)` — a truncation, reported, not a
 * silently shorter answer. `spans-multiple-segments` is a REFUSAL, not a
 * degradation: a window whose end falls past the covering segment would need
 * bytes stitched from a second segment file (its own `ftyp`+`moov`), which is
 * not one standalone-demuxable stream — the caller's answer is to request a
 * shorter window or one aligned to a single segment, not to receive spliced
 * bytes nothing has proven decodable.
 */
export const ReadWindowBytesResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    data: z.instanceof(Uint8Array),
    /** Absolute epoch ms of the returned bytes' first sample — at or before
     *  the requested `fromMs` (anchored on the nearest keyframe). */
    gopStartMs: z.number(),
    /** Media ms the returned bytes cover, from `gopStartMs`. */
    gopDurMs: z.number(),
    /** `false` ⇒ the safety byte cap cut the read short before it reached
     *  the requested `toMs`; the caller got fewer frames than asked for. */
    reachesRequestedEnd: z.boolean(),
  }),
  z.object({
    kind: z.literal('spans-multiple-segments'),
    /** Where the covering segment's own footage runs out — informational,
     *  not a retry hint (retrying the same window would refuse again). */
    segmentEndMs: z.number(),
  }),
])
export type ReadWindowBytesResult = z.infer<typeof ReadWindowBytesResultSchema>

export const recordingArchiveCapability = {
  name: 'recording-archive',
  scope: 'system',
  mode: 'singleton',
  /** Moves here with the config pair — the derived Recording settings
   *  section is a view over `getDeviceConfig`/`setDeviceConfig` (D14), and
   *  those did not move (D625). */
  exposesDeviceSettings: true,
  status: {
    schema: RecordingStatusSchema,
    kind: 'command-driven',
  },
  methods: {
    // ── Batched timeline reads, OURS ─────────────────────────────────────
    /**
     * `recording.getAvailability` for a SET of cameras, in one round trip, at
     * OUR source.
     *
     * A multi-camera timeline re-asks availability for every camera in the grid
     * on every day change; fanned out that is one request per camera for N
     * independent calendar walks. The per-camera work is IDENTICAL (the same
     * `availabilityProfileFor` + `rangesIn`, run concurrently inside the
     * recorder) — only the transport collapses.
     *
     * It lives on the ARCHIVE, not on the `recording` collection, because it
     * takes `deviceIds` with no single `deviceId` and a device-scoped mount has
     * nothing to route on (D625 §10.2). The consequence is stated rather than
     * hidden: the batch answers for OURS. A caller that needs another source's
     * coverage asks `recording.getAvailability` per device, naming that
     * source's provider.
     *
     * `protected` for the same reason the singular method is: every id in
     * `deviceIds` is a device reference, so the F1 #3 gate refuses any camera
     * outside the caller's scope — one id out of scope refuses the CALL, it
     * does not quietly drop a row.
     *
     * Every requested id gets a row, marked — see
     * {@link RecordingAvailabilityForDeviceSchema}. `deviceIds` is capped at
     * {@link RECORDING_TIMELINE_BATCH_MAX} and an over-cap ask is refused.
     */
    getAvailabilityBatch: method(
      z.object({
        deviceIds: z.array(z.number()).min(1).max(RECORDING_TIMELINE_BATCH_MAX),
        fromMs: z.number(),
        toMs: z.number(),
      }),
      z.array(RecordingAvailabilityForDeviceSchema).readonly(),
      { role: 'viewer', kind: 'query', auth: 'protected' },
    ),
    /**
     * `recording.getDaysWithRecordings` for a SET of cameras, in one round
     * trip, at OUR source. Same placement argument as
     * {@link getAvailabilityBatch}.
     *
     * The cheapest question in the product, asked once per camera per month
     * change. One directory read per day per camera at the owner, unchanged;
     * what collapses is the N requests it took to ask.
     *
     * Every requested id gets a row, marked — see
     * {@link RecordingDaysForDeviceSchema}. `deviceIds` is capped at
     * {@link RECORDING_TIMELINE_BATCH_MAX} and an over-cap ask is refused.
     */
    getDaysWithRecordingsBatch: method(
      z.object({
        deviceIds: z.array(z.number()).min(1).max(RECORDING_TIMELINE_BATCH_MAX),
        fromMs: z.number(),
        toMs: z.number(),
        tzOffsetMinutes: z.number(),
      }),
      z.array(RecordingDaysForDeviceSchema).readonly(),
      { role: 'viewer', kind: 'query', auth: 'protected' },
    ),
    getStorageUsage: method(z.object({}), RecordingStorageUsageSchema, {
      kind: 'query',
      auth: 'admin',
    }),
    /**
     * READ the camera's recording intent.
     *
     * `protected`, not `admin`, since 2026-09-21. It is the only per-camera
     * source of the recording mode the viewer has, and the camera status dot
     * asks for it on a screen every read-only user sees. As `admin` it answered
     * FORBIDDEN, the viewer collapsed that to `null` and `null` to `'off'`, and
     * a recording camera was drawn GREEN — a failed measurement rendered as a
     * value (D315, D393, D590). It carries schedules and retention, no secret,
     * and the per-device gate in `scope-access.ts` still applies; `setDeviceConfig`
     * stays `admin`.
     *
     * It is a SINGLETON method and stays one (D625 §16.2): it is the D62
     * recording authority, and an authority that several providers could answer
     * is the "two knobs over one decision" D62 forbids.
     */
    getDeviceConfig: method(z.object({ deviceId: z.number() }), RecordingConfigSchema, {
      role: 'viewer',
      kind: 'query',
      auth: 'protected',
    }),
    /** Locate footage at a wall-clock instant: the covering segment's window,
     *  or a gap with the forward nearest covered edge. Used by a feeder running
     *  in another addon process to seek recorded footage over tRPC.
     *
     *  BYTE PLANE: defined by `mfra` byte ranges over OUR own MP4 segment tree.
     *  There is no vendor-neutral statement of it, its only callers are feeders
     *  in other addon processes (the stream broker, the replay-clip source),
     *  and an onboard source that ever needs bytes delegates to the
     *  `videoclips` transport its vendor already has (D625 §9.3, §10.5). */
    locateSegment: method(
      z.object({ deviceId: z.number(), profile: z.string(), epochMs: z.number() }),
      LocateSegmentResultSchema,
      { kind: 'query', auth: 'admin' },
    ),
    /** Read one finalized segment's raw bytes by its exact `startMs`. Used by a
     *  feeder running in another addon process to pull recorded footage over tRPC. */
    readSegmentBytes: method(
      z.object({ deviceId: z.number(), profile: z.string(), startMs: z.number() }),
      ReadSegmentBytesResultSchema,
      { kind: 'query', auth: 'admin' },
    ),
    /** Read the single GOP of segment `startMs` covering `epochMs`, by mfra
     *  byte range — the scrub-granular read (D31 letter on the feeder path).
     *  See {@link ReadGopBytesResultSchema} for the degradation contract. */
    readGopBytes: method(
      z.object({
        deviceId: z.number(),
        profile: z.string(),
        startMs: z.number(),
        epochMs: z.number(),
      }),
      ReadGopBytesResultSchema,
      { kind: 'query', auth: 'admin' },
    ),
    /** Read a WINDOW `[fromMs, toMs)` of segment `startMs`, by mfra byte
     *  range — the multi-GOP twin of `readGopBytes`. Refuses (does not
     *  degrade) when the window runs past the covering segment. Used by the
     *  replay clip's `recording` source to fetch several seconds of native
     *  footage for its single ffmpeg decode pass. */
    readWindowBytes: method(
      z.object({
        deviceId: z.number(),
        profile: z.string(),
        startMs: z.number(),
        fromMs: z.number(),
        toMs: z.number(),
      }),
      ReadWindowBytesResultSchema,
      { kind: 'query', auth: 'admin' },
    ),
    setDeviceConfig: method(
      z.object({ deviceId: z.number(), config: RecordingConfigSchema }),
      RecordingConfigSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Re-scan this device's footage from disk (stat sizes) and reseed the
     *  index, then return the fresh status. */
    rescanStorage: method(z.object({ deviceId: z.number() }), RecordingStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Apply this device's retention policy to footage now; returns the oldest
     *  surviving footage start (the retention floor) or null if no footage. The
     *  prune is logged to the recordings ops-log with `reason` (default
     *  `'retention'` — the policy-driven prune; `'quota'` when disk-pressure
     *  triggered). */
    pruneFootage: method(
      z.object({ deviceId: z.number(), reason: OpsLogReasonSchema.optional() }),
      z.object({
        floorMs: z.number().nullable(),
        deletedBuckets: z.number().int(),
        reclaimedBytes: z.number().int(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Manually delete a camera's footage — the whole footprint, or a
     * `[fromMs, toMs)` window when either bound is given. Logged to the
     * recordings ops-log as `op:'manual-delete', reason:'manual'`. Destructive:
     * the admin UI guards it behind a confirm.
     */
    deleteFootprint: method(
      z.object({
        deviceId: z.number(),
        fromMs: z.number().optional(),
        toMs: z.number().optional(),
      }),
      z.object({
        deletedBuckets: z.number().int(),
        reclaimedBytes: z.number().int(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** The recordings ops-log rows (newest-first), optionally scoped to one
     *  camera. Backed by the recorder's bounded DurableState ring. */
    listOpsLog: method(OpsLogQueryInputSchema, z.array(OpsLogEntrySchema).readonly(), {
      kind: 'query',
      auth: 'admin',
    }),
    /**
     * Render a short GIF from recorded footage around `aroundMs` (low profile,
     * palette-free ffmpeg gif). Synchronous — the window is a few seconds of
     * `low`, rendering in ~1-2s. Built for notification attachments: the
     * caller gets bytes, nothing persists. Fails when no footage covers the
     * window (camera not recording → caller skips the attachment).
     */
    renderGif: method(
      z.object({
        deviceId: z.number(),
        aroundMs: z.number(),
        preRollSec: z.number().min(0).max(30).default(2),
        postRollSec: z.number().min(0).max(30).default(5),
        maxWidth: z.number().int().min(120).max(1280).default(480),
        fps: z.number().int().min(1).max(15).default(5),
      }),
      z.object({ gifBase64: z.string(), fromMs: z.number(), toMs: z.number() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Render a short MP4 clip from recorded footage around `aroundMs` — the
     * "send a clip, not a gif" notification attachment. Same window, source
     * and fail-closed contract as {@link renderGif}: no footage covering the
     * window ⇒ it throws and the caller ships no attachment. Re-encoded (never
     * stream-copied) so a concat across segments with different encoder
     * parameters still plays. Silent by contract.
     *
     * The returned window is SEGMENT-GRANULAR: the source playlist is built
     * from whole segments, so the clip starts at or before `fromMs` and ends
     * at or after `toMs` — overshoot bounded by one segment per side (an 8 s
     * ask over 4 s segments measured 12 s). `fromMs`/`toMs` report the window
     * ASKED for, not the encoded duration.
     */
    renderClip: method(
      z.object({
        deviceId: z.number(),
        aroundMs: z.number(),
        preRollSec: z.number().min(0).max(30).default(3),
        postRollSec: z.number().min(0).max(30).default(7),
        maxWidth: z.number().int().min(160).max(1920).default(640),
      }),
      z.object({
        clipBase64: z.string(),
        mime: z.string(),
        fromMs: z.number(),
        toMs: z.number(),
        bytes: z.number().int(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Internal migration-participant lease. Blocks new recorder attaches and
     * waits for writers to exit while their watchers index final segments. */
    pauseForStorageMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ paused: z.literal(true) }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    resumeForStorageMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ resumed: z.literal(true) }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    /** Re-resolve location roots after the coordinator changes defaults. */
    refreshStorageLocationsForMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ refreshed: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Internal mover, callable only by the storage-migration coordinator. */
    startStorageMigrationMove: method(
      StorageMigrationFootageMoveInputSchema,
      z.object({ jobId: z.string() }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    getStorageMigrationMoveStatus: method(
      z.object({ jobId: z.string() }),
      RelocateJobSchema.nullable(),
      { auth: 'admin' },
    ),
    cancelStorageMigrationMove: method(
      z.object({ jobId: z.string() }),
      z.object({ cancelled: z.boolean() }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    /**
     * Move footage between locations — the OPERATOR's mover, scoped to one
     * camera (and optionally to specific profiles) rather than a whole disk.
     * Queued FIFO behind the single-flight engine, so arming several is safe.
     */
    relocateFootage: method(RelocateFootageInputSchema, z.object({ jobId: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Every relocate job this recorder knows about, newest first (in RAM: the
     *  move is resumable, so a lost list costs nothing but the display). */
    listRelocateJobs: method(z.object({}), z.array(RelocateJobSchema).readonly(), {
      kind: 'query',
      auth: 'admin',
    }),
    /**
     * What a location STILL holds, asked of the durable hour ledger.
     *
     * The number behind "drain remaining": segments and bytes that would still
     * have to move off `fromLocationId`. It is a ledger aggregate — the archive
     * — because the resident index is not the archive (D295), and a drain sized
     * off the index is exactly what reported `done` over 80.3 GB on 2026-08-29.
     * `null` means the archive could not be asked (no ledger on this node, or
     * the aggregate failed) and is never conflated with an empty source.
     */
    getRelocateResidue: method(RelocateResidueInputSchema, RelocateResidueSchema, {
      kind: 'query',
      auth: 'admin',
    }),
    /**
     * Does this location's LEDGER tell the truth about its disk? (D319)
     *
     * One `readdir` per claimed hour, diffed both ways: durable rows whose file
     * is not there, and files no durable row names. `apply` defaults to FALSE —
     * the report is the product, and the dry run is how an operator
     * sanity-checks the destructive run before authorising it.
     *
     * REFUSES a source that is still a write target: a listing of a live
     * location is a lower bound, which is not the strong evidence that lets
     * this pass forget without a budget. A live location is reconciled by the
     * mover, under D318's bound.
     */
    reconcileLedgerAgainstDisk: method(LedgerWalkInputSchema, LedgerWalkReportSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Cancel a running or queued relocate job. A queued job never runs. */
    cancelRelocateJob: method(
      z.object({ jobId: z.string() }),
      z.object({ cancelled: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** What a rebalance WOULD move, and what it would refuse. Moves nothing. */
    planStorageRebalance: method(RecordingRebalanceInputSchema, RecordingRebalancePlanSchema, {
      kind: 'query',
      auth: 'admin',
    }),
    /** Arm the rebalance: enqueue one relocate job per planned move. */
    startStorageRebalance: method(RecordingRebalanceInputSchema, RecordingRebalancePlanSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * The placement plan in force plus operator pins. Drives the Locations
     * admin page: Auto vs a named recordings location, per camera.
     */
    getPlacement: method(z.object({}), RecordingPlacementViewSchema, {
      kind: 'query',
      auth: 'admin',
    }),
    /**
     * Pin a camera to a recordings location, or clear the pin (Auto). High and
     * mid follow the pin; low stays with the recordingsLow planner.
     */
    setDevicePlacement: method(
      RecordingSetDevicePlacementInputSchema,
      z.object({ ok: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IRecordingArchiveProvider = InferProvider<typeof recordingArchiveCapability>
