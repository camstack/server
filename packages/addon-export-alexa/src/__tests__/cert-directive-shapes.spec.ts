/**
 * Response shapes Amazon's Smart Home certification checks, hub side.
 *
 *   - `Alexa.RTCSessionController/SessionConnected` is answered with the
 *     matching `SessionConnected` event (it used to fall through to the
 *     "not implemented" error); `SessionDisconnected` with the matching
 *     `SessionDisconnected` event, not a generic `Alexa.Response`
 *     (alexa-rtcsessioncontroller).
 *   - every `Alexa.ErrorResponse` for an endpoint directive carries the
 *     directive's `correlationToken` and the `endpoint` (alexa-errorresponse:
 *     both required).
 */
import type { AddonContext, IScopedLogger, TokenScope } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type DirectiveRouterDeps,
  dispatchDirective,
  type VerifiedDirectiveIdentity,
} from '../directive-router.js'
import { allowAllAccess, snapshotsOff, visionOff } from './helpers/allow-all-access.js'

const CONTROL: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]
const VIEW_ONLY: readonly TokenScope[] = [{ type: 'category', target: 'device', access: ['view'] }]

function identity(scopes: readonly TokenScope[]): VerifiedDirectiveIdentity {
  return { userId: 'user-1', username: 'tester', scopes }
}

function makeDeps(): { deps: DirectiveRouterDeps; closeSession: ReturnType<typeof vi.fn> } {
  const closeSession = vi.fn().mockResolvedValue(undefined)
  const ctx = {
    api: { webrtcSession: { closeSession: { mutate: closeSession } } },
  } as unknown as AddonContext
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTags: () => logger,
    child: () => logger,
  }
  const base = { ctx, logger }
  return {
    closeSession,
    deps: {
      discovery: {
        ...base,
        listExposed: vi.fn().mockResolvedValue([]),
        buildEndpoints: vi.fn().mockResolvedValue([]),
      },
      cameraStream: { ...base, listExposed: vi.fn().mockReturnValue([]) },
      rtcSession: { ...base, listExposed: vi.fn().mockReturnValue([]) },
      ptzPreset: base,
      powerController: base,
      brightnessController: base,
      ptzDirection: base,
      reportState: base,
      securityPanel: base,
      snapshotProvider: snapshotsOff().provider,
      vision: visionOff(),
      lockController: base,
      coverController: { ...base, sendAsyncResponse: async () => true },
      climateController: { ...base },
      access: allowAllAccess(),
      afterDiscovery: () => {},
    },
  }
}

function directive(namespace: string, name: string, endpointId: string, payload: unknown = {}) {
  return {
    directive: {
      header: {
        namespace,
        name,
        messageId: 'msg-1',
        correlationToken: 'corr-1',
        payloadVersion: '3',
      },
      endpoint: { endpointId, scope: { type: 'BearerToken', token: 't' } },
      payload,
    },
  }
}

interface EventBody {
  readonly event: {
    readonly header: {
      readonly namespace: string
      readonly name: string
      readonly correlationToken?: string
    }
    readonly endpoint?: { readonly endpointId: string }
    readonly payload: Record<string, unknown>
  }
}

describe('RTCSessionController session events', () => {
  it('answers SessionConnected with the matching SessionConnected event', async () => {
    const { deps } = makeDeps()
    const res = await dispatchDirective(
      directive('Alexa.RTCSessionController', 'SessionConnected', '101', { sessionId: 's-1' }),
      deps,
      identity(VIEW_ONLY),
    )
    const body = res.body as EventBody
    expect(res.status).toBe(200)
    expect(body.event.header.namespace).toBe('Alexa.RTCSessionController')
    expect(body.event.header.name).toBe('SessionConnected')
    expect(body.event.header.correlationToken).toBe('corr-1')
    expect(body.event.endpoint?.endpointId).toBe('101')
    expect(body.event.payload).toEqual({ sessionId: 's-1' })
  })

  it('answers SessionDisconnected with the matching SessionDisconnected event', async () => {
    const { deps, closeSession } = makeDeps()
    const res = await dispatchDirective(
      directive('Alexa.RTCSessionController', 'SessionDisconnected', '101', { sessionId: 's-1' }),
      deps,
      identity(VIEW_ONLY),
    )
    const body = res.body as EventBody
    expect(body.event.header.namespace).toBe('Alexa.RTCSessionController')
    expect(body.event.header.name).toBe('SessionDisconnected')
    expect(body.event.header.correlationToken).toBe('corr-1')
    expect(body.event.endpoint?.endpointId).toBe('101')
    expect(body.event.payload).toEqual({ sessionId: 's-1' })
    expect(closeSession).toHaveBeenCalledWith({ deviceId: 101, sessionId: 's-1' })
  })
})

describe('ErrorResponse carries correlationToken and endpoint', () => {
  it('on a scope refusal', async () => {
    const { deps } = makeDeps()
    const res = await dispatchDirective(
      directive('Alexa.PowerController', 'TurnOn', '101__privacy'),
      deps,
      identity(VIEW_ONLY),
    )
    const body = res.body as EventBody
    expect(body.event.header.name).toBe('ErrorResponse')
    expect(body.event.header.correlationToken).toBe('corr-1')
    expect(body.event.endpoint?.endpointId).toBe('101__privacy')
  })

  it('on a directive this addon does not implement', async () => {
    const { deps } = makeDeps()
    const res = await dispatchDirective(
      directive('Alexa.ColorController', 'SetColor', '101'),
      deps,
      identity(CONTROL),
    )
    const body = res.body as EventBody
    expect(body.event.header.name).toBe('ErrorResponse')
    expect(body.event.header.correlationToken).toBe('corr-1')
    expect(body.event.endpoint?.endpointId).toBe('101')
  })

  it('on a handler error', async () => {
    const { deps } = makeDeps()
    const res = await dispatchDirective(
      directive('Alexa', 'ReportState', 'not-an-endpoint__x__y'),
      deps,
      identity(VIEW_ONLY),
    )
    const body = res.body as EventBody
    expect(body.event.header.name).toBe('ErrorResponse')
    expect(body.event.header.correlationToken).toBe('corr-1')
    expect(body.event.endpoint?.endpointId).toBe('not-an-endpoint__x__y')
  })
})
