/**
 * R1 — the detection-sensor endpoints themselves, and the gate that keeps a
 * ChangeReport off an endpoint Alexa was never told about (D76).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endpointsSignature } from '../endpoint-signature.js'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import { parseCameraEndpointId } from '../handlers/endpoint-id.js'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import { fakeBuildContext, quietLogger } from './helpers/fake-device-api.js'

describe('detection sensor endpoints', () => {
  it('a camera gets "<camera> <Class>" MotionSensor endpoints for its pipeline classes only', async () => {
    const eps = await buildEndpointsForExposedDevice(
      101,
      fakeBuildContext([{ id: 101, name: 'Front door', type: 'camera', capNames: ['motion'] }], {
        detectionClasses: ['person', 'vehicle'],
      }),
    )
    const sensors = eps.filter((e) => e.displayCategories[0] === 'MOTION_SENSOR')
    expect(sensors.map((e) => [e.endpointId, e.friendlyName])).toEqual([
      ['101__det_person', 'Front door Person'],
      ['101__det_vehicle', 'Front door Vehicle'],
    ])
    expect(sensors[0]?.capabilities.map((c) => c.interface)).toEqual([
      'Alexa',
      'Alexa.MotionSensor',
      'Alexa.EndpointHealth',
    ])
  })

  it('switch off ⇒ no sensors at all', async () => {
    const eps = await buildEndpointsForExposedDevice(
      101,
      fakeBuildContext([{ id: 101, name: 'Front door', type: 'camera', capNames: ['motion'] }]),
    )
    expect(eps.some((e) => e.endpointId.includes('__det_'))).toBe(false)
  })

  it('endpoint ids round-trip', () => {
    expect(parseCameraEndpointId('101__det_package')).toEqual({
      kind: 'detection',
      deviceId: 101,
      detectionClass: 'package',
    })
    expect(parseCameraEndpointId('101__det_face').kind).toBe('invalid')
  })
})

describe('gateway — detection ChangeReports go only to endpoints Alexa knows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 202, text: async () => '' }) as unknown as Response),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function gateway(signature: string | null): LwaEventGateway {
    const deps: LwaEventGatewayDeps = {
      ctx: {
        eventBus: { subscribe: () => () => {} },
        api: {},
      } as unknown as LwaEventGatewayDeps['ctx'],
      logger: quietLogger,
      listExposed: () => [{ deviceId: 101, exposedAt: 0 }],
      listLinkedAccounts: () => [{ userId: 'u', username: 'u', linkedAt: 0 }],
      listTokens: () => [
        { userId: 'u', accessToken: 'tok', expiresAt: Date.now() + 1e9, receivedAt: 0 },
      ],
      upsertToken: async () => {},
      removeLinkedAccount: async () => {},
      getAdvertisedBrokerUrl: () => null,
      getRegion: () => 'EU',
      getExportedSignature: () => signature,
      accountMaySee: () => true,
    }
    return new LwaEventGateway(deps)
  }

  const posted = (): string[] =>
    (
      globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }
    ).mock.calls.map(([, init]) => JSON.parse(init.body).event.endpoint.endpointId)

  it('posts DETECTED to a declared sensor', async () => {
    const sig = endpointsSignature([
      {
        endpointId: '101__det_person',
        manufacturerName: 'camstack',
        description: 'd',
        friendlyName: 'x',
        displayCategories: ['MOTION_SENSOR'],
        capabilities: [{ type: 'AlexaInterface', interface: 'Alexa.MotionSensor', version: '3' }],
      },
    ])
    await gateway(sig).pushDetectionSensor({
      deviceId: 101,
      endpointId: '101__det_person',
      detected: true,
      timestamp: 1,
    })
    expect(posted()).toEqual(['101__det_person'])
  })

  it('posts nothing for a sensor the last AddOrUpdateReport did not contain', async () => {
    await gateway('101|CAMERA|Alexa').pushDetectionSensor({
      deviceId: 101,
      endpointId: '101__det_person',
      detected: true,
      timestamp: 1,
    })
    await gateway(null).pushDetectionSensor({
      deviceId: 101,
      endpointId: '101__det_person',
      detected: true,
      timestamp: 1,
    })
    expect(posted()).toEqual([])
  })
})
