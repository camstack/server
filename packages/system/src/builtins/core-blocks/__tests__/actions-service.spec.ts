import {
  ALL_CAPABILITY_DEFINITIONS,
  type BoundCapsReader,
  type ActionEntry,
  type ActionStep,
  type ActionRunChanged,
  type CapCall,
  type CapCaller,
  canonicalStoredStepTargets,
  commandOrigin,
  type DeviceDirectory,
  DeviceType,
  createRecordsAccess,
  IDLE_ACTION_STATUS,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { runWithCapCallContext } from '../../../kernel/cap-call-scope.js'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { ActionsService, type ActionSources } from '../actions-service.js'
import { ActionsStore } from '../actions-store.js'
import type { DeviceTemplateDoor } from '../device-template-door.js'
import type { StepConditionDoor } from '../step-condition-door.js'
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

/** A registry where every device id the specs use offers every cap, so the save check passes. */
const OFFERS_ALL: DeviceDirectory = {
  listDeviceIdsByCaps: async () => Array.from({ length: 2000 }, (_, id) => id),
  listDevices: async () => {
    throw new Error('the registry must not be listed by a devices target')
  },
}

/** Each device's own binding map: every device the specs name is bound to every cap. */
const BOUND_TO_ALL: BoundCapsReader = {
  boundCapsOf: async (ids) =>
    new Map(ids.map((id) => [id, ALL_CAPABILITY_DEFINITIONS.map((def) => def.name)])),
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
  readonly boundCaps?: BoundCapsReader
  readonly maxRunMs?: number
  readonly stopGraceMs?: number
  readonly templates?: DeviceTemplateDoor
  readonly conditions?: StepConditionDoor
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
    logger: log.logger,
    now: () => clock,
    newId: () => `a${(ids += 1)}`,
  })
  const ledger = new RunsLedger({
    runs: records.kind(coreBlocksRecordKinds.runs),
    logger: log.logger,
    now: () => clock,
  })
  const calls: CapCall[] = []
  const sourceRuns: Array<{
    addonId: string
    actionId: string
    variables: unknown
  }> = []
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
    directory: options?.directory ?? OFFERS_ALL,
    boundCaps: options?.boundCaps ?? BOUND_TO_ALL,
    invokeCap: async (call) => {
      calls.push(call)
      await options?.invoke?.(call)
    },
    emit: (event) => events.push(event),
    logger: log.logger,
    ...(options?.templates === undefined ? {} : { templates: options.templates }),
    ...(options?.conditions === undefined ? {} : { conditions: options.conditions }),
    now: () => (clock += 10),
    newRunId: () => `run-${(runs += 1)}`,
    ...(options?.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
    ...(options?.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
  })
  return {
    service,
    store,
    ledger,
    calls,
    sourceRuns,
    events,
    log,
    records,
    /** Writes a row straight to the engine, past the kind's schema: what an older version stored. */
    putRaw: async (id: string, data: Record<string, unknown>): Promise<void> => {
      await w
        .transportFor('core-blocks')
        .put({ kind: coreBlocksRecordKinds.actions.name, record: { id, data } })
    },
    advance: (ms: number): void => {
      clock += ms
    },
  }
}

const STEP = (deviceId: number): ActionStep => ({
  kind: 'command',
  target: { kind: 'devices', ids: [deviceId] },
  actionId: 'button.press',
})

