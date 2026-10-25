/**
 * `recording` — a camera's recorded COVERAGE and PLAYBACK, from whichever
 * source the operator picked.
 *
 * A device-scoped wrapper COLLECTION since D625, and the five lines that make
 * it one (`scope`/`mode`/`kind`/`defaultActive`/`deviceTypes`) are copied from
 * `videoclips.cap.ts` deliberately: `scope: 'device'` + `mode: 'collection'` is
 * what makes `resolveCapMount` keep the PER-DEVICE mount while the collection
 * dispatcher fans out, and a device's sources are then its BINDINGS
 * (`deviceManager.getBindings`, D554 amended) rather than "every addon that
 * registered the cap somewhere".
 *
 * ## What is here and what is not
 *
 * FIVE of them — `listSources`, `getAvailability`, `getDaysWithRecordings`,
 * `getPlayback`, `getPlaybackOptions`. Every source must be able to answer
 * these or it is not a source. Everything else that used to live on this cap —
 * storage locations, retention, relocation, rebalance, the ops log, the
 * placement table, the `mfra` byte plane, `getDeviceConfig`/`setDeviceConfig`
 * and the two batch reads — is on `recording-archive`, a system singleton, and
 * the reasons are argued there.
 *
 * ## The default is OURS, and there is nowhere to say otherwise
 *
 * {@link RECORDING_SOURCE_CAMSTACK} is RESERVED. The absence of an operator
 * choice MEANS that value; it is not a row that happened to sort first. Clips
 * end their resolver with `?? sources[0]` and that is right for clips — a
 * camera full of onboard clips that says "no clips" is the defect that work
 * exists to end. For a TIMELINE it is wrong and the measurement says why: on
 * 592, ours covers 85 362 s of the day and the card 21 388 s, and
 * `videoclips.listSources` answers the ONBOARD row first. A silent fall to the
 * first row would swap a 98.8 % bar for a 24.8 % one with nothing saying so.
 *
 * So a surface that cannot find our row says `ours-absent` and offers the
 * others as a CHOICE; it never takes one on the operator's behalf. The
 * reservation is enforced in the collection dispatcher — a `listSources` row
 * carrying this id from any addon but the recorder is refused by name — and by
 * `scripts/check-reserved-collection-sources.ts` in CI.
 *
 * NOTE on events (source of truth, R5/C3): this cap carries NO event surface.
 * Timeline events (motion/object/audio) come from `pipelineAnalytics` (durable
 * SQLite rows) and are the ONLY event surface — the recorder has none.
 * Event<->footage joins are by time, padded with the shared `EVENT_PAD_MS`
 * (`interfaces/recording-config.ts`).
 */
import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { CamProfileSchema } from './schemas/streaming-shared.js'

/**
 * OUR recorder's source id. RESERVED: no other provider may return it from
 * `listSources`, and the absence of an operator choice MEANS this value.
 *
 * Reserved is ENFORCED, not requested — `device-collection-dispatch.ts` drops a
 * row spelling it from any addon but {@link RECORDING_SOURCE_CAMSTACK_ADDON},
 * naming the impostor, and `scripts/check-reserved-collection-sources.ts`
 * fails CI on a provider package that spells it at all. A rule nothing checks
 * has already been broken somewhere.
 */
export const RECORDING_SOURCE_CAMSTACK = 'camstack'

/** The one addon allowed to serve {@link RECORDING_SOURCE_CAMSTACK}: the
 *  recorder, which is the addon that writes the footage (D560). */
export const RECORDING_SOURCE_CAMSTACK_ADDON = 'recorder'

export const RecordingRangeSchema = z.object({
  profile: z.string(),
  startMs: z.number(),
  endMs: z.number(),
})

/**
 * How a source ANSWERED, on every singular read of this cap.
 *
 * `'read'` — it looked. `ranges: []` / `days: []` is then a real claim: this
 * source has no coverage in the window. `'unreadable'` — nobody could look
 * (the camera was unreachable, the calendar rung threw, the location is
 * unmounted, the node is still on the old build), and the emptiness beside it
 * means NOTHING.
 *
 * The batch rows have carried this since the grid existed; the SINGULAR
 * answers gained it with the collection (D625 §10.4), because they are the
 * ones the single-camera picker uses and because a half-converted fleet makes
 * "nobody looked" common for the length of a deploy. Without it the timeline
 * has no vocabulary for it, and `(data ?? [])` in a viewer turns a rollout into
 * a fleet of cameras that appear to have lost their recordings (D315, D393).
 */
export const RecordingReadSchema = z.enum(['read', 'unreadable'])
export type RecordingRead = z.infer<typeof RecordingReadSchema>

