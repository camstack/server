/**
 * Record kinds owned by the pipeline-analytics addon (records plan phase 2,
 * steps 7-11).
 *
 * Each kind replaced the legacy `pipeline-analytics:*` collection of the same
 * name; the records migration that copied them is closed (D900) and the tables
 * are gone (dropped offline on the operator hubs). The addon declares no
 * `execution.group`, so the hub owner stamp is the addon id
 * (`pipeline-analytics`).
 */
import { z } from 'zod'
import { defineRecordKinds, RECORD_MAX_DATA_BYTES, SceneMonitorSchema } from '@camstack/types'
import { DurableLedgerBodySchema } from '../durable/durable-record-body.js'
import {
  AudioEventBodySchema,
  FaceLedgerBodySchema,
  MotionEventBodySchema,
  IdentityConfigBodySchema,
  IdentitySampleLedgerBodySchema,
  PaEventsLedgerBodySchema,
  PlateLedgerBodySchema,
  SensorEventBodySchema,
  VehicleConfigBodySchema,
  VehicleSampleLedgerBodySchema,
} from './store/event-record-bodies.js'
import { FaceRescoreJobStatusSchema } from './face-rescore-job-status.js'

/**
 * Kinds that must agree through ONE `transact` sit in one file under one family
 * name, and the engine refuses a family split across files (records plan risk 8).
 * A gallery entry and its samples are deleted together; so are the four retrain
 * ledgers. All of them live in `events.db`, beside the vec indexes the samples
 * feed.
 */
const IDENTITY_GALLERY = 'identity-gallery'
const VEHICLE_GALLERY = 'vehicle-gallery'
const RETRAIN = 'retrain'

/** One scene definition. The record id is the `(deviceId, monitorId)` key. */
const SceneBodySchema = z.object({
  deviceId: z.number(),
  enabled: z.boolean(),
  updatedAt: z.number(),
  /** The FULL monitor, validated on write; the scalars above are indexed projections only. */
  monitor: SceneMonitorSchema,
})
export type SceneBody = z.infer<typeof SceneBodySchema>

/** A boot-migration completion marker; its PRESENCE is the fact. */
const MigrationMarkerBodySchema = z.object({
  completedAt: z.number(),
  /** Rows the pass rewrote (the audio-class pass reports it). */
  rewritten: z.number().optional(),
})
export type MigrationMarkerBody = z.infer<typeof MigrationMarkerBodySchema>

/** The orphan audit's resume position: one row, the whole map in one value on purpose. */
const SweepCursorBodySchema = z.object({
  /** A number is an offset (a settings-store scope); a string is the records
   *  engine's opaque keyset cursor (a scope walked through its kind). */
  scopes: z.record(z.string(), z.union([z.number(), z.string()])),
  /** Absent on a row written before the walk existed — absent means "from the top". */
  faceVectorCursor: z.number().optional(),
  /** One cursor per CLIP index, keyed by index name. Absent on an older row. */
  clipIndexCursors: z.record(z.string(), z.number()).optional(),
  updatedAtMs: z.number(),
})
export type SweepCursorBody = z.infer<typeof SweepCursorBodySchema>

/** The last COMPLETED face rescore: the fingerprint it ran under and its report. */
const FaceRescoreStateBodySchema = z.object({
  fingerprint: z.string().min(1),
  finishedAt: z.number(),
  report: FaceRescoreJobStatusSchema,
})
export type FaceRescoreStateBody = z.infer<typeof FaceRescoreStateBodySchema>