describe('actions — internal actions', () => {
  it('runs the steps, substitutes variables, and writes a steps.N trace to the ledger', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: {
        name: 'Alarm',
        variables: [{ name: 'vol', type: 'number', default: 5 }],
        steps: [
          {
            kind: 'command',
            target: { kind: 'devices', ids: [616] },
            actionId: 'cover.position',
            args: { position: { $var: 'vol' } },
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
    // The run states why the device was asked (D1022): this action, this run.
    expect(w.calls).toEqual([
      {
        deviceId: 616,
        cap: 'cover',
        method: 'setPosition',
        args: { position: 9 },
        origin: { kind: 'action', actionId: action.id, runId: result.runId },
      },
    ])
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces).toHaveLength(1)
    expect(traces[0]?.steps.map((s) => s.path)).toEqual(['steps.0'])
    expect(traces[0]?.outcome).toBe('ran')
  })

  it('threads a rule fire from the call context onto every cap call (D705)', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: {
        name: 'Alarm',
        steps: [
          {
            kind: 'command',
            target: { kind: 'devices', ids: [1023] },
            actionId: 'alarm.trigger',
            args: {},
          },
          {
            kind: 'command',
            target: { kind: 'devices', ids: [44] },
            actionId: 'switch.on',
            args: {},
          },
        ],
      },
    })
    const fire = {
      ruleId: 'rule-night',
      ruleName: 'Night',
      deviceId: 12,
      sourceDeviceId: 44,
      recordId: 'rec-1',
      timestamp: 9,
    }
    const result = await runWithCapCallContext(commandOrigin({ kind: 'rule', fire }).context, () =>
      w.service.run({ actionId: action.id, wait: true, caller: ADMIN }),
    )
    expect(result.outcome).toBe('ran')
    expect(w.calls.map((call) => call.origin)).toEqual([
      { kind: 'action', actionId: action.id, runId: result.runId, ruleFire: fire },
      { kind: 'action', actionId: action.id, runId: result.runId, ruleFire: fire },
    ])
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
    const result = await w.service.run({
      actionId: action.id,
      wait: true,
      caller: ADMIN,
    })
    expect(result.outcome).toBe('failed')
    expect(w.calls.map((c) => c.deviceId)).toEqual([1, 2])
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces[0]?.steps.map((s) => s.outcome)).toEqual(['ok', 'error', 'not-run'])
    const logged = w.log.lines.find((l) => l.message.includes('step failed'))
    expect(logged?.extras?.tags).toEqual({ deviceId: 2 })
  })

  it('refuses a variable the action did not declare, before anything runs', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: { name: 'One', steps: [STEP(1)] },
    })
    await expect(
      w.service.run({
        actionId: action.id,
        variables: { typo: 1 },
        wait: true,
        caller: ADMIN,
      }),
    ).rejects.toThrow(/\[invalid-variables\]/)
    expect(w.calls).toEqual([])
  })

  it('a run started while the action is running is refused, traced and logged — never queued', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = await world({ invoke: () => gate })
    const { action } = await w.service.create({
      action: { name: 'Slow', steps: [STEP(1)] },
    })
    const first = await w.service.run({ actionId: action.id, caller: ADMIN })
    expect(first.outcome).toBe('started')
    const second = await w.service.run({
      actionId: action.id,
      wait: true,
      caller: ADMIN,
    })
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

  it('minDelaySec: a run that starts inside the window after the last start is skipped, traced and logged; after the window it runs', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: { name: 'Gate', steps: [STEP(1)], minDelaySec: 30 },
    })
    expect(action.minDelaySec).toBe(30)
    const first = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(first.outcome).toBe('ran')
    const second = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(second.outcome).toBe('skipped-cooldown')
    expect(w.calls).toHaveLength(1)
    expect(
      w.log.lines.some(
        (l) => l.message.includes('throttled') && l.extras?.meta?.['actionId'] === action.id,
      ),
    ).toBe(true)
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces.map((t) => t.outcome).toSorted()).toEqual(['ran', 'skipped-cooldown'])
    w.advance(31_000)
    const third = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(third.outcome).toBe('ran')
    expect(w.calls).toHaveLength(2)
  })

  it('an action without minDelaySec is never throttled, and update can clear the window with 0', async () => {
    const w = await world()
    const { action } = await w.service.create({ action: { name: 'Free', steps: [STEP(1)] } })
    expect((await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })).outcome).toBe(
      'ran',
    )
    expect((await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })).outcome).toBe(
      'ran',
    )
    const set = await w.service.update({ actionId: action.id, action: { minDelaySec: 60 } })
    expect(set.action.minDelaySec).toBe(60)
    const cleared = await w.service.update({ actionId: action.id, action: { minDelaySec: 0 } })
    expect(cleared.action.minDelaySec).toBeUndefined()
  })

  it('emits onRunChanged when a run starts and when it ends', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: { name: 'One', steps: [STEP(1)] },
    })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.events.map((e) => [e.isRunning, e.outcome])).toEqual([
      [true, undefined],
      [false, 'ran'],
    ])
  })
})

