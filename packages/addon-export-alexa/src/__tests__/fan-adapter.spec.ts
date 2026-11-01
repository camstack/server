/**
 * A fan exported as its own device (D869): the discovery shape (FAN, power,
 * speed range, oscillation toggle, preset modes), duplicate names collapsed,
 * the Amazon validation, the state properties, and every directive routed to
 * the right cap — a native preset to `fan-control`, a custom one to
 * `fan-presets`.
 */
import type { AddonContext } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { GENERIC_ADAPTERS, resolveGenericDirective } from '../endpoints/adapters/index.js'
import type { AdapterDirectiveContext } from '../endpoints/adapters/types.js'
import { buildGenericDeviceEndpoint } from '../endpoints/generic-device.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import type { DirectiveRouterDeps } from '../directive-router.js'
import { handleFanDirective } from '../handlers/fan-controller.js'
import { genericPropertiesFor } from '../handlers/generic-state.js'
import { quietLogger } from './helpers/fake-device-api.js'

function fanSlice(overrides: Record<string, unknown> = {}) {
  return {
    speed: 40,
    percentageStep: 10,
    preset: '',
    availablePresets: ['Auto', 'Sleep'],
    direction: null,
    oscillating: false,
    lastChangedAt: 1,
    ...overrides,
  }
}

function build(
  slice: unknown,
  custom: readonly string[] = [],
  capNames = ['fan-control', 'switch'],
) {
  return buildGenericDeviceEndpoint({
    deviceId: 9,
    stableId: 's9',
    name: 'Ventilatore',
    type: 'fan',
    capNames,
    features: [],
    slices: {
      'fan-control': slice,
      'fan-presets': custom.map((name) => ({ name })),
    },
  })
}

function endpointOf(slice: unknown, custom: readonly string[] = []) {
  const built = build(slice, custom)
  if (built === null) throw new Error('the fan was not published')
  return built
}

function instances(endpoint: ReturnType<typeof endpointOf>, iface: string): readonly string[] {
  return endpoint.capabilities
    .filter((c) => c.interface === iface)
    .flatMap((c) => (c.instance === undefined ? [] : [c.instance]))
}

describe('fan discovery', () => {
  it('is a FAN with power, speed, oscillation and preset modes', () => {
    const endpoint = endpointOf(fanSlice(), ['Notte'])
    expect(endpoint.displayCategories).toEqual(['FAN'])
    expect(endpoint.capabilities.map((c) => c.interface)).toContain('Alexa.PowerController')
    expect(instances(endpoint, 'Alexa.RangeController')).toEqual(['Fan.Speed'])
    expect(instances(endpoint, 'Alexa.ToggleController')).toEqual(['Fan.Oscillating'])
    expect(instances(endpoint, 'Alexa.ModeController')).toEqual(['Fan.Preset'])
    expect(validateAlexaEndpoint(endpoint)).toEqual([])
  })

  it('collapses a custom name that repeats a native one', () => {
    const endpoint = endpointOf(fanSlice(), ['sleep', 'Notte', 'NOTTE'])
    const mode = endpoint.capabilities.find((c) => c.interface === 'Alexa.ModeController')
    const supported: unknown = mode?.configuration?.['supportedModes']
    const values = Array.isArray(supported)
      ? supported.map((m: unknown) =>
          typeof m === 'object' && m !== null ? Reflect.get(m, 'value') : null,
        )
      : []
    expect(values).toEqual(['Preset.Auto', 'Preset.Sleep', 'Preset.Notte'])
    expect(validateAlexaEndpoint(endpoint)).toEqual([])
  })

  it('publishes no ModeController for a single mode', () => {
    const endpoint = endpointOf(fanSlice({ availablePresets: [] }), ['Notte'])
    expect(instances(endpoint, 'Alexa.ModeController')).toEqual([])
    expect(validateAlexaEndpoint(endpoint)).toEqual([])
  })

  it('is registered before the switch adapter', () => {
    const caps = GENERIC_ADAPTERS.map((a) => a.cap)
    expect(caps.indexOf('fan-control')).toBeLessThan(caps.indexOf('switch'))
  })
})

describe('fan state', () => {
  it('reports the speed and the oscillation', () => {
    const props = genericPropertiesFor('fan-control', fanSlice({ oscillating: true }))
    expect(props.map((p) => [p.instance, p.value])).toEqual(
      expect.arrayContaining([
        ['Fan.Speed', 40],
        ['Fan.Oscillating', 'ON'],
      ]),
    )
  })
})

function fanApi(state: unknown, custom: readonly { id: string; name: string }[] = []) {
  return {
    fanControl: {
      setPercentage: { mutate: vi.fn(async () => undefined) },
      setOscillating: { mutate: vi.fn(async () => undefined) },
      setPreset: { mutate: vi.fn(async () => undefined) },
    },
    fanPresets: {
      getPresets: {
        query: vi.fn(async () => custom.map((p) => ({ ...p, steps: [] }))),
      },
      applyPreset: {
        mutate: vi.fn(async () => ({
          status: 'applied' as 'applied' | 'partial' | 'refused',
          steps: [] as unknown[],
        })),
      },
    },
    deviceState: { getCapSlice: { query: vi.fn(async () => state) } },
  }
}

