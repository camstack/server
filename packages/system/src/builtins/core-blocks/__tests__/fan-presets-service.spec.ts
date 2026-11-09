import {
  type ActionStep,
  type CapCall,
  type ControlStatus,
  DeviceType,
  type FanControlStatus,
  type FanPreset,
  type SwitchStatus,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { DeviceTemplateDoor } from '../device-template-door.js'
import type { StepConditionDoor } from '../step-condition-door.js'
import { FanPresetActionSource } from '../fan-presets-action-source.js'
import { FanPresetsService, type FanPresetsServiceDeps } from '../fan-presets-service.js'
import { recordingLogger } from './fixtures.js'

const FAN = 10
const LIGHT = 11
const SPEED = 12
const OTHER_ROOM = 99
const CONTAINER = 5

function cap(deviceId: number, capName: string, method: string, args: object): ActionStep {
  return {
    kind: 'cap',
    target: { kind: 'devices', ids: [deviceId] },
    cap: capName,
    method,
    args: { ...args },
  }
}

const night: FanPreset = {
  id: 'night',
  name: 'Night',
  steps: [
    cap(FAN, 'fan-control', 'setPercentage', { speed: 25 }),
    cap(LIGHT, 'switch', 'setState', { on: false }),
  ],
}

function fanStatus(patch: Partial<FanControlStatus> = {}): FanControlStatus {
  return {
    speed: 50,
    preset: '',
    availablePresets: [],
    direction: 'forward',
    oscillating: true,
    lastChangedAt: 1,
    ...patch,
  }
}

interface WorldOptions {
  readonly failOn?: number
  readonly fan?: FanControlStatus | null
  readonly controls?: Readonly<Record<number, ControlStatus | null>>
  readonly switches?: Readonly<Record<number, SwitchStatus | null>>
  readonly initial?: readonly FanPreset[]
  readonly fanParent?: number | null
  /** Facts for the container siblings; any id not listed is a switch named `dev <id>`. */
  readonly siblings?: Readonly<Record<number, { name: string; type: DeviceType }>>
  readonly children?: readonly number[]
  readonly templates?: DeviceTemplateDoor
  readonly conditions?: StepConditionDoor
}

function world(options: WorldOptions = {}) {
  let stored: readonly FanPreset[] = options.initial ?? []
  const calls: CapCall[] = []
  const lines = recordingLogger()
  const deps: FanPresetsServiceDeps = {
    store: {
      read: async () => stored,
      write: async (_id, next) => {
        stored = next
      },
      listAll: async () => new Map([[FAN, stored]]),
    },
    devices: {
      describe: async (id) =>
        id === FAN
          ? {
              name: 'Ceiling fan',
              type: DeviceType.Fan,
              parentDeviceId: options.fanParent ?? CONTAINER,
            }
          : {
              name: options.siblings?.[id]?.name ?? `dev ${id}`,
              type: options.siblings?.[id]?.type ?? DeviceType.Switch,
              parentDeviceId: CONTAINER,
            },
      childrenOf: async (parent) =>
        parent === CONTAINER ? [FAN, ...(options.children ?? [LIGHT, SPEED])] : [FAN],
    },
    readings: {
      fan: async () => (options.fan === undefined ? fanStatus() : options.fan),
      control: async (id) => options.controls?.[id] ?? null,
      switchState: async (id) => options.switches?.[id] ?? null,
    },
    invoke: async (call) => {
      calls.push(call)
      if (options.failOn !== undefined && calls.length === options.failOn) {
        throw new Error('light unreachable')
      }
    },
    logger: lines.logger,
    ...(options.templates === undefined ? {} : { templates: options.templates }),
    ...(options.conditions === undefined ? {} : { conditions: options.conditions }),
  }
  return {
    service: new FanPresetsService(deps),
    calls,
    stored: () => stored,
    lines: lines.lines,
    deps,
  }
}

describe('FanPresetsService store', () => {
  it('round-trips presets through the device store', async () => {
    const w = world()
    expect(await w.service.getPresets({ deviceId: FAN })).toEqual([])
    expect(await w.service.setPresets({ deviceId: FAN, presets: [night] })).toEqual({
      status: 'saved',
      count: 1,
    })
    expect(await w.service.getPresets({ deviceId: FAN })).toEqual([night])
  })

  it('refuses a step on a device outside the fan container, naming preset and step', async () => {
    const w = world()
    const bad: FanPreset = {
      id: 'bad',
      name: 'Bad',
      steps: [
        cap(FAN, 'fan-control', 'setPercentage', { speed: 10 }),
        cap(OTHER_ROOM, 'switch', 'setState', { on: true }),
      ],
    }
    const result = await w.service.setPresets({ deviceId: FAN, presets: [bad] })
    expect(result).toMatchObject({ status: 'refused', reason: 'not-sibling' })
    expect(result.status === 'refused' ? result.detail : '').toContain('Bad')
    expect(result.status === 'refused' ? result.detail : '').toContain('step 1')
    expect(w.stored()).toEqual([])
  })

  it('refuses a domain target and duplicate names', async () => {
    const w = world()
    const domain: FanPreset = {
      id: 'd',
      name: 'D',
      steps: [
        {
          kind: 'cap',
          target: { kind: 'domain' },
          actionId: 'switch.turnOff',
          cap: 'switch',
          method: 'setState',
          args: { on: false },
        },
      ],
    }
    expect(await w.service.setPresets({ deviceId: FAN, presets: [domain] })).toMatchObject({
      reason: 'bad-target',
    })
    const dup = [night, { ...night, id: 'night2', name: ' night ' }]
    expect(await w.service.setPresets({ deviceId: FAN, presets: dup })).toMatchObject({
      reason: 'duplicate-name',
    })
  })
})

describe('FanPresetsService.applyPreset', () => {
  it('runs every step in order and reports applied', async () => {
    const w = world({ initial: [night] })
    const result = await w.service.applyPreset({ deviceId: FAN, presetId: 'night' })
    expect(result.status).toBe('applied')
    expect(result.steps.map((s) => s.outcome)).toEqual(['applied', 'applied'])
    expect(w.calls.map((c) => [c.deviceId, c.cap, c.method])).toEqual([
      [FAN, 'fan-control', 'setPercentage'],
      [LIGHT, 'switch', 'setState'],
    ])
  })

  it('reports partial and names the failed step when a later step throws', async () => {
    const w = world({ initial: [night], failOn: 2 })
    const result = await w.service.applyPreset({ deviceId: FAN, presetId: 'night' })
    expect(result.status).toBe('partial')
    expect(result.steps[0]).toMatchObject({ index: 0, outcome: 'applied' })
    expect(result.steps[1]).toMatchObject({
      index: 1,
      outcome: 'failed',
      deviceId: LIGHT,
      message: expect.stringContaining('light unreachable'),
    })
    const warn = w.lines.find((l) => l.level === 'warn')
    expect(warn?.extras?.tags).toEqual({ deviceId: LIGHT })
  })

  it('refuses without running anything when a stored step is no longer a sibling', async () => {
    const stale: FanPreset = {
      id: 'stale',
      name: 'Stale',
      steps: [
        cap(FAN, 'fan-control', 'setPercentage', { speed: 10 }),
        cap(OTHER_ROOM, 'switch', 'setState', { on: true }),
      ],
    }
    const w = world({ initial: [stale] })
    const result = await w.service.applyPreset({ deviceId: FAN, presetId: 'stale' })
    expect(result.status).toBe('refused')
    expect(result.steps[1]).toMatchObject({
      outcome: 'refused',
      message: expect.stringContaining('[not-sibling]'),
    })
    expect(result.steps[0]?.outcome).toBe('not-run')
    expect(w.calls).toEqual([])
  })

  it('refuses an unknown preset', async () => {
    const w = world({ initial: [night] })
    const result = await w.service.applyPreset({ deviceId: FAN, presetId: 'nope' })
    expect(result.status).toBe('refused')
    expect(result.steps).toEqual([])
  })
})

describe('FanPresetsService.capturePreset', () => {
  const sibling: ActionStep[] = [
    cap(SPEED, 'control', 'setValue', { control: { kind: 'numeric', value: 0 } }),
    cap(LIGHT, 'switch', 'setState', { on: true }),
  ]

  it('captures the known values of the fan and of the sibling steps', async () => {
    const w = world({
      fan: fanStatus({ speed: 40, oscillating: false, direction: 'reverse', preset: 'eco' }),
      controls: {
        [SPEED]: { kind: 'numeric', value: 7, options: [], lastChangedAt: 1 },
      },
      switches: { [LIGHT]: { on: false, lastChangedAt: 1 } },
    })
    const result = await w.service.capturePreset({ deviceId: FAN, steps: sibling })
    expect(result.omitted).toEqual([])
    expect(
      result.steps.map((s) => (s.kind === 'cap' ? [s.cap, s.method, s.args] : s.kind)),
    ).toEqual([
      ['fan-control', 'setOscillating', { oscillating: false }],
      ['control', 'setValue', { control: { kind: 'numeric', value: 7 } }],
      ['switch', 'setState', { on: false }],
      ['fan-control', 'setDirection', { direction: 'reverse' }],
      ['fan-control', 'setPreset', { preset: 'eco' }],
      ['fan-control', 'setPercentage', { speed: 40 }],
    ])
  })

  it('leaves an unknown reading out and names it, never storing 0', async () => {
    const w = world({
      fan: fanStatus({ speed: null, oscillating: null, direction: null, preset: '' }),
      controls: {},
      switches: { [LIGHT]: { on: true, lastChangedAt: 1 } },
    })
    const result = await w.service.capturePreset({ deviceId: FAN, steps: sibling })
    expect(result.omitted.map((o) => o.what)).toEqual([
      'speed',
      'oscillating',
      'direction',
      'preset',
      'step 0',
    ])
    expect(JSON.stringify(result.steps)).not.toContain('"speed":0')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ cap: 'switch', args: { on: true } })
  })

  it('names every fan field when the fan reading itself is unavailable', async () => {
    const w = world({ fan: null, children: [] })
    const result = await w.service.capturePreset({ deviceId: FAN, fields: ['speed'], steps: [] })
    expect(result.steps).toEqual([])
    expect(result.omitted).toEqual([{ what: 'speed', reason: expect.any(String) }])
  })

  describe('without explicit steps: every settable sibling', () => {
    const H_ANGLE = 201
    const H_LEFT = 202
    const H_SWITCH = 203
    const V_SWITCH = 204
    const V_TOP = 205
    const PRESET_3D = 206
    const PLAIN_SENSOR = 207
    const num = (value: number): ControlStatus => ({
      kind: 'numeric',
      value,
      options: [],
      lastChangedAt: 1,
    })
    const dreo = {
      children: [H_ANGLE, H_LEFT, H_SWITCH, V_SWITCH, V_TOP, PRESET_3D, PLAIN_SENSOR],
      siblings: {
        [H_ANGLE]: { name: 'Angolo orizzontale', type: DeviceType.Control },
        [H_LEFT]: { name: 'Angolo oscillazione orizzontale sinistra', type: DeviceType.Control },
        [H_SWITCH]: { name: 'Oscillazione orizzontale', type: DeviceType.Switch },
        [V_SWITCH]: { name: 'Oscillazione verticale', type: DeviceType.Switch },
        [V_TOP]: { name: 'Angolo oscillazione verticale alto', type: DeviceType.Control },
        [PRESET_3D]: { name: 'Preset angolo 3D', type: DeviceType.Control },
        [PLAIN_SENSOR]: { name: 'Temperature', type: DeviceType.Sensor },
      },
      controls: {
        [H_ANGLE]: num(90),
        [H_LEFT]: num(30),
        [V_TOP]: num(60),
        [PRESET_3D]: num(2),
      },
      switches: {
        [H_SWITCH]: { on: true, lastChangedAt: 1 },
        [V_SWITCH]: { on: false, lastChangedAt: 1 },
      },
    } as const

    it('proposes bounds, oscillation, fixed angles, fan fields, speed last', async () => {
      const w = world({ ...dreo, fan: fanStatus({ speed: 40, oscillating: null }) })
      const result = await w.service.capturePreset({ deviceId: FAN, steps: [] })
      expect(result.items.map((i) => [i.group, i.label])).toEqual([
        ['angles', 'Angolo oscillazione orizzontale sinistra'],
        ['angles', 'Angolo oscillazione verticale alto'],
        ['oscillation', 'Oscillazione orizzontale'],
        ['oscillation', 'Oscillazione verticale'],
        ['angles', 'Angolo orizzontale'],
        ['angles', 'Preset angolo 3D'],
        ['fan', 'direction'],
        ['fan', 'speed'],
      ])
      expect(result.steps).toHaveLength(result.items.length)
      expect(result.steps[0]).toMatchObject({
        cap: 'control',
        target: { ids: [H_LEFT] },
        args: { control: { kind: 'numeric', value: 30 } },
      })
      expect(result.steps[2]).toMatchObject({
        cap: 'switch',
        target: { ids: [H_SWITCH] },
        args: { on: true },
      })
      expect(result.omitted.map((o) => o.what)).toEqual(['oscillating', 'preset'])
    })

    it('omits and names an unreadable sibling, and skips devices that are neither switch nor control', async () => {
      const w = world({
        ...dreo,
        controls: { [H_ANGLE]: num(90) },
        fan: fanStatus({ speed: 40 }),
      })
      const result = await w.service.capturePreset({ deviceId: FAN, steps: [] })
      expect(result.omitted.map((o) => o.what).sort()).toEqual(
        [
          'Angolo oscillazione orizzontale sinistra',
          'Angolo oscillazione verticale alto',
          'Preset angolo 3D',
          'preset',
        ].sort(),
      )
      expect(JSON.stringify(result.steps)).not.toContain(String(PLAIN_SENSOR))
      expect(result.items.map((i) => i.label)).not.toContain('Temperature')
    })
  })
})