const FEED = (args: Record<string, unknown>, deviceId = 41): ActionStep => ({
  kind: 'command',
  target: { kind: 'devices', ids: [deviceId] },
  actionId: 'petFeeder.feed',
  args,
})

describe('actions — a number tied to a quantity (D972)', () => {
  it('converts a step arg entered in kilograms to the grams the method takes, keeping the picked unit', async () => {
    const w = await world()
    const { action, warnings } = await w.service.create({
      action: {
        name: 'Meal',
        steps: [FEED({ grams: { value: 0.1, unit: 'kg' } })],
      },
    })
    expect(action.steps).toEqual([{ ...FEED({ grams: 100 }), argUnits: { grams: 'kg' } }])
    expect(warnings ?? []).toEqual([])
    const stored = await w.store.get(action.id)
    expect(stored?.steps).toEqual(action.steps)
    const ran = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls).toEqual([
      {
        deviceId: 41,
        cap: 'pet-feeder',
        method: 'feed',
        args: { grams: 100 },
        origin: { kind: 'action', actionId: action.id, runId: ran.runId },
      },
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
        action: {
          name: 'Meal',
          steps: [FEED({ grams: { value: 1, unit: 'L' } })],
        },
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
    expect(logged?.extras?.meta).toMatchObject({
      field: 'grams',
      value: 50,
      assumedUnit: 'g',
    })
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
    const { traces } = await w.service.getTraces({
      actionId: 'ha:script.night',
    })
    expect(traces).toHaveLength(1)
  })

  it('lists internal and addon entries together, with the run status', async () => {
    const w = await world({ addonActions: [addonEntry('ha:script.night')] })
    const { action } = await w.service.create({
      action: { name: 'One', steps: [STEP(1)] },
    })
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
    const a = await w.service.create({
      action: { name: 'Porch', steps: [STEP(1)] },
    })
    const b = await w.service.create({
      action: { name: 'Garage', steps: [STEP(2)] },
    })
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
      w.service.run({
        actionId: garage.id,
        deviceId: 616,
        wait: true,
        caller: VIEWER,
      }),
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
      (
        await w.service.run({
          actionId: 'ha:script.night',
          wait: true,
          caller: ADMIN,
        })
      ).outcome,
    ).toBe('ran')
  })

  it('get follows the same rule', async () => {
    const { w, porch, garage } = await linked()
    expect(
      (
        await w.service.get({
          actionId: porch.id,
          deviceId: 616,
          caller: VIEWER,
        })
      ).action?.id,
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
          {
            name: 'mode',
            type: 'select',
            label: 'Mode',
            options: ['on', 'off'],
            default: 'on',
          },
        ],
      },
    })
    await w.service.create({ action: { name: 'Garage', steps: [STEP(2)] } })
    await w.service.setLinks({ deviceId: 616, actionIds: [a.action.id] })
    const list = await w.service.listForCamera({ deviceId: 616 })
    expect(list.map((e) => e.name)).toEqual(['Porch'])
    expect(list[0]?.variables).toEqual([
      {
        name: 'mode',
        type: 'select',
        label: 'Mode',
        options: ['on', 'off'],
        default: 'on',
      },
    ])
    expect(await w.service.listForCamera({ deviceId: 999 })).toEqual([])
  })

  it('deleting an action removes every camera link that names it, and keeps the others', async () => {
    const { w, porch, garage } = await linked()
    await w.service.setLinks({
      deviceId: 617,
      actionIds: [porch.id, garage.id],
    })
    await w.service.delete({ actionId: porch.id })
    expect(await w.service.getLinks({ deviceId: 616 })).toEqual({
      deviceId: 616,
      actionIds: [],
    })
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
    expect(await w.service.getLinks({ deviceId: 616 })).toEqual({
      deviceId: 616,
      actionIds: [],
    })
    expect(porch.id).toBeDefined()
  })
})

