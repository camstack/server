/**
 * Builds the `actions` runtime out of what the core-blocks addon owns: its
 * records access (for the `runs` / `actions` / `action-links` kinds), the
 * cluster API (for the `action-source` providers and for a step's device cap)
 * and the event bus.
 *
 * Kept out of `core-blocks.addon.ts` so that file stays the addon, and so this
 * wiring can be read — and its seams (`ActionSources`, `invokeCap`) swapped in a
 * spec — without booting the addon.
 */
import { randomUUID } from 'node:crypto'
import {
  ACTION_TARGET_INVALIDATION_EVENTS,
  type ActionEntry,
  type ActionRunChanged,
  type AddonApi,
  type BoundCapsReader,
  type CapCall,
  type DeviceDirectory,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  commandOrigin,
  kebabToCamel,
  type RecordsAccess,
} from '@camstack/types'
import { ActionsService, type ActionSources } from './actions-service.js'
import { ActionsStore } from './actions-store.js'
import { templateDoorOver } from './device-template-door.js'
import { conditionDoorOver } from './step-condition-door.js'
import { coreBlocksRecordKinds } from './record-kinds.js'
import { buildRunsApi, type RunsApi } from './runs-api.js'
import { RunsLedger } from './runs-ledger.js'

export interface ActionsRuntime {
  readonly service: ActionsService
  /** Drop the registry subscriptions that keep the target cache fresh. */
  dispose(): void
  readonly ledger: RunsLedger
  readonly runsApi: RunsApi
}

export interface ActionsRuntimeDeps {
  readonly records: RecordsAccess
  readonly api: () => AddonApi | undefined
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  /** The device registry; `ctx.api` by default. A spec swaps it. */
  readonly directory?: DeviceDirectory
  /** The named devices' binding maps; `ctx.api` by default. A spec swaps it. */
  readonly boundCaps?: BoundCapsReader
}

const ACTION_SOURCE_CAP = 'action-source'

/** `ctx.api` as the `action-source` providers see it: the generated, typed client. */
export function sourcesOver(api: () => AddonApi | undefined): ActionSources {
  const need = (): AddonApi => {
    const current = api()
    if (current === undefined) {
      throw new Error('core-blocks: no ctx.api on this node — the action sources cannot be reached')
    }
    return current
  }
  return {
    list: async (): Promise<ActionEntry[]> => {
      // `action-source` is a COLLECTION: no provider means NONE, answered at
      // once. The in-process `ctx.api` link waits for a provider to appear
      // (up to the 30 s discovery deadline), so asking an empty collection
      // would stall the whole list. A registry that does not answer (no
      // entry) is not "absent": ask as before.
      const info = await need().capabilities.getCapability.query({ name: ACTION_SOURCE_CAP })
      if (info !== null && info.providers.length === 0) return []
      const entries = await need().actionSource.listActions.query({})
      return [...entries]
    },
    run: async ({ addonId, actionId, variables }) => {
      await need().actionSource.runAction.mutate({ addonId, actionId, variables: { ...variables } })
    },
    stop: async ({ addonId, actionId }) => {
      await need().actionSource.stopAction.mutate({ addonId, actionId })
    },
  }
}

/**
 * A device cap call by name — the same lookup a generated automation block
 * does: `ctx.api` is keyed by the ROUTER name (`alarmPanel`), not the cap name.
 */
export function invokeCapOver(api: () => AddonApi | undefined): (call: CapCall) => Promise<void> {
  return async (call) => {
    const current = api()
    if (current === undefined)
      throw new Error('no ctx.api on this node — a device cap cannot be reached')
    const client: unknown = Reflect.get(current, kebabToCamel(call.cap))
    const procedure: unknown =
      client !== null && client !== undefined ? Reflect.get(Object(client), call.method) : undefined
    const mutate: unknown =
      procedure !== null && procedure !== undefined
        ? Reflect.get(Object(procedure), 'mutate')
        : undefined
    if (typeof mutate !== 'function') {
      throw new Error(`no such device method: ${call.cap}.${call.method}`)
    }
    const input = { ...call.args, deviceId: call.deviceId }
    // The origin rides out-of-band in the call's context (D1022), never in the args.
    await Reflect.apply(
      mutate,
      procedure,
      call.origin === undefined ? [input] : [input, commandOrigin(call.origin)],
    )
  }
}

/**
 * What each named device offers, from its OWN binding map (`getBindingsBatch`,
 * D12): one batched read of just the devices a step names, by cap name (D13).
 */
export function boundCapsOver(api: () => AddonApi | undefined): BoundCapsReader {
  return {
    boundCapsOf: async (deviceIds) => {
      const current = api()
      if (current === undefined) {
        throw new Error('core-blocks: no ctx.api on this node — device bindings cannot be read')
      }
      const rows = await current.deviceManager.getBindingsBatch.query({ deviceIds: [...deviceIds] })
      return new Map(rows.map((row) => [row.deviceId, row.entries.map((entry) => entry.capName)]))
    },
  }
}

/**
 * The device registry as the target resolver reads it: the devices bound to a
 * cap (`listDeviceIdsByCaps`, D13) and the slim listing for type and room.
 */
export function directoryOver(api: () => AddonApi | undefined): DeviceDirectory {
  const need = (): AddonApi => {
    const current = api()
    if (current === undefined) {
      throw new Error('core-blocks: no ctx.api on this node — the device registry cannot be read')
    }
    return current
  }
  return {
    listDeviceIdsByCaps: (capNames) =>
      need().deviceManager.listDeviceIdsByCaps.query({ capNames: [...capNames] }),
    listDevices: async (deviceIds) => {
      const rows = await need().deviceManager.listAll.query({
        deviceIds: [...deviceIds],
        projection: 'slim',
      })
      return rows.map((d) => ({
        id: d.id,
        type: d.type,
        location: d.location,
        disabled: d.disabled,
      }))
    },
  }
}

export function buildActionsRuntime(deps: ActionsRuntimeDeps): ActionsRuntime {
  const ledger = new RunsLedger({
    runs: deps.records.kind(coreBlocksRecordKinds.runs),
    logger: deps.logger.child('runs'),
  })
  const store = new ActionsStore({
    actions: deps.records.kind(coreBlocksRecordKinds.actions),
    links: deps.records.kind(coreBlocksRecordKinds['action-links']),
    logger: deps.logger.child('actions-store'),
  })
  const service = new ActionsService({
    store,
    ledger,
    sources: sourcesOver(deps.api),
    directory: deps.directory ?? directoryOver(deps.api),
    boundCaps: deps.boundCaps ?? boundCapsOver(deps.api),
    invokeCap: invokeCapOver(deps.api),
    templates: templateDoorOver(deps.api),
    conditions: conditionDoorOver(deps.api),
    emit: (event: ActionRunChanged) =>
      deps.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: 'core-blocks' },
        category: EventCategory.ActionsRunChanged,
        data: event,
      }),
    logger: deps.logger.child('actions'),
  })
  // A cached domain is stale the moment a device is added, removed, moved or re-bound.
  const unsubscribers = ACTION_TARGET_INVALIDATION_EVENTS.map((category) =>
    deps.eventBus.subscribe({ category }, () => service.invalidateTargets()),
  )
  return {
    service,
    ledger,
    runsApi: buildRunsApi(ledger, deps.logger.child('runs')),
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    },
  }
}
