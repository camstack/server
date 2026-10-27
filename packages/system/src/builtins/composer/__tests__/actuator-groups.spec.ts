import {
  APPLIANCE_DEFAULTS,
  DeviceFeature,
  type ApplianceHelperSpec,
  type GroupCommandResult,
  type GroupHelperSpec,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { actuatorDispatcher } from '../actuator-dispatch.js'
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
      fieldPath: 'watts',
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
  readonly calls: { readonly deviceId: number; readonly cap: string }[]
  readonly lines: ReturnType<typeof recordingLogger>['lines']
} {
  const group = new FakeGroup(900)
  const calls: { deviceId: number; cap: string }[] = []
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
      calls.push({ deviceId: call.deviceId, cap: call.cap })
      if (call.deviceId === 2 && call.cap === 'switch') throw new Error('member 2 refused')
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
