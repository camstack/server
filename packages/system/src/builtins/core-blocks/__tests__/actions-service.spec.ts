import {
  type ActionEntry,
  type ActionStep,
  type ActionRunChanged,
  type CapCaller,
  type DeviceDirectory,
  DeviceType,
  createRecordsAccess,
  IDLE_ACTION_STATUS,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { ActionsService, type ActionSources } from '../actions-service.js'
import { ActionsStore } from '../actions-store.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { actionOwner, RunsLedger } from '../runs-ledger.js'
import { recordingLogger } from './fixtures.js'

const ADMIN: CapCaller = { userId: 'root', isAdmin: true }
const VIEWER: CapCaller = { userId: 'guest', isAdmin: false }

function addonEntry(id: string, overrides: Partial<ActionEntry> = {}): ActionEntry {
  return {
    id,
    name: id,
    addonId: id.split(':')[0] ?? 'x',
    source: 'addon',
    readOnly: true,
    status: IDLE_ACTION_STATUS,
    ...overrides,
  }
}

/** A registry that was never asked: a legacy `devices` step does not read it. */
const NO_REGISTRY: DeviceDirectory = {
  listDeviceIdsByCaps: async () => {
    throw new Error('the registry must not be read by a devices target')
  },
  listDevices: async () => {
    throw new Error('the registry must not be read by a devices target')
  },
}

async function world(options?: {
  readonly addonActions?: readonly ActionEntry[]
  readonly invoke?: (call: {
    deviceId: number
    cap: string
    method: string
    args: Readonly<Record<string, unknown>>
  }) => Promise<void>
  readonly sourceRun?: () => Promise<void>
  readonly directory?: DeviceDirectory
}) {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const log = recordingLogger()
  let clock = 1_000
  let ids = 0
  const store = new ActionsStore({
    actions: records.kind(coreBlocksRecordKinds.actions),
    links: records.kind(coreBlocksRecordKinds['action-links']),
    now: () => clock,
    newId: () => `a${(ids += 1)}`,
  })
  const ledger = new RunsLedger({
    runs: records.kind(coreBlocksRecordKinds.runs),
    logger: log.logger,
    now: () => clock,
  })
  const calls: Array<{ deviceId: number; cap: string; method: string; args: unknown }> = []
  const sourceRuns: Array<{ addonId: string; actionId: string; variables: unknown }> = []
  const events: ActionRunChanged[] = []
  const sources: ActionSources = {
    list: async () => [...(options?.addonActions ?? [])],
    run: async (input) => {
      sourceRuns.push(input)
      await options?.sourceRun?.()
    },
    stop: async () => undefined,
  }
  let runs = 0
  const service = new ActionsService({
    store,
    ledger,
    sources,
    directory: options?.directory ?? NO_REGISTRY,
    invokeCap: async (call) => {
      calls.push(call)
      await options?.invoke?.(call)
    },
    emit: (event) => events.push(event),
    logger: log.logger,
    now: () => (clock += 10),
    newRunId: () => `run-${(runs += 1)}`,
  })
  return { service, store, ledger, calls, sourceRuns, events, log, records }
}

const STEP = (deviceId: number) => ({ kind: 'cap', deviceId, cap: 'siren', method: 'on' }) as const

describe('actions — internal actions', () => {
  it('runs the steps, substitutes variables, and writes a steps.N trace to the ledger', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: {
        name: 'Alarm',
        variables: [{ name: 'vol', type: 'number', default: 5 }],
        steps: [
          {
            kind: 'cap',
            deviceId: 616,
            cap: 'siren',
            method: 'on',
            args: { volume: { $var: 'vol' } },
          },
        ],
      },
    })
    const result = await w.service.run({
      actionId: action.id,
      variables: { vol: 9 },
      wait: true,
      caller: ADMIN,
    })
    expect(result.outcome).toBe('ran')
    expect(w.calls).toEqual([{ deviceId: 616, cap: 'siren', method: 'on', args: { volume: 9 } }])
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces).toHaveLength(1)
    expect(traces[0]?.steps.map((s) => s.path)).toEqual(['steps.0'])
    expect(traces[0]?.outcome).toBe('ran')
  })

  it('a failed step stops the sequence: later steps are not-run and the run is failed', async () => {
    const w = await world({
      invoke: async (call) => {
        if (call.deviceId === 2) throw new Error('siren offline')
      },
    })
    const { action } = await w.service.create({
      action: { name: 'Two', steps: [STEP(1), STEP(2), STEP(3)] },
    })
    const result = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(result.outcome).toBe('failed')
    expect(w.calls.map((c) => c.deviceId)).toEqual([1, 2])
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces[0]?.steps.map((s) => s.outcome)).toEqual(['ok', 'error', 'not-run'])
    const logged = w.log.lines.find((l) => l.message.includes('step failed'))
    expect(logged?.extras?.tags).toEqual({ deviceId: 2 })
  })

  it('refuses a variable the action did not declare, before anything runs', async () => {
    const w = await world()
    const { action } = await w.service.create({ action: { name: 'One', steps: [STEP(1)] } })
    await expect(
      w.service.run({ actionId: action.id, variables: { typo: 1 }, wait: true, caller: ADMIN }),
    ).rejects.toThrow(/\[invalid-variables\]/)
    expect(w.calls).toEqual([])
  })

  it('a run started while the action is running is refused, traced and logged — never queued', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = await world({ invoke: () => gate })
    const { action } = await w.service.create({ action: { name: 'Slow', steps: [STEP(1)] } })
    const first = await w.service.run({ actionId: action.id, caller: ADMIN })
    expect(first.outcome).toBe('started')
    const second = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(second.outcome).toBe('skipped-overlap')
    expect(w.calls).toHaveLength(1)
    expect(
      w.log.lines.some(
        (l) => l.message.includes('already running') && l.extras?.meta?.['actionId'] === action.id,
      ),
    ).toBe(true)
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces.map((t) => t.outcome).toSorted()).toEqual(['ran', 'skipped-overlap'])
  })

  it('emits onRunChanged when a run starts and when it ends', async () => {
    const w = await world()
    const { action } = await w.service.create({ action: { name: 'One', steps: [STEP(1)] } })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.events.map((e) => [e.isRunning, e.outcome])).toEqual([
      [true, undefined],
      [false, 'ran'],
    ])
  })
})

