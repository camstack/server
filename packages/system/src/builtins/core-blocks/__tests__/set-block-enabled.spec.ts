import {
  type CoreBlock,
  type CoreBlockInput,
  type GroupHelperSpec,
  compileHelper,
  composedDeviceStableId,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordingLogger } from '../../composer/__tests__/fixtures.js'
import {
  type GroupTriggerSync,
  type OwnedBlockWrite,
  groupTriggerSyncOver,
  ownedGroupOf,
} from '../group-triggers.js'
import { type SetBlockEnabledDeps, setBlockEnabled } from '../set-block-enabled.js'

const demo = (stableId: string, addonId = 'demo') => ({ addonId, stableId })

function groupBlock(id: string): CoreBlock {
  const spec: GroupHelperSpec = {
    kind: 'group',
    templateId: 'light',
    aggregate: 'any',
    active: 'at-least-one',
    members: ['lamp-1', 'lamp-2'].map((m) => ({
      source: demo(m),
      cap: 'switch',
      fieldPath: 'on',
    })),
    triggers: [
      {
        id: 't1',
        source: { kind: 'fired', device: demo('button'), eventIds: ['PRESS_SHORT'] },
        action: { kind: 'switch' },
      },
    ],
  }
  const compiled = compileHelper(spec)
  if (!compiled.ok) throw new Error('the spec did not compile')
  return {
    id,
    name: 'Bathroom light',
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u',
    status: 'stopped',
    lastChangedAt: 1,
    source: { kind: 'composition', composition: compiled.composition },
  }
}

const DEVICES: ReadonlyMap<string, number> = new Map([
  ['demo/button', 10],
  ['demo/lamp-1', 21],
  ['demo/lamp-2', 22],
  [`composer/${composedDeviceStableId('g1')}`, 99],
])

let blocks: CoreBlock[]
let sync: GroupTriggerSync
let armed: boolean
let syncFails: boolean
let log: ReturnType<typeof recordingLogger>
let deps: SetBlockEnabledDeps

const owned = (): CoreBlock | undefined => blocks.find((b) => ownedGroupOf(b) !== null)

beforeEach(() => {
  blocks = [groupBlock('g1')]
  armed = true
  syncFails = false
  log = recordingLogger()
  const real = groupTriggerSyncOver({
    blocks: {
      isLoaded: () => true,
      list: () => blocks,
      get: (id) => blocks.find((b) => b.id === id) ?? null,
    },
    writes: {
      create: async (input: CoreBlockInput) => {
        blocks = [
          ...blocks,
          {
            id: 'own1',
            name: input.name,
            code: input.code ?? '',
            enabled: input.enabled,
            placement: input.placement,
            createdAt: 1,
            updatedAt: 1,
            createdBy: 'system',
            status: 'stopped',
            lastChangedAt: 1,
          },
        ]
      },
      save: async (blockId: string, write: OwnedBlockWrite) => {
        blocks = blocks.map((b) => (b.id === blockId ? { ...b, ...write } : b))
      },
      remove: async (blockId: string) => {
        blocks = blocks.filter((b) => b.id !== blockId)
      },
    },
    deviceIds: async () => DEVICES,
    logger: log.logger,
  })
  sync = {
    ...real,
    sync: (id, mode) =>
      syncFails ? Promise.reject(new Error('device list unavailable')) : real.sync(id, mode),
  }
  deps = {
    refuseIfOwned: () => undefined,
    update: async (blockId, patch) => {
      blocks = blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b))
      const block = blocks.find((b) => b.id === blockId)
      if (block === undefined) throw new Error('no block')
      return block
    },
    convergeSoon: () => undefined,
    groupTriggers: () => (armed ? sync : null),
    deviceIdOf: async () => 99,
    logger: log.logger,
  }
})

describe('setBlockEnabled on a group with a trigger', () => {
  it('switches the owned automation off with the group, and on again', async () => {
    await sync.sync('g1', 'save')
    expect(owned()?.enabled).toBe(true)

    await setBlockEnabled(deps, { blockId: 'g1', enabled: false })
    expect(owned()?.enabled).toBe(false)

    await setBlockEnabled(deps, { blockId: 'g1', enabled: true })
    expect(owned()?.enabled).toBe(true)
  })

  it('logs a failed sync under the group device and still keeps the switch', async () => {
    await sync.sync('g1', 'save')
    syncFails = true
    const result = await setBlockEnabled(deps, { blockId: 'g1', enabled: false })
    expect(result.block.enabled).toBe(false)
    const line = log.lines.find((l) => l.message.includes('group triggers'))
    expect(line?.extras?.tags).toEqual({ deviceId: 99 })
  })

  it('does nothing extra before the group sync is armed', async () => {
    armed = false
    await expect(setBlockEnabled(deps, { blockId: 'g1', enabled: false })).resolves.toBeDefined()
  })
})
