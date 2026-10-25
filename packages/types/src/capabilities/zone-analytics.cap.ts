import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * Per-zone occupancy aggregation produced by the analytics frame
 * processor on every inference result. Covers the full combinatorial
 * matrix the operator UI needs: total objects everywhere, total
 * objects per zone, single class everywhere, single class per zone,
 * objects outside any zone.
 *
 * Counts are derived from the analytics tracker (tracked detections
 * with stable trackIds), not raw detector hits — this filters out
 * one-off detector flickers and gives counts that match what the user
 * sees on the live overlay.
 *
 * Overlap policy: a detection that intersects two zones counts in
 * BOTH zones' `byClass` and `totalObjects` (count-in-each). The
 * `frame` aggregate de-duplicates trivially since it's frame-wide.
 * `unzoned` counts only detections that landed in zero zones.
 */
const PerScopeBreakdownSchema = z.object({
  /** Total tracked objects in this scope (frame / zone / unzoned). */
  totalObjects: z.number().int().nonnegative(),
  /** Per-class count. Keys are macro class names (e.g. `person`, `car`). */
  byClass: z.record(z.string(), z.number().int().nonnegative()),
  /**
   * Of `totalObjects`, how many are STANDING — objects the census holds,
   * present but not going anywhere (a parked car, a bin, a statue).
   *
   * The operator's question about a scene has two halves and they answer
   * different things: "what is parked here" is stable for hours and must not
   * flap, while "who is walking through" is the thing an alert is about. One
   * number could only serve one of them, and `totalObjects` served the first
   * badly — a passer-by moved it and every occupancy rule saw a change.
   *
   * `standing + transient === totalObjects`, always. The total keeps its old
   * meaning exactly, so no rule written against it changes behaviour.
   *
   * ABSENT means UNKNOWN, never zero (D393): a snapshot from a node older than
   * this field cannot say, and a reader that folds absence in as 0 reports "no
   * parked objects here" about a camera whose lot is full.
   */
  standingObjects: z.number().int().nonnegative().optional(),
  /** Of `totalObjects`, how many are passing through. See `standingObjects` —
   *  same absence rule. */
  transientObjects: z.number().int().nonnegative().optional(),
})

const ZoneScopeBreakdownSchema = PerScopeBreakdownSchema.extend({
  zoneId: z.string(),
  zoneName: z.string(),
  /** TrackIds of objects currently inside this zone — for cross-reference
   *  with the per-track detail panel and live overlay. */
  trackIds: z.array(z.string()).readonly(),
})

/**
 * A parked ("stationary") object surfaced alongside occupancy — an object that
 * settled and stopped moving. It is NO LONGER a tracked object (the tracker was
 * told to forget it so it stops re-spawning tracks/events), but it IS still
 * physically present, so it keeps counting toward `frame` occupancy and is
 * listed here so the UI can show it in a dedicated "Stationary" section instead
 * of flooding the live event feed.
 */
const StationaryObjectSchema = z.object({
  id: z.string(),
  className: z.string(),
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
  frameWidth: z.number().int().nonnegative(),
  frameHeight: z.number().int().nonnegative(),
  /** When the source track was first seen. */
  firstSeenAt: z.number().int(),
  /** When the object was recognised as parked (promotion time). */
  becameStationaryAt: z.number().int(),
  /** Last frame a detection confirmed the object is still there. */
  lastConfirmedAt: z.number().int(),
  /** Enrichment label carried from the source track (identity / plate). */
  label: z.string().optional(),
  /** Native-resolution key-frame media key for the parked object's best image. */
  keyFrameMediaId: z.number().int().optional(),
})
export type StationaryObject = z.infer<typeof StationaryObjectSchema>

