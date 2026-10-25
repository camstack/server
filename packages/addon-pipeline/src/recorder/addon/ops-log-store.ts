/**
 * Recordings ops-log persistence for the recorder addon.
 *
 * ONE ROW PER OPERATION in the `recorder` / `ops-log` record kind, through a
 * {@link RecordKindHandle}. The ring is bounded — `maxEntries` newest rows
 * survive — trimmed with one `deleteWhere({ atBefore })` per append.
 *
 * ## Records migration (phase 2, step 26)
 *
 * The store was previously backed by a {@link RowMapStore} over a SettingsStore
 * collection named `recorder:ops-log`. It is now backed by a
 * `RecordKindHandle<OpsLogEntry>` obtained from `ctx.records`. The record's
 * `at` field maps to `OpsLogEntry.at`.
 *
 * ## What the RowMapStore replaced
 *
 * The ring lived in ONE key of the recorder's `addon-settings` / `root` blob,
 * as a flat JSON array. On the reference hub it was 147 437 bytes of that row's
 * 201 833 — so appending one audit line read, parsed, re-serialised and rewrote
 * ~200 KB, and so did every unrelated reader of that row. The ops log is the
 * CHEAPEST thing in the recorder and it was paying for the most expensive.
 *
 * Writes stay BEST-EFFORT: `createRecordingOpsLogSink().append` never throws —
 * a failed audit write must not fail the operation it records.
 */
import { OpsLogEntrySchema, OPS_LOG_DEFAULT_LIMIT, OPS_LOG_RING_DEFAULT_MAX } from '@camstack/types'
import type {
  IScopedLogger,
  OpsLogEntry,
  OpsLogQueryInput,
  OpsLogOp,
  OpsLogReason,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { recorderRecordKinds } from './record-kinds.js'

// Re-export for callers that need the legacy name for docs / adoption scripts.
export { RECORDING_OPS_LOG_LEGACY_COLLECTION as RECORDING_OPS_LOG_COLLECTION } from './record-kinds.js'

/** Row-per-operation handle over the `recorder` / `ops-log` record kind. */
export type RecordingOpsLogState = RecordKindHandle<OpsLogEntry>

/**
 * Obtain the `recorder` / `ops-log` record kind handle.
 * `ctx.records.declare(recorderRecordKinds)` MUST have run before any read or
 * write (called at boot in `onInitialize`).
 */
export function recordingOpsLogState(records: RecordsAccess): RecordingOpsLogState {
  return records.kind(recorderRecordKinds['ops-log'])
}

/**
 * Trim the ring to the newest `maxEntries` rows. Returns how many went.
 *
 * The cursor is the OLDEST row that must SURVIVE — offset `maxEntries - 1`
 * newest-first — and the delete removes everything strictly BEFORE its `at`
 * (`atBefore: cursor.at` deletes rows where `at < cursor.at`).
 *
 * Strictly, to avoid dropping the cursor row itself and any rows tied on its
 * millisecond. The ring may hold a few MORE than the cap on a millisecond tie
 * and never FEWER.
 */
export async function trimOpsLog(
  state: RecordingOpsLogState,
  maxEntries: number = OPS_LOG_RING_DEFAULT_MAX,
): Promise<number> {
  const total = await state.count({})
  if (total <= maxEntries) return 0
  // Get the newest maxEntries rows to find the oldest one that must survive.
  // The last row in this newest-first page is the oldest surviving row.
  const page = await state.query({ desc: true, limit: maxEntries })
  const oldest = page.records[page.records.length - 1]
  if (oldest === undefined) return 0
  // Delete everything strictly older than the oldest surviving row.
  // `atBefore` means `at < atBefore`, so rows tied on the cutoff millisecond
  // survive — the ring may hold a few MORE than the cap on a tie, never fewer.
  return state.deleteWhere({ atBefore: oldest.at ?? 0 })
}

/**
 * Append one row and persist, then trim the ring. Validates at the boundary.
 * Returns the stored row.
 */
export async function appendOpsLog(
  state: RecordingOpsLogState,
  entry: OpsLogEntry,
  maxEntries: number = OPS_LOG_RING_DEFAULT_MAX,
): Promise<OpsLogEntry> {
  const validated = OpsLogEntrySchema.parse(entry)
  await state.put({ id: validated.id, at: validated.at, data: validated })
  await trimOpsLog(state, maxEntries)
  return validated
}

/**
 * List ops-log rows newest-first, optionally scoped to one device, capped at
 * `limit` (default {@link OPS_LOG_DEFAULT_LIMIT}).
 *
 * Scoped to a device this is an INDEXED query on the `device` index — not a
 * read of the whole ring followed by a filter and a sort in JS.
 */
export async function listOpsLog(
  state: RecordingOpsLogState,
  query: OpsLogQueryInput,
): Promise<readonly OpsLogEntry[]> {
  const result = await state.query({
    ...(query.deviceId === undefined ? {} : { where: { deviceId: query.deviceId } }),
    desc: true,
    limit: query.limit ?? OPS_LOG_DEFAULT_LIMIT,
  })
  return result.records.map((r) => r.data)
}

/** The fields a caller supplies to record one recordings op — the sink fills
 *  `id`, `at`, `domain` ('recording') and `nodeId`. */
export interface RecordingOpsLogAppendInput {
  readonly op: OpsLogOp
  readonly reason: OpsLogReason
  readonly deviceId: number | null
  readonly itemsAffected: number
  readonly bytesReclaimed: number
  readonly detail?: string | null
  readonly actor?: string
}

/** Best-effort recorder-domain ops-log sink bound over a record kind handle. */
export interface RecordingOpsLogSink {
  append(input: RecordingOpsLogAppendInput): Promise<void>
  list(query: OpsLogQueryInput): Promise<readonly OpsLogEntry[]>
}

export interface RecordingOpsLogSinkDeps {
  readonly state: RecordingOpsLogState
  readonly nodeId: string
  readonly now: () => number
  readonly newId: () => string
  readonly logger: IScopedLogger
  readonly maxEntries?: number
}

/**
 * Build the recorder's ops-log sink. `append` stamps `domain:'recording'`,
 * `nodeId`, `id` and `at`, then persists best-effort — a failed write is logged,
 * never thrown, so it cannot fail the operation being audited.
 */
export function createRecordingOpsLogSink(deps: RecordingOpsLogSinkDeps): RecordingOpsLogSink {
  return {
    append: async (input): Promise<void> => {
      const entry: OpsLogEntry = {
        id: deps.newId(),
        at: deps.now(),
        domain: 'recording',
        op: input.op,
        reason: input.reason,
        deviceId: input.deviceId,
        nodeId: deps.nodeId,
        itemsAffected: input.itemsAffected,
        bytesReclaimed: input.bytesReclaimed,
        detail: input.detail ?? null,
        actor: input.actor ?? 'operator',
      }
      try {
        await appendOpsLog(deps.state, entry, deps.maxEntries)
      } catch (err: unknown) {
        deps.logger.warn('recorder: ops-log append failed (best-effort)', {
          tags: { deviceId: input.deviceId ?? undefined },
          meta: { op: input.op, error: err instanceof Error ? err.message : String(err) },
        })
      }
    },
    list: (query): Promise<readonly OpsLogEntry[]> => listOpsLog(deps.state, query),
  }
}
