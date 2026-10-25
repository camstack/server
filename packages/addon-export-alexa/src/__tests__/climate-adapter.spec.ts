/**
 * Thermostats and air conditioners (D874): the discovery shape per device
 * (golden JSON), the slice -> property mapping, every directive -> cap action,
 * the out-of-range / unsupported-mode errors, and the shaped ChangeReports.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AddonContext } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  GENERIC_ADAPTERS,
  GENERIC_DIRECTIVE_KEYS,
  resolveGenericDirective,
} from '../endpoints/adapters/index.js'
import type { AdapterDirectiveContext } from '../endpoints/adapters/types.js'
import { buildGenericDeviceEndpoint, planGenericEndpoint } from '../endpoints/generic-device.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import type { DirectiveRouterDeps } from '../directive-router.js'
import { handleCoverDirective } from '../handlers/cover-controller.js'
import { handleClimateDirective, handlesPower } from '../handlers/climate-controller.js'
import { snapToStep } from '../endpoints/adapters/climate-model.js'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import { genericPropertiesFor } from '../handlers/generic-state.js'
import { stateReportsFor } from '../state-reports/state-change-map.js'
import { fakeBuildContext, quietLogger } from './helpers/fake-device-api.js'

const GOLDEN: Record<string, unknown> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./helpers/climate-golden.json', import.meta.url)), 'utf8'),
)

const GREE_FANS = ['auto', 'low', 'medium_low', 'medium', 'medium_high', 'high']

function slice(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'heat',
    availableModes: ['off', 'heat'],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: 20,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: 19.4,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: 5,
    maxTemp: 30,
    tempStep: 0.5,
    lastFetchedAt: 1,
    ...overrides,
  }
}

const HEAT_ONLY = slice()
const HEAT_COOL = slice({
  mode: 'heat_cool',
  availableModes: ['off', 'heat', 'cool', 'auto', 'heat_cool'],
  availableFanModes: ['auto', 'low', 'high'],
  fanMode: 'auto',
  availablePresets: ['none', 'eco'],
  target: null,
  targetLow: 19,
  targetHigh: 24,
})
const GREE = slice({
  mode: 'cool',
  availableModes: ['off', 'auto', 'cool', 'dry', 'fan_only', 'heat'],
  availableFanModes: GREE_FANS,
  fanMode: 'medium_low',
  availablePresets: ['none', 'turbo', 'quiet', 'sleep', 'eco', '8c_heat'],
  preset: 'none',
  target: 24,
  currentTemp: 26.2,
  minTemp: 16,
  maxTemp: 30,
  tempStep: 1,
})

function build(type: string, climate: unknown, features: readonly string[] = []) {
  return buildGenericDeviceEndpoint({
    deviceId: 7,
    stableId: 's7',
    name: 'Clima',
    type,
    capNames: ['climate-control'],
    features,
    slices: { 'climate-control': climate },
  })
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('climate discovery: golden endpoints', () => {
  const CASES: Record<string, ReturnType<typeof build>> = {
    haHeatOnly: build('thermostat', HEAT_ONLY),
    haHeatCoolRange: build('thermostat', HEAT_COOL),
    greeAc: build('climate', GREE),
  }
  for (const [name, endpoint] of Object.entries(CASES)) {
    it(`${name} equals the golden JSON and passes the Amazon validator`, () => {
      expect(plain(endpoint)).toEqual(GOLDEN[name])
      if (endpoint !== null) expect(validateAlexaEndpoint(endpoint)).toEqual([])
    })
  }

  it('a thermostat is THERMOSTAT, an air conditioner AIR_CONDITIONER', () => {
    expect(CASES['haHeatOnly']?.displayCategories).toEqual(['THERMOSTAT'])
    expect(CASES['greeAc']?.displayCategories).toEqual(['AIR_CONDITIONER'])
  })

  it('a heat-only thermostat declares only targetSetpoint and HEAT / OFF', () => {
    const thermostat = CASES['haHeatOnly']?.capabilities.find(
      (c) => c.interface === 'Alexa.ThermostatController',
    )
    expect(thermostat?.version).toBe('3.1')
    expect(thermostat?.properties?.supported.map((p) => p.name)).toEqual([
      'targetSetpoint',
      'thermostatMode',
    ])
    expect(thermostat?.configuration?.['supportedModes']).toEqual(['HEAT', 'OFF'])
  })

  it('a range thermostat adds lower / upper setpoints and ECO from its eco preset', () => {
    const thermostat = CASES['haHeatCoolRange']?.capabilities.find(
      (c) => c.interface === 'Alexa.ThermostatController',
    )
    expect(thermostat?.properties?.supported.map((p) => p.name)).toEqual([
      'targetSetpoint',
      'lowerSetpoint',
      'upperSetpoint',
      'thermostatMode',
    ])
    expect(thermostat?.configuration?.['supportedModes']).toEqual([
      'HEAT',
      'COOL',
      'AUTO',
      'ECO',
      'OFF',
    ])
  })

  it('dry and fan_only (no Amazon thermostat value) travel as a Climate.Mode ModeController', () => {
    const instances = CASES['greeAc']?.capabilities.filter((c) => c.instance !== undefined)
    expect(instances?.map((c) => c.instance)).toEqual(['Climate.Mode', 'Climate.FanSpeed'])
    const modes = instances?.[0]?.configuration?.['supportedModes']
    expect(Array.isArray(modes) && modes.map((m: { value: string }) => m.value)).toEqual([
      'Mode.Heat',
      'Mode.Cool',
      'Mode.Auto',
      'Mode.Dry',
      'Mode.Fan',
      'Mode.Off',
    ])
  })

  it('a thermostat that is not in dry / fan_only publishes no Climate.Mode', () => {
    expect(CASES['haHeatOnly']?.capabilities.some((c) => c.instance !== undefined)).toBe(false)
  })

  it('low / medium / high use the Amazon assets, other fan modes Italian + English text', () => {
    const fan = CASES['greeAc']?.capabilities.find((c) => c.instance === 'Climate.FanSpeed')
    const modes = fan?.configuration?.['supportedModes']
    expect(Array.isArray(modes) && modes.map((m: { value: string }) => m.value)).toEqual([
      'Fan.Auto',
      'Fan.Low',
      'Fan.MediumLow',
      'Fan.Medium',
      'Fan.MediumHigh',
      'Fan.High',
    ])
    const names = (value: string) =>
      Array.isArray(modes)
        ? modes.find((m: { value: string }) => m.value === value)?.modeResources.friendlyNames
        : undefined
    expect(names('Fan.Low')).toEqual([{ '@type': 'asset', value: { assetId: 'Alexa.Value.Low' } }])
    expect(names('Fan.MediumLow')).toEqual([
      { '@type': 'text', value: { text: 'Medio basso', locale: 'it-IT' } },
      { '@type': 'text', value: { text: 'Medium low', locale: 'en-US' } },
    ])
  })

  it('an unreadable slice still publishes the basic thermostat from the device features', () => {
    const e = buildGenericDeviceEndpoint({
      deviceId: 7,
      stableId: 's7',
      name: 'Clima',
      type: 'thermostat',
      capNames: ['climate-control'],
      features: ['climate-dual-setpoint'],
    })
    const thermostat = e?.capabilities.find((c) => c.interface === 'Alexa.ThermostatController')
    expect(thermostat?.properties?.supported.map((p) => p.name)).toContain('lowerSetpoint')
    expect(thermostat?.configuration?.['supportedModes']).toEqual(['HEAT', 'COOL', 'AUTO', 'OFF'])
  })

  it('a thermostat that also has a temperature sensor stays a THERMOSTAT with one TemperatureSensor', () => {
    const plan = planGenericEndpoint({
      deviceId: 7,
      stableId: 's7',
      name: 'Clima',
      type: 'thermostat',
      capNames: ['climate-control', 'temperature-sensor'],
      slices: { 'climate-control': HEAT_ONLY },
    })
    expect(plan.kind).toBe('endpoint')
    if (plan.kind !== 'endpoint') return
    expect(plan.endpoint.displayCategories).toEqual(['THERMOSTAT'])
    expect(
      plan.endpoint.capabilities.filter((c) => c.interface === 'Alexa.TemperatureSensor'),
    ).toHaveLength(1)
    expect(validateAlexaEndpoint(plan.endpoint)).toEqual([])
  })

  it('discovery reads the climate slice and publishes (no more "thermostat skipped")', async () => {
    const warn = vi.fn()
    const info = vi.fn()
    const ctx = fakeBuildContext(
      [
        { id: 21, name: 'Salotto', type: 'thermostat', capNames: ['climate-control'] },
        { id: 22, name: 'Camera', type: 'climate', capNames: ['climate-control'] },
      ],
      { api: { deviceState: { getCapSlice: { query: async () => GREE } } } },
    )
    const deps = { ...ctx, logger: { ...quietLogger, warn, info } }
    const [thermostat] = await buildEndpointsForExposedDevice(21, deps)
    const [ac] = await buildEndpointsForExposedDevice(22, deps)
    expect(thermostat?.displayCategories).toEqual(['THERMOSTAT'])
    expect(ac?.displayCategories).toEqual(['AIR_CONDITIONER'])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('climate state', () => {
  const props = (s: unknown) =>
    genericPropertiesFor('climate-control', s).map((p) => [
      p.namespace.replace('Alexa.', ''),
      p.instance ?? '',
      p.name,
      p.value,
    ])

  it('a heating thermostat reports target, mode HEAT, temperature and power', () => {
    expect(props(HEAT_ONLY)).toEqual([
      ['ThermostatController', '', 'targetSetpoint', { value: 20, scale: 'CELSIUS' }],
      ['ThermostatController', '', 'thermostatMode', 'HEAT'],
      ['TemperatureSensor', '', 'temperature', { value: 19.4, scale: 'CELSIUS' }],
      ['PowerController', '', 'powerState', 'ON'],
    ])
  })

  it('a range thermostat in heat_cool reports lower / upper and AUTO', () => {
    const p = props(HEAT_COOL)
    expect(p).toContainEqual([
      'ThermostatController',
      '',
      'lowerSetpoint',
      { value: 19, scale: 'CELSIUS' },
    ])
    expect(p).toContainEqual([
      'ThermostatController',
      '',
      'upperSetpoint',
      { value: 24, scale: 'CELSIUS' },
    ])
    expect(p).toContainEqual(['ThermostatController', '', 'thermostatMode', 'AUTO'])
    expect(p.some((r) => r[2] === 'targetSetpoint')).toBe(false)
  })

  it('off reports OFF and powerState OFF; the eco preset reports ECO', () => {
    expect(props(slice({ mode: 'off' }))).toContainEqual([
      'ThermostatController',
      '',
      'thermostatMode',
      'OFF',
    ])
    expect(props(slice({ mode: 'off' }))).toContainEqual([
      'PowerController',
      '',
      'powerState',
      'OFF',
    ])
    expect(props({ ...HEAT_COOL, mode: 'heat', preset: 'eco' })).toContainEqual([
      'ThermostatController',
      '',
      'thermostatMode',
      'ECO',
    ])
  })

  it('dry has no thermostatMode: the Climate.Mode instance carries it', () => {
    const p = props({ ...GREE, mode: 'dry' })
    expect(p.some((r) => r[2] === 'thermostatMode')).toBe(false)
    expect(p).toContainEqual(['ModeController', 'Climate.Mode', 'mode', 'Mode.Dry'])
    expect(p).toContainEqual(['ModeController', 'Climate.FanSpeed', 'mode', 'Fan.MediumLow'])
  })

  it('an unusable slice reports nothing', () => {
    expect(props({ nope: true })).toEqual([])
  })
})

describe('climate ChangeReports', () => {
  const change = (s: Record<string, unknown>) =>
    stateReportsFor({ deviceId: 7, capName: 'climate-control', slice: s }, { 7: ['7__dev'] })

  it('one report per property; only the current temperature is shaped (0.5 C / 60 s)', () => {
    const out = change(HEAT_ONLY)
    expect(out?.kind).toBe('reports')
    if (out?.kind !== 'reports') return
    const byName = new Map(out.reports.map((r) => [r.properties[0]?.name ?? '', r]))
    expect([...byName.keys()]).toEqual([
      'targetSetpoint',
      'thermostatMode',
      'temperature',
      'powerState',
    ])
    expect(byName.get('temperature')?.shaping).toMatchObject({
      deadband: 0.5,
      minIntervalMs: 60_000,
    })
    expect(byName.get('targetSetpoint')?.shaping).toBeUndefined()
    expect(byName.get('thermostatMode')?.shaping).toBeUndefined()
  })

  it('a fan change reports on its own instance', () => {
    const out = change(GREE)
    if (out?.kind !== 'reports') throw new Error('expected reports')
    expect(out.reports.map((r) => r.instance ?? '')).toContain('Climate.FanSpeed')
  })
})

describe('adapter registry', () => {
  it('every adapter names its own cap among the caps it reads', () => {
    for (const adapter of GENERIC_ADAPTERS) expect(adapter.stateCaps).toContain(adapter.cap)
  })

  it('declares the thermostat directives the router must authorize as control', () => {
    expect(GENERIC_DIRECTIVE_KEYS).toEqual(
      expect.arrayContaining([
        'Alexa.ThermostatController/SetTargetTemperature',
        'Alexa.ThermostatController/AdjustTargetTemperature',
        'Alexa.ThermostatController/SetThermostatMode',
        'Alexa.LockController/Lock',
        'Alexa.PowerController/TurnOn',
        'Alexa.RangeController/SetRangeValue',
        'Alexa.ModeController/SetMode',
      ]),
    )
  })
})

// ── Directives ──────────────────────────────────────────────────────

function climateApi(state: unknown, caps: readonly string[] = ['climate-control']) {
  return {
    climateControl: {
      setMode: { mutate: vi.fn(async () => undefined) },
      setFanMode: { mutate: vi.fn(async () => undefined) },
      setPreset: { mutate: vi.fn(async () => undefined) },
      setTarget: { mutate: vi.fn(async () => undefined) },
      setTargetRange: { mutate: vi.fn(async () => undefined) },
    },
    deviceState: { getCapSlice: { query: vi.fn(async () => state) } },
    deviceManager: {
      getBindings: {
        query: vi.fn(async () => ({ entries: caps.map((capName) => ({ capName })) })),
      },
    },
  }
}

type Api = ReturnType<typeof climateApi>

function directive(
  key: string,
  payload: unknown,
  api: Api,
  instance?: string,
): AdapterDirectiveContext {
  const [namespace = '', name = ''] = key.split('/')
  const ctx = { api } as unknown as AddonContext
  const deps = { climateController: { ctx, logger: quietLogger } } as unknown as DirectiveRouterDeps
  return {
    header: {
      namespace,
      name,
      payloadVersion: '3',
      messageId: 'm',
      correlationToken: 'c',
      ...(instance !== undefined ? { instance } : {}),
    },
    endpoint: { endpointId: '7__dev' },
    payload,
    deviceId: 7,
    deps,
    identity: { userId: 'u', username: 'u', scopes: [] },
  }
}

interface Answer {
  event: { header: { name: string }; payload: { type?: string; validRange?: unknown } & object }
  context?: { properties: Array<{ name: string; value: unknown; instance?: string }> }
}

async function run(
  key: string,
  payload: unknown,
  state: unknown,
  instance?: string,
): Promise<{ api: Api; answer: Answer }> {
  const api = climateApi(state)
  const answer = (await handleClimateDirective(directive(key, payload, api, instance))) as Answer
  return { api, answer }
}

const C = (value: number) => ({ value, scale: 'CELSIUS' })
const SET = 'Alexa.ThermostatController/SetTargetTemperature'
const ADJUST = 'Alexa.ThermostatController/AdjustTargetTemperature'
const SET_MODE = 'Alexa.ThermostatController/SetThermostatMode'

describe('climate directives: setpoints', () => {
  it('SetTargetTemperature -> setTarget, snapped to the step, answered with the new state', async () => {
    const { api, answer } = await run(SET, { targetSetpoint: C(21.3) }, HEAT_ONLY)
    expect(api.climateControl.setTarget.mutate).toHaveBeenCalledWith({ deviceId: 7, target: 21.5 })
    expect(answer.event.header.name).toBe('Response')
    expect(answer.context?.properties.find((p) => p.name === 'targetSetpoint')?.value).toEqual(
      C(21.5),
    )
  })

  it('Fahrenheit and Kelvin are converted to Celsius', async () => {
    const f = await run(SET, { targetSetpoint: { value: 68, scale: 'FAHRENHEIT' } }, HEAT_ONLY)
    expect(f.api.climateControl.setTarget.mutate).toHaveBeenCalledWith({ deviceId: 7, target: 20 })
    const k = await run(SET, { targetSetpoint: { value: 293.15, scale: 'KELVIN' } }, HEAT_ONLY)
    expect(k.api.climateControl.setTarget.mutate).toHaveBeenCalledWith({ deviceId: 7, target: 20 })
  })

  it('a setpoint outside the device range is TEMPERATURE_VALUE_OUT_OF_RANGE with the valid range', async () => {
    for (const value of [4, 31]) {
      const { api, answer } = await run(SET, { targetSetpoint: C(value) }, HEAT_ONLY)
      expect(answer.event.payload.type).toBe('TEMPERATURE_VALUE_OUT_OF_RANGE')
      expect(answer.event.payload.validRange).toEqual({
        minimumValue: C(5),
        maximumValue: C(30),
      })
      expect(api.climateControl.setTarget.mutate).not.toHaveBeenCalled()
    }
  })

  it('respects an AC with a 16-30 C range and a 1 C step', async () => {
    const low = await run(SET, { targetSetpoint: C(15) }, GREE)
    expect(low.answer.event.payload.type).toBe('TEMPERATURE_VALUE_OUT_OF_RANGE')
    const ok = await run(SET, { targetSetpoint: C(22.4) }, GREE)
    expect(ok.api.climateControl.setTarget.mutate).toHaveBeenCalledWith({ deviceId: 7, target: 22 })
  })

  it('a lower / upper pair -> setTargetRange (and heat_cool first when it was not)', async () => {
    const { api, answer } = await run(
      SET,
      { lowerSetpoint: C(18), upperSetpoint: C(23) },
      { ...HEAT_COOL, mode: 'heat' },
    )
    expect(api.climateControl.setMode.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      mode: 'heat_cool',
    })
    expect(api.climateControl.setTargetRange.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      targetLow: 18,
      targetHigh: 23,
    })
    expect(answer.event.header.name).toBe('Response')
  })

  it('range refusals: dual unsupported, too close, out of range, triple', async () => {
    const dual = await run(SET, { lowerSetpoint: C(18), upperSetpoint: C(23) }, HEAT_ONLY)
    expect(dual.answer.event.payload.type).toBe('DUAL_SETPOINTS_UNSUPPORTED')
    const close = await run(SET, { lowerSetpoint: C(20), upperSetpoint: C(20) }, HEAT_COOL)
    expect(close.answer.event.payload.type).toBe('REQUESTED_SETPOINTS_TOO_CLOSE')
    const out = await run(SET, { lowerSetpoint: C(2), upperSetpoint: C(23) }, HEAT_COOL)
    expect(out.answer.event.payload.type).toBe('TEMPERATURE_VALUE_OUT_OF_RANGE')
    const triple = await run(
      SET,
      { targetSetpoint: C(20), lowerSetpoint: C(18), upperSetpoint: C(23) },
      HEAT_COOL,
    )
    expect(triple.answer.event.payload.type).toBe('TRIPLE_SETPOINTS_UNSUPPORTED')
    expect(out.api.climateControl.setTargetRange.mutate).not.toHaveBeenCalled()
  })

  it('a single setpoint while the thermostat is in range mode is refused, not guessed', async () => {
    const { api, answer } = await run(SET, { targetSetpoint: C(21) }, HEAT_COOL)
    expect(answer.event.payload.type).toBe('UNWILLING_TO_SET_VALUE')
    expect(api.climateControl.setTarget.mutate).not.toHaveBeenCalled()
  })

  it('AdjustTargetTemperature reads the setpoint and adds the delta (Fahrenheit delta scaled)', async () => {
    const up = await run(ADJUST, { targetSetpointDelta: C(1.5) }, HEAT_ONLY)
    expect(up.api.climateControl.setTarget.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      target: 21.5,
    })
    const f = await run(
      ADJUST,
      { targetSetpointDelta: { value: -2, scale: 'FAHRENHEIT' } },
      HEAT_ONLY,
    )
    expect(f.api.climateControl.setTarget.mutate).toHaveBeenCalledWith({ deviceId: 7, target: 19 })
  })

  it('AdjustTargetTemperature shifts a range, and refuses past the limit', async () => {
    const shift = await run(ADJUST, { targetSetpointDelta: C(1) }, HEAT_COOL)
    expect(shift.api.climateControl.setTargetRange.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      targetLow: 20,
      targetHigh: 25,
    })
    const past = await run(ADJUST, { targetSetpointDelta: C(20) }, HEAT_ONLY)
    expect(past.answer.event.payload.type).toBe('TEMPERATURE_VALUE_OUT_OF_RANGE')
  })

  it('AdjustTargetTemperature with an unknown setpoint refuses instead of guessing', async () => {
    const { api, answer } = await run(
      ADJUST,
      { targetSetpointDelta: C(1) },
      slice({ target: null }),
    )
    expect(answer.event.payload.type).toBe('ENDPOINT_UNREACHABLE')
    expect(api.climateControl.setTarget.mutate).not.toHaveBeenCalled()
  })
})

describe('climate directives: modes, power, fan', () => {
  it('SetThermostatMode maps HEAT / COOL / AUTO / OFF to the cap modes', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['HEAT', GREE, 'heat'],
      ['COOL', GREE, 'cool'],
      ['AUTO', GREE, 'auto'],
      ['OFF', GREE, 'off'],
      ['AUTO', slice({ availableModes: ['off', 'heat_cool'] }), 'heat_cool'],
    ]
    for (const [requested, state, expected] of cases) {
      const { api, answer } = await run(SET_MODE, { thermostatMode: { value: requested } }, state)
      expect(api.climateControl.setMode.mutate).toHaveBeenCalledWith({
        deviceId: 7,
        mode: expected,
      })
      expect(answer.event.header.name).toBe('Response')
    }
  })

  it('a mode the device lacks, and CUSTOM, are UNSUPPORTED_THERMOSTAT_MODE', async () => {
    for (const mode of [{ value: 'COOL' }, { value: 'CUSTOM', customName: 'FAN' }]) {
      const { api, answer } = await run(SET_MODE, { thermostatMode: mode }, HEAT_ONLY)
      expect(answer.event.payload.type).toBe('UNSUPPORTED_THERMOSTAT_MODE')
      expect(api.climateControl.setMode.mutate).not.toHaveBeenCalled()
    }
  })

  it('ECO sets the eco preset; leaving ECO clears it', async () => {
    const eco = await run(SET_MODE, { thermostatMode: { value: 'ECO' } }, HEAT_COOL)
    expect(eco.api.climateControl.setPreset.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      preset: 'eco',
    })
    const leave = await run(
      SET_MODE,
      { thermostatMode: { value: 'HEAT' } },
      { ...HEAT_COOL, mode: 'heat', preset: 'eco' },
    )
    expect(leave.api.climateControl.setPreset.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      preset: 'none',
    })
    expect(leave.api.climateControl.setMode.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      mode: 'heat',
    })
  })

  it('ECO on a device without the preset is unsupported', async () => {
    const { answer } = await run(SET_MODE, { thermostatMode: { value: 'ECO' } }, HEAT_ONLY)
    expect(answer.event.payload.type).toBe('UNSUPPORTED_THERMOSTAT_MODE')
  })

  it('TurnOff -> off; TurnOn from off -> the preferred on mode; TurnOn while on changes nothing', async () => {
    const off = await run('Alexa.PowerController/TurnOff', {}, GREE)
    expect(off.api.climateControl.setMode.mutate).toHaveBeenCalledWith({ deviceId: 7, mode: 'off' })
    expect(off.answer.context?.properties[0]).toMatchObject({ name: 'powerState', value: 'OFF' })
    const on = await run('Alexa.PowerController/TurnOn', {}, { ...GREE, mode: 'off' })
    expect(on.api.climateControl.setMode.mutate).toHaveBeenCalledWith({ deviceId: 7, mode: 'auto' })
    const already = await run('Alexa.PowerController/TurnOn', {}, GREE)
    expect(already.api.climateControl.setMode.mutate).not.toHaveBeenCalled()
    expect(already.answer.event.header.name).toBe('Response')
  })

  it('PowerController belongs to the thermostat only when it is not also a switch', async () => {
    const c = (caps: readonly string[]) =>
      directive('Alexa.PowerController/TurnOn', {}, climateApi(HEAT_ONLY, caps))
    expect(await handlesPower(c(['climate-control']))).toBe(true)
    expect(await handlesPower(c(['climate-control', 'switch']))).toBe(false)
    expect(await handlesPower(c(['switch']))).toBe(false)
  })

  it('Climate.Mode SetMode reaches dry and fan_only through the cap', async () => {
    const dry = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Mode.Dry' },
      GREE,
      'Climate.Mode',
    )
    expect(dry.api.climateControl.setMode.mutate).toHaveBeenCalledWith({ deviceId: 7, mode: 'dry' })
    expect(dry.answer.context?.properties[0]).toMatchObject({
      instance: 'Climate.Mode',
      value: 'Mode.Dry',
    })
    const fan = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Mode.Fan' },
      GREE,
      'Climate.Mode',
    )
    expect(fan.api.climateControl.setMode.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      mode: 'fan_only',
    })
  })

  it("Climate.FanSpeed SetMode -> setFanMode with the device's own name", async () => {
    const { api, answer } = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Fan.MediumHigh' },
      GREE,
      'Climate.FanSpeed',
    )
    expect(api.climateControl.setFanMode.mutate).toHaveBeenCalledWith({
      deviceId: 7,
      fanMode: 'medium_high',
    })
    expect(answer.context?.properties[0]).toMatchObject({ value: 'Fan.MediumHigh' })
  })

  it('an unknown mode value is INVALID_VALUE and commands nothing', async () => {
    const { api, answer } = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Fan.Turbo' },
      GREE,
      'Climate.FanSpeed',
    )
    expect(answer.event.payload.type).toBe('INVALID_VALUE')
    expect(api.climateControl.setFanMode.mutate).not.toHaveBeenCalled()
  })

  it('an unreadable climate state, or a command the device refuses, is ENDPOINT_UNREACHABLE', async () => {
    const dead = await run(SET, { targetSetpoint: C(20) }, { nope: true })
    expect(dead.answer.event.payload.type).toBe('ENDPOINT_UNREACHABLE')
    const api = climateApi(HEAT_ONLY)
    api.climateControl.setTarget.mutate.mockRejectedValue(new Error('offline'))
    const answer = (await handleClimateDirective(
      directive(SET, { targetSetpoint: C(20) }, api),
    )) as Answer
    expect(answer.event.payload.type).toBe('ENDPOINT_UNREACHABLE')
  })

  it('a malformed payload is INVALID_DIRECTIVE', async () => {
    const { answer } = await run(SET, { targetSetpoint: 'warm' }, HEAT_ONLY)
    expect(answer.event.payload.type).toBe('INVALID_DIRECTIVE')
  })
})

describe('directive resolution: two caps, one key', () => {
  const resolve = (key: string, caps: readonly string[], instance?: string) =>
    resolveGenericDirective(directive(key, {}, climateApi(HEAT_ONLY, caps), instance))

  it('PowerController goes to the thermostat when the device has climate-control, to the switch otherwise', async () => {
    expect((await resolve('Alexa.PowerController/TurnOn', ['climate-control']))?.handle).toBe(
      handleClimateDirective,
    )
    expect((await resolve('Alexa.PowerController/TurnOn', ['switch']))?.handle).not.toBe(
      handleClimateDirective,
    )
  })

  it('ModeController/SetMode goes by instance: Climate.* to the thermostat, Blind.* to the cover', async () => {
    const mode = 'Alexa.ModeController/SetMode'
    expect((await resolve(mode, ['climate-control'], 'Climate.FanSpeed'))?.handle).toBe(
      handleClimateDirective,
    )
    expect((await resolve(mode, ['cover'], 'Blind.State'))?.handle).toBe(handleCoverDirective)
    expect(await resolve(mode, ['cover'], 'Other.Thing')).toBeNull()
  })
})

describe('climate power claim (review fixes)', () => {
  it('a failed bindings read keeps the previous answer instead of handing a thermostat to the switch handler', async () => {
    const api = climateApi({})
    const c = directive('Alexa.PowerController/TurnOff', {}, api)
    expect(await handlesPower(c)).toBe(true)
    api.deviceManager.getBindings.query.mockRejectedValueOnce(new Error('transient'))
    expect(await handlesPower(c)).toBe(true)
  })

  it('with no previous answer a failed read does not claim', async () => {
    const api = climateApi({})
    api.deviceManager.getBindings.query.mockRejectedValueOnce(new Error('transient'))
    expect(await handlesPower(directive('Alexa.PowerController/TurnOn', {}, api))).toBe(false)
  })

  it('a setpoint snapped to the step never exceeds an off-grid maximum', () => {
    expect(snapToStep(30.2, { min: 16, max: 30.2, step: 0.6 })).toBeLessThanOrEqual(30.2)
    expect(snapToStep(16, { min: 16, max: 30.2, step: 0.5 })).toBe(16)
  })
})