const FEED = (args: Record<string, unknown>, deviceId = 41): ActionStep => ({
  kind: 'cap',
  target: { kind: 'devices', ids: [deviceId] },
  cap: 'pet-feeder',
  method: 'feed',
  args,
})

describe('actions — a number tied to a quantity (D972)', () => {
  it('converts a step arg entered in kilograms to the grams the method takes, keeping the picked unit', async () => {
    const w = await world()
    const { action, warnings } = await w.service.create({
      action: { name: 'Meal', steps: [FEED({ grams: { value: 0.1, unit: 'kg' } })] },
    })
    expect(action.steps).toEqual([{ ...FEED({ grams: 100 }), argUnits: { grams: 'kg' } }])
    expect(warnings ?? []).toEqual([])
    const stored = await w.store.get(action.id)
    expect(stored?.steps).toEqual(action.steps)
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls).toEqual([
      { deviceId: 41, cap: 'pet-feeder', method: 'feed', args: { grams: 100 } },
    ])
  })

  it('converts on update too, and re-saving what it stored converts nothing twice', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: { name: 'Meal', steps: [FEED({ grams: 60 })] },
    })
    const updated = await w.service.update({
      actionId: action.id,
      action: { steps: [FEED({ hopper1: { value: 0.05, unit: 'kg' } })] },
    })
    expect(updated.action.steps).toEqual([
      { ...FEED({ hopper1: 50 }), argUnits: { hopper1: 'kg' } },
    ])
    const again = await w.service.update({
      actionId: action.id,
      action: { steps: updated.action.steps },
    })
    expect(again.action.steps).toEqual(updated.action.steps)
    expect(again.warnings ?? []).toEqual([])
  })

  it('refuses a unit of another dimension with the invalid-steps code, storing nothing', async () => {
    const w = await world()
    await expect(
      w.service.create({
        action: { name: 'Meal', steps: [FEED({ grams: { value: 1, unit: 'L' } })] },
      }),
    ).rejects.toThrow(/\[invalid-steps\].*cross-dimension/)
    expect(await w.store.list()).toEqual([])
  })

  it('accepts a bare number as the declared unit, answers a warning and logs it with the deviceId tag', async () => {
    const w = await world()
    const { action, warnings } = await w.service.create({
      action: { name: 'Meal', steps: [FEED({ grams: 50 })] },
    })
    expect(action.steps).toEqual([FEED({ grams: 50 })])
    expect(warnings).toHaveLength(1)
    expect(warnings?.[0]).toMatchObject({
      field: 'grams',
      value: 50,
      assumedUnit: 'g',
      deviceId: 41,
    })
    const logged = w.log.lines.find((l) => l.level === 'warn' && l.message.includes('bare number'))
    expect(logged?.extras?.tags).toEqual({ deviceId: 41 })
    expect(logged?.extras?.meta).toMatchObject({ field: 'grams', value: 50, assumedUnit: 'g' })
  })
})

