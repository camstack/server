/**
 * Wires `TimedRunService` to the hub: its rows (the `timed-runs` kind), the
 * device registry for a device's type, the device caps for the on/off command
 * and `deviceState.setCapSlice` for the mirrored slice.
 */
import {
  type AddonApi,
  type IScopedLogger,
  type RecordsAccess,
  type TimedRunActuator,
} from '@camstack/types'
import { invokeCapOver } from '../actions-wiring.js'
import { timeoutScheduler } from '../power-source-service.js'
import { coreBlocksRecordKinds, type TimedRunRowBody } from '../record-kinds.js'
import {
  TIMED_RUN_SETTLE_MS,
  type TimedRunActuation,
  type TimedRunRows,
  type TimedRunQuickRuns,
  TimedRunService,
} from './timed-run-service.js'

/** The addon's per-device settings (D865), the one home of the one-tap run. */
export interface TimedRunSettingsAccess {
  readonly readDeviceStore: (deviceId: number) => Promise<Record<string, unknown>>
  readonly writeDeviceStore: (deviceId: number, patch: Record<string, unknown>) => Promise<void>
}

export interface TimedRunWiringDeps {
  readonly records: RecordsAccess
  readonly settings: () => TimedRunSettingsAccess | undefined
  readonly api: () => AddonApi | undefined
  readonly logger: IScopedLogger
}

const ARM_RETRY_DELAY_MS = 5_000
const ARM_MAX_ATTEMPTS = 24

function rowsOver(records: RecordsAccess): TimedRunRows {
  const kind = records.kind(coreBlocksRecordKinds['timed-runs'])
  return {
    get: async (deviceId) => (await kind.get(String(deviceId)))?.data ?? null,
    put: async (deviceId, body) => {
      await kind.put({ id: String(deviceId), deviceId, data: body })
    },
    remove: async (deviceId) => {
      await kind.delete(String(deviceId))
    },
    all: async () => {
      const out: { deviceId: number; body: TimedRunRowBody }[] = []
      let cursor: string | undefined
      do {
        const page = await kind.query({ ...(cursor === undefined ? {} : { cursor }) })
        for (const row of page.records) {
          if (row.deviceId !== null) out.push({ deviceId: row.deviceId, body: row.data })
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      return out
    },
  }
}

const QUICK_RUN_KEY = 'quickRunDuration'

function quickRunsOver(settings: () => TimedRunSettingsAccess | undefined): TimedRunQuickRuns {
  const need = (): TimedRunSettingsAccess => {
    const current = settings()
    if (current === undefined) throw new Error('core-blocks: no ctx.settings on this node')
    return current
  }
  return {
    read: async (deviceId) => {
      const stored = (await need().readDeviceStore(deviceId))[QUICK_RUN_KEY]
      return typeof stored === 'number' ? stored : null
    },
    write: (deviceId, duration) => need().writeDeviceStore(deviceId, { [QUICK_RUN_KEY]: duration }),
  }
}

function actuationOver(api: () => AddonApi | undefined): TimedRunActuation {
  const invoke = invokeCapOver(api)
  return {
    set: (deviceId, actuator: TimedRunActuator, on) =>
      actuator === 'switch'
        ? invoke({ deviceId, cap: 'switch', method: 'setState', args: { on } })
        : invoke({ deviceId, cap: 'pet-fountain', method: 'setPump', args: { on } }),
  }
}

export function buildTimedRunService(deps: TimedRunWiringDeps): TimedRunService {
  const need = (): AddonApi => {
    const current = deps.api()
    if (current === undefined) throw new Error('core-blocks: no ctx.api on this node')
    return current
  }
  return new TimedRunService({
    rows: rowsOver(deps.records),
    deviceTypeOf: async (deviceId) => {
      const found = await need().deviceManager.getDevice.query({ deviceId })
      return found === null || found === undefined ? null : found.type
    },
    timedRunDeviceIds: async () =>
      need().deviceManager.listDeviceIdsByCaps.query({ capNames: ['timed-run'] }),
    actuation: actuationOver(deps.api),
    quickRuns: quickRunsOver(deps.settings),
    publish: async (deviceId, status) => {
      await need().deviceState.setCapSlice.mutate({
        deviceId,
        capName: 'timed-run',
        slice: { ...status },
      })
    },
    scheduler: timeoutScheduler,
    now: () => Date.now(),
    settleMs: TIMED_RUN_SETTLE_MS,
    logger: deps.logger,
  })
}

/**
 * Re-arm the stored deadlines. ARMED, never awaited: the registry is a hub-core
 * cap, answerable only after boot, so a first attempt may find it not ready. A
 * failed read changes nothing (D49) and is tried again a bounded number of times.
 */
export async function armTimedRuns(
  service: TimedRunService,
  logger: IScopedLogger,
  options: { readonly isDisposed: () => boolean },
): Promise<void> {
  for (let attempt = 1; attempt <= ARM_MAX_ATTEMPTS; attempt += 1) {
    if (options.isDisposed()) return
    try {
      await service.reconcile()
      return
    } catch (error) {
      if (attempt === ARM_MAX_ATTEMPTS) {
        logger.warn('timed-run could not read its stored deadlines; none are re-armed', {
          meta: { attempts: attempt, error: String(error) },
        })
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ARM_RETRY_DELAY_MS))
    }
  }
}