describe('FanPresetActionSource', () => {
  it('lists every preset as an action and runs it by id', async () => {
    const w = world({ initial: [night] })
    const source = new FanPresetActionSource({
      presets: w.service,
      devices: w.deps.devices,
      store: w.deps.store,
      addonId: 'core-blocks',
      logger: recordingLogger().logger,
    })
    const entries = await source.listActions({})
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: `core-blocks:fan-preset:${FAN}/night`,
      source: 'addon',
      readOnly: true,
      addonId: 'core-blocks',
    })
    expect(entries[0]?.name).toContain('Night')
    await source.runAction({ actionId: `core-blocks:fan-preset:${FAN}/night` })
    expect(w.calls).toHaveLength(2)
  })

  it('throws, so the run is recorded failed, when a step did not apply', async () => {
    const w = world({ initial: [night], failOn: 2 })
    const source = new FanPresetActionSource({
      presets: w.service,
      devices: w.deps.devices,
      store: w.deps.store,
      addonId: 'core-blocks',
      logger: recordingLogger().logger,
    })
    await expect(
      source.runAction({ actionId: `core-blocks:fan-preset:${FAN}/night` }),
    ).rejects.toThrow(/step 1/)
  })
})

describe('FanPresetsService.applyPreset — device templates (D1021)', () => {
  it('renders a templated arg through the door, bound to the fan it was applied on', async () => {
    const seen: Array<readonly number[] | undefined> = []
    const templates: DeviceTemplateDoor = {
      render: async (sources, allowed) => {
        seen.push(allowed)
        return sources.map(() => ({ ok: true as const, text: 'Warm 21.5', trace: [] }))
      },
      check: async () => [],
    }
    const preset: FanPreset = {
      id: 'say',
      name: 'Say',
      steps: [cap(FAN, 'fan-control', 'setLabel', { label: '{{ stufa.temperature }}' })],
    }
    const w = world({ initial: [preset], templates })
    const result = await w.service.applyPreset({ deviceId: FAN, presetId: 'say' })
    expect(result.status).toBe('applied')
    expect(w.calls[0]?.args).toEqual({ label: 'Warm 21.5' })
    expect(seen).toEqual([[FAN]])
  })
})

describe('FanPresetsService.applyPreset — a conditional step (#472)', () => {
  it("reads the step's if through the door bound to the fan, and runs the else on false", async () => {
    const built: Array<readonly number[] | undefined> = []
    const conditions: StepConditionDoor = (readable) => {
      built.push(readable)
      return async () => ({ result: 'false', reason: 'not on' })
    }
    const preset: FanPreset = {
      id: 'if',
      name: 'If',
      steps: [
        {
          ...cap(FAN, 'fan-control', 'setLabel', { label: 'then' }),
          if: {
            kind: 'device-is',
            deviceId: FAN,
            cap: 'switch',
            fieldPath: 'on',
            operator: 'eq',
            value: true,
          },
          else: [cap(FAN, 'fan-control', 'setLabel', { label: 'else' })],
        },
      ],
    }
    const w = world({ initial: [preset], conditions })
    const result = await w.service.applyPreset({ deviceId: FAN, presetId: 'if' })
    expect(result.status).toBe('applied')
    expect(w.calls.map((c) => c.args)).toEqual([{ label: 'else' }])
    expect(built).toEqual([[FAN]])
  })
})