describe('runs ledger', () => {
  it('a delete removes the action and its ledger row', async () => {
    const w = await world()
    const { action } = await w.service.create({
      action: { name: 'One', steps: [STEP(1)] },
    })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect((await w.ledger.get(actionOwner(action.id))).traces).toHaveLength(1)
    await w.service.delete({ actionId: action.id })
    expect((await w.ledger.get(actionOwner(action.id))).traces).toEqual([])
  })
})

describe('actions — D983 targets', () => {
  const DOMAIN_STEP = {
    kind: 'command',
    target: { kind: 'domain', roomId: 'Kitchen' },
    actionId: 'cover.open',
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
    const { action } = await w.service.create({
      action: { name: 'Open', steps: [DOMAIN_STEP] },
    })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls.map((c) => c.deviceId)).toEqual([1])

    reg.add(3, 'kitchen')
    w.service.invalidateTargets()
    w.calls.length = 0
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls.map((c) => c.deviceId).sort()).toEqual([1, 3])
  })

  it('an empty domain is logged with the action id and traced as empty, never silent', async () => {
    const w = await world({
      directory: coverRegistry([{ id: 2, location: 'Garage' }]).directory,
    })
    const { action } = await w.service.create({
      action: { name: 'Open', steps: [DOMAIN_STEP] },
    })
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls).toEqual([])
    const line = w.log.lines.find((l) => l.message.includes('resolved to no devices'))
    expect(line?.extras?.meta).toMatchObject({
      actionId: 'cover.open',
      owner: action.id,
    })
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces[0]?.steps[0]?.outcome).toBe('empty')
  })
})

