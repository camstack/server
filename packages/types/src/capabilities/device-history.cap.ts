import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * device-history — the ONE mechanism for numeric history (D850).
 *
 * A device value is recorded because its capability says so (the `history`
 * block of a `*.cap.ts`, captured hub-side from `DeviceStateChanged`); any
 * other series is DECLARED by the addon that produces it and fed with points
 * (`record`) or closed five-minute buckets (`recordBuckets`). Rollups 5m / 1h /
 * 1d are computed here and nowhere else. Storage is `history.db` (D851).
 *
 * Who the PRODUCER is: `declareSeries`, `record` and `recordBuckets` are owner
 * checked against the `callerAddonId` the transport stamps into a call that
 * crossed a process (never in an input schema, so a session cannot supply it).
 * A call with no stamp is refused `not-owner`. The methods are `admin` so a
 * non-admin session never reaches them; an addon's `ctx.api` call bypasses the
 * tier by design.
 */

/** Whose history: a real device, or a cluster node (load, memory). */
export const DeviceHistorySubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), deviceId: z.number().int() }),
  z.object({ kind: z.literal('node'), nodeId: z.string().min(1) }),
])
export type DeviceHistorySubject = z.infer<typeof DeviceHistorySubjectSchema>

/**
 * `enum` stores a STATE as the ordinal of its value in the series' value list
 * (`DeviceHistorySeriesInfo.values`, append-only, so an ordinal never changes
 * meaning); a rollup keeps the time spent in each state (`states`).
 */
export const DeviceHistoryKindSchema = z.enum(['gauge', 'counter', 'boolean', 'enum'])
export type DeviceHistoryKind = z.infer<typeof DeviceHistoryKindSchema>

/** What a PRODUCER may declare. `enum` is cap-only: its value list is the cap field's. */
export const DeviceHistoryProducerKindSchema = z.enum(['gauge', 'counter', 'boolean'])
export type DeviceHistoryProducerKind = z.infer<typeof DeviceHistoryProducerKindSchema>

/**
 * A key computed at READ time from stored series of the same device, never
 * stored itself. Energy (kWh per bucket) comes from the power meter's
 * `kwhTotal` counter when the device has one, else from integrating its
 * `watts` gauge over time.
 */
export const DEVICE_HISTORY_ENERGY_KEY = 'derived:energy.kwh'

export const DeviceHistoryResolutionSchema = z.enum(['raw', '5m', '1h', '1d'])
export type DeviceHistoryResolution = z.infer<typeof DeviceHistoryResolutionSchema>

/** Why a producer's point or bucket was not stored. Counted, never silent (D391). */
export const DeviceHistoryRefusalReasonSchema = z.enum([
  'undeclared',
  'not-owner',
  'opted-out',
  'not-a-real-device',
  'rate',
  'ingest-mismatch',
  /** A timestamp in the future, older than the raw retention, or a bucket not aligned to 5 minutes. */
  'out-of-range',
])
export type DeviceHistoryRefusalReason = z.infer<typeof DeviceHistoryRefusalReasonSchema>

const RefusalSchema = z.object({
  key: z.string(),
  reason: DeviceHistoryRefusalReasonSchema,
  count: z.number().int(),
})

const IngestResultSchema = z.object({
  accepted: z.number().int(),
  refused: z.array(RefusalSchema).readonly(),
})
export type DeviceHistoryIngestResult = z.infer<typeof IngestResultSchema>

const SeriesInfoSchema = z.object({
  key: z.string(),
  scope: z.string(),
  kind: DeviceHistoryKindSchema,
  /** `null` is unknown (a `unitFrom` series whose device does not state a unit right now), never a guess. */
  unit: z.string().nullable(),
  displayName: z.string(),
  source: z.enum(['cap', 'addon', 'derived']),
  /** `enum`: the value of each ordinal (index = ordinal); `null` for every other kind. */
  values: z.array(z.string()).readonly().nullable(),
  firstTs: z.number(),
  lastTs: z.number(),
})
export type DeviceHistorySeriesInfo = z.infer<typeof SeriesInfoSchema>

