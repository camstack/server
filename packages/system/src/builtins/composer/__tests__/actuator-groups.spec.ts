import {
  APPLIANCE_DEFAULTS,
  DeviceFeature,
  type ApplianceHelperSpec,
  type GroupCommandResult,
  type GroupHelperSpec,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { actuatorDispatcher, type ActuatorDispatchInput } from '../actuator-dispatch.js'
import {
  ActuatorGroups,
  type ActuatorGroupDevice,
  type ActuatorMemberLookup,
} from '../actuator-groups.js'
import { recordingLogger } from './fixtures.js'

const IDS: Readonly<Record<string, number>> = { a: 1, b: 2, c: 3 }

function appliance(kind: ApplianceHelperSpec['appliance']): ApplianceHelperSpec {
  const defaults = APPLIANCE_DEFAULTS[kind]
  return {
    kind: 'appliance',
    templateId: 'appliance',
    appliance: kind,
    thresholdWatts: defaults.thresholdWatts,
    startDwellMs: defaults.startDwellMs,
    stopDwellMs: defaults.stopDwellMs,
    member: {
      source: { addonId: 'lights', stableId: 'a' },
      cap: 'power-meter',
      fieldPath: 'power',
    },
  }
}

function spec(templateId: 'switch' | 'light', stableIds: readonly string[]): GroupHelperSpec {
  return {
    kind: 'group',
    templateId,
    aggregate: 'any',
    active: 'at-least-one',
    members: stableIds.map((stableId) => ({
      source: { addonId: 'lights', stableId },
      cap: 'switch',
      fieldPath: 'on',
    })),
  }
}

class FakeGroup implements ActuatorGroupDevice {
  shared: readonly string[] = []
  modes: readonly DeviceFeature[] = []
  recorded: readonly GroupCommandResult[] = []

  constructor(readonly id: number) {}

  syncShared(caps: readonly string[], modes: readonly DeviceFeature[]): void {
    this.shared = [...caps]
    this.modes = [...modes]
  }

  recordCommands(results: readonly GroupCommandResult[]): void {
    this.recorded = results.map((row) => ({ ...row }))
  }
}

function harness(capsOf: (deviceId: number) => ActuatorMemberLookup): {
  readonly group: FakeGroup
  readonly groups: ActuatorGroups
  readonly calls: {
    readonly deviceId: number
    readonly cap: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
  }[]
  readonly lines: ReturnType<typeof recordingLogger>['lines']
} {
  const group = new FakeGroup(900)
  const calls: {
    deviceId: number
    cap: string
    method: string
    args: Readonly<Record<string, unknown>>
  }[] = []
  const recorded = recordingLogger()
  const groups = new ActuatorGroups({
    logger: recorded.logger,
    now: () => 1_700_000_000_000,
    resolve: (ref) => {
      const deviceId = IDS[ref.stableId]
      return deviceId === undefined ? { kind: 'other' } : { kind: 'found', deviceId }
    },
    readMember: async (deviceId) => capsOf(deviceId),
    deviceOf: () => group,
    invoke: async (call) => {
      calls.push({ deviceId: call.deviceId, cap: call.cap, method: call.method, args: call.args })
      if (call.deviceId === 2 && call.cap === 'switch') throw new Error('member 2 refused')
      if (call.deviceId === 2 && call.cap === 'cover') throw new Error('shutter 2 is stuck')
    },
  })
  return { group, groups, calls, lines: recorded.lines }
}

describe('actuator groups', () => {
  it('commands every member that binds the cap and keeps going when one throws', async () => {
    const world = harness((deviceId) => ({
      kind: 'ready',
      caps: deviceId === 3 ? ['brightness'] : ['switch', 'brightness'],
      features: [],
    }))
    await world.groups.sync([{ id: 'porch', helper: spec('switch', ['a', 'b', 'c']) }])
    const run = actuatorDispatcher()
    if (run === null) throw new Error('dispatcher was not attached')
    await run({ groupDeviceId: 900, cap: 'switch', method: 'setState', args: { on: true } })
    expect(world.calls.map((call) => call.deviceId)).toEqual([1, 2])
    expect(world.group.recorded.map((row) => ({ deviceId: row.deviceId, ok: row.ok }))).toEqual([
      { deviceId: 1, ok: true },
      { deviceId: 2, ok: false },
    ])
    const memberLine = world.lines.find((line) => line.extras?.tags?.deviceId === 2)
    expect(memberLine?.message).toContain('failed on a member')
    world.groups.shutdown()
  })

  it('drops colour from a light group when a new member does not bind it', async () => {
    const caps = new Map<number, readonly string[]>([
      [1, ['switch', 'brightness', 'color']],
      [2, ['switch', 'brightness', 'color']],
      [3, ['switch', 'brightness']],
    ])
    const world = harness((deviceId) => ({
      kind: 'ready',
      caps: caps.get(deviceId) ?? [],
      features:
        deviceId === 3
          ? [DeviceFeature.LightColorMired]
          : [DeviceFeature.LightColorRgb, DeviceFeature.LightColorMired],
    }))
    await world.groups.sync([{ id: 'porch', helper: spec('light', ['a', 'b']) }])
    expect(world.group.shared).toEqual(['switch', 'brightness', 'color'])
    expect(world.group.modes).toEqual([DeviceFeature.LightColorRgb, DeviceFeature.LightColorMired])
    await world.groups.sync([{ id: 'porch', helper: spec('light', ['a', 'b', 'c']) }])
    expect(world.group.shared).toEqual(['switch', 'brightness'])
    expect(world.group.modes).toEqual([])
    const memberLine = world.lines.find((line) => line.extras?.tags?.deviceId === 3)
    expect(memberLine?.extras?.meta?.groupDeviceId).toBe(900)
    expect(memberLine?.extras?.meta?.cap).toBe('color')
    const groupLine = world.lines.find((line) => line.extras?.tags?.deviceId === 900)
    expect(groupLine?.message).toContain('dropped a capability')
    const run = actuatorDispatcher()
    if (run === null) throw new Error('dispatcher was not attached')
    await expect(
      run({
        groupDeviceId: 900,
        cap: 'color',
        method: 'setColor',
        args: { color: { mode: 'mired', mired: 250 } },
      }),
    ).rejects.toThrow(/does not share color/)
    expect(world.calls).toEqual([])
    world.groups.shutdown()
  })

  it('does not treat an appliance helper as a command group', async () => {
    const world = harness(() => ({ kind: 'ready', caps: ['switch'], features: [] }))
    await world.groups.sync([{ id: 'washer', helper: appliance('washer') }])
    expect(world.group.shared).toEqual([])
    const run = actuatorDispatcher()
    if (run === null) throw new Error('dispatcher was not attached')
    await expect(
      run({ groupDeviceId: 900, cap: 'switch', method: 'setState', args: { on: true } }),
    ).rejects.toThrow(/not live/)
    expect(world.calls).toEqual([])
    const dropped = world.lines.find((line) => line.message.includes('not a live helper group'))
    expect(dropped?.extras?.tags?.deviceId).toBe(900)
    world.groups.shutdown()
  })
})

function typed(
  templateId: GroupHelperSpec['templateId'],
  cap: string,
  fieldPath: string,
  stableIds: readonly string[],
): GroupHelperSpec {
  return {
    kind: 'group',
    templateId,
    aggregate: 'any',
    active: 'at-least-one',
    members: stableIds.map((stableId) => ({
      source: { addonId: 'shutters', stableId },
      cap,
      fieldPath,
    })),
  }
}

async function dispatch(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
): Promise<void> {
  const run = actuatorDispatcher()
  if (run === null) throw new Error('dispatcher was not attached')
  await run({ groupDeviceId: 900, cap, method, args })
}

describe('actuator groups beyond switch and light', () => {
  it('a cover group commands every shutter and keeps one result per shutter', async () => {
    const world = harness(() => ({
      kind: 'ready',
      caps: ['cover'],
      features: [DeviceFeature.CoverPositionable],
    }))
    await world.groups.sync([
      { id: 'south', helper: typed('cover', 'cover', 'state', ['a', 'b', 'c']) },
    ])
    expect(world.group.shared).toEqual(['cover'])
    expect(world.group.modes).toEqual([DeviceFeature.CoverPositionable])
    await dispatch('cover', 'setPosition', { position: 40 })
    expect(world.calls.map((call) => [call.deviceId, call.method, call.args])).toEqual([
      [1, 'setPosition', { position: 40 }],
      [2, 'setPosition', { position: 40 }],
      [3, 'setPosition', { position: 40 }],
    ])
    await dispatch('cover', 'open', {})
    expect(world.group.recorded.map((row) => [row.deviceId, row.method, row.ok])).toEqual([
      [1, 'open', true],
      [2, 'open', false],
      [3, 'open', true],
    ])
    expect(world.group.recorded[1]?.error).toBe('shutter 2 is stuck')
    world.groups.shutdown()
  })

  it('refuses a method a member cannot take, without calling anyone', async () => {
    const world = harness((deviceId) => ({
      kind: 'ready',
      caps: ['cover'],
      features: deviceId === 3 ? [] : [DeviceFeature.CoverPositionable],
    }))
    await world.groups.sync([
      { id: 'south', helper: typed('cover', 'cover', 'state', ['a', 'b', 'c']) },
    ])
    expect(world.group.modes).toEqual([])
    await expect(dispatch('cover', 'setPosition', { position: 40 })).rejects.toThrow(
      /does not share cover.setPosition/,
    )
    await expect(dispatch('cover', 'explode', {})).rejects.toThrow(/does not share cover.explode/)
    expect(world.calls).toEqual([])
    const line = world.lines.find((item) => item.extras?.tags?.deviceId === 900)
    expect(line?.message).toContain('does not share')
    world.groups.shutdown()
  })

  it('a fan group offers speed only when every fan has it, and recomputes on a bindings change', async () => {
    const caps = new Map<number, readonly string[]>([
      [1, ['switch', 'fan-control']],
      [2, ['switch', 'fan-control']],
    ])
    const world = harness((deviceId) => ({
      kind: 'ready',
      caps: caps.get(deviceId) ?? [],
      features: [DeviceFeature.FanSpeed],
    }))
    await world.groups.sync([{ id: 'attic', helper: typed('fan', 'switch', 'on', ['a', 'b']) }])
    expect(world.group.shared).toEqual(['switch', 'fan-control'])
    caps.set(2, ['switch'])
    await world.groups.onMemberBindings(2)
    expect(world.group.shared).toEqual(['switch'])
    await expect(dispatch('fan-control', 'setPercentage', { speed: 50 })).rejects.toThrow(
      /does not share fan-control/,
    )
    await dispatch('switch', 'setState', { on: true })
    expect(world.calls.map((call) => call.deviceId)).toEqual([1, 2])
    world.groups.shutdown()
  })

  describe('lock group safety', () => {
    async function lockWorld() {
      const world = harness(() => ({ kind: 'ready', caps: ['lock-control'], features: [] }))
      await world.groups.sync([
        { id: 'doors', helper: typed('lock', 'lock-control', 'state', ['a', 'b']) },
      ])
      return world
    }

    it('never fans out an unlock that was not confirmed, and records nothing', async () => {
      const world = await lockWorld()
      await expect(dispatch('lock-control', 'unlock', {})).rejects.toThrow(/confirmation/)
      await expect(dispatch('lock-control', 'unlock', { confirm: false })).rejects.toThrow(
        /confirmation/,
      )
      expect(world.calls).toEqual([])
      expect(world.group.recorded).toEqual([])
      const refused = world.lines.find((line) => line.message.includes('unlock was refused'))
      expect(refused?.extras?.tags?.deviceId).toBe(900)
      world.groups.shutdown()
    })

    it('fans out a confirmed unlock without handing the confirmation to the locks', async () => {
      const world = await lockWorld()
      await dispatch('lock-control', 'unlock', { confirm: true, code: '0000' })
      expect(world.calls.map((call) => [call.deviceId, call.method, call.args])).toEqual([
        [1, 'unlock', { code: '0000' }],
        [2, 'unlock', { code: '0000' }],
      ])
      world.groups.shutdown()
    })

    it('locks without a confirmation', async () => {
      const world = await lockWorld()
      await dispatch('lock-control', 'lock', {})
      expect(world.calls.map((call) => [call.deviceId, call.method])).toEqual([
        [1, 'lock'],
        [2, 'lock'],
      ])
      world.groups.shutdown()
    })

    it('does not offer open, which latches a door outside the table', async () => {
      const world = await lockWorld()
      await expect(dispatch('lock-control', 'open', {})).rejects.toThrow(/does not share/)
      expect(world.calls).toEqual([])
      world.groups.shutdown()
    })
  })
})

describe('actuator groups — forwards of a built cap (D967)', () => {
  function forwardWorld() {
    const handled: ActuatorDispatchInput[] = []
    const recorded = recordingLogger()
    const groups = new ActuatorGroups({
      logger: recorded.logger,
      now: () => 1,
      resolve: () => ({ kind: 'other' }),
      readMember: async () => ({ kind: 'unreadable', error: 'unused' }),
      deviceOf: () => null,
      invoke: async () => {
        throw new Error('a forward must not fan out')
      },
      forwards: {
        serves: (id) => id === 321,
        command: async (input) => {
          handled.push(input)
        },
      },
    })
    return { groups, handled }
  }

  it('hands a command of a forward-commanded device to the forwards, not to a group', async () => {
    const { groups, handled } = forwardWorld()
    const run = actuatorDispatcher()
    if (run === null) throw new Error('dispatcher was not attached')
    await run({ groupDeviceId: 321, cap: 'pump', method: 'setPump', args: { on: true } })
    expect(handled).toEqual([
      { groupDeviceId: 321, cap: 'pump', method: 'setPump', args: { on: true } },
    ])
    groups.shutdown()
  })

  it('a device the forwards do not serve still needs a live group', async () => {
    const { groups, handled } = forwardWorld()
    const run = actuatorDispatcher()
    if (run === null) throw new Error('dispatcher was not attached')
    await expect(
      run({ groupDeviceId: 5, cap: 'switch', method: 'setState', args: { on: true } }),
    ).rejects.toThrow('actuator group is not live')
    expect(handled).toEqual([])
    groups.shutdown()
  })
})
