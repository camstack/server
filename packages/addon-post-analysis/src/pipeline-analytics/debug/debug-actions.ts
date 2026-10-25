/**
 * The `debug.*` bridge — the Events → Debug tab's whole read surface.
 *
 * These are **custom actions**, not capability methods, deliberately. A cap
 * method is a cluster-wide contract: it needs codegen, a `@camstack/system`
 * force-publish and a release train before the UI can call it, and every node
 * carries the router whether or not it will ever answer. This tab is a hub-local
 * diagnostic over a store the hub already owns — nothing else in the cluster
 * consumes it — so it rides `addons.custom` and ships with a single
 * `camstack deploy`.
 *
 * The addonId to call these with is the MANIFEST id, `pipeline-analytics`, never
 * the npm package name `@camstack/addon-post-analysis`. The dispatcher's
 * not-found message says so out loud because the confusion has already cost this
 * repo an afternoon.
 *
 * ## Why the read is split in two
 *
 * `debug.listTracks` is a single indexed query per camera and returns the marked
 * set. `debug.analyze` is the expensive half — three media-inventory queries and
 * an event count PER TRACK — and is asked for explicitly, by id. Folding them
 * would have made opening the tab cost the analysis of every marked track on
 * every camera, which is the shape of request this repo has twice had to undo.
 *
 * `z.object({})` and never `z.void()` for an input-less action: the
 * `addons.custom` envelope requires an `input` field and validates it before the
 * action is resolved, so `z.void()` yields an action that can never be called.
 */

import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { MEDIA_PROVENANCES } from '../store/media-store.js'
import { CENSUS_MAX_WINDOW_MS } from '../store/read-census.js'

/** How many marked tracks one camera may return. The set is hand-made; this is a
 *  runaway guard, not a page size. */
export const MAX_DEBUG_TRACKS_PER_DEVICE = 200
/** How many tracks one `debug.analyze` call may inventory. */
const MAX_ANALYZE_TRACKS = 200
/**
 * How many tracks ONE export may carry, and how many bytes.
 *
 * Far tighter than the list caps, and deliberately so: listing is index rows,
 * exporting is every blob those rows point at, decoded from base64 and pushed
 * through the hub's one thread. An unbounded "export all" on a busy hub is a
 * self-inflicted outage, and this repo has already had one.
 */
export const MAX_EXPORT_TRACKS = 25
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024
/** How many five-minute rows one `debug.lts` call may return. A year of one
 *  series is 105,120 rows; a chart asks for a window, never the archive. */
const MAX_LTS_ROWS = 5_000

const DebugFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warn', 'info']),
  detail: z.string(),
})

/**
 * The subject fields every debug row carries.
 *
 * They exist so the tab can render the SAME card and the SAME detail surface
 * the Events feed renders — the operator asked for one visual language, and a
 * debug row that could not name its own best event would have needed a second,
 * text-only one. Every field is read off the `slim` row `listDebug` already
 * fetches, so the list costs exactly what it cost before.
 */
const DebugTrackSubjectFields = {
  trackId: z.string(),
  deviceId: z.number(),
  className: z.string(),
  /** Tier 1 (`bird`). */
  label: z.string().optional(),
  /** Tier 2 (`Turdus migratorius`) — the finest thing known about the subject. */
  subLabel: z.string().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  durationMs: z.number(),
  active: z.boolean(),
  importance: z.number().optional(),
  /** The event whose media the tile is drawn from. Empty/absent = no tile. */
  bestEventId: z.string().optional(),
  /** Operator flags, so the card renders them without a second read.
   *  **Absent ≠ false** — a row that predates the columns omits them. */
  markForTrain: z.boolean().optional(),
  favourited: z.boolean().optional(),
  /**
   * WHY this track closed without a native best-shot tile
   * ([D276](../../../../../docs/decisions/adr-0276-a-stand-in-tile-is-provisional-and-a-close-says-why.md)).
   * Absent means "nothing to say", never "it went fine".
   */
  previewMissReason: z.string().optional(),
} as const

const DebugTrackListItemSchema = z.object(DebugTrackSubjectFields)

const DebugTrackReportSchema = z.object({
  ...DebugTrackSubjectFields,
  mediaCount: z.number(),
  mediaKinds: z.array(z.string()).readonly(),
  eventCount: z.number(),
  positionCount: z.number(),
  findings: z.array(DebugFindingSchema).readonly(),
  /**
   * Where the stored `thumbnail`'s bytes came from — `native` > `raster` >
   * `standin` (D276). Store-internal and deliberately NOT on any cap output;
   * this bridge is a custom action, which is what makes publishing it a
   * one-deploy change. Omitted when the track has no thumbnail row at all.
   */
  thumbnailProvenance: z.enum(MEDIA_PROVENANCES).optional(),
})

