/**
 * Builds the schedulers runtime out of what core-blocks already owns: its
 * records access, the runs ledger and the actions' target resolver, plus
 * `ctx.api` (the site, device state, device calls) and the event bus.
 */
import {
  ACTION_TARGET_INVALIDATION_EVENTS,
  ActionTargetResolver,
  ALL_CAPABILITY_DEFINITIONS,
  type AddonApi,
  capUnitResolver,
  type DeviceDirectory,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  type RecordsAccess,
  type SiteReading,
} from '@camstack/types'
import { directoryOver, invokeCapOver } from '../actions-wiring.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { type RunsLedger, schedulerOwner } from '../runs-ledger.js'
import { parseDeviceStateChanged } from '../../shared/device-state-changed.js'
import { SchedulerEngine, SCHEDULER_TRACE_KEEP } from './scheduler-engine.js'
import { SchedulersService } from './scheduler-service.js'
import { SchedulersStore } from './scheduler-store.js'
import type { SchedulerClock, SchedulerHost } from './scheduler-types.js'

export interface SchedulersRuntime {
  readonly service: SchedulersService
  readonly engine: SchedulerEngine
  readonly store: SchedulersStore
  dispose(): void
}

export interface SchedulersRuntimeDeps {
  readonly records: RecordsAccess
  readonly api: () => AddonApi | undefined
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  readonly ledger: RunsLedger
  readonly directory?: DeviceDirectory
  /** A spec swaps these. */
  readonly host?: SchedulerHost
  readonly clock?: SchedulerClock
}

/** `ctx.api` as the engine reads it: the site, a device's state slice, and device calls. */
export function hostOver(api: () => AddonApi | undefined): SchedulerHost {
  const need = (): AddonApi => {
    const current = api()
    if (current === undefined) {
      throw new Error('core-blocks: no ctx.api on this node — the scheduler cannot reach the hub')
    }
    return current
  }
  return {
    readSite: async (): Promise<SiteReading> => need().system.getSiteLocation.query(),
    fetchSlice: (deviceId, cap) => need().deviceState.getCapSlice.query({ deviceId, capName: cap }),
    fetchStableIds: async () => {
      const all = await need().deviceManager.listAll.query({
        projection: 'slim',
      })
      return new Map(
        all.flatMap((d) => (d.stableId === undefined ? [] : [[d.stableId, d.id] as const])),
      )
    },
    invokeCap: invokeCapOver(api),
  }
}

export function buildSchedulersRuntime(deps: SchedulersRuntimeDeps): SchedulersRuntime {
  const store = new SchedulersStore({
    schedulers: deps.records.kind(coreBlocksRecordKinds.schedulers),
    state: deps.records.kind(coreBlocksRecordKinds['scheduler-state']),
  })
  const host = deps.host ?? hostOver(deps.api)
  const targets = new ActionTargetResolver(
    deps.directory ?? directoryOver(deps.api),
    deps.logger.child('targets'),
  )
  const engine = new SchedulerEngine({
    store,
    host,
    targets,
    logger: deps.logger.child('engine'),
    record: (schedulerId, trace) =>
      deps.ledger.report(schedulerOwner(schedulerId), {
        trace,
        keepTraces: SCHEDULER_TRACE_KEEP,
      }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  })
  const service = new SchedulersService({
    store,
    engine,
    ledger: deps.ledger,
    host,
    targets,
    units: capUnitResolver(ALL_CAPABILITY_DEFINITIONS),
    logger: deps.logger.child('schedulers'),
  })
  const unsubscribers = [
    ...ACTION_TARGET_INVALIDATION_EVENTS.map((category) =>
      deps.eventBus.subscribe({ category }, () => engine.invalidateTargets()),
    ),
    deps.eventBus.subscribe({ category: EventCategory.DeviceStateChanged }, (event) => {
      const data = parseDeviceStateChanged(event.data)
      if (data !== null) engine.onDeviceState(data.deviceId, data.capName, data.slice)
    }),
  ]
  return {
    service,
    engine,
    store,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      engine.dispose()
    },
  }
}

/** Bounded, like the blocks integration: the gap is the rest of hub boot. */
const ARM_RETRY_DELAY_MS = 5_000
const ARM_MAX_ATTEMPTS = 24

/**
 * Start the engine WITHOUT putting it on the boot path: `system.getSiteLocation`
 * is a hub-core cap, unanswerable until the builtins finished booting (the same
 * gap `armBlocksIntegration` waits out). Resolves when it started or gave up.
 */
export async function armSchedulerEngine(
  engine: SchedulerEngine,
  logger: IScopedLogger,
  options: {
    readonly retryDelayMs?: number
    readonly maxAttempts?: number
    readonly isDisposed?: () => boolean
  } = {},
): Promise<void> {
  const delay = options.retryDelayMs ?? ARM_RETRY_DELAY_MS
  const max = options.maxAttempts ?? ARM_MAX_ATTEMPTS
  for (let attempt = 1; attempt <= max; attempt += 1) {
    if (options.isDisposed?.() === true) return
    if (await engine.start()) return
    if (attempt === max) {
      logger.warn(
        'scheduler engine never started — the site could not be read; schedulers are not running',
        {
          meta: { attempts: attempt },
        },
      )
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
  }
}
