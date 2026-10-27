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
  type ActionEntry,
  type ActionRunChanged,
  type AddonApi,
  type CapCall,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  kebabToCamel,
  type RecordsAccess,
} from '@camstack/types'
import { ActionsService, type ActionSources } from './actions-service.js'
import { ActionsStore } from './actions-store.js'
import { coreBlocksRecordKinds } from './record-kinds.js'
import { buildRunsApi, type RunsApi } from './runs-api.js'
import { RunsLedger } from './runs-ledger.js'

export interface ActionsRuntime {
  readonly service: ActionsService
  readonly ledger: RunsLedger
  readonly runsApi: RunsApi
}

export interface ActionsRuntimeDeps {
  readonly records: RecordsAccess
  readonly api: () => AddonApi | undefined
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
}

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
    await Reflect.apply(mutate, procedure, [{ ...call.args, deviceId: call.deviceId }])
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
  })
  const service = new ActionsService({
    store,
    ledger,
    sources: sourcesOver(deps.api),
    invokeCap: invokeCapOver(deps.api),
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
  return { service, ledger, runsApi: buildRunsApi(ledger, deps.logger.child('runs')) }
}