type Api = ReturnType<typeof fanApi>

function directive(
  key: string,
  payload: unknown,
  api: Api,
  instance: string,
): AdapterDirectiveContext {
  const [namespace = '', name = ''] = key.split('/')
  const ctx = { api } as unknown as AddonContext
  const deps = {
    fanController: { ctx, logger: quietLogger },
  } as unknown as DirectiveRouterDeps
  return {
    header: {
      namespace,
      name,
      payloadVersion: '3',
      messageId: 'm',
      correlationToken: 'c',
      instance,
    },
    endpoint: { endpointId: '9__dev' },
    payload,
    deviceId: 9,
    deps,
    identity: { userId: 'u', username: 'u', scopes: [] },
  }
}

interface Answer {
  event: { header: { name: string }; payload: { type?: string } }
  context?: { properties: Array<{ name: string; value: unknown }> }
}

async function run(key: string, payload: unknown, instance: string, api: Api): Promise<Answer> {
  return (await handleFanDirective(directive(key, payload, api, instance))) as Answer
}

describe('fan directives', () => {
  it('routes by instance through the registry', async () => {
    const found = await resolveGenericDirective(
      directive(
        'Alexa.RangeController/SetRangeValue',
        { rangeValue: 50 },
        fanApi(fanSlice()),
        'Fan.Speed',
      ),
    )
    expect(found?.key).toBe('Alexa.RangeController/SetRangeValue')
  })

  it('sets the speed and refuses a value out of range', async () => {
    const api = fanApi(fanSlice())
    const ok = await run(
      'Alexa.RangeController/SetRangeValue',
      { rangeValue: 70 },
      'Fan.Speed',
      api,
    )
    expect(ok.event.header.name).toBe('Response')
    expect(api.fanControl.setPercentage.mutate).toHaveBeenCalledWith({
      deviceId: 9,
      speed: 70,
    })
    const bad = await run(
      'Alexa.RangeController/SetRangeValue',
      { rangeValue: 130 },
      'Fan.Speed',
      api,
    )
    expect(bad.event.payload.type).toBe('VALUE_OUT_OF_RANGE')
  })

  it('adjusts by the device step when the delta is the default', async () => {
    const api = fanApi(fanSlice({ speed: 40, percentageStep: 25 }))
    await run(
      'Alexa.RangeController/AdjustRangeValue',
      { rangeValueDelta: 1, rangeValueDeltaDefault: true },
      'Fan.Speed',
      api,
    )
    expect(api.fanControl.setPercentage.mutate).toHaveBeenCalledWith({
      deviceId: 9,
      speed: 65,
    })
  })

  it('toggles the oscillation', async () => {
    const api = fanApi(fanSlice())
    await run('Alexa.ToggleController/TurnOn', {}, 'Fan.Oscillating', api)
    expect(api.fanControl.setOscillating.mutate).toHaveBeenCalledWith({
      deviceId: 9,
      oscillating: true,
    })
  })

  it('sends a NATIVE preset to fan-control and never to fan-presets', async () => {
    const api = fanApi(fanSlice(), [{ id: 'n', name: 'Notte' }])
    const answer = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Preset.Sleep' },
      'Fan.Preset',
      api,
    )
    expect(answer.event.header.name).toBe('Response')
    expect(api.fanControl.setPreset.mutate).toHaveBeenCalledWith({
      deviceId: 9,
      preset: 'Sleep',
    })
    expect(api.fanPresets.applyPreset.mutate).not.toHaveBeenCalled()
  })

  it('sends a CUSTOM preset to fan-presets and never to fan-control', async () => {
    const api = fanApi(fanSlice(), [{ id: 'n', name: 'Notte' }])
    const answer = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Preset.Notte' },
      'Fan.Preset',
      api,
    )
    expect(answer.event.header.name).toBe('Response')
    expect(api.fanPresets.applyPreset.mutate).toHaveBeenCalledWith({
      deviceId: 9,
      presetId: 'n',
    })
    expect(api.fanControl.setPreset.mutate).not.toHaveBeenCalled()
  })

  it('names the failed step when a custom preset only partly applied', async () => {
    const api = fanApi(fanSlice(), [{ id: 'n', name: 'Notte' }])
    api.fanPresets.applyPreset.mutate.mockResolvedValueOnce({
      status: 'partial',
      steps: [{ index: 1, outcome: 'failed', message: 'lamp offline' }],
    })
    const answer = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Preset.Notte' },
      'Fan.Preset',
      api,
    )
    expect(answer.event.header.name).toBe('ErrorResponse')
  })

  it('refuses an unknown mode', async () => {
    const api = fanApi(fanSlice())
    const answer = await run(
      'Alexa.ModeController/SetMode',
      { mode: 'Preset.Nope' },
      'Fan.Preset',
      api,
    )
    expect(answer.event.payload.type).toBe('INVALID_VALUE')
  })
})