describe('actions — addon entries are read-only here', () => {
  it('refuses to update or delete an addon entry with a typed error', async () => {
    const w = await world({ addonActions: [addonEntry('ha:script.night')] })
    await expect(
      w.service.update({ actionId: 'ha:script.night', action: { name: 'x' } }),
    ).rejects.toThrow(/\[read-only\]/)
    await expect(w.service.delete({ actionId: 'ha:script.night' })).rejects.toThrow(/\[read-only\]/)
  })

  it('runs an addon entry through its source, with the entry addon and the variables', async () => {
    const w = await world({
      addonActions: [
        addonEntry('ha:script.night', {
          variables: [{ name: 'mode', type: 'select', options: ['a', 'b'], default: 'a' }],
        }),
      ],
    })
    const result = await w.service.run({
      actionId: 'ha:script.night',
      variables: { mode: 'b' },
      wait: true,
      caller: ADMIN,
    })
    expect(result.outcome).toBe('ran')
    expect(w.sourceRuns).toEqual([
      { addonId: 'ha', actionId: 'ha:script.night', variables: { mode: 'b' } },
    ])
    const { traces } = await w.service.getTraces({ actionId: 'ha:script.night' })
    expect(traces).toHaveLength(1)
  })

  it('lists internal and addon entries together, with the run status', async () => {
    const w = await world({ addonActions: [addonEntry('ha:script.night')] })
    const { action } = await w.service.create({ action: { name: 'One', steps: [STEP(1)] } })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    const list = await w.service.list()
    expect(list.map((e) => e.id).toSorted()).toEqual([action.id, 'ha:script.night'].toSorted())
    const internal = list.find((e) => e.id === action.id)
    expect(internal?.status.lastRunAt).not.toBeNull()
    expect(internal?.status.isRunning).toBe(false)
  })
})

