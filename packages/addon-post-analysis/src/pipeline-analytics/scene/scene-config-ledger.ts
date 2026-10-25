/**
 * The scene CONFIG half of {@link SceneStore}: a RAM mirror over the `scenes`
 * record kind, with the contract `DurableLedger` states for every mirrored
 * fact (D130), kept for this half now that its rows live in `ctx.records`:
 *
 * 1. The MIRROR is the read surface; the engine is never on a decision path.
 * 2. A failed load NEVER clears the mirror — it reports and keeps what it holds.
 * 3. `write-behind`: the mirror advances first, the durable write follows and a
 *    failure is logged, never thrown at the caller (losing an ROI write costs a
 *    redraw; the operator's edit is live in this process either way).
 *
 * The reseed is bounded by {@link SCENE_LEDGER_LOAD_LIMIT}-sized pages: a bound
 * nobody chose is the default wearing the word.
 */
import type { IScopedLogger, RecordKindHandle, RecordRow } from '@camstack/types'
import { SceneMonitorSchema } from '@camstack/types'
import type { SceneBody } from '../record-kinds.js'

/** One persisted scene definition. */
export interface SceneConfigRow {
  readonly key: string
  readonly deviceId: number
  readonly monitor: SceneBody['monitor']
  readonly updatedAt: number
}

/** The engine's page cap for one query; a reseed pages by it, bounded by the ledger limit. */
const PAGE_SIZE = 1000

/**
 * A row whose monitor JSON no longer validates is SKIPPED, not repaired: a
 * half-parsed scene would report a verdict about a region it cannot describe.
 */
function sceneFromRecord(row: RecordRow<SceneBody>): SceneConfigRow | null {
  const { deviceId, updatedAt } = row.data
  if (!Number.isFinite(deviceId) || !Number.isFinite(updatedAt)) return null
  const parsed = SceneMonitorSchema.safeParse(row.data.monitor)
  if (!parsed.success) return null
  return { key: row.id, deviceId, monitor: parsed.data, updatedAt }
}

export class SceneConfigLedger {
  private readonly mirror = new Map<string, SceneConfigRow>()

  constructor(
    private readonly kind: RecordKindHandle<SceneBody>,
    private readonly logger: IScopedLogger,
    private readonly loadLimit: number,
  ) {}

  /**
   * Boot / reconcile reseed: replaces the mirror with what the engine holds and
   * returns the rows. A failure returns what is already mirrored.
   */
  async load(): Promise<readonly SceneConfigRow[]> {
    try {
      const next = new Map<string, SceneConfigRow>()
      let skipped = 0
      let seen = 0
      let cursor: string | undefined
      for (;;) {
        const limit = Math.min(PAGE_SIZE, this.loadLimit - seen)
        if (limit <= 0) break
        const page = await this.kind.query({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        })
        seen += page.records.length
        for (const record of page.records) {
          const row = sceneFromRecord(record)
          if (row === null) skipped += 1
          else next.set(row.key, row)
        }
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      this.mirror.clear()
      for (const [key, row] of next) this.mirror.set(key, row)
      if (skipped > 0) {
        this.logger.warn('scene rows skipped as malformed — they gate NOTHING', {
          meta: { kind: this.kind.name, skipped },
        })
      }
      return [...this.mirror.values()]
    } catch (err) {
      this.logger.warn('scene load failed — keeping the state already in memory', {
        meta: {
          kind: this.kind.name,
          error: String(err),
          held: this.mirror.size,
        },
      })
      return [...this.mirror.values()]
    }
  }

  snapshot(): readonly SceneConfigRow[] {
    return [...this.mirror.values()]
  }

  get(key: string): SceneConfigRow | undefined {
    return this.mirror.get(key)
  }

  /** Write-behind upsert: the mirror advances, then the engine write is best-effort and logged. */
  async put(row: SceneConfigRow): Promise<void> {
    this.mirror.set(row.key, row)
    try {
      await this.kind.put({
        id: row.key,
        data: {
          deviceId: row.deviceId,
          enabled: row.monitor.enabled,
          updatedAt: row.updatedAt,
          monitor: row.monitor,
        },
      })
    } catch (err) {
      this.logger.warn('scene persist failed — this scene may be lost on restart', {
        tags: { deviceId: row.deviceId },
        meta: { kind: this.kind.name, key: row.key, error: String(err) },
      })
    }
  }

  /** Drop one key, mirror and row. A failed delete leaves a row the next load re-mirrors. */
  async forget(key: string): Promise<void> {
    this.mirror.delete(key)
    try {
      await this.kind.delete(key)
    } catch (err) {
      this.logger.debug('scene delete failed', {
        meta: { kind: this.kind.name, key, error: String(err) },
      })
    }
  }
}