export const RecordingAvailabilitySchema = z.object({
  deviceId: z.number(),
  /** See {@link RecordingReadSchema}. An `'unreadable'` answer carries an empty
   *  `ranges` that means nothing — never draw it as "no footage". */
  read: RecordingReadSchema,
  ranges: z.array(RecordingRangeSchema),
  /**
   * Every profile this camera has footage in AT THIS SOURCE — not only the one
   * `ranges` describes (D433).
   *
   * `ranges` answers for ONE profile by design: the timeline is a single bar,
   * and enumerating all of them triples the directory reads for a bar that
   * would look identical. But the answer used to say nothing about that, so a
   * caller asking "what can I export?" read the single preferred profile as
   * the only one that exists — on this deployment every camera records `high`
   * AND `low`, the low tree holding 14 GB for camera 101 alone, and the export
   * UI could not see it.
   *
   * Cheap: it is the same shallow directory read the profile CHOICE already
   * makes. Ask for a specific profile's ranges with the `profile` input.
   */
  profilesWithFootage: z.array(z.string()),
})
export type RecordingAvailability = z.infer<typeof RecordingAvailabilitySchema>

export const RecordingDaysSchema = z.object({
  deviceId: z.number(),
  /** See {@link RecordingReadSchema}. `days: []` on an `'unreadable'` answer is
   *  "nobody could look", and the date-picker must not spell it the same as
   *  "no footage this month". */
  read: RecordingReadSchema,
  /** Local-midnight epochs (UTC ms) of days that have ≥1 recorded segment. */
  days: z.array(z.number()),
})
export type RecordingDays = z.infer<typeof RecordingDaysSchema>

export const RecordingManifestSchema = z.object({
  deviceId: z.number(),
  /** Local filesystem path to the master playlist; null when no recording exists for the requested range. */
  localMasterPath: z.string().nullable(),
  /** HTTP(S) URL to the master playlist on the recording node's playback server
   *  (the PRIMARY candidate); null when no recording / server. Carries the
   *  scoped playback token in its path. */
  playbackUrl: z.string().nullable(),
  /**
   * Candidate master-playlist URLs the client tries in order (LAN first, then
   * remote — Tailscale/Cloudflare if the operator configured extra hosts), each
   * carrying the same scoped token. `playbackUrl` is the first entry. Empty when
   * there is no recording / server.
   */
  playbackEndpoints: z.array(z.string()),
})
export type RecordingManifest = z.infer<typeof RecordingManifestSchema>

export const RecordingSourceAvailabilitySchema = z.object({
  state: z.enum(['ok', 'sleeping', 'unreachable', 'no-storage', 'index-empty']),
  /** Free text, shown verbatim. Names the camera's own refusal when there is one. */
  reason: z.string().optional(),
  /** When this source's coverage was last CONFIRMED. A cached answer is never
   *  drawn as current: the surface shows the age whenever it is older than the
   *  refresh interval. The clip catalog's `catalogAsOf`, under the name the
   *  timeline uses for it. */
  coverageAsOf: z.number().optional(),
})
export type RecordingSourceAvailability = z.infer<typeof RecordingSourceAvailabilitySchema>

/**
 * One SOURCE of recorded coverage for a camera — a row of the picker.
 *
 * A provider lists the sources IT serves for that device, and answers for each
 * of them whether it can answer at all. A provider with nothing to offer on a
 * camera returns `[]` — it is not that camera's business. The five availability
 * states are `ClipSourceAvailability`'s verbatim: they mean exactly the same
 * things about a coverage index as about a clip catalog, and `sleeping` in
 * particular is what stops a battery camera being woken to paint a bar.
 */
export const RecordingSourceSchema = z.object({
  /** The source id. {@link RECORDING_SOURCE_CAMSTACK} for ours (RESERVED), a
   *  vendor namespace (`native:reolink:onboard`, …) for a camera's own store. */
  source: z.string(),
  /** Operator-facing name of the source ("CamStack recordings", "SD card"). */
  label: z.string(),
  /**
   * The addon that SERVES this row, and the value a later call passes as
   * `provider`.
   *
   * Optional for version skew only. The collection dispatcher stamps it from
   * the registry, so a row that travelled through the fan-out carries the
   * authoritative id whatever the provider filled in (D557 §4).
   */
  addonId: z.string().optional(),
  availability: RecordingSourceAvailabilitySchema,
})
export type RecordingSource = z.infer<typeof RecordingSourceSchema>