describe('actions — camera links and who may run what', () => {
  async function linked() {
    const w = await world({ addonActions: [addonEntry('ha:script.night')] })
    const a = await w.service.create({ action: { name: 'Porch', steps: [STEP(1)] } })
    const b = await w.service.create({ action: { name: 'Garage', steps: [STEP(2)] } })
    await w.service.setLinks({ deviceId: 616, actionIds: [a.action.id] })
    return { w, porch: a.action, garage: b.action }
  }

  it('a scoped user can run an action linked to their camera', async () => {
    const { w, porch } = await linked()
    const result = await w.service.run({
      actionId: porch.id,
      deviceId: 616,
      wait: true,
      caller: VIEWER,
    })
    expect(result.outcome).toBe('ran')
    expect(w.calls).toHaveLength(1)
  })

  it('the same user is refused an action that is not linked to that camera, and it is logged', async () => {
    const { w, garage } = await linked()
    await expect(
      w.service.run({ actionId: garage.id, deviceId: 616, wait: true, caller: VIEWER }),
    ).rejects.toThrow(/\[not-linked\]/)
    expect(w.calls).toEqual([])
    const refusal = w.log.lines.find((l) => l.message.includes('refused'))
    expect(refusal?.level).toBe('warn')
    expect(refusal?.extras?.tags).toEqual({ deviceId: 616 })
  })

  it('a user who names no camera is refused', async () => {
    const { w, porch } = await linked()
    await expect(w.service.run({ actionId: porch.id, wait: true, caller: VIEWER })).rejects.toThrow(
      /\[not-linked\]/,
    )
    expect(w.calls).toEqual([])
  })

  it('an admin can run anything, linked or not, camera named or not', async () => {
    const { w, garage } = await linked()
    expect((await w.service.run({ actionId: garage.id, wait: true, caller: ADMIN })).outcome).toBe(
      'ran',
    )
    expect(
      (await w.service.run({ actionId: 'ha:script.night', wait: true, caller: ADMIN })).outcome,
    ).toBe('ran')
  })

  it('get follows the same rule', async () => {
    const { w, porch, garage } = await linked()
    expect(
      (await w.service.get({ actionId: porch.id, deviceId: 616, caller: VIEWER })).action?.id,
    ).toBe(porch.id)
    await expect(
      w.service.get({ actionId: garage.id, deviceId: 616, caller: VIEWER }),
    ).rejects.toThrow(/\[not-linked\]/)
    expect((await w.service.get({ actionId: garage.id, caller: ADMIN })).action?.id).toBe(garage.id)
  })

  it('listForCamera returns only the linked actions, with their variables', async () => {
    const w = await world()
    const a = await w.service.create({
      action: {
        name: 'Porch',
        steps: [STEP(1)],
        variables: [
          { name: 'mode', type: 'select', label: 'Mode', options: ['on', 'off'], default: 'on' },
        ],
      },
    })
    await w.service.create({ action: { name: 'Garage', steps: [STEP(2)] } })
    await w.service.setLinks({ deviceId: 616, actionIds: [a.action.id] })
    const list = await w.service.listForCamera({ deviceId: 616 })
    expect(list.map((e) => e.name)).toEqual(['Porch'])
    expect(list[0]?.variables).toEqual([
      { name: 'mode', type: 'select', label: 'Mode', options: ['on', 'off'], default: 'on' },
    ])
    expect(await w.service.listForCamera({ deviceId: 999 })).toEqual([])
  })

  it('deleting an action removes every camera link that names it, and keeps the others', async () => {
    const { w, porch, garage } = await linked()
    await w.service.setLinks({ deviceId: 617, actionIds: [porch.id, garage.id] })
    await w.service.delete({ actionId: porch.id })
    expect(await w.service.getLinks({ deviceId: 616 })).toEqual({ deviceId: 616, actionIds: [] })
    expect(await w.service.getLinks({ deviceId: 617 })).toEqual({
      deviceId: 617,
      actionIds: [garage.id],
    })
    expect(await w.service.listForCamera({ deviceId: 616 })).toEqual([])
  })

  it('an action an addon stopped declaring is hidden from the camera, its link kept', async () => {
    const w = await world({ addonActions: [] })
    await w.service.setLinks({ deviceId: 616, actionIds: ['ha:script.gone'] })
    expect(await w.service.listForCamera({ deviceId: 616 })).toEqual([])
    expect((await w.service.getLinks({ deviceId: 616 })).actionIds).toEqual(['ha:script.gone'])
  })

  it('a camera removed takes its links with it', async () => {
    const { w, porch } = await linked()
    await w.records.deleteDevice(616)
    expect(await w.service.getLinks({ deviceId: 616 })).toEqual({ deviceId: 616, actionIds: [] })
    expect(porch.id).toBeDefined()
  })
})

