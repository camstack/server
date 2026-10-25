/**
 * S1 at the directive router: every endpoint directive is checked against
 * (1) the operator's exposed set, (2) real parentage for an accessory id, and
 * (3) the LINKING user's live grant at the directive's access — before any
 * handler runs. Discovery returns only what that user may see, shaped to what
 * that user may drive.
 */
import type { AddonContext, DeviceMetaLike, IScopedLogger, TokenScope } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { AlexaAccessGate, type AlexaUserGrant } from '../access/access-gate.js'
import {
  type DirectiveRouterDeps,
  dispatchDirective,
  type VerifiedDirectiveIdentity,
} from '../directive-router.js'
import type { AlexaEndpoint } from '../endpoints/types.js'
import { snapshotsOff, visionOff } from './helpers/allow-all-access.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withTags: () => logger,
  child: () => logger,
}

const FLEET: Readonly<Record<number, DeviceMetaLike>> = {
  10: { id: 10, type: 'camera', location: 'Garden', parentDeviceId: null },
  11: { id: 11, type: 'switch', location: 'Garden', parentDeviceId: 10 },
  20: { id: 20, type: 'camera', location: 'Bedroom', parentDeviceId: null },
  21: { id: 21, type: 'switch', location: 'Bedroom', parentDeviceId: 20 },
  99: { id: 99, type: 'switch', location: null, parentDeviceId: null },
}

const viewGarden: TokenScope = {
  type: 'device',
  selector: { kind: 'locations', locations: ['Garden'] },
  access: ['view'],
}

const USERS: readonly AlexaUserGrant[] = [
  { userId: 'admin', isAdmin: true, scopes: [] },
  { userId: 'viewer', isAdmin: false, scopes: [viewGarden] },
]

const LINK_SCOPES: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]

function identity(userId: string): VerifiedDirectiveIdentity {
  return { userId, username: userId, scopes: LINK_SCOPES }
}