const QueryPointSchema = z.object({
  /** Raw: the point's time. Rollup: the bucket start. */
  t: z.number(),
  samples: z.number().int(),
  /** `sum / samples`. */
  mean: z.number().nullable(),
  /** Time-weighted mean (`tw_sum / tw_ms`); `null` for bucket-ingested series. For a boolean: the fraction of time true. */
  twMean: z.number().nullable(),
  min: z.number(),
  max: z.number(),
  /** `null` is unknown, never zero (D393). For an `enum` series: the ordinal of {@link state}. */
  last: z.number().nullable(),
  /**
   * The increase over the point: a `counter`'s growth since the previous point
   * or bucket (a drop is a reset, counted from zero), and for
   * {@link DEVICE_HISTORY_ENERGY_KEY} the kWh used in the bucket. `null` for
   * every other kind, and when it cannot be known.
   */
  delta: z.number().nullable(),
  /** `enum`: the state in force at the end of the point (the name of `last`); `null` otherwise. */
  state: z.string().nullable(),
  /** `enum` rollup: milliseconds spent in each state inside the bucket; `null` for raw points and other kinds. */
  states: z.record(z.string(), z.number()).nullable(),
})
export type DeviceHistoryQueryPoint = z.infer<typeof QueryPointSchema>

const QuerySeriesSchema = z.object({
  scope: z.string(),
  /** The last point STRICTLY BEFORE `from` in the chosen tier, so a step chart can start at the held value. */
  before: z
    .object({ t: z.number(), value: z.number().nullable(), state: z.string().nullable() })
    .nullable(),
  points: z.array(QueryPointSchema).readonly(),
  /** A derived key: the stored key its points were computed from; `null` for a stored series. */
  derivedFrom: z.string().nullable(),
})

/** The window part of a query, shared by the device and node forms. */
const QueryWindowShape = {
  key: z.string(),
  scope: z.string().optional(),
  from: z.number(),
  to: z.number(),
  resolution: z.union([DeviceHistoryResolutionSchema, z.literal('auto')]).default('auto'),
  maxPoints: z.number().int().positive().max(5000).default(1000),
}

const QueryResultSchema = z.object({
  resolution: DeviceHistoryResolutionSchema,
  series: z.array(QuerySeriesSchema).readonly(),
  truncated: z.boolean(),
})
export type DeviceHistoryQueryResult = z.infer<typeof QueryResultSchema>

/** Items one `queryMany` may carry: a dashboard's worth, not a scan. */
export const DEVICE_HISTORY_QUERY_MANY_MAX_ITEMS = 24

/** One read of a batch: a device's key or a node's key (exactly one subject). */
const QueryManyItemSchema = z.union([
  z.object({ deviceId: z.number().int(), key: z.string(), scope: z.string().optional() }),
  z.object({ forNodeId: z.string().min(1), key: z.string(), scope: z.string().optional() }),
])
export type DeviceHistoryQueryManyItem = z.infer<typeof QueryManyItemSchema>

const QueryManyEntrySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: QueryResultSchema }),
  /** This item failed; the others still answered. */
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type DeviceHistoryQueryManyEntry = z.infer<typeof QueryManyEntrySchema>

const TierStatusSchema = z.object({
  tier: DeviceHistoryResolutionSchema,
  /** `null` until the first background count answered. */
  rows: z.number().int().nullable(),
  /** `rows` times a fixed per-row estimate — approximate, labelled so. */
  approxBytes: z.number().nullable(),
  countedAt: z.number().nullable(),
})

/** Operator/diagnostic view: rows per tier, last runs, refusals and drops since boot. */
// ── Orphan series (D917) ─────────────────────────────────────────────

/**
 * Why a series is orphan. `device-gone`: its device is absent from the
 * successful device listings (the departure clock). `undeclared`: its `cap:`
 * key is declared by no capability any more (a field a cap removed).
 */
export const DeviceHistoryOrphanReasonSchema = z.enum(['device-gone', 'undeclared'])
export type DeviceHistoryOrphanReason = z.infer<typeof DeviceHistoryOrphanReasonSchema>

/** Rows held per stored tier. */
const TierRowsSchema = z.object({
  raw: z.number().int(),
  '5m': z.number().int(),
  '1h': z.number().int(),
  '1d': z.number().int(),
})
export type DeviceHistoryTierRows = z.infer<typeof TierRowsSchema>

