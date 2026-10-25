/**
 * "Who are my children?" asked by a thousand devices, answered in a handful of
 * calls.
 *
 * ## The number
 *
 * Every `BaseDevice` inherits a `getAccessoryChildren()` that returns `[]`, so
 * the accessory reconcile in `device-cap-proxy.ts` runs its orphan-prune step
 * for EVERY registered device — including the leaf accessories that can never
 * own one. Each pass asked `device-manager.getChildren` for its own id.
 * Measured on the live hub 2026-08-27, 120-second boot window, 1 017 devices:
 * **1 024 calls returning 919 rows in total**. A thousand round-trips, and a
 * thousand indexed scans behind them, to move less than one row each.
 *
 * ## Why a loader and not a caller that loops
 *
 * There is no loop to unroll. Reconcile is per-device by construction: it runs
 * inside `register()`, and again whenever a late feature-probe writes the
 * slice. The repetition is a THOUSAND INDEPENDENT CALLERS, not one caller
 * asking a thousand times — so the collapse has to happen between them.
 *
 * ## Why the batch is self-clocking, with no window to tune
 *
 * At most ONE batch call is in flight. Anything that arrives while it is in
 * flight lands in the next batch, dispatched the moment the current one
 * settles. That makes the batch size adapt to the arrival rate on its own:
 *
 *  - Idle: the first caller flushes on the next macrotask. No added wait, and
 *    no timer to pick a value for and be wrong about.
 *  - Boot: `BaseDeviceProvider.onRestoreDevices` issues every top-level
 *    `create()` at once and `runBounded(specs, 12)` spawns accessory children
 *    twelve wide, so reconciles arrive in bursts — measured as 2 372 device
 *    log lines in one 5-second bucket at boot+16s, against 62 at boot+142s.
 *    Every arrival inside one round-trip collapses into the next call.
 *  - Worst case: arrivals slower than a round-trip give batches of one, which
 *    is exactly today's cost. The loader can never be worse than what it
 *    replaces.
 *
 * A fixed debounce window would have to be guessed against that distribution,
 * and would tax the idle case to pay for the busy one.
 *
 * ## Degrading, rather than breaking, against an older hub
 *
 * `getChildrenBatch` is a NEW method: a hub that predates it rejects the call
 * (it does not silently strip the input and answer a different question, which
 * is what adding a `parentDeviceIds` FIELD to `getChildren` would have done).
 * Every waiter in a failed batch is then answered by the per-parent
 * `getChildren` it would have used anyway, so the reconcile is never denied
 * its answer. A rejection that names the method as unknown latches the
 * fallback permanently — re-probing a method the hub will never have, once per
 * batch for a whole boot, is the storm this exists to remove.
 */

// This module is in the addon-runner's closure: the batch bound comes from the
// lightweight entry, and the logger interface is type-only (erased). Pulling a
// runtime VALUE off the root barrel here costs ~146MB RSS per forked runner (D28).
import type { IScopedLogger } from '@camstack/types'
import { DEVICE_CHILDREN_BATCH_MAX } from '@camstack/types/addon'

/**
 * The child fields the accessory reconcile reads. Deliberately narrower than
 * `DeviceInfo`: the loader is a transport, and a transport that pins the whole
 * projection would have to change every time an unrelated field does.
 */
export interface ReconcileChildRow {
  readonly id: number
  readonly stableId: string
  readonly name: string
  readonly linkDeviceId?: number | null
}

/**
 * Narrow an untyped cap answer to the fields the reconcile reads.
 *
 * `callDeviceManager` is an untyped boundary, and the answer may come from a
 * hub of a different vintage. A row that does not carry an id, a stableId and
 * a name is not a child this code can prune ON, so it is dropped rather than
 * cast into shape — the prune step DELETES, and a half-parsed row is the input
 * that would make it delete the wrong thing.
 */
export function parseChildRows(value: unknown): readonly ReconcileChildRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: ReconcileChildRow[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const id = Reflect.get(entry, 'id')
    const stableId = Reflect.get(entry, 'stableId')
    const name = Reflect.get(entry, 'name')
    const linkDeviceId = Reflect.get(entry, 'linkDeviceId')
    if (typeof id !== 'number' || typeof stableId !== 'string' || typeof name !== 'string') {
      return null
    }
    rows.push({
      id,
      stableId,
      name,
      ...(typeof linkDeviceId === 'number' || linkDeviceId === null ? { linkDeviceId } : {}),
    })
  }
  return rows
}

/**
 * Narrow a `getChildrenBatch` answer: a record keyed by parent id as a string.
 *
 * An EMPTY record is a valid answer — "none of these parents has children" —
 * and so is what a hub that answers the call but knows none of the parents
 * would send. Both mean "nothing to prune", which is the safe direction. Only
 * a shape that is not a record at all is `null`, and the loader treats that as
 * a failed batch and re-asks per parent.
 */
