/**
 * What the gateway actually PUTS ON THE WIRE for a motion event.
 *
 * Two rules, both established from the live hub on 2026-08-07:
 *
 *  1. Camera firmware motion NEVER posts an `ObjectDetection` event (D779):
 *     a pixel change is not a person. Before D779 every rising edge posted a
 *     `person` event, and 223 of them were posted in 692 s to endpoint 104
 *     alone. Object detection now comes from the pipeline's tracks only
 *     (`vision/object-detection-feed.ts`) and is posted only to an endpoint
 *     that DECLARES the interface — a 2xx is not delivery (D76).
 *  2. `NOT_DETECTED` is held until the source goes quiet. 104 alternated with
 *     a median 1.76 s gap; a transition-only dedupe relays that faithfully and
 *     produces ~1 POST/s against a rate-limited gateway.
 *
 * Driven through the real `start()` subscription rather than by reaching at a
 * private method, so the wiring is part of what is under test.
 */
import { EventCategory } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  withTags: () => noopLogger,
} as unknown as LwaEventGatewayDeps['logger']

type MotionHandler = (event: { data: unknown }) => void

interface Harness {
  readonly gateway: LwaEventGateway
  readonly emitMotion: (detected: boolean) => Promise<void>
  readonly labels: () => string[]
}

const DEVICE_ID = 104