function camEndpoint(id: string, extra: AlexaEndpoint['capabilities'] = []): AlexaEndpoint {
  return {
    endpointId: id,
    manufacturerName: 'camstack',
    description: 'd',
    friendlyName: `cam ${id}`,
    displayCategories: ['CAMERA'],
    capabilities: [
      { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
      {
        type: 'AlexaInterface',
        interface: 'Alexa.RTCSessionController',
        version: '3',
        configuration: { isFullDuplexAudioSupported: true },
      },
      ...extra,
    ],
  }
}

const PTZ: AlexaEndpoint['capabilities'][number] = {
  type: 'AlexaInterface',
  interface: 'Alexa.ModeController',
  version: '3',
  instance: 'ptz.pan',
  capabilityResources: {
    friendlyNames: [{ '@type': 'text', value: { text: 'Pan', locale: 'en-US' } }],
  },
  properties: {
    supported: [{ name: 'mode' }],
    proactivelyReported: false,
    retrievable: false,
  },
  configuration: {
    ordered: false,
    supportedModes: ['ptz.pan.left', 'ptz.pan.right'].map((value) => ({
      value,
      modeResources: {
        friendlyNames: [{ '@type': 'text', value: { text: value, locale: 'en-US' } }],
      },
    })),
  },
}

function switchEndpoint(id: string): AlexaEndpoint {
  return {
    endpointId: id,
    manufacturerName: 'camstack',
    description: 'd',
    friendlyName: `switch ${id}`,
    displayCategories: ['SWITCH'],
    capabilities: [
      { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
      {
        type: 'AlexaInterface',
        interface: 'Alexa.PowerController',
        version: '3',
        properties: {
          supported: [{ name: 'powerState' }],
          proactivelyReported: false,
          retrievable: true,
        },
      },
    ],
  }
}

function makeDeps(
  opts: {
    users?: () => Promise<readonly AlexaUserGrant[]>
    exposed?: number[]
    afterDiscovery?: (userId: string, endpoints: readonly AlexaEndpoint[]) => void
  } = {},
): DirectiveRouterDeps {
  const ctx = {} as Partial<AddonContext> as AddonContext
  const exposed = opts.exposed ?? [10, 20]
  const gate = new AlexaAccessGate({
    listUserGrants: opts.users ?? (async () => USERS),
    getDeviceMeta: async (id) => FLEET[id] ?? null,
    logger,
  })
  const endpointsByDevice: Record<number, AlexaEndpoint[]> = {
    10: [camEndpoint('10', [PTZ]), switchEndpoint('10__11')],
    20: [camEndpoint('20'), switchEndpoint('20__21')],
  }
  return {
    discovery: {
      ctx,
      logger,
      listExposed: async () => exposed.map((deviceId) => ({ deviceId, exposedAt: 0 })),
      buildEndpoints: async (deviceId) => endpointsByDevice[deviceId] ?? [],
    },
    cameraStream: { ctx, logger, listExposed: () => [] },
    rtcSession: { ctx, logger, listExposed: () => [] },
    ptzPreset: { ctx, logger },
    powerController: { ctx, logger },
    brightnessController: { ctx, logger },
    ptzDirection: { ctx, logger },
    reportState: { ctx, logger },
    securityPanel: { ctx, logger },
    snapshotProvider: snapshotsOff().provider,
    vision: visionOff(),
    lockController: { ctx, logger },
    coverController: { ctx, logger, sendAsyncResponse: async () => true },
    climateController: { ctx, logger },
    access: { gate, isExposed: (id) => exposed.includes(id) },
    afterDiscovery: opts.afterDiscovery ?? (() => {}),
  }
}

function reportState(endpointId: string): unknown {
  return {
    directive: {
      header: {
        namespace: 'Alexa',
        name: 'ReportState',
        messageId: 'm1',
        correlationToken: 'c1',
        payloadVersion: '3',
      },
      endpoint: { endpointId, scope: { type: 'BearerToken', token: 't' } },
      payload: {},
    },
  }
}

function turnOn(endpointId: string): unknown {
  return {
    directive: {
      header: {
        namespace: 'Alexa.PowerController',
        name: 'TurnOn',
        messageId: 'm2',
        correlationToken: 'c2',
        payloadVersion: '3',
      },
      endpoint: { endpointId, scope: { type: 'BearerToken', token: 't' } },
      payload: {},
    },
  }
}

function eventOf(body: unknown): { name?: string; type?: string } {
  const event = (body as { event?: { header?: { name?: string }; payload?: { type?: string } } })
    .event
  return { name: event?.header?.name, type: event?.payload?.type }
}

describe('directive router — the link reaches only what its user may', () => {
  it('admin link: ReportState on an exposed camera reaches the handler', async () => {
    const r = await dispatchDirective(reportState('20'), makeDeps(), identity('admin'))
    expect(eventOf(r.body).name).toBe('StateReport')
  })

  it('viewer link: a camera outside the grant does not exist for it', async () => {
    const r = await dispatchDirective(reportState('20'), makeDeps(), identity('viewer'))
    expect(eventOf(r.body)).toEqual({ name: 'ErrorResponse', type: 'NO_SUCH_ENDPOINT' })
  })

  it('viewer link: a camera inside the grant answers', async () => {
    const r = await dispatchDirective(reportState('10'), makeDeps(), identity('viewer'))
    expect(eventOf(r.body).name).toBe('StateReport')
  })

  it('viewer link: a control directive on a viewable device is refused before the handler', async () => {
    const r = await dispatchDirective(turnOn('10__privacy'), makeDeps(), identity('viewer'))
    expect(eventOf(r.body)).toEqual({ name: 'ErrorResponse', type: 'INVALID_DIRECTIVE' })
  })

  it('even an admin cannot reach a device that was never exposed', async () => {
    const r = await dispatchDirective(turnOn('99'), makeDeps(), identity('admin'))
    expect(eventOf(r.body)).toEqual({ name: 'ErrorResponse', type: 'NO_SUCH_ENDPOINT' })
  })

  it('a forged accessory id naming an unrelated device is refused, even for an admin', async () => {
    // 99 is a switch that belongs to nobody; before S1 `10__99` actuated it.
    const r = await dispatchDirective(turnOn('10__99'), makeDeps(), identity('admin'))
    expect(eventOf(r.body)).toEqual({ name: 'ErrorResponse', type: 'NO_SUCH_ENDPOINT' })
  })

  it('a link whose user was deleted is told its credential is no longer valid', async () => {
    const r = await dispatchDirective(reportState('10'), makeDeps(), identity('ghost'))
    expect(eventOf(r.body)).toEqual({
      name: 'ErrorResponse',
      type: 'INVALID_AUTHORIZATION_CREDENTIAL',
    })
  })

  it('an unreadable user store refuses (fail closed)', async () => {
    const deps = makeDeps({
      users: async () => {
        throw new Error('store down')
      },
    })
    const r = await dispatchDirective(reportState('10'), deps, identity('admin'))
    expect(eventOf(r.body)).toEqual({ name: 'ErrorResponse', type: 'INTERNAL_ERROR' })
  })

  it('SessionDisconnected is never refused — it only tears down what exists', async () => {
    const r = await dispatchDirective(
      {
        directive: {
          header: {
            namespace: 'Alexa.RTCSessionController',
            name: 'SessionDisconnected',
            messageId: 'm3',
            correlationToken: 'c3',
            payloadVersion: '3',
          },
          endpoint: { endpointId: '20', scope: { type: 'BearerToken', token: 't' } },
          payload: { sessionId: 's1' },
        },
      },
      {
        ...makeDeps(),
        rtcSession: {
          ctx: {
            api: { webrtcSession: { closeSession: { mutate: async () => ({}) } } },
          } as unknown as AddonContext,
          logger,
          listExposed: () => [],
        },
      },
      identity('ghost'),
    )
    expect(eventOf(r.body).name).toBe('SessionDisconnected')
  })
})

describe('discovery — per-user endpoint set', () => {
  function discover(): unknown {
    return {
      directive: {
        header: {
          namespace: 'Alexa.Discovery',
          name: 'Discover',
          messageId: 'm4',
          payloadVersion: '3',
        },
        payload: { scope: { type: 'BearerToken', token: 't' } },
      },
    }
  }

  function endpointsOf(body: unknown): readonly AlexaEndpoint[] {
    return (body as { event: { payload: { endpoints: AlexaEndpoint[] } } }).event.payload.endpoints
  }

  it('an admin is shown every exposed endpoint, untouched', async () => {
    const r = await dispatchDirective(discover(), makeDeps(), identity('admin'))
    expect(endpointsOf(r.body).map((e) => e.endpointId)).toEqual(['10', '10__11', '20', '20__21'])
  })

  it('a view-only user is shown its camera without PTZ or two-way audio, and no actuators', async () => {
    const r = await dispatchDirective(discover(), makeDeps(), identity('viewer'))
    const eps = endpointsOf(r.body)
    expect(eps.map((e) => e.endpointId)).toEqual(['10'])
    const cam = eps[0]!
    expect(cam.capabilities.some((c) => c.interface === 'Alexa.ModeController')).toBe(false)
    const rtc = cam.capabilities.find((c) => c.interface === 'Alexa.RTCSessionController')
    expect(rtc?.configuration?.isFullDuplexAudioSupported).toBe(false)
  })

  it('hands the endpoints it answered to the initial-connectivity hook (D770)', async () => {
    const seen: Array<{ userId: string; ids: string[] }> = []
    const deps = makeDeps({
      afterDiscovery: (userId, endpoints) => {
        seen.push({ userId, ids: endpoints.map((e) => e.endpointId) })
      },
    })
    await dispatchDirective(discover(), deps, identity('viewer'))
    expect(seen).toEqual([{ userId: 'viewer', ids: ['10'] }])
  })

  it('a deleted user is shown nothing', async () => {
    const r = await dispatchDirective(discover(), makeDeps(), identity('ghost'))
    expect(eventOf(r.body).type).toBe('INVALID_AUTHORIZATION_CREDENTIAL')
  })
})

describe('an offline device (R3)', () => {
  function offlineDeps(): DirectiveRouterDeps {
    const base = makeDeps()
    const ctx = {
      api: {
        deviceStatus: { getStatus: { query: async () => ({ online: false, lastChangedAt: 1 }) } },
      },
    } as unknown as AddonContext
    return { ...base, reportState: { ctx, logger } }
  }

  it('refuses a control directive with ENDPOINT_UNREACHABLE before any handler runs', async () => {
    const r = await dispatchDirective(turnOn('10__privacy'), offlineDeps(), identity('admin'))
    expect(eventOf(r.body)).toEqual({ name: 'ErrorResponse', type: 'ENDPOINT_UNREACHABLE' })
  })

  it('still answers ReportState — with connectivity UNREACHABLE', async () => {
    const r = await dispatchDirective(reportState('10'), offlineDeps(), identity('admin'))
    expect(eventOf(r.body).name).toBe('StateReport')
    const props = (
      r.body as { context: { properties: Array<{ namespace: string; value: unknown }> } }
    ).context.properties
    expect(props.find((p) => p.namespace === 'Alexa.EndpointHealth')?.value).toEqual({
      value: 'UNREACHABLE',
    })
  })
})

describe('R4 (D779): the object-detection directives go through the gate', () => {
  function reportData(endpointId: string): unknown {
    return {
      directive: {
        header: {
          namespace: 'Alexa.DataController',
          name: 'ReportData',
          instance: 'Camera.SmartVisionData',
          messageId: 'm3',
          correlationToken: 'c3',
          payloadVersion: '1.0',
        },
        endpoint: { endpointId, scope: { type: 'BearerToken', token: 't' } },
        payload: {
          queryType: 'QUERY_BY_TIMESTAMP_RANGE',
          query: { fromTime: '2026-10-08T00:00:00Z', toTime: '2026-10-08T23:59:59Z' },
          maxResults: 10,
        },
      },
    }
  }

  function setClasses(endpointId: string): unknown {
    return {
      directive: {
        header: {
          namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
          name: 'SetObjectDetectionClasses',
          messageId: 'm4',
          correlationToken: 'c4',
          payloadVersion: '1.0',
        },
        endpoint: { endpointId, scope: { type: 'BearerToken', token: 't' } },
        payload: { objectDetectionClasses: [{ imageNetClass: 'person' }] },
      },
    }
  }

  it('viewer link: history of a camera inside the grant is answered, instance echoed', async () => {
    const r = await dispatchDirective(reportData('10'), makeDeps(), identity('viewer'))
    const header = (r.body as { event: { header: Record<string, unknown> } }).event.header
    expect(header).toMatchObject({
      namespace: 'Alexa.DataController',
      name: 'DataReport',
      instance: 'Camera.SmartVisionData',
      correlationToken: 'c3',
    })
  })

  it('viewer link: history of a camera outside the grant does not exist for it', async () => {
    const r = await dispatchDirective(reportData('20'), makeDeps(), identity('viewer'))
    expect(eventOf(r.body)).toEqual({ name: 'ErrorResponse', type: 'NO_SUCH_ENDPOINT' })
  })

  it('SetObjectDetectionClasses needs only view (it changes what Alexa is told, nothing in CamStack)', async () => {
    const r = await dispatchDirective(setClasses('10'), makeDeps(), identity('viewer'))
    expect(eventOf(r.body).name).toBe('Response')
  })
})
