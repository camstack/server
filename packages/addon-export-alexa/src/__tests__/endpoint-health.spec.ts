/**
 * `Alexa.EndpointHealth` on camera endpoints — BACK, with the three things
 * whose absence parked it (R0, D770).
 *
 * The first attempt declared it and never reported it: the hub sent
 * `connectivity` only on an online/offline TRANSITION and ReportState did not
 * answer it, so Alexa held no value at all — and the phone app, unlike an Echo
 * Show, refused live view on an endpoint of unknown health. Amazon requires
 * the interface on every sensor endpoint (a camera with MotionSensor is one),
 * so it comes back with:
 *
 *   1. ReportState answering `connectivity` for every endpoint that declares
 *      it — `OK` when the device-status read itself fails, because a hub-side
 *      read glitch is not evidence the camera is offline;
 *   2. an initial connectivity ChangeReport after every AddOrUpdateReport and
 *      every Discover, so Alexa holds a value from the start;
 *   3. the existing transition ChangeReports.
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildParentCameraEndpoint } from '../endpoints/builder.js'
import { handleReportState } from '../handlers/report-state.js'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'

const logger: IScopedLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  withTags: () => logger,
  child: () => logger,
}

describe('discovery', () => {
  it('a camera endpoint declares Alexa.EndpointHealth 3.1, retrievable and proactive', () => {
    const ep = buildParentCameraEndpoint({
      deviceId: 101,
      stableId: 's',
      friendlyName: 'Front door',
      isDoorbell: false,
      hasIntercom: false,
      hasMotion: true,
      ptzPresetNames: [],
      hasPtz: false,
    })
    const health = ep.capabilities.find((c) => c.interface === 'Alexa.EndpointHealth')
    expect(health).toMatchObject({
      version: '3.1',
      properties: {
        supported: [{ name: 'connectivity' }],
        proactivelyReported: true,
        retrievable: true,
      },
    })
    expect(ep.capabilities.map((c) => c.interface)).toContain('Alexa.RTCSessionController')
  })
})

describe('ReportState', () => {
  function ctxWith(online: boolean | Error): AddonContext {
    const fail = () => Promise.reject(new Error('no cap'))
    return {
      api: {
        battery: { getStatus: { query: fail } },
        motion: { getStatus: { query: fail } },
        deviceStatus: {
          getStatus: {
            query: () =>
              online instanceof Error
                ? Promise.reject(online)
                : Promise.resolve({ online, lastChangedAt: 1 }),
          },
        },
      },
    } as unknown as AddonContext
  }
  const header = {
    namespace: 'Alexa',
    name: 'ReportState',
    messageId: 'm',
    correlationToken: 'c',
    payloadVersion: '3',
  }
  const identity = { userId: 'u', username: 'u', scopes: [] }

  async function connectivityOf(online: boolean | Error): Promise<unknown> {
    const res = (await handleReportState(
      header,
      { endpointId: '101' },
      { ctx: ctxWith(online), logger },
      identity,
    )) as {
      context: { properties: Array<{ namespace: string; name: string; value: unknown }> }
    }
    return res.context.properties.find((p) => p.namespace === 'Alexa.EndpointHealth')?.value
  }

  it('ALWAYS answers connectivity — the property whose absence broke the phone app', async () => {
    expect(await connectivityOf(true)).toEqual({ value: 'OK' })
    expect(await connectivityOf(false)).toEqual({ value: 'UNREACHABLE' })
    // An unreadable status is a hub-side glitch, not an offline camera.
    expect(await connectivityOf(new Error('down'))).toEqual({ value: 'OK' })
  })
})

describe('proactive connectivity ChangeReport', () => {
  type Handler = (event: { data: unknown }) => void
  const handlers = new Map<string, Handler>()

  function startGateway(signature: string | null): LwaEventGateway {
    handlers.clear()
    const deps: LwaEventGatewayDeps = {
      ctx: {
        eventBus: {
          subscribe: (filter: { category: string }, handler: Handler) => {
            handlers.set(filter.category, handler)
            return () => {}
          },
        },
        api: {},
      } as unknown as LwaEventGatewayDeps['ctx'],
      logger: logger as unknown as LwaEventGatewayDeps['logger'],
      listExposed: () =>
        [{ deviceId: 101 }] as unknown as ReturnType<LwaEventGatewayDeps['listExposed']>,
      listLinkedAccounts: () => [{ userId: 'userA', username: 'userA', linkedAt: 0 }],
      listTokens: () => [
        {
          userId: 'userA',
          accessToken: 'tok',
          refreshToken: 'ref',
          expiresAt: Date.now() + 1e9,
          receivedAt: 0,
        },
      ],
      upsertToken: async () => {},
      removeLinkedAccount: async () => {},
      getAdvertisedBrokerUrl: () => null,
      getRegion: () => 'EU',
      getExportedSignature: () => signature,
      accountMaySee: () => true,
    }
    const gw = new LwaEventGateway(deps)
    gw.start()
    return gw
  }

  async function emit(category: string, deviceId = 101): Promise<void> {
    handlers.get(category)?.({ data: { deviceId } })
    await vi.advanceTimersByTimeAsync(0)
  }

  function posted(): Array<{
    url: string
    body: {
      event: {
        header: { name: string }
        endpoint: { endpointId: string }
        payload: { change: { cause: { type: string }; properties: Array<Record<string, unknown>> } }
      }
    }
  }> {
    return (
      globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }
    ).mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body) }))
  }

  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(1_700_000_000_000)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 202, text: async () => '' }) as unknown as Response),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('posts UNREACHABLE when the camera goes offline, OK when it returns, once each', async () => {
    const gw = startGateway('101|CAMERA|Alexa,Alexa.EndpointHealth,Alexa.MotionSensor')
    await emit(EventCategory.DeviceOffline)
    await emit(EventCategory.DeviceOffline)
    await emit(EventCategory.DeviceOnline)
    gw.stop()

    const sent = posted()
    expect(sent).toHaveLength(2)
    expect(sent[0]?.url).toBe('https://api.eu.amazonalexa.com/v3/events')
    expect(sent[0]?.body.event.header.name).toBe('ChangeReport')
    expect(sent[0]?.body.event.endpoint.endpointId).toBe('101')
    expect(sent[0]?.body.event.payload.change.properties[0]).toMatchObject({
      namespace: 'Alexa.EndpointHealth',
      name: 'connectivity',
      value: { value: 'UNREACHABLE' },
    })
    expect(sent[1]?.body.event.payload.change.properties[0]).toMatchObject({
      value: { value: 'OK' },
    })
  })

  it('ignores a device that is not exposed', async () => {
    const gw = startGateway(null)
    await emit(EventCategory.DeviceOffline, 999)
    gw.stop()
    expect(posted()).toHaveLength(0)
  })

  it('does not post to an endpoint Alexa knows without EndpointHealth', async () => {
    const gw = startGateway('101|CAMERA|Alexa,Alexa.MotionSensor')
    await emit(EventCategory.DeviceOffline)
    gw.stop()
    expect(posted()).toHaveLength(0)
  })
})

describe('initial connectivity after a push', () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(1_700_000_000_000)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 202, text: async () => '' }) as unknown as Response),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function gatewayWith(online: boolean): LwaEventGateway {
    const deps: LwaEventGatewayDeps = {
      ctx: {
        eventBus: { subscribe: () => () => {} },
        api: {
          deviceStatus: {
            getStatus: { query: async () => ({ online, lastChangedAt: 1 }) },
          },
        },
      } as unknown as LwaEventGatewayDeps['ctx'],
      logger: logger as unknown as LwaEventGatewayDeps['logger'],
      listExposed: () =>
        [{ deviceId: 101 }] as unknown as ReturnType<LwaEventGatewayDeps['listExposed']>,
      listLinkedAccounts: () => [{ userId: 'userA', username: 'userA', linkedAt: 0 }],
      listTokens: () => [
        { userId: 'userA', accessToken: 'tok', expiresAt: Date.now() + 1e9, receivedAt: 0 },
      ],
      upsertToken: async () => {},
      removeLinkedAccount: async () => {},
      getAdvertisedBrokerUrl: () => null,
      getRegion: () => 'EU',
      getExportedSignature: () => null,
      accountMaySee: () => true,
    }
    return new LwaEventGateway(deps)
  }

  it('reports connectivity for every EndpointHealth endpoint it just pushed, and only those', async () => {
    const gw = gatewayWith(false)
    const camera = buildParentCameraEndpoint({
      deviceId: 101,
      stableId: 's',
      friendlyName: 'Front door',
      isDoorbell: false,
      hasIntercom: false,
      hasMotion: true,
      ptzPresetNames: [],
      hasPtz: false,
    })
    const privacy = {
      ...camera,
      endpointId: '101__privacy',
      capabilities: camera.capabilities.filter((c) => c.interface === 'Alexa'),
    }
    gw.scheduleInitialConnectivity('userA', [camera, privacy])
    await vi.advanceTimersByTimeAsync(10_000)
    const bodies = (
      globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }
    ).mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies).toHaveLength(1)
    expect(bodies[0].event.endpoint.endpointId).toBe('101')
    expect(bodies[0].event.payload.change.properties[0]).toMatchObject({
      namespace: 'Alexa.EndpointHealth',
      name: 'connectivity',
      value: { value: 'UNREACHABLE' },
    })
  })
})