export const CameraOccupancySnapshotSchema = z.object({
  /** Frame timestamp of the inference result that produced this snapshot. */
  ts: z.number().int(),
  /** Frame width/height in pixels — let the UI normalize bbox coords. */
  frameWidth: z.number().int().nonnegative(),
  frameHeight: z.number().int().nonnegative(),
  /** Per-zone breakdown — one entry per defined zone (user + onboard). */
  zones: z.array(ZoneScopeBreakdownSchema).readonly(),
  /** Frame-wide aggregate (everywhere, regardless of zone membership).
   *  INCLUDES currently-confirmed stationary objects (they are still present). */
  frame: PerScopeBreakdownSchema,
  /** Detections that landed outside every zone. Empty when no zones defined. */
  unzoned: PerScopeBreakdownSchema,
  /** Parked objects on this camera (additive — absent on legacy snapshots).
   *  Surfaced separately so the UI shows them in a dedicated section rather
   *  than as repeated tracks/events. */
  stationaryObjects: z.array(StationaryObjectSchema).readonly().optional(),
})
export type CameraOccupancySnapshot = z.infer<typeof CameraOccupancySnapshotSchema>

/**
 * One camera's row in a `getCurrentSnapshotBatch` answer.
 *
 * THREE outcomes, and the single-camera method could only express two of them
 * because `snapshot: null` was already spoken for:
 *
 *  - `read: 'read'`, `snapshot` present — the live occupancy reading.
 *  - `read: 'read'`, `snapshot: null`   — read, and this camera has no reading
 *    yet: no frame since boot, and no parked-object registry to hydrate from.
 *  - `read: 'unreadable'`               — the owner could not answer for this
 *    camera. `snapshot` is null, and it does NOT mean "nothing parked here".
 *
 * Collapsing the last two is the failure this field exists to prevent: a
 * hydration that threw would otherwise render as an empty Stationary section,
 * which is a definite claim about a camera nobody could read.
 */
export const CameraOccupancySnapshotForDeviceSchema = z.object({
  deviceId: z.number(),
  read: z.enum(['read', 'unreadable']),
  snapshot: CameraOccupancySnapshotSchema.nullable(),
})
export type CameraOccupancySnapshotForDevice = z.infer<
  typeof CameraOccupancySnapshotForDeviceSchema
>
export type ZoneScopeBreakdown = z.infer<typeof ZoneScopeBreakdownSchema>
export type PerScopeBreakdown = z.infer<typeof PerScopeBreakdownSchema>

/**
 * Time-series resolution. The history methods return one bucket per
 * step over the requested range. Smaller resolutions cost more
 * memory + bandwidth; bound to discrete steps so caller cannot ask
 * for arbitrary fractional buckets.
 */
const HistoryResolutionEnum = z.enum(['minute', '5min', 'hour'])
export type HistoryResolution = z.infer<typeof HistoryResolutionEnum>

const HistoryRangeSchema = z.object({
  /** Range start (epoch ms, inclusive). */
  from: z.number().int(),
  /** Range end (epoch ms, inclusive). Defaults to "now" at query time. */
  to: z.number().int(),
  resolution: HistoryResolutionEnum,
})

const HistoryPointSchema = z.object({
  /** Bucket midpoint (epoch ms). */
  ts: z.number().int(),
  /** Object count averaged over the bucket (rounded to nearest integer). */
  count: z.number().int().nonnegative(),
})
export type HistoryPoint = z.infer<typeof HistoryPointSchema>

/**
 * Zone Analytics capability — spatial occupancy aggregations over
 * tracked detections. Hosted by `addon-pipeline-analytics`.
 *
 * Live snapshot is mirrored into the `zone-occupancy` device-state
 * slice on every frame; the cap method `getCurrentSnapshot` is a
 * direct read for callers that don't want to subscribe.
 *
 * History methods are sourced from a 60-minute rolling in-memory
 * ring of frame-level samples (sub-second resolution). Queries
 * outside the ring window return empty arrays — durable storage
 * is a follow-up (Step 4b: persisted samples → SQL store).
 *
 * Every history method takes an optional `className` filter:
 * - omitted → bucket count includes ALL classes in scope
 * - present → bucket count restricted to that class
 *
 * The `getZoneHistory` / `getCameraHistory` / `getUnzonedHistory`
 * triple covers the three spatial scopes (per-zone, frame-wide,
 * outside-any-zone). Crossing them with `className?` gives the full
 * combinatorial coverage the operator UI requested.
 *
 * ## ⚠️ The three history methods are DEPRECATED
 *
 * They are served from a 60-MINUTE in-memory ring. It dies with the process,
 * so after a restart they report nothing about a night that did happen, and any
 * window past an hour is silently clamped — a caller cannot tell a clamp from
 * an empty scene. The presets in the occupancy chart existed to hide that
 * horizon rather than to answer a question.
 *
 * Use `pipelineAnalytics.readLongTermSeries({ series: 'occupancy', scope })`
 * instead. Those rows are already written for every camera, ~60 bytes per
 * (camera, scope, 5-minute bucket), kept for a year, and survive a restart.
 * Spell the scope with `occupancyScope(zoneId?, className?)` — the same
 * function the writer uses, so the two cannot drift.
 *
 * The ring stays until these three go, and it is the only thing left reading
 * it. Do not add a fourth caller.
 */
