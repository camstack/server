/**
 * The tombstones of deleted devices (D865) — `tombstones` record kind (phase 4).
 */
import {
  DEVICE_TOMBSTONE_RETENTION_MS,
  errMsg,
  type DeviceTombstone,
  type IScopedLogger,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { deviceManagerRecordKinds, DeviceTombstoneBodySchema } from './record-kinds.js'
import type { z } from 'zod'

export const DEVICE_TOMBSTONES_COLLECTION = 'device-manager:tombstones'

type TombstoneBody = z.infer<typeof DeviceTombstoneBodySchema>

/** More than the engine's default row cap, so a read is never silently truncated. */
const TOMBSTONE_READ_LIMIT = 20_000

function rowToTombstone(id: string, body: TombstoneBody): DeviceTombstone | null {
  const deviceId = Number(id)
  if (!Number.isInteger(deviceId) || deviceId <= 0) return null
  return {
    deviceId,
    deletedAt: body.deletedAt,
    providerAddonId: body.providerAddonId,
  }
}

export interface DeviceTombstoneStoreOptions {
  readonly kind: RecordKindHandle<TombstoneBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly retentionMs?: number
}

export class DeviceTombstoneStore {
  private readonly kind: RecordKindHandle<TombstoneBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly retentionMs: number

  constructor(opts: DeviceTombstoneStoreOptions) {
    this.kind = opts.kind
    this.logger = opts.logger
    this.now = opts.now ?? ((): number => Date.now())
    this.retentionMs = opts.retentionMs ?? DEVICE_TOMBSTONE_RETENTION_MS
  }

  static of(records: Pick<RecordsAccess, 'kind'>, logger: IScopedLogger): DeviceTombstoneStore {
    return new DeviceTombstoneStore({
      kind: records.kind(deviceManagerRecordKinds.tombstones),
      logger,
    })
  }

  /** Record a deletion. Re-recording the same id keeps the EARLIER `deletedAt`. */
  async record(tombstone: DeviceTombstone): Promise<void> {
    const key = String(tombstone.deviceId)
    const existing = await this.kind.get(key)
    const existingAt =
      existing !== null ? rowToTombstone(existing.id, existing.data)?.deletedAt : undefined
    if (existingAt === undefined) {
      await this.kind.put({
        id: key,
        at: tombstone.deletedAt,
        data: {
          deletedAt: tombstone.deletedAt,
          providerAddonId: tombstone.providerAddonId,
        },
      })
    }
    await this.pruneExpired()
  }

  /** Tombstones with `deletedAt >= sinceMs`, oldest first. Expired ones are pruned first. */
  async listSince(sinceMs: number): Promise<readonly DeviceTombstone[]> {
    await this.pruneExpired()
    const floor = Math.max(sinceMs, this.now() - this.retentionMs)
    const rows = await readAllRows(this.kind, { atFrom: floor, order: 'at' })
    const out: DeviceTombstone[] = []
    for (const row of rows) {
      if (out.length >= TOMBSTONE_READ_LIMIT) break
      const decoded = rowToTombstone(row.id, row.data)
      if (decoded !== null && decoded.deletedAt >= floor) out.push(decoded)
    }
    return out
  }

  /** Delete tombstones older than the retention window. Best-effort: a failure is logged. */
  async pruneExpired(): Promise<number> {
    try {
      const cutoff = this.now() - this.retentionMs
      const rows = await readAllRows(this.kind, { atTo: cutoff - 1 })
      for (const row of rows) {
        await this.kind.delete(row.id)
      }
      return rows.length
    } catch (err: unknown) {
      this.logger.warn('device tombstone prune failed — retried on the next write', {
        meta: { error: errMsg(err) },
      })
      return 0
    }
  }
}
