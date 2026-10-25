/**
 * Worker-side device restore helper.
 *
 * Shared by `process-runner` (single-addon subprocess) and
 * `group-runner` (group subprocess). Calls the worker addon's
 * `restoreDevices(SavedDevice[])` with devices read from the hub's
 * `device-manager` capability. Blocks on the `system.ready-state`
 * readiness of the hub's `device-manager` via
 * `ReadinessRegistry.awaitReady`, then issues the calls ONCE.
 *
 * Lives in its own module so it can be imported without triggering
 * the runner entry-point side effects (each runner is also an
 * executable that calls `main()` at import time).
 */
import { errMsg, ReadinessRegistry, ReadinessTimeoutError } from '@camstack/types/addon'
import type { ICamstackAddon, IEventBus, IScopedLogger } from '@camstack/types'

export async function runWorkerDeviceRestoreWithRetry(
  addon: ICamstackAddon,
  context: {
    api?: unknown
    eventBus?: IEventBus
    logger?:
      | IScopedLogger
      | {
          info?: (m: string) => void
          warn?: (m: string) => void
          debug?: (m: string) => void
        }
  },
  addonId: string,
  sourceNodeId: string,
): Promise<void> {
  // `context.logger` is the runner's hub-forwarding logger (process-runner
  // / group-runner pass a `createRemoteLogger`), so these diagnostics reach
  // the hub `LogManager` like any other addon log. The logger is typed
  // optional, so every call is optional-chained; trace lines use `debug`,
  // skips/failures use `warn`.
  const log = context.logger
  log?.debug?.(`[worker-restore] entry: addon="${addonId}" sourceNodeId="${sourceNodeId}"`)
  const restoreFn = (
    addon as {
      restoreDevices?: (saved: readonly unknown[]) => Promise<void>
    }
  ).restoreDevices
  if (typeof restoreFn !== 'function') {
    log?.warn?.(`[worker-restore] "${addonId}": no restoreDevices function — skipping`)
    return
  }

  const api = context.api
  if (!api) {
    log?.warn?.(`[worker-restore] "${addonId}": context.api missing — skipping`)
    return
  }
  const bus = context.eventBus
  if (!bus) {
    log?.warn?.(`[worker-restore] "${addonId}": context.eventBus missing — skipping`)
    return
  }

  const shared =
    (
      context as {
        kernel?: {
          readinessRegistry?: import('@camstack/types').IReadinessRegistry
        }
      }
    ).kernel?.readinessRegistry ?? null
  const registry =
    shared ??
    new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId,
      logger: context.logger as IScopedLogger | undefined,
    })
  log?.debug?.(`[worker-restore] "${addonId}": awaiting device-manager readiness on hub...`)
  try {
    await registry.awaitReady(
      'device-manager',
      { type: 'node', nodeId: 'hub' },
      { timeoutMs: 60_000 },
    )
    log?.debug?.(`[worker-restore] "${addonId}": device-manager READY`)
  } catch (err) {
    if (err instanceof ReadinessTimeoutError) {
      context.logger?.warn?.(
        `[worker-restore] device-manager not ready within ${err.waitedMs}ms — skipping for "${addonId}"`,
      )
      return
    }
    throw err
  } finally {
    if (!shared && registry instanceof ReadinessRegistry) registry.close()
  }

  try {
    const deviceManager = Reflect.get(api as object, 'deviceManager') as {
      listPersistedByAddon: {
        query: (i: { addonId: string }) => Promise<unknown>
      }
      loadConfig: { query: (i: { deviceId: number }) => Promise<unknown> }
    }
    log?.debug?.(`[worker-restore] "${addonId}": calling listPersistedByAddon...`)
    const rowsResult = await deviceManager.listPersistedByAddon.query({
      addonId,
    })
    log?.debug?.(
      `[worker-restore] "${addonId}": got ${Array.isArray(rowsResult) ? rowsResult.length : 0} row(s)`,
    )
    const rows = Array.isArray(rowsResult)
      ? (rowsResult as Array<{
          id: number
          stableId: string
          type: string
          name: string
          parentDeviceId: number | null
        }>)
      : []
    if (rows.length === 0) {
      context.logger?.info?.(
        `[worker-restore] no persisted devices to restore for addon "${addonId}"`,
      )
      return
    }
    const savedDevices = await Promise.all(
      rows.map(async (row) => {
        const config = await deviceManager.loadConfig.query({
          deviceId: row.id,
        })
        return {
          id: row.id,
          stableId: row.stableId,
          type: row.type,
          name: row.name,
          parentDeviceId: row.parentDeviceId,
          config: (config ?? {}) as Record<string, unknown>,
        }
      }),
    )
    await restoreFn.call(addon, savedDevices)
    // "restore pass complete", not "restored N": the addon's own restore
    // logs the honest restored/failed split (a per-device failure is
    // handed to the bounded retry, D347 — it is not part of this pass).
    log?.info?.(
      `[worker-restore] "${addonId}": restore pass complete for ${savedDevices.length} persisted device(s)`,
    )
  } catch (err) {
    log?.warn?.(`[worker-restore] "${addonId}": restoreDevices threw: ${errMsg(err)}`)
  }
}