export const pipelineAnalyticsRecordKinds = defineRecordKinds({
  scenes: {
    schema: SceneBodySchema,
    class: 'config',
    writeTrigger:
      'an operator CRUD on a scene (create, update, delete, capture a reference, delete a reference) — one row per (deviceId, monitorId)',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'device', fields: ['deviceId'] }],
    retention: {
      none: 'operator intent: a scene goes only through deleteScene, never by age',
    },
    // Each reference carries two CLIP embeddings (~6-10 KB each): a scene row can pass the 64 KiB default.
    maxDataBytes: RECORD_MAX_DATA_BYTES,
  },
  migrations: {
    schema: MigrationMarkerBodySchema,
    class: 'config',
    database: 'events',
    writeTrigger:
      'one marker row when a boot migration (label-tier-4g, audio-track-class-d189) completes without truncating',
    device: 'none',
    at: 'none',
    retention: {
      none: 'its PRESENCE stops the migration re-scanning every track, face and event row on the next boot; bounded by the number of migrations ever written (two today)',
    },
  },
  'sweep-cursors': {
    schema: SweepCursorBodySchema,
    class: 'config',
    database: 'events',
    writeTrigger:
      'the end of every orphan-audit pass rewrites the one row holding every scope cursor',
    device: 'none',
    at: 'none',
    retention: {
      none: 'one row (id orphan-audit); losing it costs a re-walk from offset 0, never a wrong delete',
    },
  },
  'face-rescore-state': {
    schema: FaceRescoreStateBodySchema,
    class: 'config',
    writeTrigger: 'a whole-archive face rescore (manual or scheduled) completes',
    device: 'none',
    at: 'none',
    retention: {
      none: 'one row (id last-run); losing it costs one idempotent rescore on the next scheduler tick',
    },
  },

  // ── Phase 3 live-state ledgers (DurableLedger → records) ─────────────────

  'phantom-cells': {
    schema: DurableLedgerBodySchema,
    class: 'ledger',
    writeTrigger: 'a phantom cell closes and the short-motionless bar records it',
    device: 'required',
    at: 'none',
    retention: {
      none: 'bounded by per-device cap in application code',
    },
  },
  'package-background': {
    schema: DurableLedgerBodySchema,
    class: 'ledger',
    writeTrigger: 'package background state accepted for a device',
    device: 'required',
    at: 'none',
    retention: { none: 'one row per device key the owner tracks' },
  },
  'stationary-evidence': {
    schema: DurableLedgerBodySchema,
    class: 'ledger',
    writeTrigger: 'stationary evidence row written on the registry sweep',
    device: 'required',
    at: 'none',
    retention: { none: 'owner sweep drops idle evidence; maxRowsPerDevice in kind metadata' },
  },
  'stationary-objects': {
    schema: DurableLedgerBodySchema,
    class: 'ledger',
    writeTrigger: 'parked object registry upsert or flush on the sweep interval',
    device: 'required',
    at: 'none',
    retention: { none: 'rows drop when the object moves or TTL expires' },
  },
  'scene-latch': {
    schema: DurableLedgerBodySchema,
    class: 'ledger',
    writeTrigger: 'scene monitor latch state write-through after a verdict',
    device: 'required',
    at: 'none',
    retention: { none: 'one row per (deviceId, monitorId) scene latch' },
  },

  // ── Phase 5 trackless event ledgers (events.db) ─────────────────────────

  'motion-events': {
    schema: MotionEventBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per motion episode (D475): INSERT on rising edge, UPDATE once at close',
    device: 'required',
    at: 'required',
    indexes: [{ name: 'device', fields: ['deviceId'] }],
    deviceRemoval: 'delete',
    retention: {
      owner: 'device-window',
      reason: 'terminal age-keyed root swept with the device retention window (D61/D62)',
    },
  },
  'audio-events': {
    schema: AudioEventBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger:
      'one row per accepted audio episode (classification path; level rows are history P4)',
    device: 'required',
    at: 'required',
    indexes: [{ name: 'device', fields: ['deviceId'] }],
    deviceRemoval: 'delete',
    retention: {
      owner: 'device-window',
      reason: 'terminal age-keyed root on the device window, same as motion-events',
    },
  },
  'sensor-events': {
    schema: SensorEventBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger:
      'one row per (watching camera, linked-sensor state change); ingest is telemetry-lossy (D8)',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'device', fields: ['deviceId'] },
      { name: 'device_kind', fields: ['deviceId', 'kind'] },
    ],
    deviceRemoval: 'delete',
    retention: {
      owner: 'device-window',
      reason: 'terminal age-keyed root on the camera retention window (D61)',
    },
  },
  faces: {
    schema: FaceLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger:
      'one UPSERT per track face detail (`face-<trackId>`); the recognizer overwrites as a better read lands',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'device', fields: ['deviceId'] },
      { name: 'assigned_ts', fields: ['assigned', 'timestamp'] },
      { name: 'identity_ts', fields: ['recognizedIdentityId', 'timestamp'] },
      // `recognized` is the denormalised "carries an identity" bit (face-recognized.ts): the
      // recognized / identified gallery views and the pending list are ranges over it.
      { name: 'recognized_ts', fields: ['recognized', 'timestamp'] },
      { name: 'assigned_recognized_ts', fields: ['assigned', 'recognized', 'timestamp'] },
      { name: 'track', fields: ['trackId'] },
    ],
    retention: {
      none: 'track-owned (D61): rows leave with their track; enrolled faces exempt from capacity sweeps',
    },
  },
  identities: {
    schema: IdentityConfigBodySchema,
    class: 'config',
    // events.db with its samples and the vec indexes (one family, one file).
    database: 'events',
    transactFamily: IDENTITY_GALLERY,
    writeTrigger:
      'one row per person the operator creates; updated on rename and on every sample add or remove',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'name', fields: ['name'] }],
    retention: {
      none: 'operator delete only — losing the gallery un-enrols every person',
    },
  },
  'identity-samples': {
    schema: IdentitySampleLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per face sample the operator enrols onto an identity',
    device: 'optional',
    at: 'required',
    indexes: [
      { name: 'identity_added', fields: ['identityId', 'addedAt'] },
      // The re-enrol passes list samples by `source` (`photo`, `detected`)
      // across every identity: a filter no declared index serves is refused.
      { name: 'source_added', fields: ['source', 'addedAt'] },
    ],
    retention: {
      none: 'enrollment exempt — rows leave only on removeSample or deleteIdentity',
    },
    transactFamily: IDENTITY_GALLERY,
  },
  vehicles: {
    schema: VehicleConfigBodySchema,
    class: 'config',
    // Same as identities: the family lives in events.db.
    database: 'events',
    transactFamily: VEHICLE_GALLERY,
    writeTrigger:
      'one row per vehicle the operator creates; updated on rename and on every sample add or remove',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'name', fields: ['name'] }],
    retention: {
      none: 'operator delete only — losing the gallery un-enrols every vehicle',
    },
  },
  'vehicle-samples': {
    schema: VehicleSampleLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per plate read the operator enrols onto a vehicle',
    device: 'optional',
    at: 'required',
    indexes: [{ name: 'vehicle_added', fields: ['vehicleId', 'addedAt'] }],
    retention: {
      none: 'enrollment exempt — rows leave only on removeSample or deleteVehicle',
    },
    transactFamily: VEHICLE_GALLERY,
  },
  plates: {
    schema: PlateLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger:
      'one UPSERT per track plate read (`plate-<trackId>`); higher-scoring OCR overwrites the row',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'device', fields: ['deviceId'] },
      { name: 'track', fields: ['trackId'] },
      { name: 'vehicle_ts', fields: ['recognizedVehicleId', 'timestamp'] },
    ],
    retention: {
      none: 'track-owned (D61): rows leave with their track; corrected and enrolled reads exempt',
    },
  },
  'track-aliases': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger:
      'one row per L2 fusion (D683): alias id → survivor trackId; rewritten when the survivor is absorbed',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'track', fields: ['trackId'] },
      { name: 'device', fields: ['deviceId'] },
    ],
    retention: {
      none: 'track-owned via survivor `trackId`; widens retention cascade (D683)',
    },
  },
  'track-purity': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'operator ground-truth purity mark (`setTrackPurity`); `pure` deletes the row',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'device_updated', fields: ['deviceId', 'updatedAt'] },
      { name: 'updated', fields: ['updatedAt'] },
    ],
    retention: {
      none: 'row-count ceiling MAX_TRACK_PURITIES in application code (D681)',
    },
  },
  'track-relations': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'operator ground-truth relation between two tracks',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'device_updated', fields: ['deviceId', 'updatedAt'] },
      { name: 'updated', fields: ['updatedAt'] },
    ],
    retention: {
      none: 'row-count ceiling MAX_TRACK_RELATIONS in application code (D681)',
    },
  },
  'tracking-tapes': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per promoted tracking-tape window (D681)',
    device: 'required',
    at: 'required',
    indexes: [{ name: 'device_created', fields: ['deviceId', 'createdAt'] }],
    retention: {
      none: 'promotion budget MAX_PROMOTED_TAPES — refused, never evicted by age',
    },
  },
  'birth-decision-ledger': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one append-only row per track-birth verdict (D409)',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'at', fields: ['at'] },
      { name: 'device_at', fields: ['deviceId', 'at'] },
      // `listBirthDecisions({ verdict })`, with and without a camera: a filter
      // no declared index serves is refused by the engine.
      { name: 'verdict_at', fields: ['verdict', 'at'] },
      { name: 'device_verdict_at', fields: ['deviceId', 'verdict', 'at'] },
    ],
    retention: {
      none: 'row-count ceiling MAX_BIRTH_DECISION_RECORDS in application code',
    },
  },
  'debug-note-archive': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per debug note retired at review (D405)',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'archived_at', fields: ['archivedAt'] },
      { name: 'device_archived', fields: ['deviceId', 'archivedAt'] },
    ],
    retention: {
      none: 'row-count ceiling MAX_ARCHIVED_DEBUG_NOTES in application code',
    },
  },
  'ops-log': {
    schema: PaEventsLedgerBodySchema,
    class: 'audit',
    database: 'events',
    writeTrigger: 'one best-effort row per events-domain maintenance op',
    device: 'optional',
    at: 'required',
    indexes: [
      { name: 'at', fields: ['at'] },
      { name: 'device_at', fields: ['deviceId', 'at'] },
    ],
    retention: {
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      from: 'at',
    },
  },
  'retrain-frames': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per frame copied into the retrain dataset at selection',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'track', fields: ['trackId'] },
      { name: 'device_complete', fields: ['deviceId', 'complete'] },
    ],
    retention: { none: 'operator curation only; blobs on artifacts tenant (D781)' },
    transactFamily: RETRAIN,
  },
  'retrain-annotations': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per bbox annotation on a retrain copy',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'track', fields: ['trackId'] },
      { name: 'media', fields: ['mediaKey'] },
      { name: 'device_created', fields: ['deviceId', 'createdAt'] },
      // Corpus page: which frames carry a class, without reading annotation
      // bodies (D447 — the group column is on the index).
      { name: 'class_media', fields: ['macroClass', 'mediaKey'] },
      // Same count, scoped to one camera, for a device filter's total.
      { name: 'device_media', fields: ['deviceId', 'mediaKey'] },
    ],
    retention: { none: 'leaves with frame deselect / operator delete' },
    transactFamily: RETRAIN,
  },
  'retrain-collections': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per named retrain collection',
    device: 'none',
    at: 'required',
    indexes: [
      { name: 'name_key', fields: ['nameKey'], unique: true },
      { name: 'created', fields: ['createdAt'] },
    ],
    retention: { none: 'deleted with operator deleteCollection' },
    transactFamily: RETRAIN,
  },
  'retrain-collection-frames': {
    schema: PaEventsLedgerBodySchema,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one membership row per (collection, frame) pair',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'collection_added', fields: ['collectionId', 'addedAt'] },
      { name: 'frame', fields: ['frameId'] },
    ],
    retention: { none: 'membership only; frame pixels live in retrain-frames' },
    transactFamily: RETRAIN,
  },
})