export const zoneAnalyticsCapability = {
  name: 'zone-analytics',
  scope: 'device',
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /** Latest computed occupancy snapshot for this camera. Null when
     *  the analytics pipeline hasn't seen a frame for this device yet
     *  (no inference result emitted since boot or since binding was
     *  activated). */
    getCurrentSnapshot: method(
      z.object({ deviceId: z.number() }),
      CameraOccupancySnapshotSchema.nullable(),
    ),
    /**
     * The same snapshot, for a SET of cameras, in one round trip.
     *
     * The Events page's Stationary section polls this every 15s for every
     * selected camera. Fanned out client-side that is one query per camera to
     * read a `Map.get` at the owner — the answer costs nothing, the round trip
     * costs everything. Batched, N transports become one and the per-device
     * work is unchanged.
     *
     * Every requested deviceId gets a row, tagged `read` — see
     * {@link CameraOccupancySnapshotForDeviceSchema}. A camera the owner could
     * not answer for is `'unreadable'`, never an empty reading.
     */
    getCurrentSnapshotBatch: method(
      z.object({ deviceIds: z.array(z.number()).min(1).max(200) }),
      z.array(CameraOccupancySnapshotForDeviceSchema).readonly(),
    ),
    /** Time-series object count inside one zone. `className` optional —
     *  omit to count every class in the zone. */
    getZoneHistory: method(
      z
        .object({
          deviceId: z.number(),
          zoneId: z.string(),
          className: z.string().optional(),
        })
        .extend(HistoryRangeSchema.shape),
      z.array(HistoryPointSchema).readonly(),
    ),
    /** Time-series frame-wide object count (everywhere). */
    getCameraHistory: method(
      z
        .object({
          deviceId: z.number(),
          className: z.string().optional(),
        })
        .extend(HistoryRangeSchema.shape),
      z.array(HistoryPointSchema).readonly(),
    ),
    /** Time-series count of objects outside every zone. */
    getUnzonedHistory: method(
      z
        .object({
          deviceId: z.number(),
          className: z.string().optional(),
        })
        .extend(HistoryRangeSchema.shape),
      z.array(HistoryPointSchema).readonly(),
    ),
  },
  /**
   * Runtime-state slice — the latest occupancy snapshot mirrored by
   * the analytics frame processor on every inference result. Consumers
   * read via `device.state.zoneAnalytics.value` and stay in sync
   * automatically; the explicit `getCurrentSnapshot` cap method is
   * still useful for one-off polls without a subscription.
   */
  runtimeState: CameraOccupancySnapshotSchema,

  /**
   * Runtime-state durability: **session** — per-frame analytics; with `audio-metrics` it is ~90 % of the offered write rate. Re-derived on the next frame.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — occupancy is the addon series `pipeline-analytics/occupancy`; the rest is per-zone arrays keyed by runtime ids.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IZoneAnalyticsProvider = InferProvider<typeof zoneAnalyticsCapability>

export {
  CameraOccupancySnapshotSchema as _CameraOccupancySnapshotSchema,
  HistoryPointSchema,
  HistoryRangeSchema,
  HistoryResolutionEnum,
  PerScopeBreakdownSchema,
  StationaryObjectSchema,
  ZoneScopeBreakdownSchema,
}
