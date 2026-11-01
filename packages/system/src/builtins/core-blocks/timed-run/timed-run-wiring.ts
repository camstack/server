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
  TimedRunService,
} from './timed-run-service.js'

export interface TimedRunWiringDeps {
  readonly records: RecordsAccess
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
    actuation: actuationOver(deps.api),
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
