/**
 * Record kinds owned by the recorder addon (records plan phase 2,
 * steps 25–26).
 *
 * Each kind replaced the legacy `recorder:*` RowMapStore collection of the
 * same name; the records migration that copied them is closed (D900).
 *
 * The recorder runs on `any-node` but only the designated recording node (hub
 * by default) writes these collections. `ctx.records.declare` is guarded by
 * `ctx.records !== undefined` in `onInitialize` — an agent that is not the
 * recording node exits before that point; a recording node that is not the hub
 * (non-standard) throws at the guard with a clear message.
 *
 * The addon declares no `execution.group`, so the hub owner stamp is the addon
 * id (`recorder`).
 */
import { defineRecordKinds, ExportRecordSchema, OpsLogEntrySchema } from '@camstack/types'

/** Legacy RowMapStore collection name — kept for the adoption mapper and docs. */
export const RECORDING_EXPORTS_LEGACY_COLLECTION = 'recorder:exports'
/** Legacy RowMapStore collection name — kept for the adoption mapper and docs. */
export const RECORDING_OPS_LOG_LEGACY_COLLECTION = 'recorder:ops-log'

export const recorderRecordKinds = defineRecordKinds({
  /**
   * One row per export job, inserted by `createExport` and updated as the
   * render progresses. The system NEVER deletes a row — it is the export AUDIT.
   * `deleteExport` and the janitor flip `state` and clear the file, keeping
   * the row. The record's `at` field maps to `createdAt`.
   *
   * Indexed by `deviceId` to serve the per-device listing efficiently.
   */
  exports: {
    schema: ExportRecordSchema,
    class: 'ledger',
    writeTrigger:
      'one row per export job, inserted by createExport; rewritten by the render engine (progress / state patches) and the download hook',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'device', fields: ['deviceId'] }],
    retention: {
      none: 'operator intent — a row is the export AUDIT and survives forever; deleteExport and the janitor flip state and remove the file without removing the row; removeExport is a deliberate operator purge',
    },
  },

  /**
   * A bounded ring of per-operation audit rows. One row per recordings
   * operation (prune, evict, relocate, export, …), appended best-effort by
   * `createRecordingOpsLogSink().append`. The ring is trimmed to the newest
   * `OPS_LOG_RING_DEFAULT_MAX` (500) rows after every append.
   *
   * Indexed by `deviceId` so a per-device listing is an indexed query, not a
   * full scan of the ring.
   *
   * The record's `at` field maps to `OpsLogEntry.at`.
   */
  'ops-log': {
    schema: OpsLogEntrySchema,
    class: 'ledger',
    writeTrigger:
      'one row per recordings operation (prune, evict, relocate, export, …), appended best-effort by createRecordingOpsLogSink().append; the ring is trimmed to the newest 500 rows in application code after every write',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'device', fields: ['deviceId'] }],
    retention: {
      none: 'a bounded ring of the newest 500 rows; older rows are removed in application code (trimOpsLog) after each append — owner-pruned',
    },
  },
})