export function parseChildrenByParent(
  value: unknown,
): ReadonlyMap<number, readonly ReconcileChildRow[]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out = new Map<number, readonly ReconcileChildRow[]>()
  for (const [key, entry] of Object.entries(value)) {
    const parentDeviceId = Number(key)
    if (!Number.isInteger(parentDeviceId)) return null
    const rows = parseChildRows(entry)
    if (rows === null) return null
    out.set(parentDeviceId, rows)
  }
  return out
}

export interface ChildrenBatchLoaderOptions {
  /** One `device-manager.getChildrenBatch` call. Rejects like any RPC. */
  readonly fetchBatch: (
    parentDeviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, readonly ReconcileChildRow[]>>
  /** One `device-manager.getChildren` call — the fallback, and the old path. */
  readonly fetchOne: (parentDeviceId: number) => Promise<readonly ReconcileChildRow[]>
  readonly logger: IScopedLogger
  /** Test seam. Production takes {@link DEVICE_CHILDREN_BATCH_MAX}. */
  readonly maxBatch?: number
}

export interface ChildrenBatchLoader {
  /** The direct children of one parent, coalesced with every other in-flight ask. */
  load(parentDeviceId: number): Promise<readonly ReconcileChildRow[]>
}

interface Waiter {
  readonly parentDeviceId: number
  readonly resolve: (rows: readonly ReconcileChildRow[]) => void
  readonly reject: (err: unknown) => void
}

/**
 * True when an error says the hub has no such procedure — the version-skew
 * case, and the only one worth latching on. Anything else (a timeout, a busy
 * broker) is transient and must not disable batching for the process lifetime.
 */
function looksLikeUnknownMethod(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const lowered = message.toLowerCase()
  return (
    lowered.includes('not_found') ||
    lowered.includes('no procedure') ||
    lowered.includes('unknown method') ||
    lowered.includes('no such method') ||
    lowered.includes('not available')
  )
}

export function createChildrenBatchLoader(opts: ChildrenBatchLoaderOptions): ChildrenBatchLoader {
  const maxBatch = Math.max(1, opts.maxBatch ?? DEVICE_CHILDREN_BATCH_MAX)
  let pending: Waiter[] = []
  let flushScheduled = false
  let flushing = false
  let batchUnsupported = false

  const answerOneByOne = async (waiters: readonly Waiter[]): Promise<void> => {
    await Promise.all(
      waiters.map(async (waiter) => {
        try {
          waiter.resolve(await opts.fetchOne(waiter.parentDeviceId))
        } catch (err) {
          waiter.reject(err)
        }
      }),
    )
  }

  const runBatch = async (waiters: readonly Waiter[]): Promise<void> => {
    // Distinct parents only — two devices never ask about the same parent in
    // the same pass, but a re-probe landing mid-flight can.
    const parentDeviceIds = [...new Set(waiters.map((w) => w.parentDeviceId))]
    try {
      const byParent = await opts.fetchBatch(parentDeviceIds)
      // A parent with no children is ABSENT from the map, never an empty row —
      // which reads here as exactly what it means: nothing to prune.
      for (const waiter of waiters) waiter.resolve(byParent.get(waiter.parentDeviceId) ?? [])
    } catch (err) {
      const unknown = looksLikeUnknownMethod(err)
      if (unknown) batchUnsupported = true
      opts.logger.warn(
        unknown
          ? 'device-manager.getChildrenBatch is not available on this hub — falling back to per-parent getChildren for the process lifetime'
          : 'device-manager.getChildrenBatch failed — answering this batch per parent',
        {
          meta: {
            parents: parentDeviceIds.length,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
      await answerOneByOne(waiters)
    }
  }

  const flush = async (): Promise<void> => {
    flushing = true
    try {
      while (pending.length > 0) {
        const batch = pending.slice(0, maxBatch)
        pending = pending.slice(maxBatch)
        if (batchUnsupported) await answerOneByOne(batch)
        else await runBatch(batch)
      }
    } finally {
      flushing = false
    }
  }

  const scheduleFlush = (): void => {
    if (flushScheduled || flushing) return
    flushScheduled = true
    // Deliberately NOT `unref`ed. It is a zero-delay timer, so it holds the
    // loop for at most one turn — while an unref'd one could let the process
    // exit with a waiter still pending, and a pending waiter is a `register()`
    // that never returns.
    setTimeout(() => {
      flushScheduled = false
      void flush().catch((err: unknown) => {
        // `flush` resolves or rejects every waiter itself; a throw here would
        // be a bug in the loader, and a silent one is how a reconcile hangs.
        opts.logger.warn('children batch flush threw', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, 0)
  }

  return {
    load(parentDeviceId: number): Promise<readonly ReconcileChildRow[]> {
      return new Promise<readonly ReconcileChildRow[]>((resolve, reject) => {
        pending.push({ parentDeviceId, resolve, reject })
        scheduleFlush()
      })
    },
  }
}