/**
 * What a surface may DRAW for this (camera, source) — D612's rule applied to a
 * timeline: **the source declares what it can do, and the surface draws what
 * was declared. It never assumes, and never offers a gesture it will then
 * refuse.** D612 exists because `8` and `16` were offered as clip rates, the
 * broker clamped them to `4`, and no line anywhere said so.
 *
 * Asked once per (camera, source) before anything is drawn — never replaced by
 * a constant the surface keeps, which is the second authority D612 ends.
 */
export const RecordingSourceOptionsSchema = z.object({
  /** How this source's media reaches the player.
   *  `archive` = our own indexed segment tree; `stream` = the provider's
   *  forward-only fMP4 (D597); `realtime` = a replay bound to wall clock. */
  transport: z.enum(['archive', 'stream', 'realtime']),

  /** What the BAR means. `continuous` = gaps are holes in a recording;
   *  `sparse` = gaps are the absence of one, and must be drawn as such.
   *
   *  Not an onboard-only concession: measured 2026-09-24, OUR bar covers 98.8 %
   *  of 107's day and 1.2 % of 1436's. It is a fact about a (source, camera)
   *  pair, and ours answers it per camera from `deriveRecordingMode`. */
  coverage: z.enum(['continuous', 'sparse']),

  /** Where the playhead may be put.
   *  `free`    — anywhere, to the frame.
   *  `forward` — only ahead of the current position.
   *  `segment` — a position SNAPS to the head of the covering segment; a finer
   *              ask is accepted by the camera and SILENTLY IGNORED. Measured
   *              on 1436 (Hikvision V5.7.1, 2026-09-23): a window-narrowed
   *              `ContentMgmt/search` returns a row and a `playbackURI`, the
   *              replay opens 200 and delivers media — and the burned-in OSD of
   *              the first frame reads the SEGMENT HEAD every time. Calling
   *              that `forward` would tell the surface it may move the playhead
   *              ahead within a loaded segment, which it may not. */
  seek: z.enum(['free', 'forward', 'segment']),

  /** Frame-step BACKWARD is meaningful. */
  stepBack: z.boolean(),
  /** Whether the drag-scrub gesture is served, as opposed to refused by name. */
  scrub: z.boolean(),
  /** Deliverable rates, ascending, always containing `1`. The surface draws its
   *  picker from this and from NOTHING else (D612, D620, D621). `0` is not a
   *  member: pause is the absence of a rate. */
  rates: z.array(z.number().positive()).min(1).readonly(),

  /** TRUE when a read of this source HOLDS the camera's only playback session.
   *  A surface with this set makes at most ONE read at a time and draws no
   *  scrub-thumbnail strip, no hover preview, no prefetch and no background
   *  refresh. The precedent is exact and expensive: filling one screen of
   *  Hikvision thumbnails at 1.01× realtime consumed fifteen minutes of that
   *  camera's only playback session (1.2.126, reported within minutes), and a
   *  timeline is a screenful of reads by construction. */
  exclusive: z.boolean(),
})
export type RecordingSourceOptions = z.infer<typeof RecordingSourceOptionsSchema>

/**
 * How to PLAY the instant that was asked for, from the chosen source.
 *
 * No new media transport is built for onboard sources: the `clip` arm is a
 * DELEGATION to the `videoclips` transport that vendor already has (D597 /
 * D616 / D617). The onboard half of this collection is a PROJECTION of
 * `videoclips` for coverage and a delegation to it for bytes.
 */
export const RecordingPlaybackSchema = z.discriminatedUnion('kind', [
  /** Ours. {@link RecordingManifestSchema} is unchanged from the method that
   *  used to be called `getPlaybackManifest`, so the recorder's implementation
   *  and the HLS player path are untouched behind the rename. */
  z.object({ kind: z.literal('hls'), manifest: RecordingManifestSchema }),

  z.object({
    kind: z.literal('clip'),
    /** The `videoclips` source namespace this clip id belongs to. */
    source: z.string(),
    clipId: z.string(),
    /** Where this clip actually STARTS. On a `seek: 'segment'` source the
     *  playhead lands here, not at the requested instant — the surface must be
     *  TOLD, not left to discover it from a burned-in OSD. */
    startsAtMs: z.number(),
  }),

  /** Nothing covers the instant. A reason, per D391: a branch that produces no
   *  media names why, and a branch that could not LOOK says that rather than
   *  "there is nothing here". */
  z.object({ kind: z.literal('none'), reason: z.string() }),
])
export type RecordingPlayback = z.infer<typeof RecordingPlaybackSchema>

