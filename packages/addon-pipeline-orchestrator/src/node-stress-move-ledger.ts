/**
 * `NodeStressMoveLedger` — the DURABLE record of every failover move the
 * orchestrator actually applied.
 *
 * ## The hole this closes
 *
 * `failover` mode is allowed to move a camera between nodes, and the entire
 * safety argument for letting it is three guards that are all read off ONE
 * list: the move history.
 *
 *  - **the 4-moves-per-hour budget** (`maxMovesPerWindow` / `rateWindowMs`),
 *  - **the 10-minute per-device cooldown** (`deviceCooldownMs`),
 *  - **the 30-minute return ban** (`returnBanMs`) that stops a camera being
 *    pushed straight back to the node it just left.
 *
 * That list lived in a `private history: StressFailoverHistoryEntry[]` and
 * nothing else in the system held it. So **every orchestrator restart granted a
 * fresh budget**: four more moves immediately available, every cooldown
 * cleared, every return ban lifted. The 2026-08-13 census (§1.1 #17) recorded
 * it as the third instance of the same cold-start shape as the liveness flood
 * and the occupancy cold baseline — "the anti-flap guards that are the entire
 * safety argument for `failover` mode do not survive a restart".
 *
 * A crash-loop is exactly the state in which the guards matter most, and it is
 * exactly the state in which they were being reset.
 *
 * ## What is written, and what is deliberately not
 *
 * One row per APPLIED move, and only on success — a failed relocation must not
 * burn the device's cooldown (one flaky attach would otherwise disable failover
 * for that camera for ten minutes, which the controller's own spec pins).
 *
 * The write is **behind** the decision: the move has already happened by the
 * time the row is written, so there is nothing left to abort. A persist that
 * fails is logged at `warn` with the device tag — that line IS the record that
 * the budget may be short by one after the next restart. It is never silent.
 *
 * The row set is bounded by {@link NodeStressMoveLedger.pruneOlderThan}, which
 * the controller calls with the longest guard window: a move older than that
 * is read by no guard, so keeping it would be growth with no reader. The
 * record kind also carries a TTL of 2 h so the engine sweeps stale rows even
 * if the controller never calls pruneOlderThan.
 *
 * ## Records migration (phase 2, step 12)
 *
 * The ledger now reads and writes via `ctx.records` (RecordKindHandle) instead
 * of the SettingsStore DurableLedger. The kind is declared at boot via
 * `ctx.records.declare(orchestratorRecordKinds)` before this class is
 * constructed. No static `declare` method — that is the caller's
 * responsibility.
 */

import type { IScopedLogger, RecordKindHandle } from '@camstack/types'
import type { NodeStressMoveBody } from './record-kinds.js'
import type { StressFailoverHistoryEntry } from './node-stress.js'
// Re-export: the legacy collection name, for the docs.
export { NODE_STRESS_MOVES_COLLECTION } from './record-kinds.js'

const LOAD_LIMIT = 10_000

function moveId(entry: StressFailoverHistoryEntry): string {
  return `${entry.deviceId}:${entry.at}`
}

export interface NodeStressMoveLedgerDeps {
  readonly kind: RecordKindHandle<NodeStressMoveBody>
  readonly logger: IScopedLogger
}

export class NodeStressMoveLedger {
  private readonly kind: RecordKindHandle<NodeStressMoveBody>
  private readonly logger: IScopedLogger
  /** RAM mirror: id → row */
  private readonly mirror = new Map<string, StressFailoverHistoryEntry & { id: string }>()

  constructor(deps: NodeStressMoveLedgerDeps) {
    this.kind = deps.kind
    this.logger = deps.logger
  }

  /**
   * Boot reseed: replaces the mirror with what the records engine holds.
   * Returns the row count so the caller can say out loud how much budget it
   * recovered — "moves recovered: 0" after a restart is the line that explains
   * a burst of relocations. A failure is logged and returns 0 (the
   * pre-existing behaviour) rather than aborting boot.
   */
  async load(): Promise<number> {
    try {
      let seen = 0
      let cursor: string | undefined
      const next = new Map<string, StressFailoverHistoryEntry & { id: string }>()
      for (;;) {
        const limit = Math.min(1_000, LOAD_LIMIT - seen)
        if (limit <= 0) break
        const page = await this.kind.query({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        })
        seen += page.records.length
        for (const record of page.records) {
          const { data } = record
          const deviceId = Number(data['deviceId'])
          const at = Number(data['at'])
          const fromNodeId = data['fromNodeId']
          if (!Number.isFinite(deviceId) || !Number.isFinite(at)) continue
          if (typeof fromNodeId !== 'string' || fromNodeId.length === 0) continue
          next.set(record.id, { id: record.id, deviceId, fromNodeId, at })
        }
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      this.mirror.clear()
      for (const [id, row] of next) this.mirror.set(id, row)
      return this.mirror.size
    } catch (err: unknown) {
      this.logger.warn('node-stress move history unavailable — this boot starts cold', {
        meta: { kind: this.kind.name, error: String(err) },
      })
      return 0
    }
  }

  /** The history the guards read. Pure RAM — a guard must never wait on I/O. */
  entries(): readonly StressFailoverHistoryEntry[] {
    return [...this.mirror.values()].map(({ deviceId, fromNodeId, at }) => ({
      deviceId,
      fromNodeId,
      at,
    }))
  }

  /**
   * Record one APPLIED move. Mirror first; the durable write follows and its
   * failure is logged (with the device tag), never thrown at a relocation that
   * already happened.
   */
  record(entry: StressFailoverHistoryEntry): void {
    const id = moveId(entry)
    this.mirror.set(id, { ...entry, id })
    void this.kind
      .put({
        id,
        at: entry.at,
        data: { deviceId: entry.deviceId, fromNodeId: entry.fromNodeId, at: entry.at },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          'stress move persist failed — this move may be lost on restart; budget may be short by 1',
          {
            tags: { deviceId: entry.deviceId },
            meta: { kind: this.kind.name, id, error: String(err) },
          },
        )
      })
  }

  /**
   * Drop moves older than `cutoff` — no guard can read them. Returns the
   * count. The record kind already carries a 2-h TTL for the same reason;
   * this is the synchronous application-side complement.
   */
  async pruneOlderThan(cutoff: number): Promise<number> {
    const toDelete: string[] = []
    for (const [id, row] of this.mirror) {
      if (row.at < cutoff) toDelete.push(id)
    }
    for (const id of toDelete) {
      this.mirror.delete(id)
      try {
        await this.kind.delete(id)
      } catch (err: unknown) {
        this.logger.warn('stress move prune failed — row may reappear on next boot', {
          meta: { kind: this.kind.name, id, error: String(err) },
        })
      }
    }
    return toDelete.length
  }
}
