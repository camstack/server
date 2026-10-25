/**
 * R3 — proactive state reports end to end through the gateway: only to an
 * endpoint Alexa knows WITH the interface (D76), only to accounts whose user
 * may see the device (S1), deduplicated, and connectivity on every
 * EndpointHealth endpoint of the device (camera + its detection sensors).
 */
import type { AddonContext } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endpointsSignature } from '../endpoint-signature.js'
import {
  buildAlarmPanelEndpoint,
  buildChildAccessoryEndpoint,
  buildDetectionSensorEndpoint,
  buildParentCameraEndpoint,
} from '../endpoints/builder.js'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import { StateChangeReporter } from '../state-reports/state-change-reporter.js'
import { quietLogger } from './helpers/fake-device-api.js'

const camera = buildParentCameraEndpoint({
  deviceId: 10,
  stableId: 's',
  friendlyName: 'Garden',
  isDoorbell: false,
  hasIntercom: false,
  hasMotion: true,
  ptzPresetNames: [],
  hasPtz: false,
})
const siren = buildChildAccessoryEndpoint({
  parentDeviceId: 10,
  parentName: 'Garden',
  childDeviceId: 11,
  childStableId: 'c',
  childName: 'Siren',
  kind: 'siren',
  hasBrightness: false,
})
const person = buildDetectionSensorEndpoint({
  deviceId: 10,
  stableId: 's',
  cameraName: 'Garden',
  detectionClass: 'person',
})
const panel = buildAlarmPanelEndpoint({
  deviceId: 30,
  stableId: 'p',
  friendlyName: 'Casa',
  availableModes: ['away'],
  requiresCode: false,
})

const SIGNATURES: Record<number, string> = {
  10: endpointsSignature([camera, siren, person]),
  30: endpointsSignature([panel]),
}
const EXPORTED = { 10: ['10', '10__11', '10__det_person'], 30: ['30__alarm'] }

type Handler = (event: { data: unknown }) => void

function setup(opts: { maySee?: (userId: string, deviceId: number) => boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const eventBus = {
    subscribe: (filter: { category: string }, handler: Handler) => {
      handlers.set(filter.category, handler)
      return () => {}
    },
  } as unknown as AddonContext['eventBus']
  const deps: LwaEventGatewayDeps = {
    ctx: { eventBus, api: {} } as unknown as LwaEventGatewayDeps['ctx'],
    logger: quietLogger,
    listExposed: () => [
      { deviceId: 10, exposedAt: 0 },
      { deviceId: 30, exposedAt: 0 },
    ],
    listLinkedAccounts: () => [
      { userId: 'admin', username: 'admin', linkedAt: 0 },
      { userId: 'viewer', username: 'viewer', linkedAt: 0 },
    ],
    listTokens: () =>
      ['admin', 'viewer'].map((userId) => ({
        userId,
        accessToken: `tok-${userId}`,
        expiresAt: Date.now() + 1e9,
        receivedAt: 0,
      })),
    upsertToken: async () => {},
    removeLinkedAccount: async () => {},
    getAdvertisedBrokerUrl: () => null,
    getRegion: () => 'EU',
    getExportedSignature: (id) => SIGNATURES[id] ?? null,
    accountMaySee: opts.maySee ?? (() => true),
  }
  const gateway = new LwaEventGateway(deps)
  const reporter = new StateChangeReporter({
    eventBus,
    getExportedEndpoints: () => EXPORTED,
    reportConnectivity: (d, c) => gateway.reportConnectivity(d, c),
    postStateChange: (r) => gateway.postStateChange(r),
    postHeldMotion: (r, detected) =>
      gateway.pushDetectionSensor({
        deviceId: r.exposedDeviceId,
        endpointId: r.endpointId,
        detected,
        timestamp: 1,
      }),
    logger: quietLogger,
  })
  reporter.start()
  const emit = async (data: unknown): Promise<void> => {
    handlers.get(EventCategory.DeviceStateChanged)?.({ data })
    await vi.advanceTimersByTimeAsync(0)
  }
  return { emit }
}

function sent(): Array<{
  token: string
  endpointId: string
  props: Array<{ namespace: string; name: string; value: unknown }>
}> {
  return (
    globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }
  ).mock.calls.map(([, init]) => {
    const body = JSON.parse(init.body)
    return {
      token: body.event.endpoint.scope.token,
      endpointId: body.event.endpoint.endpointId,
      props: body.event.payload.change.properties,
    }
  })
}

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

describe('StateChangeReporter + gateway', () => {
  it('an alarm going off reaches Alexa as a SecurityPanelController ChangeReport', async () => {
    const h = setup()
    await h.emit({
      deviceId: 30,
      capName: 'alarm-panel',
      slice: { state: 'triggered', targetMode: 'away' },
    })
    expect(sent().map((s) => [s.token, s.endpointId, s.props.map((p) => p.name)])).toEqual([
      ['tok-admin', '30__alarm', ['armState', 'burglaryAlarm']],
      ['tok-viewer', '30__alarm', ['armState', 'burglaryAlarm']],
    ])
  })

  it('a siren switched at the device reaches Alexa once; a re-announced slice does not repeat it', async () => {
    const h = setup()
    await h.emit({ deviceId: 11, capName: 'switch', slice: { on: true, lastChangedAt: 1 } })
    await h.emit({ deviceId: 11, capName: 'switch', slice: { on: true, lastChangedAt: 2 } })
    expect(
      sent()
        .filter((s) => s.token === 'tok-admin')
        .map((s) => [s.endpointId, s.props[0]?.value]),
    ).toEqual([['10__11', 'ON']])
  })

  it('a camera going offline reports UNREACHABLE on the camera AND its detection sensors', async () => {
    const h = setup()
    await h.emit({
      deviceId: 10,
      capName: 'device-status',
      slice: { online: false, lastChangedAt: 1 },
    })
    expect(
      sent()
        .filter((s) => s.token === 'tok-admin')
        .map((s) => [s.endpointId, s.props[0]?.value])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['10', { value: 'UNREACHABLE' }],
      ['10__det_person', { value: 'UNREACHABLE' }],
    ])
  })

  it('nothing goes to an account whose user may not see the device (S1)', async () => {
    const h = setup({ maySee: (userId) => userId === 'admin' })
    await h.emit({ deviceId: 30, capName: 'alarm-panel', slice: { state: 'disarmed' } })
    expect(sent().map((s) => s.token)).toEqual(['tok-admin'])
  })

  it('nothing for an endpoint Alexa does not know with that interface (D76)', async () => {
    const h = setup()
    // `brightness` on a siren that never declared BrightnessController.
    await h.emit({ deviceId: 11, capName: 'brightness', slice: { percentage: 40 } })
    expect(sent()).toEqual([])
  })
})