export const recordingCapability = {
  name: 'recording',
  scope: 'device',
  /** Several sources per camera, listed beside each other. The mount stays
   *  `device-scoped` — see `resolveCapMount`'s ordering and D554: per-device
   *  wins over the global collection fan-out. */
  mode: 'collection',
  kind: 'wrapper',
  defaultActive: true,
  /** Recorded coverage is a property of a camera — the cap is meaningless on a
   *  sensor, a button or an event emitter, and the `defaultActive` auto-bind
   *  reads this to decide which devices it may claim. */
  deviceTypes: [DeviceType.Camera],
  methods: {
    /**
     * The sources this camera has, WITH the reason any of them cannot answer.
     *
     * Asked separately from `getAvailability` because an empty bar is
     * ambiguous and this is the only place the ambiguity is resolved: every
     * bound provider contributes its own rows, and a provider that could not be
     * reached at all still produces one row saying so. A surface that draws "no
     * recordings" without reading this is drawing a guess.
     *
     * The ONLY method here without a `provider` — it is the call that tells the
     * caller what to put there.
     */
    listSources: method(
      z.object({ deviceId: z.number() }),
      z.array(RecordingSourceSchema).readonly(),
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * Recorded coverage of `[fromMs, toMs)` at ONE source — the timeline bar.
     *
     * `protected`, not `admin`: a per-camera read is exactly what a camera
     * viewer is FOR, and the device-scoped mount routes through
     * `getProviderForDevice`, so a camera outside the caller's scope is refused
     * before a provider is reached.
     */
    getAvailability: method(
      z.object({
        deviceId: z.number(),
        /**
         * WHICH provider to ask — the `addonId` a {@link RecordingSourceSchema}
         * row carries, never a source id and never a list. **REQUIRED**, in the
         * schema, where the generated types make it unomittable rather than
         * merely discouraged (D554 amended).
         *
         * It was learned the expensive way on `videoclips.listClips`: measured
         * on the live hub 2026-09-20, device 107 bound to `recorder` AND
         * `provider-reolink`, a bare call with `limit: 3` answered SIX rows,
         * three from each source, merged — `device-collection-dispatch.ts`
         * leaves an unpinned fan-out un-narrowed, so absence buys the union the
         * method exists not to be. An un-narrowed `getAvailability` would do
         * that to a TIMELINE: our ranges and the card's clips unioned into one
         * bar, which is "two sources are never drawn together" broken in the
         * one place it matters most.
         *
         * A provider the device is not bound to is refused BY NAME (D552's
         * `rejectUnresolvedAddonPin`), never answered by another one.
         */
        provider: z.string().min(1),
        fromMs: z.number(),
        toMs: z.number(),
        /**
         * Answer for THIS profile instead of the source's preferred one (D433).
         * Absent keeps the timeline's behaviour — one bar, one profile, one set
         * of reads. `profilesWithFootage` on the answer says what may be asked
         * for.
         */
        profile: z.string().optional(),
      }),
      RecordingAvailabilitySchema,
      { kind: 'query', auth: 'protected' },
    ),
    /** Which calendar days in [fromMs,toMs) this source has ≥1 recording in,
     *  bucketed by the client's local day (`tzOffsetMinutes` = minutes to add
     *  to UTC). Drives the theater date-picker's day dots. `provider` is
     *  REQUIRED for the reason `getAvailability` states. */
    getDaysWithRecordings: method(
      z.object({
        deviceId: z.number(),
        provider: z.string().min(1),
        fromMs: z.number(),
        toMs: z.number(),
        tzOffsetMinutes: z.number(),
      }),
      RecordingDaysSchema,
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * How to PLAY `[fromMs, toMs)` at this source.
     *
     * It was `getPlaybackManifest`, and the rename is not cosmetic: a
     * "manifest" is an HLS master playlist, which is a property of OUR recorder
     * and of nothing else. Keeping the name would make every onboard
     * implementation a lie in its signature. The old shape survives verbatim
     * inside the union's `hls` arm, so the recorder's implementation is
     * unchanged behind it.
     */
    getPlayback: method(
      z.object({
        deviceId: z.number(),
        provider: z.string().min(1),
        fromMs: z.number(),
        toMs: z.number(),
        profile: CamProfileSchema.optional(),
      }),
      RecordingPlaybackSchema,
      { kind: 'query', auth: 'protected' },
    ),
    /**
     * What this (camera, source) can actually DO — asked before anything is
     * drawn. See {@link RecordingSourceOptionsSchema}; a constant the surface
     * keeps instead is the second authority D612 exists to end.
     */
    getPlaybackOptions: method(
      z.object({ deviceId: z.number(), provider: z.string().min(1) }),
      RecordingSourceOptionsSchema,
      { kind: 'query', auth: 'protected' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IRecordingProvider = InferProvider<typeof recordingCapability>