const ListTracksInputSchema = z.object({
  /** Empty or absent means every camera that has tracks. */
  deviceIds: z.array(z.number()).optional(),
  limit: z.number().int().positive().max(MAX_DEBUG_TRACKS_PER_DEVICE).optional(),
})

const ListTracksOutputSchema = z.object({
  tracks: z.array(DebugTrackListItemSchema).readonly(),
  /**
   * True when a camera hit `limit`. Said rather than implied: a silently capped
   * list is how an operator concludes a mark did not take.
   */
  truncated: z.boolean(),
})

const AnalyzeInputSchema = z.object({
  trackIds: z.array(z.string()).min(1).max(MAX_ANALYZE_TRACKS),
})

const AnalyzeOutputSchema = z.object({
  reports: z.array(DebugTrackReportSchema).readonly(),
  /**
   * Ids that were asked for and no longer exist. Per D81 a `debug` mark does NOT
   * pin retention, so a marked track can be evicted between the list and the
   * analysis — reported as a number the tab can show rather than as silence.
   */
  vanished: z.array(z.string()).readonly(),
})

/**
 * Long-term statistics read surface.
 *
 * A custom action for the same reason the rest of this file is one: it is a
 * hub-local read over a store the hub already owns, and it ships with a single
 * `camstack deploy` instead of a release train. When a chart exists and needs
 * this cluster-wide, promoting it to a cap method is a separate decision made
 * once — not something to pre-pay for now.
 *
 * The MEAN is returned alongside `sum`/`samples` rather than instead of them:
 * a caller that wants to re-bucket (hour, day) needs the addable fields, and a
 * caller that wants a chart needs the mean. Deriving it here keeps the two from
 * ever disagreeing.
 */
const LtsQueryInputSchema = z.object({
  /** `motion` | `audio-dbfs` | `battery` | `occupancy`. Omit for all. */
  series: z.string().optional(),
  /** A camera id, as a string — node rows live in the orchestrator's own table. */
  subject: z.string().optional(),
  /** Zone id for `occupancy`; `''` is the frame-wide series. */
  scope: z.string().optional(),
  /** Inclusive bucket-start bounds, ms. */
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  limit: z.number().int().positive().max(MAX_LTS_ROWS).optional(),
})

const LtsRowSchema = z.object({
  subject: z.string(),
  deviceId: z.number().optional(),
  series: z.string(),
  scope: z.string(),
  bucketStart: z.number(),
  samples: z.number(),
  sum: z.number(),
  mean: z.number(),
  min: z.number(),
  max: z.number(),
})

const LtsQueryOutputSchema = z.object({
  rows: z.array(LtsRowSchema).readonly(),
  /** Buckets still accumulating in RAM — so "is it running" is answerable
   *  immediately rather than after the first five minutes of silence. */
  open: z.array(LtsRowSchema).readonly(),
})

/** How many call sites one census read may return. */
export const MAX_CENSUS_SITES = 200

/**
 * How many evidence candidates one camera may return.
 *
 * A device is capped at `EVIDENCE_MAX_CANDIDATES_PER_DEVICE` (512) and 102 was
 * carrying ~497 of them when the mis-binding was found, so the default has to
 * be a page, not the archive.
 */
const MAX_STATIONARY_CANDIDATES = 200
export const DEFAULT_STATIONARY_CANDIDATES = 25

/**
 * Arm / read the store-read call-site census (`store/read-census.ts`).
 *
 * `armMs: 0` reads the last window without starting a new one, which is how a
 * result is fetched after the window closed. Anything else re-arms and clears —
 * see `StoreReadCensus.arm` for why two windows may never share one table.
 */
const StoreCensusInputSchema = z.object({
  armMs: z.number().int().min(0).max(CENSUS_MAX_WINDOW_MS).optional(),
  limit: z.number().int().positive().max(MAX_CENSUS_SITES).optional(),
})

const StoreCensusRowSchema = z.object({
  op: z.string(),
  site: z.string(),
  calls: z.number(),
  /** Calls extrapolated to a minute, so it is directly comparable with the
   *  engine's own `sqlite engine busy` report. */
  perMin: z.number(),
  rows: z.number(),
})

const StoreCensusOutputSchema = z.object({
  armed: z.boolean(),
  elapsedMs: z.number(),
  sites: z.number(),
  calls: z.number(),
  rows: z.array(StoreCensusRowSchema).readonly(),
})

