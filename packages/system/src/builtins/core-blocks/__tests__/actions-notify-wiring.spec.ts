import {
  ALL_CAPABILITY_DEFINITIONS,
  type AddonApi,
  type BoundCapsReader,
  type CapCaller,
  type DeviceDirectory,
  createRecordsAccess,
  instanceApiOverTargets,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'

import { SystemEventBus } from '../../../events/system-event-bus.js'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { buildActionsRuntime } from '../actions-wiring.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { recordingLogger } from './fixtures.js'

const ADMIN: CapCaller = { userId: 'root', isAdmin: true }

const NO_DEVICES: DeviceDirectory = {
  listDeviceIdsByCaps: async () => [],
  listDevices: async () => [],
}
const BOUND_TO_ALL: BoundCapsReader = {
  boundCapsOf: async (ids) =>
    new Map(ids.map((id) => [id, ALL_CAPABILITY_DEFINITIONS.map((def) => def.name)])),
}

interface Sent {
  readonly targetId: string
  readonly addonId: string
  readonly body: string
  readonly title?: string
}

/** `ctx.api` as the actions runtime reads it: one notifier target, and the `send` that records. */
function notifierApi(sent: Sent[]): AddonApi {
  const instances = instanceApiOverTargets(() => [
    { id: 'tg-1', name: 'Phone', kind: 'ntfy', addonId: 'notifiers', enabled: true, config: {} },
  ])
  const fake = {
    ...instances,
    notificationOutput: {
      send: {
        mutate: async (input: {
          targetId: string
          addonId: string
          notification: { body: string; title?: string }
        }) => {
          sent.push({
            targetId: input.targetId,
            addonId: input.addonId,
            body: input.notification.body,
            ...(input.notification.title === undefined ? {} : { title: input.notification.title }),
          })
          return { success: true }
        },
      },
    },
  }
  // The fake covers only the routers the runtime reads for a notify step.
  return Object.assign(Object.create(null), fake)
}

async function runtimeOver(api: () => AddonApi | undefined) {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const log = recordingLogger()
  const runtime = buildActionsRuntime({
    records,
    api,
    eventBus: new SystemEventBus(),
    logger: log.logger,
    directory: NO_DEVICES,
    boundCaps: BOUND_TO_ALL,
  })
  return { runtime, log }
}

describe('a stored Action with a notify step', () => {
  it('reaches the notifier through the runtime ctx.api (same path as an automation)', async () => {
    const sent: Sent[] = []
    const { runtime } = await runtimeOver(() => notifierApi(sent))
    const { action } = await runtime.service.create({
      action: {
        name: 'Tell me',
        steps: [{ kind: 'notify', targetId: 'tg-1', title: 'Garden', body: 'Watering done' }],
      },
    })
    const result = await runtime.service.run({
      actionId: action.id,
      variables: {},
      wait: true,
      caller: ADMIN,
    })
    expect(result.outcome).toBe('ran')
    expect(sent).toEqual([
      { targetId: 'tg-1', addonId: 'notifiers', body: 'Watering done', title: 'Garden' },
    ])
  })

  it('fails the run, naming the missing ctx.api, when the node has none', async () => {
    const { runtime } = await runtimeOver(() => undefined)
    const { action } = await runtime.service.create({
      action: { name: 'Tell me', steps: [{ kind: 'notify', targetId: 'tg-1', body: 'hi' }] },
    })
    const result = await runtime.service.run({
      actionId: action.id,
      variables: {},
      wait: true,
      caller: ADMIN,
    })
    expect(result.outcome).not.toBe('ran')
    expect(result.message).toContain('no ctx.api')
  })
})