describe('runs ledger', () => {
  it('a delete removes the action and its ledger row', async () => {
    const w = await world()
    const { action } = await w.service.create({ action: { name: 'One', steps: [STEP(1)] } })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect((await w.ledger.get(actionOwner(action.id))).traces).toHaveLength(1)
    await w.service.delete({ actionId: action.id })
    expect((await w.ledger.get(actionOwner(action.id))).traces).toEqual([])
  })
})

describe('actions — D983 targets', () => {
  const DOMAIN_STEP = {
    kind: 'cap',
    actionId: 'cover.open',
    target: { kind: 'domain', roomId: 'Kitchen' },
    cap: 'cover',
    method: 'open',
  } as const

  function coverRegistry(seed: ReadonlyArray<{ id: number; location: string | null }>): {
    directory: DeviceDirectory
    add(id: number, location: string | null): void
  } {
    const devices = [...seed]
    return {
      add: (id, location) => void devices.push({ id, location }),
      directory: {
        listDeviceIdsByCaps: async (caps) =>
          caps.includes('cover') ? devices.map((d) => d.id) : [],
        listDevices: async (ids) =>
          devices
            .filter((d) => ids.includes(d.id))
            .map((d) => ({
              id: d.id,
              type: DeviceType.Generic,
              location: d.location,
              disabled: false,
            })),
      },
    }
  }

  it('runs a domain step on every device in the room, and on one added later after invalidation', async () => {
    const reg = coverRegistry([
      { id: 1, location: 'Kitchen' },
      { id: 2, location: 'Garage' },
    ])
    const w = await world({ directory: reg.directory })
    const { action } = await w.service.create({ action: { name: 'Open', steps: [DOMAIN_STEP] } })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls.map((c) => c.deviceId)).toEqual([1])

    reg.add(3, 'kitchen')
    w.service.invalidateTargets()
    w.calls.length = 0
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls.map((c) => c.deviceId).sort()).toEqual([1, 3])
  })

  it('an empty domain is logged with the action id and traced as empty, never silent', async () => {
    const w = await world({ directory: coverRegistry([{ id: 2, location: 'Garage' }]).directory })
    const { action } = await w.service.create({ action: { name: 'Open', steps: [DOMAIN_STEP] } })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls).toEqual([])
    const line = w.log.lines.find((l) => l.message.includes('resolved to no devices'))
    expect(line?.extras?.meta).toMatchObject({ actionId: 'cover.open', owner: action.id })
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces[0]?.steps[0]?.outcome).toBe('empty')
  })

  it('a stored legacy row is READ as the new shape and rewritten once by the migration', async () => {
    const w = await world()
    const kind = w.records.kind(coreBlocksRecordKinds.actions)
    await kind.put({
      id: 'legacy-1',
      data: {
        name: 'Legacy',
        steps: [
          { kind: 'cap', deviceId: [7, 9], cap: 'siren', method: 'on', args: { code: 'MARK-42' } },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    })
    const read = await w.store.get('internal:legacy-1')
    expect(read?.steps?.[0]).toMatchObject({
      target: { kind: 'devices', ids: [7, 9] },
      args: { code: 'MARK-42' },
    })
    expect(read?.steps?.[0]).not.toHaveProperty('deviceId')

    expect(await w.service.migrateTargets()).toBe(1)
    const stored = await kind.get('legacy-1')
    expect(stored?.data.steps[0]).toMatchObject({
      target: { kind: 'devices', ids: [7, 9] },
      args: { code: 'MARK-42' },
    })
    expect(stored?.data.steps[0]).not.toHaveProperty('deviceId')
    expect(await w.service.migrateTargets()).toBe(0)
  })
})