/**
 * The stationary registry + evidence ledger, read as they stand right now.
 *
 * This exists because a live audit on 2026-08-28 could not answer two questions
 * from the logs alone, and both turned out to BE the defect:
 *
 *  - **Which candidate captured a track?** A promotion reports `agreed`/`seen`;
 *    it never says which track fed the row, or which track went elsewhere. The
 *    D280 mis-binding was reconstructed by ARITHMETIC (240 = one track's 239
 *    observations + 1) because nothing could be asked directly. `bindings`
 *    answers it.
 *  - **What is waiting to retire?** A departure strike is invisible between the
 *    read that arms it and the retirement it causes. `strikes` shows the
 *    pending ones with their age, which is precisely the number D279 turns on.
 *
 * Read-only, hub-local, and a custom action rather than a cap method for the
 * same reason as everything else in this file: no codegen, no publish train,
 * one `camstack deploy`.
 */
const StationaryInputSchema = z.object({
  /** Empty or absent means every camera holding an entry or a candidate. */
  deviceIds: z.array(z.number()).optional(),
  /** Candidates per camera, best-evidenced first. */
  candidateLimit: z.number().int().positive().max(MAX_STATIONARY_CANDIDATES).optional(),
})

const StationaryBboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})

const StationaryEntrySchema = z.object({
  id: z.string(),
  className: z.string(),
  bbox: StationaryBboxSchema,
  becameStationaryAt: z.number(),
  lastConfirmedAt: z.number(),
  sourceTrackId: z.string().optional(),
  label: z.string().optional(),
})

const StationaryStrikeSchema = z.object({
  entryId: z.string(),
  armedAt: z.number(),
  absentReads: z.number(),
  /** Age against the device's own OBSERVED clock, not wall time — the same
   *  clock the confirmation gap is measured on. */
  observedAgeMs: z.number(),
})

const StationaryCandidateSchema = z.object({
  key: z.string(),
  className: z.string(),
  anchor: StationaryBboxSchema,
  agreed: z.number(),
  seen: z.number(),
  ratio: z.number(),
  spanMs: z.number(),
  firstAgreedAt: z.number(),
  lastAgreedAt: z.number(),
  updatedAt: z.number(),
  sourceTrackId: z.string().optional(),
})

const StationaryBindingSchema = z.object({
  trackId: z.string(),
  candidateKey: z.string(),
})

const StationaryDeviceSchema = z.object({
  deviceId: z.number(),
  /** When the current observation session opened. Absent means no frame has
   *  reached the gate for this camera since boot — a different statement from
   *  "nothing is parked here". */
  sessionOpenedAt: z.number().optional(),
  /** The device's observed clock (its latest processed frame), which every
   *  age in this payload is measured against. */
  observedAt: z.number().optional(),
  entries: z.array(StationaryEntrySchema).readonly(),
  strikes: z.array(StationaryStrikeSchema).readonly(),
  candidates: z.array(StationaryCandidateSchema).readonly(),
  /** True when `candidates` was cut by `candidateLimit`. Said rather than
   *  implied: a silently capped list is how a reader concludes a row is gone. */
  candidatesTruncated: z.boolean(),
  candidateTotal: z.number(),
  bindings: z.array(StationaryBindingSchema).readonly(),
})

const StationaryOutputSchema = z.object({
  devices: z.array(StationaryDeviceSchema).readonly(),
})

export const debugActions = defineCustomActions({
  'debug.listTracks': customAction(ListTracksInputSchema, ListTracksOutputSchema, {
    auth: 'admin',
  }),
  'debug.analyze': customAction(AnalyzeInputSchema, AnalyzeOutputSchema, { auth: 'admin' }),
  'debug.lts': customAction(LtsQueryInputSchema, LtsQueryOutputSchema, { auth: 'admin' }),
  'debug.storeCensus': customAction(StoreCensusInputSchema, StoreCensusOutputSchema, {
    auth: 'admin',
  }),
  'debug.stationary': customAction(StationaryInputSchema, StationaryOutputSchema, {
    auth: 'admin',
  }),
})

export type DebugStoreCensusInput = z.infer<typeof StoreCensusInputSchema>
export type DebugStoreCensusOutput = z.infer<typeof StoreCensusOutputSchema>

export type DebugLtsInput = z.infer<typeof LtsQueryInputSchema>
export type DebugLtsOutput = z.infer<typeof LtsQueryOutputSchema>

export type DebugActions = typeof debugActions
export type DebugListTracksInput = z.infer<typeof ListTracksInputSchema>
export type DebugListTracksOutput = z.infer<typeof ListTracksOutputSchema>
export type DebugTrackListItem = z.infer<typeof DebugTrackListItemSchema>
export type DebugAnalyzeInput = z.infer<typeof AnalyzeInputSchema>
export type DebugAnalyzeOutput = z.infer<typeof AnalyzeOutputSchema>
export type DebugStationaryInput = z.infer<typeof StationaryInputSchema>
export type DebugStationaryOutput = z.infer<typeof StationaryOutputSchema>
export type DebugStationaryDevice = z.infer<typeof StationaryDeviceSchema>
