/**
 * A fan preset is a desired fan-control state (D1034), applied through the
 * fan's own fan-control methods. The fixture is the Dreo studio fan (3370):
 * its horizontal axis linked to the swing switch 3361 and angle control 3364,
 * its preset to the select 3375 — the links themselves are the forward's
 * business (`fan-link-forward.spec.ts`); here the fan-control calls are faked.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DeviceType,
  type FanControlStatus,
  type FanOscillationAxisResult,
  type FanPreset,
  type IScopedLogger,
  type SetOscillationAxisInput,
} from '@camstack/types'
import {
  type FanPresetsFanControl,
  FanPresetsService,
  type FanPresetsStore,
} from '../fan-presets-service.js'

const FAN = 3370

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function memoryStore(initial: readonly FanPreset[] = []): FanPresetsStore {
  let rows: readonly FanPreset[] = initial
  return {
    read: async () => rows,
    write: async (_id, presets) => {
      rows = presets
    },
    listAll: async () => new Map([[FAN, rows]]),
  }
}

const STATUS: FanControlStatus = {
  speed: 40,
  preset: 'Preset 2',
  availablePresets: ['Off', 'Preset 1', 'Preset 2'],
  direction: null,
  oscillating: true,
  oscillationAxes: {
    horizontal: {
      oscillating: true,
      angle: 30,
      sweepFrom: null,
      sweepTo: null,
      min: 0,
      max: 120,
      step: 1,
    },
    vertical: null,
  },
  lastChangedAt: 1,
}

interface Harness {
  readonly service: FanPresetsService
  readonly calls: string[]
}

function harness(
  options: {
    presets?: readonly FanPreset[]
    status?: FanControlStatus | null
    axis?: (input: SetOscillationAxisInput) => FanOscillationAxisResult
    failSpeed?: boolean
    type?: DeviceType
  } = {},
): Harness {
  const calls: string[] = []
  const fanControl: FanPresetsFanControl = {
    setPreset: async (_id, preset) => {
      calls.push(`setPreset ${preset}`)
    },
    setPercentage: async (_id, speed) => {
      calls.push(`setPercentage ${speed}`)
      if (options.failSpeed === true) throw new Error('fan offline')
    },
    setDirection: async (_id, direction) => {
      calls.push(`setDirection ${direction}`)
    },
    setOscillationAxis: async (input) => {
      calls.push(`setOscillationAxis ${JSON.stringify(input)}`)
      return options.axis?.(input) ?? { status: 'applied' }
    },
  }
  const service = new FanPresetsService({
    store: memoryStore(options.presets),
    devices: {
      describe: async () => ({ name: 'Ventilatore studio', type: options.type ?? DeviceType.Fan }),
    },
    readings: { fan: async () => (options.status === undefined ? STATUS : options.status) },
    fanControl,
    logger: logger(),
  })
  return { service, calls }
}

const NIGHT: FanPreset = {
  id: 'night',
  name: 'Night',
  state: {
    preset: 'Preset 1',
    speed: 25,
    oscillationAxes: { horizontal: { oscillating: false, angle: 45 } },
  },
}

describe('setPresets', () => {
  it('saves a desired state', async () => {
    const { service } = harness()
    expect(await service.setPresets({ deviceId: FAN, presets: [NIGHT] })).toEqual({
      status: 'saved',
      count: 1,
    })
    expect(await service.getPresets({ deviceId: FAN })).toEqual([NIGHT])
  })

  it('refuses a preset that sets nothing', async () => {
    const { service } = harness()
    const r = await service.setPresets({
      deviceId: FAN,
      presets: [{ id: 'x', name: 'Empty', state: { oscillationAxes: { vertical: {} } } }],
    })
    expect(r).toMatchObject({ status: 'refused', reason: 'empty-state' })
  })

  it('refuses a device that is not a fan, and duplicate names', async () => {
    expect(
      await harness({ type: DeviceType.Switch }).service.setPresets({
        deviceId: FAN,
        presets: [NIGHT],
      }),
    ).toMatchObject({ reason: 'not-a-fan' })
    expect(
      await harness().service.setPresets({
        deviceId: FAN,
        presets: [NIGHT, { ...NIGHT, id: 'other', name: ' night ' }],
      }),
    ).toMatchObject({ reason: 'duplicate-name' })
  })
})

describe('applyPreset', () => {
  it('calls the fan’s own methods in order: preset, speed, then the axis in one call', async () => {
    const { service, calls } = harness({ presets: [NIGHT] })
    const r = await service.applyPreset({ deviceId: FAN, presetId: 'night' })
    expect(r.status).toBe('applied')
    expect(calls).toEqual([
      'setPreset Preset 1',
      'setPercentage 25',
      `setOscillationAxis ${JSON.stringify({ deviceId: FAN, axis: 'horizontal', oscillating: false, angle: 45 })}`,
    ])
    expect(r.fields.map((f) => `${f.field}=${f.outcome}`)).toEqual([
      'preset=applied',
      'speed=applied',
      'oscillationAxes.horizontal.oscillating=applied',
      'oscillationAxes.horizontal.angle=applied',
    ])
  })

  it('a refused axis field is reported per field, with what landed before it', async () => {
    const { service } = harness({
      presets: [NIGHT],
      axis: () => ({
        status: 'refused',
        reason: 'out-of-range',
        field: 'angle',
        detail: 'angle 45 is outside 0…40',
        applied: ['oscillating'],
      }),
    })
    const r = await service.applyPreset({ deviceId: FAN, presetId: 'night' })
    expect(r.status).toBe('partial')
    expect(r.fields.slice(2)).toEqual([
      { field: 'oscillationAxes.horizontal.oscillating', outcome: 'applied' },
      {
        field: 'oscillationAxes.horizontal.angle',
        outcome: 'refused',
        message: 'out-of-range: angle 45 is outside 0…40',
      },
    ])
  })

  it('stops at the first failure: the rest is not-run, never silently skipped', async () => {
    const { service, calls } = harness({ presets: [NIGHT], failSpeed: true })
    const r = await service.applyPreset({ deviceId: FAN, presetId: 'night' })
    expect(r.status).toBe('partial')
    expect(r.fields.map((f) => f.outcome)).toEqual(['applied', 'failed', 'not-run', 'not-run'])
    expect(calls.some((c) => c.startsWith('setOscillationAxis'))).toBe(false)
  })

  it('an unknown preset id is refused with nothing run', async () => {
    const { service, calls } = harness({ presets: [NIGHT] })
    expect(await service.applyPreset({ deviceId: FAN, presetId: 'gone' })).toEqual({
      status: 'refused',
      fields: [],
    })
    expect(calls).toEqual([])
  })
})

describe('capturePreset', () => {
  it('reads the fan-control state; an unknown reading is omitted, never 0 (D393)', async () => {
    const r = await harness().service.capturePreset({ deviceId: FAN })
    expect(r.state).toEqual({
      speed: 40,
      preset: 'Preset 2',
      oscillationAxes: { horizontal: { oscillating: true, angle: 30 } },
    })
    expect(r.omitted.map((o) => o.what)).toEqual([
      'direction',
      'oscillationAxes.horizontal.sweepFrom',
      'oscillationAxes.horizontal.sweepTo',
      'oscillationAxes.vertical',
    ])
  })

  it('takes only the fields asked for', async () => {
    const r = await harness().service.capturePreset({ deviceId: FAN, fields: ['speed'] })
    expect(r).toEqual({ state: { speed: 40 }, omitted: [] })
  })

  it('an unreadable fan captures nothing and names every field', async () => {
    const r = await harness({ status: null }).service.capturePreset({
      deviceId: FAN,
      fields: ['speed', 'preset'],
    })
    expect(r.state).toEqual({})
    expect(r.omitted.map((o) => o.what)).toEqual(['speed', 'preset'])
  })
})
