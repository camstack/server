/**
 * What a device removal leaves behind is cleaned AT REMOVAL, by steps that
 * cannot block one another (D864).
 *
 * `removeDevice` used to run its clean-up as one straight line: the first step
 * that threw skipped every later one, and the keychain was not in the line at
 * all — a device-scoped secret (`secret://provider-dreame/device/4483/…`)
 * outlived its device for good. Each store is a {@link RemovalStep} now: run
 * independently, counted, logged ONCE per device with `tags: { deviceId }`,
 * and a step that failed is retried by a BOUNDED in-memory reconcile
 * (a few attempts, growing delays, then it gives up loudly).
 *
 * There is deliberately no boot-time sweep (the operator forbids purges on
 * boot): a retry that dies with the process is picked up by the keychain
 * admin's orphan listing (System -> Secrets), which names a device-scoped
 * secret whose device no longer points at it.
 */
import { errMsg, type IScopedLogger } from '@camstack/types'

/** One store that holds data of a removed device. `run` returns what it deleted. */
export interface RemovalStep {
  /** The store, named for the log (`keychain-secrets`, `device-config`, …). */
  readonly store: string
  /** Delete this device's data from the store; resolves to the number of rows/refs removed. */
  readonly run: () => Promise<number>
}

/** The outcome of one {@link RemovalCleanup.run}. */
export interface RemovalCleanupReport {
  readonly deviceId: number
  /** Rows/refs removed per store, for the steps that succeeded. */
  readonly counts: Readonly<Record<string, number>>
  /** The stores whose step threw — scheduled for a bounded retry. */
  readonly failed: readonly string[]
}

/** Retry delays after a failed step; the list length bounds the attempts. */
export const REMOVAL_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000]

export interface RemovalCleanupOptions {
  readonly logger: IScopedLogger
  /** The log message stem; the hook fan-out (D865) runs its own instance under another one. */
  readonly label?: string
  readonly retryDelaysMs?: readonly number[]
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface RemovalCleanup {
  /** Run every step independently; log once; schedule a bounded retry for the failures. */
  run(deviceId: number, steps: readonly RemovalStep[]): Promise<RemovalCleanupReport>
  /** Cancel every pending retry (addon shutdown). */
  dispose(): void
}

interface Attempt {
  readonly counts: Record<string, number>
  readonly failed: RemovalStep[]
  readonly errors: Record<string, string>
}

async function attempt(steps: readonly RemovalStep[]): Promise<Attempt> {
  const counts: Record<string, number> = {}
  const failed: RemovalStep[] = []
  const errors: Record<string, string> = {}
  for (const step of steps) {
    try {
      counts[step.store] = await step.run()
    } catch (err: unknown) {
      failed.push(step)
      errors[step.store] = errMsg(err)
    }
  }
  return { counts, failed, errors }
}

export function createRemovalCleanup(opts: RemovalCleanupOptions): RemovalCleanup {
  const label = opts.label ?? 'device removal cleanup'
  const delays = opts.retryDelaysMs ?? REMOVAL_RETRY_DELAYS_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle))
  const pending = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false

  const schedule = (
    deviceId: number,
    steps: readonly RemovalStep[],
    retryIndex: number,
    first: boolean,
  ): void => {
    if (disposed) return
    const delay = delays[retryIndex]
    if (delay === undefined) {
      opts.logger.error(`${label} gave up — the data stays until cleaned by hand`, {
        tags: { deviceId },
        meta: { stores: steps.map((s) => s.store), attempts: retryIndex + (first ? 1 : 0) },
      })
      return
    }
    const handle = setTimer(() => {
      pending.delete(handle)
      void retry(deviceId, steps, retryIndex)
    }, delay)
    handle.unref?.()
    pending.add(handle)
  }

  const retry = async (
    deviceId: number,
    steps: readonly RemovalStep[],
    retryIndex: number,
  ): Promise<void> => {
    const result = await attempt(steps)
    opts.logger.info(`${label} retried`, {
      tags: { deviceId },
      meta: { counts: result.counts, failed: result.failed.map((s) => s.store), retryIndex },
    })
    if (result.failed.length > 0) schedule(deviceId, result.failed, retryIndex + 1, false)
  }

  return {
    async run(deviceId, steps) {
      const result = await attempt(steps)
      const failedStores = result.failed.map((s) => s.store)
      const meta = { counts: result.counts, failed: failedStores, errors: result.errors }
      if (failedStores.length === 0) {
        opts.logger.info(label, { tags: { deviceId }, meta })
      } else {
        opts.logger.warn(`${label} incomplete — failed steps are retried`, {
          tags: { deviceId },
          meta,
        })
        schedule(deviceId, result.failed, 0, true)
      }
      return { deviceId, counts: result.counts, failed: failedStores }
    },
    dispose() {
      disposed = true
      for (const handle of pending) clearTimer(handle)
      pending.clear()
    },
  }
}
