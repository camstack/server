/**
 * D983 for notification sequences: a stored step is READ as the new target
 * shape, the store rewrites a legacy row once, and the runner resolves a
 * domain target at run time.
 */
import type { DeviceDirectory, InMemoryRecords } from '@camstack/types'
import { ActionTargetResolver, DeviceType } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ncRecordKinds } from '../record-kinds.js'
import { NcRuleActionRunner } from '../rule-actions.js'
import { NcSequenceStore } from '../sequence-store.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'

describe('NcSequenceStore — a legacy step is read and rewritten as a target', () => {
  let world: InMemoryRecords
  let store: NcSequenceStore

  beforeEach(async () => {
    world = makeNcRecords()
    store = new NcSequenceStore({
      kind: world.records.kind(ncRecordKinds.sequences),
      logger: makeSilentLogger(),
      now: () => 5_000,
    })
    await world.records.kind(ncRecordKinds.sequences).put({
      id: 'seq-legacy',
      data: {
        name: 'open the gate',
        actions: [
          { kind: 'cap', deviceId: 7, cap: 'siren', method: 'on', args: { code: 'MARK-42' } },
        ],
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    })
  })

  it('serves target.devices with the marked arg intact, and persists it once', async () => {
    await store.load()
    const step = store.get('seq-legacy')?.actions[0]
    expect(step).toMatchObject({ kind: 'cap', target: { kind: 'devices', ids: [7] } })
    expect(step).toMatchObject({ args: { code: 'MARK-42' } })
    expect(step).not.toHaveProperty('deviceId')

    const stored = ncTable(world, 'sequences').get('seq-legacy')
    const storedStep = Array.isArray(stored?.['actions']) ? stored['actions'][0] : undefined
    expect(storedStep).toMatchObject({ target: { kind: 'devices', ids: [7] } })
    expect(storedStep).not.toHaveProperty('deviceId')
    expect(stored?.['createdAt']).toBe(1_000)
  })
})

describe('NcRuleActionRunner — a domain step is resolved when it runs', () => {
  function runnerOver(devices: { id: number; location: string | null }[]) {
    const directory: DeviceDirectory = {
      listDeviceIdsByCaps: async (caps) => (caps.includes('cover') ? devices.map((d) => d.id) : []),
      listDevices: async (ids) =>
        devices
          .filter((d) => ids.includes(d.id))
          .map((d) => ({ ...d, type: DeviceType.Generic, disabled: false })),
    }
    const resolver = new ActionTargetResolver(directory, makeSilentLogger())
    const calls: number[] = []
    const runner = new NcRuleActionRunner({
      logger: makeSilentLogger(),
      actuate: async ({ deviceId }) => void calls.push(deviceId),
      isDeviceScoped: () => true,
      resolveTarget: (target, actionId, owner) =>
        resolver.resolve(target, actionId, {}, { actionId, owner }),
      sleep: async () => undefined,
    })
    return { runner, calls, resolver, devices }
  }

  const sequence = {
    id: 'seq-open',
    name: 'open the kitchen',
    enabled: true,
    throttle: false,
    actions: [
      {
        kind: 'cap',
        actionId: 'cover.open',
        target: { kind: 'domain', roomId: 'Kitchen' },
        cap: 'cover',
        method: 'open',
      },
    ],
  } as const

  it('actuates every device in the room, including one added after invalidation', async () => {
    const h = runnerOver([
      { id: 1, location: 'Kitchen' },
      { id: 2, location: 'Garage' },
    ])
    await h.runner.run({ ruleId: 'r', ruleName: 'r', sequences: [sequence], deviceId: 1 })
    expect(h.calls).toEqual([1])
    h.devices.push({ id: 3, location: 'kitchen' })
    h.resolver.invalidate()
    await h.runner.run({ ruleId: 'r', ruleName: 'r', sequences: [sequence], deviceId: 1 })
    expect(h.calls).toEqual([1, 1, 3])
  })
})