function makeHarness(signature: string | null, maySee: boolean = true): Harness {
  let motionHandler: MotionHandler | null = null
  const deps: LwaEventGatewayDeps = {
    ctx: {
      eventBus: {
        subscribe: (filter: { category: string }, handler: MotionHandler) => {
          if (filter.category === EventCategory.MotionOnMotionChanged) motionHandler = handler
          return () => {}
        },
      },
      api: {},
    } as unknown as LwaEventGatewayDeps['ctx'],
    logger: noopLogger,
    listExposed: () =>
      [{ deviceId: DEVICE_ID }] as unknown as ReturnType<LwaEventGatewayDeps['listExposed']>,
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
    getRegion: () => 'NA',
    getExportedSignature: () => signature,
    accountMaySee: () => maySee,
  }
  const gateway = new LwaEventGateway(deps)
  gateway.start()

  return {
    gateway,
    emitMotion: async (detected: boolean) => {
      motionHandler?.({ data: { deviceId: DEVICE_ID, detected, timestamp: Date.now() } })
      // The subscription callback is fire-and-forget; let its promise chain run.
      await vi.advanceTimersByTimeAsync(0)
    },
    labels: () =>
      (globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls
        .map(([, init]) => JSON.parse(init.body) as { event: { header: { namespace: string } } })
        .map((body) => body.event.header.namespace),
  }
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

const DETECTION = {
  trackId: 't1',
  imageNetClass: 'person' as const,
  eventIdentifier: '2b3409df-d686-4a52-9bba-d361860bac61',
  objectIdentifier: '573409df-5486-5c52-b4ba-d361860bac73',
  timestamp: 1_700_000_000_000,
}

describe('ObjectDetection (D779)', () => {
  it('camera motion never posts ObjectDetection, even on an endpoint that declares it', async () => {
    const h = makeHarness(
      '104|CAMERA|Alexa,Alexa.MotionSensor,Alexa.SmartVision.ObjectDetectionSensor',
    )
    await h.emitMotion(true)
    expect(h.labels()).toEqual(['Alexa']) // the MotionSensor ChangeReport, alone
  })

  it('does NOT post when the endpoint Alexa knows does not declare the interface', async () => {
    const h = makeHarness('104|CAMERA|Alexa,Alexa.CameraStreamController,Alexa.MotionSensor')
    await h.gateway.postObjectDetection({ deviceId: DEVICE_ID, detection: DETECTION })
    expect(h.labels()).toEqual([])
  })

  it('does NOT post when the endpoint shape is unknown', async () => {
    // A null signature is the absence of evidence, not evidence of presence.
    const h = makeHarness(null)
    await h.gateway.postObjectDetection({ deviceId: DEVICE_ID, detection: DETECTION })
    expect(h.labels()).toEqual([])
  })

  it('does NOT post when only ANOTHER endpoint of the device declares it', async () => {
    const h = makeHarness(
      '104|CAMERA|Alexa,Alexa.MotionSensor;104__x|CAMERA|Alexa,Alexa.SmartVision.ObjectDetectionSensor',
    )
    await h.gateway.postObjectDetection({ deviceId: DEVICE_ID, detection: DETECTION })
    expect(h.labels()).toEqual([])
  })

  it("posts Amazon's ObjectDetection shape, with the images minted for that account", async () => {
    const h = makeHarness(
      '104|CAMERA|Alexa,Alexa.MotionSensor,Alexa.SmartVision.ObjectDetectionSensor,Alexa.DataController#Camera.SmartVisionData',
    )
    await h.gateway.postObjectDetection({
      deviceId: DEVICE_ID,
      detection: DETECTION,
      imagesFor: (userId) => ({
        frameImageUri: `https://hub/f?u=${userId}`,
        croppedImageUri: `https://hub/c?u=${userId}`,
      }),
    })
    const body = JSON.parse(
      (globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
        .calls[0]![1].body,
    )
    expect(body.event.header).toMatchObject({
      namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
      name: 'ObjectDetection',
      payloadVersion: '1.0',
    })
    expect(body.event.endpoint.endpointId).toBe('104')
    expect(body.event.payload.events).toEqual([
      {
        eventIdentifier: DETECTION.eventIdentifier,
        imageNetClass: 'person',
        timeOfSample: new Date(DETECTION.timestamp).toISOString(),
        uncertaintyInMilliseconds: 500,
        objectIdentifier: DETECTION.objectIdentifier,
        frameImageUri: 'https://hub/f?u=userA',
        croppedImageUri: 'https://hub/c?u=userA',
      },
    ])
  })

  it('reaches no account whose hub user may not view the camera', async () => {
    const h = makeHarness('104|CAMERA|Alexa,Alexa.SmartVision.ObjectDetectionSensor', false)
    await h.gateway.postObjectDetection({ deviceId: DEVICE_ID, detection: DETECTION })
    expect(h.labels()).toEqual([])
  })
})

describe('the falling edge is held', () => {
  it('a 1.78s flap produces ONE DETECTED and no NOT_DETECTED', async () => {
    const h = makeHarness(null)
    for (let i = 0; i < 10; i += 1) {
      await h.emitMotion(true)
      await vi.advanceTimersByTimeAsync(900)
      await h.emitMotion(false)
      await vi.advanceTimersByTimeAsync(880)
    }
    expect(h.labels()).toEqual(['Alexa'])
  })

  it('NOT_DETECTED lands once the source genuinely goes quiet', async () => {
    const h = makeHarness(null)
    await h.emitMotion(true)
    await h.emitMotion(false)
    // Amazon: NOT_DETECTED no sooner than 30 s after DETECTED.
    await vi.advanceTimersByTimeAsync(30_000)

    const bodies = (
      globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }
    ).mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies).toHaveLength(2)
    expect(bodies[1].event.payload.change.properties[0].value).toBe('NOT_DETECTED')
  })

  it('stop() cancels a pending clear — a stopped addon posts nothing more', async () => {
    const h = makeHarness(null)
    await h.emitMotion(true)
    await h.emitMotion(false)
    h.gateway.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.labels()).toEqual(['Alexa'])
  })
})

describe('S1 — an event reaches only an account whose user may view the device', () => {
  it('posts nothing for a linked account whose hub user has no grant on the camera', async () => {
    const h = makeHarness(null, false)
    await h.emitMotion(true)
    expect(h.labels()).toEqual([])
  })
})