const OrphanSeriesSchema = z.object({
  seriesId: z.number().int(),
  deviceId: z.number().int(),
  key: z.string(),
  scope: z.string(),
  /** The metric's display name; `null` when its metric row is gone too. */
  displayName: z.string().nullable(),
  reason: DeviceHistoryOrphanReasonSchema,
  /** `device-gone`: since when the device has been absent; `null` otherwise. */
  missingSince: z.number().nullable(),
  firstTs: z.number(),
  lastTs: z.number(),
  rows: TierRowsSchema,
})
export type DeviceHistoryOrphanSeries = z.infer<typeof OrphanSeriesSchema>

/** At most this many orphans are listed (with their row counts) per call. */
export const DEVICE_HISTORY_ORPHAN_LIST_MAX = 200
/** At most this many series are deleted per call. */
export const DEVICE_HISTORY_ORPHAN_DELETE_MAX = 50

export const DeviceHistoryOrphanDeleteRefusalSchema = z.enum(['not-found', 'not-orphan', 'failed'])

const OrphanDeleteEntrySchema = z.discriminatedUnion('ok', [
  z.object({ seriesId: z.number().int(), ok: z.literal(true), deleted: TierRowsSchema }),
  z.object({
    seriesId: z.number().int(),
    ok: z.literal(false),
    reason: DeviceHistoryOrphanDeleteRefusalSchema,
  }),
])
export type DeviceHistoryOrphanDeleteEntry = z.infer<typeof OrphanDeleteEntrySchema>

const OrphanListSchema = z.object({
  series: z.array(OrphanSeriesSchema).readonly(),
  /** More orphans exist than {@link DEVICE_HISTORY_ORPHAN_LIST_MAX}. */
  truncated: z.boolean(),
})
export type DeviceHistoryOrphanList = z.infer<typeof OrphanListSchema>

export const DeviceHistoryStatusSchema = z.object({
  startedAt: z.number(),
  /** The store is declared, series loaded and the first reconcile has answered. */
  ready: z.boolean(),
  series: z.number().int(),
  metrics: z.number().int(),
  optedOutDevices: z.number().int(),
  tiers: z.array(TierStatusSchema).readonly(),
  capture: z.object({
    eventsSeen: z.number().int(),
    pointsEmitted: z.number().int(),
    pointsWritten: z.number().int(),
    pointsDropped: z.number().int(),
    bufferDepth: z.number().int(),
    trailingEmitted: z.number().int(),
    reconciledPoints: z.number().int(),
    reconcileRuns: z.number().int(),
    reconcileFailures: z.number().int(),
    lastReconcileAt: z.number().nullable(),
    lastFlushAt: z.number().nullable(),
    flushFailures: z.number().int(),
    skipped: z.record(z.string(), z.number().int()),
  }),
  ingest: z.object({
    accepted: z.number().int(),
    refused: z.record(z.string(), z.number().int()),
  }),
  rollup: z.object({
    last5mAt: z.number().nullable(),
    last1hAt: z.number().nullable(),
    last1dAt: z.number().nullable(),
    errors: z.number().int(),
    dirty5m: z.number().int(),
    dirty1h: z.number().int(),
    dirty1d: z.number().int(),
  }),
  retention: z.object({
    lastRunAt: z.number().nullable(),
    deleted: z.record(z.string(), z.number().int()),
    purgedSeries: z.number().int(),
  }),
  directory: z.object({
    devices: z.number().int(),
    lastRefreshAt: z.number().nullable(),
  }),
})
export type DeviceHistoryStatus = z.infer<typeof DeviceHistoryStatusSchema>