describe('actions — the run ceiling', () => {
  const WAIT_STEPS = (seconds: number): ActionStep[] => [{ kind: 'wait', seconds }]

  it('a waited run longer than the 60 s transport default ends with its real outcome', async () => {
    vi.useFakeTimers()
    try {
      const w = await world()
      const { action } = await w.service.create({
        action: { name: 'Long', steps: [...WAIT_STEPS(120), STEP(1)] },
      })
      const run = w.service.run({
        actionId: action.id,
        wait: true,
        caller: ADMIN,
      })
      await vi.advanceTimersByTimeAsync(121_000)
      await expect(run).resolves.toMatchObject({ outcome: 'ran' })
      expect(w.calls.map((c) => c.deviceId)).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a run past the ceiling is stopped, reported timed-out, never ran, and logged', async () => {
    const w = await world({ maxRunMs: 60 })
    // written past create's own check, as an action stored under an older ceiling would be
    const action = await w.store.create({
      name: 'Endless',
      steps: [STEP(1), ...WAIT_STEPS(30), STEP(2)],
    })
    const result = await w.service.run({
      actionId: action.id,
      wait: true,
      caller: ADMIN,
    })
    expect(result.outcome).toBe('timed-out')
    expect(result.message).toMatch(/limit/)
    expect(w.calls.map((c) => c.deviceId)).toEqual([1])
    const { traces } = await w.service.getTraces({ actionId: action.id })
    expect(traces[0]?.outcome).toBe('failed')
    const logged = w.log.lines.find((l) => l.message.includes('time limit'))
    expect(logged?.extras?.meta).toMatchObject({ actionId: action.id })
    // the action is free again: a second run is accepted, not refused as overlapping
    const again = await w.service.run({ actionId: action.id, caller: ADMIN })
    expect(again.outcome).toBe('started')
  })

  it('an addon run that ignores the stop is still answered once the grace has passed', async () => {
    const w = await world({
      addonActions: [addonEntry('ha:script')],
      maxRunMs: 30,
      stopGraceMs: 30,
      sourceRun: () => new Promise<void>(() => undefined),
    })
    const result = await w.service.run({
      actionId: 'ha:script',
      wait: true,
      caller: ADMIN,
    })
    expect(result.outcome).toBe('timed-out')
  })

  it('create refuses an action whose waits alone exceed the ceiling', async () => {
    const w = await world({ maxRunMs: 500_000 })
    await expect(
      w.service.create({
        action: {
          name: 'Too long',
          steps: [...WAIT_STEPS(300), ...WAIT_STEPS(300)],
        },
      }),
    ).rejects.toThrow(/\[invalid-steps\].*limit|\[invalid-steps\].*at most/)
    await expect(
      w.service.create({ action: { name: 'Fits', steps: WAIT_STEPS(300) } }),
    ).resolves.toBeDefined()
  })

  it('an action stored over the ceiling can still be renamed', async () => {
    const w = await world({ maxRunMs: 500_000 })
    const stored = await w.store.create({
      name: 'Old',
      steps: [...WAIT_STEPS(300), ...WAIT_STEPS(300)],
    })
    const { action } = await w.service.update({
      actionId: stored.id,
      action: { name: 'Renamed' },
    })
    expect(action.name).toBe('Renamed')
  })

  it('update refuses it too, and keeps the stored action', async () => {
    const w = await world({ maxRunMs: 500_000 })
    const { action } = await w.service.create({
      action: { name: 'Fits', steps: WAIT_STEPS(300) },
    })
    await expect(
      w.service.update({
        actionId: action.id,
        action: { steps: [...WAIT_STEPS(300), ...WAIT_STEPS(300)] },
      }),
    ).rejects.toThrow(/\[invalid-steps\]/)
    expect((await w.store.get(action.id))?.steps).toHaveLength(1)
  })
})

describe('actions — device templates in step args (D1021)', () => {
  /** A door over two devices: `stufa` is camera 616's, `garage` is 9. */
  function door() {
    const owners: Record<string, number> = { stufa: 616, garage: 9 }
    const renders: Array<{ templates: readonly string[]; allowed: readonly number[] | undefined }> =
      []
    const fake: DeviceTemplateDoor = {
      render: async (templates, allowed) => {
        renders.push({ templates, allowed })
        return templates.map((t) => ({
          ok: true as const,
          text: t.replace(
            /\{\{ (\w+)\.temp \}\}/,
            (_m, alias: string) => `${owners[alias] ?? '?'}C`,
          ),
          trace: [],
        }))
      },
      check: async (templates, allowed) =>
        templates.map((t) => {
          const alias = /\{\{ (\w+)\./.exec(t)?.[1] ?? ''
          const deviceId = owners[alias] ?? null
          return {
            ok: true as const,
            aliases: [
              {
                alias,
                deviceId,
                allowed: allowed === undefined || (deviceId !== null && allowed.includes(deviceId)),
              },
            ],
          }
        }),
    }
    return { fake, renders }
  }

  async function templated(templates: DeviceTemplateDoor, text: string) {
    const w = await world({ templates })
    const { action } = await w.service.create({
      action: {
        name: 'Say',
        steps: [
          {
            kind: 'command',
            target: { kind: 'devices', ids: [616] },
            actionId: 'cover.position',
            args: { position: text },
          },
        ],
      },
    })
    await w.service.setLinks({ deviceId: 616, actionIds: [action.id] })
    return { w, action }
  }

  it('an admin run renders the arg through the door before dispatch', async () => {
    const d = door()
    const { w, action } = await templated(d.fake, 'now {{ garage.temp }}')
    const result = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(result.outcome).toBe('ran')
    expect(w.calls[0]?.args).toEqual({ position: 'now 9C' })
    expect(d.renders[0]?.allowed).toBeUndefined()
  })

  it('a non-admin run is bound to the camera it came through', async () => {
    const d = door()
    const { w, action } = await templated(d.fake, 'now {{ stufa.temp }}')
    const result = await w.service.run({
      actionId: action.id,
      deviceId: 616,
      wait: true,
      caller: VIEWER,
    })
    expect(result.outcome).toBe('ran')
    expect(d.renders[0]?.allowed).toEqual([616])
  })

  it('a non-admin run is REFUSED, before anything runs, when a template names a device outside its camera', async () => {
    const d = door()
    const { w, action } = await templated(d.fake, 'now {{ garage.temp }}')
    await expect(
      w.service.run({ actionId: action.id, deviceId: 616, wait: true, caller: VIEWER }),
    ).rejects.toThrow(/\[template-scope\]/)
    expect(w.calls).toEqual([])
    expect(d.renders).toEqual([])
    const line = w.log.lines.find((l) => l.message.includes('template'))
    expect(line?.level).toBe('warn')
    expect(line?.extras?.tags).toEqual({ deviceId: 616 })
  })

  it('a render that is refused fails the run with the typed reason and sends nothing', async () => {
    const refusing: DeviceTemplateDoor = {
      render: async (templates) =>
        templates.map(() => ({
          ok: false as const,
          refusal: { reason: 'budget-exceeded' as const, message: 'too slow' },
          trace: [],
        })),
      check: async () => [],
    }
    const { w, action } = await templated(refusing, 'now {{ stufa.temp }}')
    const result = await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(result.outcome).toBe('failed')
    expect(result.message).toContain('[budget-exceeded]')
    expect(w.calls).toEqual([])
  })
})

describe('actions — a conditional step (#472)', () => {
  const IF = {
    kind: 'device-is',
    deviceId: 616,
    cap: 'switch',
    fieldPath: 'on',
    operator: 'eq',
    value: true,
  } as const
  const GUARDED: ActionStep = {
    kind: 'command',
    target: { kind: 'devices', ids: [616] },
    actionId: 'button.press',
    if: IF,
    else: [{ kind: 'command', target: { kind: 'devices', ids: [616] }, actionId: 'cover.stop' }],
  }

  /** A door whose verdict is fixed; it records the readable set it was built for. */
  function door(result: 'true' | 'false' | 'unknown') {
    const built: Array<readonly number[] | undefined> = []
    const fake: StepConditionDoor = (readable) => {
      built.push(readable)
      return async () => ({ result, reason: `fixed ${result}` })
    }
    return { fake, built }
  }

  async function guarded(conditions: StepConditionDoor | undefined) {
    const w = await world(conditions === undefined ? {} : { conditions })
    const { action } = await w.service.create({ action: { name: 'If', steps: [GUARDED] } })
    await w.service.setLinks({ deviceId: 616, actionIds: [action.id] })
    return { w, action }
  }

  it('true runs the step, false runs the else, unknown runs neither — and the trace says which', async () => {
    for (const [result, methods, outcome] of [
      ['true', ['press'], 'ok'],
      ['false', ['stop'], 'ok'],
      ['unknown', [], 'skipped'],
    ] as const) {
      const { w, action } = await guarded(door(result).fake)
      await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
      expect(w.calls.map((c) => c.method)).toEqual(methods)
      const { traces } = await w.service.getTraces({ actionId: action.id })
      expect(traces[0]?.steps[0]).toMatchObject({ condition: result, outcome })
    }
  })

  it('a service wired with no door reads every guard as unknown', async () => {
    const { w, action } = await guarded(undefined)
    await w.service.run({ actionId: action.id, wait: true, caller: ADMIN })
    expect(w.calls).toEqual([])
    const logged = w.log.lines.find(
      (l) => l.level === 'warn' && l.message.includes('condition could not be read'),
    )
    expect(logged?.extras?.tags).toEqual({ deviceId: 616 })
    expect(logged?.extras?.meta).toMatchObject({ actionId: action.id, step: 0 })
  })

  it('a non-admin run builds its evaluator bound to the camera it came through', async () => {
    const d = door('true')
    const { w, action } = await guarded(d.fake)
    await w.service.run({ actionId: action.id, deviceId: 616, wait: true, caller: VIEWER })
    expect(d.built).toEqual([[616]])
  })
})

describe('actions — a device must offer the action it is told to run', () => {
  /** Device 616's own bindings carry a button and a switch, never a cover. */
  const NO_COVER: BoundCapsReader = {
    boundCapsOf: async (ids) =>
      new Map(ids.map((id) => [id, id === 616 ? ['button', 'switch'] : []])),
  }
  const OPEN: ActionStep = {
    kind: 'command',
    target: { kind: 'devices', ids: [616] },
    actionId: 'cover.open',
  }

  it('refuses a create naming a device not bound to the action cap, stores nothing and logs the device', async () => {
    const w = await world({ boundCaps: NO_COVER })
    await expect(w.service.create({ action: { name: 'Open', steps: [OPEN] } })).rejects.toThrow(
      /\[invalid-steps\]/,
    )
    expect(await w.store.list()).toEqual([])
    expect(w.log.lines.some((l) => l.extras?.tags?.['deviceId'] === 616)).toBe(true)
  })

  it('refuses an update that brings the step in, and keeps the stored steps', async () => {
    const w = await world({ boundCaps: NO_COVER })
    const { action } = await w.service.create({ action: { name: 'Ring', steps: [STEP(616)] } })
    await expect(
      w.service.update({ actionId: action.id, action: { steps: [OPEN] } }),
    ).rejects.toThrow(/\[invalid-steps\]/)
    const kept = await w.service.get({ actionId: action.id, caller: ADMIN })
    expect(kept.action?.steps).toEqual([STEP(616)])
  })

  it('accepts the same step once the device offers the action', async () => {
    const w = await world()
    await expect(
      w.service.create({ action: { name: 'Open', steps: [OPEN] } }),
    ).resolves.toBeDefined()
  })
})

describe('actions — a row stored with a step shape this version no longer reads', () => {
  /** What an older version stored: a `cap` step, from before steps were stored by action id. */
  const LEGACY_BODY = {
    name: 'Feed the cat',
    steps: [
      {
        kind: 'cap',
        target: { kind: 'devices', ids: [616] },
        cap: 'pet-feeder',
        method: 'feed',
        args: {},
      },
    ],
    createdAt: 500,
    updatedAt: 500,
  }

  it('lists the other actions, skips the old row and logs its id and the reason', async () => {
    const w = await world()
    const { action: good } = await w.service.create({ action: { name: 'Porch', steps: [STEP(7)] } })
    await w.putRaw('legacy', LEGACY_BODY)

    const listed = await w.service.list()
    expect(listed.map((e) => e.id)).toEqual([good.id])
    expect((await w.service.get({ actionId: 'internal:legacy', caller: ADMIN })).action).toBeNull()

    const skipped = w.log.lines.filter((l) => l.message.startsWith('internal action skipped'))
    expect(skipped.length).toBeGreaterThan(0)
    expect(skipped[0]?.extras?.meta?.['actionId']).toBe('internal:legacy')
    expect(String(skipped[0]?.extras?.meta?.['reason'])).toContain('steps.0')
  })

  it('is overwritten by a save with a name and command steps, under the same id', async () => {
    const w = await world()
    await w.putRaw('legacy', LEGACY_BODY)

    const { action } = await w.service.update({
      actionId: 'internal:legacy',
      action: { name: 'Feed the cat', steps: [STEP(616)] },
    })

    expect(action.id).toBe('internal:legacy')
    const listed = await w.service.list()
    expect(listed.map((e) => [e.id, e.steps])).toEqual([['internal:legacy', [STEP(616)]]])
  })

  it('refuses a partial patch of the old row, and a missing id is still not found', async () => {
    const w = await world()
    await w.putRaw('legacy', LEGACY_BODY)

    await expect(
      w.service.update({ actionId: 'internal:legacy', action: { name: 'Renamed' } }),
    ).rejects.toThrow(/invalid-steps/)
    await expect(
      w.service.update({ actionId: 'internal:nope', action: { name: 'x', steps: [STEP(1)] } }),
    ).rejects.toThrow(/not-found/)
  })
})

describe('actions — a row stored with a device type D1033 retired', () => {
  // `thermostat` was retired into `climate`. The step schema stays strict on the
  // wire; the store reads the old row back with the canonical type instead of
  // dropping the operator's action.
  const domainStep = (deviceType: string): Record<string, unknown> => ({
    kind: 'command',
    target: { kind: 'domain', deviceType },
    actionId: 'climate.heat',
  })

  it('lists the action with its domain target read as climate', async () => {
    const w = await world()
    await w.putRaw('warm', {
      name: 'Warm up',
      steps: [domainStep('thermostat')],
      createdAt: 500,
      updatedAt: 500,
    })

    const listed = await w.service.list()
    expect(listed.map((e) => [e.id, e.steps])).toEqual([
      ['internal:warm', [domainStep(DeviceType.Climate)]],
    ])
  })

  it('reads the retired type inside an else list too', () => {
    const steps = [{ ...domainStep('thermostat'), else: [domainStep('thermostat')] }]
    expect(canonicalStoredStepTargets(steps)).toEqual([
      { ...domainStep(DeviceType.Climate), else: [domainStep(DeviceType.Climate)] },
    ])
  })
})
