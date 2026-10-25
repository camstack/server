/**
 * Record kinds for NC live-state ledgers (records plan phase 3, steps 25–36).
 *
 * Hosted in the pipeline-analytics addon (`pipeline-analytics` owner stamp).
 * Declared by the hub; every node reads and writes them through `ctx.records`.
 */
import { defineRecordKinds, RECORD_MAX_DATA_BYTES, type RecordRetention } from '@camstack/types'
import { DurableLedgerBodySchema } from '../durable/durable-record-body.js'

const ledger = (
  writeTrigger: string,
  database: 'settings' | 'events' = 'settings',
  retention: RecordRetention = {
    none: 'mirror load-all at boot; rows drop only via owner prune or device-removal hook',
  },
) => ({
  schema: DurableLedgerBodySchema,
  class: 'ledger' as const,
  database,
  writeTrigger,
  device: 'optional' as const,
  at: 'none' as const,
  retention,
})

/**
 * The shape the four QUERIED kinds share with the mirrors. Each spells its own
 * file, trigger, indexes and retention as literals (the records guards read them).
 * `device` and `at` stay what the first (empty) declaration said — the engine
 * refuses to change either — so every read is served by a DATA-field index, and
 * the camera rides the record envelope (`deviceId`) for the D865 removal.
 */
const QUERIED = {
  schema: DurableLedgerBodySchema,
  device: 'optional' as const,
  at: 'none' as const,
}

export const ncDurableRecordKinds = defineRecordKinds({
  liveness: ledger(
    'a liveness state TRANSITION the centre accepted (seed or flip); a no-flip writes nothing',
  ),
  'device-alerts': ledger('a sustained device alert episode the centre confirmed or cleared'),
  'system-state': ledger('a system-state subject flip the state summary accepted'),
  'alert-episodes': ledger(
    'an alert episode the centre notified (critical or error); its resolution deletes the row',
  ),
  occupancy: ledger('a confirmed occupancy level write-through after the watcher decided an edge'),
  'device-prunes': ledger('one row recording what a deleted-device prune removed'),
  'state-summary-stamps': ledger('digest delivery stamps per rule kind'),
  meta: ledger('outbox boot-reconcile watermark and other single-key meta rows', 'settings', {
    none: 'one fixed key (watermark), overwritten in place, never deleted',
  }),
  snoozes: ledger('operator opens or closes a snooze window (write-through)'),
  // The four below are NOT DurableLedger mirrors: their owners query them (QUERIED).
  'snooze-suppressed': {
    ...QUERIED,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'aggregate count per (window, target, rule, camera) for suppressed notifications',
    indexes: [{ name: 'snooze', fields: ['snoozeId'] }],
    retention: {
      owner: 'notification-center',
      reason: 'deleted with its snooze window, 6 h after that window closes',
    },
  },
  'track-groups': {
    ...QUERIED,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per grouped delivery window opened at admission time',
    indexes: [
      { name: 'open', fields: ['sealed'] },
      { name: 'opened', fields: ['openedAt'] },
      { name: 'device_opened', fields: ['deviceId', 'openedAt'] },
      { name: 'rule_opened', fields: ['ruleId', 'openedAt'] },
      { name: 'rule_device_opened', fields: ['ruleId', 'deviceId', 'openedAt'] },
    ],
    retention: {
      owner: 'notification-center',
      reason: 'ring: the newest NC_GROUP_MAX_ROWS_PER_DEVICE rows per camera, trimmed on write',
    },
  },
  outbox: {
    ...QUERIED,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'one row per (rule, dedupRef, target) enqueued for delivery',
    // The history filters (rule / status / camera, any combination) each with the
    // fire time as the range and the order — eight indexes, the engine's maximum.
    indexes: [
      { name: 'created', fields: ['createdAt'] },
      { name: 'rule_created', fields: ['ruleId', 'createdAt'] },
      { name: 'status_created', fields: ['status', 'createdAt'] },
      { name: 'device_created', fields: ['deviceId', 'createdAt'] },
      { name: 'rule_status_created', fields: ['ruleId', 'status', 'createdAt'] },
      { name: 'rule_device_created', fields: ['ruleId', 'deviceId', 'createdAt'] },
      { name: 'status_device_created', fields: ['status', 'deviceId', 'createdAt'] },
      { name: 'rule_status_device_created', fields: ['ruleId', 'status', 'deviceId', 'createdAt'] },
    ],
    retention: {
      owner: 'notification-center',
      reason:
        'terminal (sent/dead) rows older than 7 days pruned at boot; a pending row retries to dead first',
    },
    // A payload carries the confirm verdict, the media ids and the rendered words.
    maxDataBytes: RECORD_MAX_DATA_BYTES,
  },
  artifacts: {
    ...QUERIED,
    class: 'ledger',
    database: 'events',
    writeTrigger: 'retained notification artefact metadata indexed for lookup and expiry',
    indexes: [
      { name: 'captured', fields: ['capturedAt'] },
      { name: 'expires', fields: ['expiresAt'] },
    ],
    retention: {
      owner: 'notification-center',
      reason:
        'falls with its bytes: expired rows on every node, orphans against the shelf on the producer node',
    },
  },
})