export const deviceHistoryCapability = {
  name: 'device-history',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /**
     * The series a DEVICE has, and their span. `deviceId` is a flat top-level field
     * on purpose: the generated device selector (and so the scope gate) only sees
     * top-level ids, and a nested `subject.deviceId` would let a principal limited
     * to one device read another's history. Node series are the admin-only
     * `listNodeSeries` / `queryNode`.
     */
    listSeries: method(
      z.object({ deviceId: z.number().int() }),
      z.array(SeriesInfoSchema).readonly(),
    ),
    /**
     * A NODE's series. The subject is `forNodeId`, never `nodeId`: a top-level
     * `nodeId` is the cap ROUTING key, and `nodeId: 'agent-a'` sent the
     * read to that agent, which hosts no device-history.
     */
    listNodeSeries: method(
      z.object({ forNodeId: z.string().min(1) }),
      z.array(SeriesInfoSchema).readonly(),
      { auth: 'admin' },
    ),

    /**
     * One series (or every scope of it) at one resolution. `auto` picks the
     * finest tier whose retention covers `from` and whose point count fits
     * `maxPoints`; when even the coarsest tier does not fit, the newest
     * `maxPoints` points are returned and `truncated` is true. A series fed by
     * closed buckets has no raw rows, so `auto` never answers it from raw; nor
     * {@link DEVICE_HISTORY_ENERGY_KEY}, which is computed from rollups.
     */
    query: method(z.object({ deviceId: z.number().int(), ...QueryWindowShape }), QueryResultSchema),
    queryNode: method(
      z.object({ forNodeId: z.string().min(1), ...QueryWindowShape }),
      QueryResultSchema,
      { auth: 'admin' },
    ),

    /**
     * Several reads over ONE window, answered in order (one entry per item).
     * Admin-only: its subjects are nested in `items`, where the device scope
     * gate cannot see them — a principal limited to one device uses `query`.
     */
    queryMany: method(
      z.object({
        items: z.array(QueryManyItemSchema).min(1).max(DEVICE_HISTORY_QUERY_MANY_MAX_ITEMS),
        from: QueryWindowShape.from,
        to: QueryWindowShape.to,
        resolution: QueryWindowShape.resolution,
        maxPoints: QueryWindowShape.maxPoints,
      }),
      z.object({ results: z.array(QueryManyEntrySchema).readonly() }),
      { auth: 'admin' },
    ),

    /** Producer: declare (idempotent) a series key this addon owns: `addon:<callerAddonId>/<name>`. */
    declareSeries: method(
      z.object({
        name: z.string().regex(/^[a-z0-9-]+$/),
        subjectKind: z.enum(['device', 'node']),
        kind: DeviceHistoryProducerKindSchema,
        unit: z.string().optional(),
        displayName: z.string().min(1),
        ingest: z.enum(['points', 'buckets']),
      }),
      z.object({ key: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Producer: points. Low rate: at most one per 10 s per series, sustained. */
    record: method(
      z.object({
        points: z
          .array(
            z.object({
              key: z.string(),
              subject: DeviceHistorySubjectSchema,
              scope: z.string().default(''),
              ts: z.number(),
              value: z.number(),
            }),
          )
          .max(5000),
      }),
      IngestResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Producer: CLOSED five-minute buckets. Idempotent upsert keyed (series, bucketStart). */
    recordBuckets: method(
      z.object({
        buckets: z
          .array(
            z.object({
              key: z.string(),
              subject: DeviceHistorySubjectSchema,
              scope: z.string().default(''),
              bucketStart: z.number(),
              samples: z.number().int().positive(),
              sum: z.number(),
              min: z.number(),
              max: z.number(),
              last: z.number().nullable(),
              lastTs: z.number().nullable(),
            }),
          )
          .max(5000),
      }),
      IngestResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Per-device opt-out. This addon IS the authority: the switch stores nothing elsewhere (D62). */
    getDeviceEnabled: method(
      z.object({ deviceId: z.number().int() }),
      z.object({ enabled: z.boolean() }),
    ),
    setDeviceEnabled: method(
      z.object({ deviceId: z.number().int(), enabled: z.boolean() }),
      z.object({ enabled: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    getStatus: method(z.object({}), DeviceHistoryStatusSchema, { auth: 'admin' }),

    /**
     * Device series no longer linked to a device (D917): the device is absent
     * from the listings, or the key is declared by no capability. REPORTED,
     * never purged by this judgement; each entry counts its rows per tier
     * (a primary-key range per series). Ordered by device, key, scope.
     */
    listOrphanSeries: method(z.object({}), OrphanListSchema, { auth: 'admin' }),

    /**
     * Delete orphan series by id. Each id is re-judged NOW: a series that is
     * not orphan (its device came back) is refused `not-orphan`, an unknown id
     * `not-found`. Deletes tier by tier in the retention slices, then the
     * series row; one entry per id, in order.
     */
    deleteOrphanSeries: method(
      z.object({
        seriesIds: z.array(z.number().int()).min(1).max(DEVICE_HISTORY_ORPHAN_DELETE_MAX),
      }),
      z.object({ results: z.array(OrphanDeleteEntrySchema).readonly() }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IDeviceHistoryProvider = InferProvider<typeof deviceHistoryCapability>
