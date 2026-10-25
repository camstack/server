/**
 * Covers, blinds, shutters, awnings (D869): the discovery shape per kind, the
 * directive → `cover` cap action, the slice → property mapping, and the kinds
 * that are deliberately not exposed yet.
 */
import { describe, expect, it, vi } from 'vitest'
import { coverKindOf, describeCover } from '../endpoints/adapters/cover-model.js'
import { buildGenericDeviceEndpoint, planGenericEndpoint } from '../endpoints/generic-device.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import { handleCoverDirective } from '../handlers/cover-controller.js'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import { genericPropertiesFor } from '../handlers/generic-state.js'
import { stateReportsFor } from '../state-reports/state-change-map.js'
import { fakeBuildContext, quietLogger } from './helpers/fake-device-api.js'
import type { AsyncResponseInput } from '../handlers/deferred-response.js'
import type { AdapterDirectiveContext } from '../endpoints/adapters/types.js'
import type { DirectiveRouterDeps } from '../directive-router.js'
import type { AddonContext } from '@camstack/types'

const base = { deviceId: 9, stableId: 's9', name: 'Tapparella', type: 'cover' }
const POSITIONABLE = ['cover-positionable']

function build(role: string | null, features: readonly string[] = POSITIONABLE) {
  return buildGenericDeviceEndpoint({ ...base, capNames: ['cover'], role, features })
}

function instanceCaps(endpoint: ReturnType<typeof build>) {
  return (endpoint?.capabilities ?? []).filter((c) => c.instance !== undefined)
}

describe('cover discovery shape', () => {
  it('a positionable blind is a Blind.Position RangeController, INTERIOR_BLIND', () => {
    const e = build('cover-blind')
    expect(e?.displayCategories).toEqual(['INTERIOR_BLIND'])
    const [range] = instanceCaps(e)
    expect(range).toMatchObject({
      interface: 'Alexa.RangeController',
      instance: 'Blind.Position',
      capabilityResources: {
        friendlyNames: [{ '@type': 'asset', value: { assetId: 'Alexa.Setting.Opening' } }],
      },
      properties: { supported: [{ name: 'rangeValue' }], retrievable: true },
      configuration: {
        supportedRange: { minimumValue: 0, maximumValue: 100, precision: 1 },
        unitOfMeasure: 'Alexa.Unit.Percent',
      },
    })
    expect(range?.semantics?.actionMappings?.map((m) => m.actions[0])).toEqual([
      'Alexa.Actions.Close',
      'Alexa.Actions.Open',
      'Alexa.Actions.Lower',
      'Alexa.Actions.Raise',
    ])
    expect(range?.semantics?.stateMappings).toEqual([
      { '@type': 'StatesToValue', states: ['Alexa.States.Closed'], value: 0 },
      {
        '@type': 'StatesToRange',
        states: ['Alexa.States.Open'],
        range: { minimumValue: 1, maximumValue: 100 },
      },
    ])
  })

  it('kinds pick the display category: shutter and awning exterior, curtain interior', () => {
    expect(build('cover-shutter')?.displayCategories).toEqual(['EXTERIOR_BLIND'])
    expect(build('cover-awning')?.displayCategories).toEqual(['EXTERIOR_BLIND'])
    expect(build('cover-curtain')?.displayCategories).toEqual(['INTERIOR_BLIND'])
    expect(build(null)?.displayCategories).toEqual(['INTERIOR_BLIND'])
    expect(coverKindOf('cover-window')).toBe('window')
  })

  it('a cover that only opens and closes is a Blind.State ModeController', () => {
    const e = build('cover-blind', [])
    const [mode] = instanceCaps(e)
    expect(mode).toMatchObject({
      interface: 'Alexa.ModeController',
      instance: 'Blind.State',
      configuration: {
        ordered: false,
        supportedModes: [{ value: 'State.Open' }, { value: 'State.Closed' }],
      },
    })
    expect(mode?.semantics?.actionMappings?.map((m) => m.directive.payload)).toEqual([
      { mode: 'State.Closed' },
      { mode: 'State.Open' },
    ])
  })

  it('a slice with a position makes a device without the feature positionable', () => {
    const plan = planGenericEndpoint({
      ...base,
      capNames: ['cover'],
      role: 'cover-shutter',
      features: [],
      slices: { cover: { state: 'closed', position: 0, tiltPosition: null, lastChangedAt: 1 } },
    })
    expect(plan.kind === 'endpoint' && instanceCaps(plan.endpoint)[0]?.instance).toBe(
      'Blind.Position',
    )
  })

  it('a tilting cover adds Blind.Tilt, no semantics, Italian + English names', () => {
    const e = build('cover-blind', [...POSITIONABLE, 'cover-tilt'])
    const caps = instanceCaps(e)
    expect(caps.map((c) => c.instance)).toEqual(['Blind.Position', 'Blind.Tilt'])
    const tilt = caps[1]
    expect(tilt?.semantics).toBeUndefined()
    expect(tilt?.capabilityResources?.friendlyNames).toEqual([
      { '@type': 'text', value: { text: 'Inclinazione', locale: 'it-IT' } },
      { '@type': 'text', value: { text: 'Tilt', locale: 'en-US' } },
    ])
  })

  it('every cover shape passes the Amazon validator', () => {
    for (const role of ['cover-blind', 'cover-shutter', 'cover-awning', 'cover-curtain', null]) {
      for (const features of [[], POSITIONABLE, [...POSITIONABLE, 'cover-tilt']]) {
        const e = build(role, features)
        expect(e).not.toBeNull()
        if (e !== null) expect(validateAlexaEndpoint(e)).toEqual([])
      }
    }
  })

  it('garage, gate and door are not exposed yet: skipped with a reason, not an error', () => {
    for (const role of ['cover-garage', 'cover-gate', 'cover-door']) {
      const plan = planGenericEndpoint({
        ...base,
        capNames: ['cover'],
        role,
        features: POSITIONABLE,
      })
      expect(plan.kind).toBe('skip')
      expect(
        describeCover({ ...base, role, features: [], capNames: ['cover'], slices: {} }).kind,
      ).toBe('skip')
    }
  })

  it('discovery logs a withheld garage door once at info with the deviceId tag', async () => {
    const info = vi.fn()
    const ctx = fakeBuildContext([
      {
        id: 31,
        name: 'Garage',
        type: 'cover',
        capNames: ['cover'],
        role: 'cover-garage',
        features: POSITIONABLE,
      },
    ])
    const logger = { ...quietLogger, info }
    const deps = { ...ctx, logger }
    expect(await buildEndpointsForExposedDevice(31, deps)).toEqual([])
    expect(await buildEndpointsForExposedDevice(31, deps)).toEqual([])
    const calls = info.mock.calls.filter((c) => String(c[0]).includes('not published'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toMatchObject({ tags: { deviceId: 31 } })
  })

  it('discovery reads the cover slice to find a position the features did not declare', async () => {
    const ctx = fakeBuildContext(
      [{ id: 41, name: 'Tapparella', type: 'cover', capNames: ['cover'], role: 'cover-shutter' }],
      {
        api: {
          deviceState: {
            getCapSlice: {
              query: async () => ({
                state: 'open',
                position: 80,
                tiltPosition: null,
                lastChangedAt: 1,
              }),
            },
          },
        },
      },
    )
    const [endpoint] = await buildEndpointsForExposedDevice(41, ctx)
    expect(endpoint?.capabilities.find((c) => c.instance !== undefined)?.instance).toBe(
      'Blind.Position',
    )
  })
})

describe('cover state', () => {
  it('a positioned cover reports Blind.Position, with tilt when it has one', () => {
    expect(
      genericPropertiesFor('cover', {
        state: 'open',
        position: 42.4,
        tiltPosition: 10,
        lastChangedAt: 1,
      }),
    ).toEqual([
      {
        namespace: 'Alexa.RangeController',
        instance: 'Blind.Position',
        name: 'rangeValue',
        value: 42,
      },
      { namespace: 'Alexa.RangeController', instance: 'Blind.Tilt', name: 'rangeValue', value: 10 },
    ])
  })

  it('a cover without a position reports Blind.State: a closing cover is going to Closed', () => {
    expect(
      genericPropertiesFor('cover', {
        state: 'closing',
        position: null,
        tiltPosition: null,
        lastChangedAt: 1,
      }),
    ).toEqual([
      {
        namespace: 'Alexa.ModeController',
        instance: 'Blind.State',
        name: 'mode',
        value: 'State.Closed',
      },
    ])
  })

  it('a slice change becomes shaped ChangeReports, one per instance', () => {
    const out = stateReportsFor(
      {
        deviceId: 9,
        capName: 'cover',
        slice: { state: 'open', position: 60, tiltPosition: 20, lastChangedAt: 1 },
      },
      { 9: ['9__dev'] },
    )
    expect(out?.kind).toBe('reports')
    if (out?.kind !== 'reports') return
    expect(out.reports.map((r) => r.instance)).toEqual(['Blind.Position', 'Blind.Tilt'])
    expect(out.reports[0]?.shaping).toMatchObject({ deadband: 1, debounceMs: 1000 })
  })
})

function directiveContext(
  name: string,
  namespace: string,
  instance: string,
  payload: unknown,
  api: unknown,
  sendAsyncResponse = vi.fn(async (_input: AsyncResponseInput) => true),
): AdapterDirectiveContext {
  const ctx = { api } as unknown as AddonContext
  const deps = {
    coverController: {
      ctx,
      logger: quietLogger,
      sendAsyncResponse,
      sleep: async () => {},
      now: (() => {
        let t = 0
        return () => (t += 1500)
      })(),
    },
  } as unknown as DirectiveRouterDeps
  return {
    header: {
      namespace,
      name,
      instance,
      payloadVersion: '3',
      messageId: 'm',
      correlationToken: 'c',
    },
    endpoint: { endpointId: '9__dev' },
    payload,
    deviceId: 9,
    deps,
    identity: { userId: 'u', username: 'u', scopes: [] },
  }
}

function coverApi(slice: unknown) {
  return {
    cover: {
      setPosition: { mutate: vi.fn(async () => undefined) },
      setTiltPosition: { mutate: vi.fn(async () => undefined) },
      open: { mutate: vi.fn(async () => undefined) },
      close: { mutate: vi.fn(async () => undefined) },
    },
    deviceState: { getCapSlice: { query: vi.fn(async () => slice) } },
  }
}

describe('cover directives', () => {
  const at = (position: number | null, state = 'open', tiltPosition: number | null = null) => ({
    state,
    position,
    tiltPosition,
    lastChangedAt: 1,
  })

  it('SetRangeValue moves the position; a cover already there answers Response', async () => {
    const api = coverApi(at(30))
    const res = (await handleCoverDirective(
      directiveContext(
        'SetRangeValue',
        'Alexa.RangeController',
        'Blind.Position',
        { rangeValue: 30 },
        api,
      ),
    )) as {
      event: { header: { name: string } }
      context: { properties: Array<{ instance: string; value: number }> }
    }
    expect(api.cover.setPosition.mutate).toHaveBeenCalledWith({ deviceId: 9, position: 30 })
    expect(res.event.header.name).toBe('Response')
    expect(res.context.properties[0]).toMatchObject({ instance: 'Blind.Position', value: 30 })
  })

  it('a cover still moving answers DeferredResponse and the real Response arrives later', async () => {
    let reads = 0
    const api = coverApi(null)
    api.deviceState.getCapSlice.query = vi.fn(async () => {
      reads += 1
      return at(reads < 5 ? 10 : 100, reads < 5 ? 'opening' : 'open')
    })
    const sendAsyncResponse = vi.fn(async (_input: AsyncResponseInput) => true)
    let settled: Promise<void> | null = null
    const c = directiveContext(
      'SetRangeValue',
      'Alexa.RangeController',
      'Blind.Position',
      { rangeValue: 100 },
      api,
      sendAsyncResponse,
    )
    const coverController = {
      ...c.deps.coverController,
      onSettled: (p: Promise<void>) => (settled = p),
    }
    const res = (await handleCoverDirective({
      ...c,
      deps: { ...c.deps, coverController },
    })) as { event: { header: { name: string; correlationToken: string }; payload: unknown } }
    expect(res.event.header.name).toBe('DeferredResponse')
    expect(res.event.payload).toEqual({ estimatedDeferralInSeconds: 30 })
    await settled
    expect(sendAsyncResponse).toHaveBeenCalledTimes(1)
    expect(sendAsyncResponse.mock.calls[0]?.[0]).toMatchObject({
      userId: 'u',
      endpointId: '9__dev',
      correlationToken: 'c',
      outcome: { kind: 'response' },
    })
  })

  it('AdjustRangeValue moves from the current position by the delta, clamped', async () => {
    const api = coverApi(at(95))
    await handleCoverDirective(
      directiveContext(
        'AdjustRangeValue',
        'Alexa.RangeController',
        'Blind.Position',
        { rangeValueDelta: 10, rangeValueDeltaDefault: false },
        api,
      ),
    )
    expect(api.cover.setPosition.mutate).toHaveBeenCalledWith({ deviceId: 9, position: 100 })
  })

  it('AdjustRangeValue on a cover whose position is unknown refuses instead of guessing', async () => {
    const api = coverApi(at(null))
    const res = (await handleCoverDirective(
      directiveContext(
        'AdjustRangeValue',
        'Alexa.RangeController',
        'Blind.Position',
        { rangeValueDelta: -10, rangeValueDeltaDefault: false },
        api,
      ),
    )) as { event: { payload: { type: string } } }
    expect(res.event.payload.type).toBe('ENDPOINT_UNREACHABLE')
    expect(api.cover.setPosition.mutate).not.toHaveBeenCalled()
  })

  it('tilt goes through setTiltPosition; an out-of-range value is refused', async () => {
    const api = coverApi(at(50, 'open', 40))
    await handleCoverDirective(
      directiveContext(
        'SetRangeValue',
        'Alexa.RangeController',
        'Blind.Tilt',
        { rangeValue: 40 },
        api,
      ),
    )
    expect(api.cover.setTiltPosition.mutate).toHaveBeenCalledWith({ deviceId: 9, tiltPosition: 40 })
    const res = (await handleCoverDirective(
      directiveContext(
        'SetRangeValue',
        'Alexa.RangeController',
        'Blind.Position',
        { rangeValue: 140 },
        api,
      ),
    )) as { event: { payload: { type: string; validRange: unknown } } }
    expect(res.event.payload.type).toBe('VALUE_OUT_OF_RANGE')
    expect(res.event.payload.validRange).toEqual({ minimumValue: 0, maximumValue: 100 })
  })

  it('Blind.State SetMode opens and closes through the cap', async () => {
    const api = coverApi(at(null, 'closed'))
    await handleCoverDirective(
      directiveContext(
        'SetMode',
        'Alexa.ModeController',
        'Blind.State',
        { mode: 'State.Closed' },
        api,
      ),
    )
    expect(api.cover.close.mutate).toHaveBeenCalledWith({ deviceId: 9 })
    await handleCoverDirective(
      directiveContext(
        'SetMode',
        'Alexa.ModeController',
        'Blind.State',
        { mode: 'State.Open' },
        api,
      ),
    )
    expect(api.cover.open.mutate).toHaveBeenCalledWith({ deviceId: 9 })
  })

  it('a command the cap refuses is answered ENDPOINT_UNREACHABLE and nothing is deferred', async () => {
    const api = coverApi(at(0))
    api.cover.setPosition.mutate = vi.fn(async () => {
      throw new Error('offline')
    })
    const sendAsyncResponse = vi.fn(async (_input: AsyncResponseInput) => true)
    const res = (await handleCoverDirective(
      directiveContext(
        'SetRangeValue',
        'Alexa.RangeController',
        'Blind.Position',
        { rangeValue: 50 },
        api,
        sendAsyncResponse,
      ),
    )) as { event: { payload: { type: string } } }
    expect(res.event.payload.type).toBe('ENDPOINT_UNREACHABLE')
    expect(sendAsyncResponse).not.toHaveBeenCalled()
  })
})
